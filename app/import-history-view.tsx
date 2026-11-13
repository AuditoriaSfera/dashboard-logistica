"use client";

import { useMemo, useState } from "react";
import { Clock3, Database, RefreshCw, Store } from "lucide-react";

export type HistoryMetric = { label?: string; unit?: "count" | "percent"; value: number | null; target?: number | null; status?: string };
export type HistoryStore = { store: string; storeCode: string | null; indicators?: Record<string, HistoryMetric>; total?: number; retirada?: number; entrega?: number; omni?: number; revendedor?: number; retiradaCancelados?: number; entregaCancelados?: number; itens?: number; pctRetirada?: number; pctEntrega?: number };
export type HistorySnapshot = {
  indicators?: Record<string, HistoryMetric>;
  stores?: HistoryStore[];
  total?: number; retirada?: number; entrega?: number; omni?: number; revendedor?: number;
  retiradaCancelados?: number; entregaCancelados?: number; itens?: number; pctRetirada?: number; pctEntrega?: number;
};
export type ImportHistoryEntry = {
  id: string; sourceType: "indicators" | "orders"; fileName: string; importedAt: string;
  sourceModifiedAt?: string | null; importedBy?: string | null; recordCount?: number | null;
  note?: string | null; snapshot?: HistorySnapshot | null; isBaseline?: boolean;
};

const integer = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const percent = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 2 });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const COUNT_INDICATORS = new Set(["retirada", "trilogo"]);
const INDICATOR_ORDER = ["pec-omni", "medallia", "plataforma-logistica", "recebimento", "arruamento", "retirada", "trilogo", "quebra-estoque", "saldo-pedidos", "retirada-cancelados", "entrega-cancelados"];
const INDICATOR_LABELS: Record<string, string> = {
  "pec-omni": "PEC / OMNI", medallia: "Medallia", "plataforma-logistica": "Plataforma Logística",
  recebimento: "Recebimento", arruamento: "Arruamento", retirada: "Retirada", trilogo: "Chamados Sfera",
  "quebra-estoque": "Quebra de Estoque", "saldo-pedidos": "Saldo de Pedidos",
  "retirada-cancelados": "Retirada Cancelados", "entrega-cancelados": "Entrega Cancelados",
};
const orderMetrics = [
  ["total", "Total de pedidos", "count"], ["retirada", "Retirada", "count"], ["entrega", "Entrega", "count"],
  ["omni", "OMNI", "count"], ["revendedor", "Revendedor", "count"], ["retiradaCancelados", "Retirada cancelados", "count"],
  ["entregaCancelados", "Entrega cancelados", "count"], ["itens", "Itens", "count"],
  ["pctRetirada", "% Retirada", "percent"], ["pctEntrega", "% Entrega", "percent"],
] as const;

function day(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function formatCount(value: number | null | undefined) { return value == null || !Number.isFinite(value) ? "—" : integer.format(value); }
function formatMetric(value: number | null | undefined, unit: "count" | "percent") {
  return value == null || !Number.isFinite(value) ? "—" : unit === "percent" ? percent.format(value) : integer.format(value);
}
function formatDelta(value: number | null, previous: number | null, unit: "count" | "percent") {
  if (value == null || previous == null) return { text: "Sem comparação", className: "history-neutral" };
  const delta = value - previous;
  if (Math.abs(delta) < 1e-9) return { text: "Sem alteração", className: "history-neutral" };
  const magnitude = unit === "percent"
    ? `${delta > 0 ? "+" : "−"}${Math.abs(delta * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} p.p.`
    : `${delta > 0 ? "+" : "−"}${integer.format(Math.abs(delta))}`;
  return { text: magnitude, className: delta > 0 ? "history-up" : "history-down" };
}
function storeKey(store: Pick<HistoryStore, "store" | "storeCode">) { return store.storeCode || store.store; }
function storeIn(entry: ImportHistoryEntry, key: string) {
  return entry.snapshot?.stores?.find((store) => storeKey(store) === key || store.store === key) || null;
}
function indicatorValue(entry: ImportHistoryEntry, id: string, selectedStore: string) {
  if (!entry.snapshot) return null;
  return selectedStore ? storeIn(entry, selectedStore)?.indicators?.[id]?.value ?? null : entry.snapshot.indicators?.[id]?.value ?? null;
}
function orderValue(entry: ImportHistoryEntry, id: string, selectedStore: string) {
  if (!entry.snapshot) return null;
  return selectedStore ? storeIn(entry, selectedStore)?.[id as keyof HistoryStore] as number | null ?? null : entry.snapshot[id as keyof HistorySnapshot] as number | null ?? null;
}
function previousSnapshot(events: ImportHistoryEntry[], entry: ImportHistoryEntry) {
  const index = events.findIndex((item) => item.id === entry.id);
  return events.slice(index + 1).find((item) => item.sourceType === entry.sourceType && item.snapshot) || null;
}
function changedIndicatorCount(entry: ImportHistoryEntry, previous: ImportHistoryEntry | null) {
  if (!entry.snapshot?.indicators || !previous?.snapshot?.indicators) return null;
  return Object.keys(entry.snapshot.indicators).filter((id) => {
    const current = entry.snapshot?.indicators?.[id]?.value;
    const before = previous.snapshot?.indicators?.[id]?.value;
    return current != null && before != null && Math.abs(current - before) > 1e-9;
  }).length;
}

export function ImportHistoryView({ imports, loading, error, warning, onReload }: {
  imports: ImportHistoryEntry[]; loading: boolean; error: string; warning: string; onReload: () => void;
}) {
  const [storeFilter, setStoreFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "indicators" | "orders">("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const ordered = useMemo(() => [...imports].sort((a, b) => b.importedAt.localeCompare(a.importedAt) || Number(b.id) - Number(a.id)), [imports]);
  const stores = useMemo(() => {
    const map = new Map<string, HistoryStore>();
    for (const event of ordered) for (const store of event.snapshot?.stores || []) if (store.store) map.set(storeKey(store), store);
    return [...map.entries()].sort((a, b) => a[1].store.localeCompare(b[1].store, "pt-BR"));
  }, [ordered]);
  const visible = useMemo(() => ordered.filter((item) => {
    const importDay = day(item.importedAt);
    return (typeFilter === "all" || item.sourceType === typeFilter)
      && (!dateFrom || importDay >= dateFrom) && (!dateTo || importDay <= dateTo);
  }), [ordered, typeFilter, dateFrom, dateTo]);
  const orderEvents = ordered.filter((item) => item.sourceType === "orders" && item.snapshot?.total != null);
  const currentOrders = orderEvents[0] || null;
  const priorOrders = currentOrders ? previousSnapshot(ordered, currentOrders) : null;
  const currentTotal = currentOrders ? orderValue(currentOrders, "total", storeFilter === "all" ? "" : storeFilter) : null;
  const priorTotal = currentOrders && priorOrders ? orderValue(priorOrders, "total", storeFilter === "all" ? "" : storeFilter) : null;
  const orderDelta = formatDelta(currentTotal, priorTotal, "count");
  const importsInRange = visible.filter((item) => !item.isBaseline).length;
  const indicatorEntries = visible.filter((item) => item.sourceType === "indicators");
  const indicatorIds = useMemo(() => {
    const ids = new Set<string>();
    for (const event of ordered) for (const id of Object.keys(event.snapshot?.indicators || {})) ids.add(id);
    return [...ids].sort((a, b) => {
      const ai = INDICATOR_ORDER.indexOf(a); const bi = INDICATOR_ORDER.indexOf(b);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.localeCompare(b, "pt-BR");
    });
  }, [ordered]);
  const storeName = storeFilter === "all" ? "Todas as lojas" : stores.find(([key]) => key === storeFilter)?.[1].store || storeFilter;
  const comparisonLabel = storeFilter === "all" ? "Geral" : storeName;

  return <>
    <section className="page-head"><div><span className="eyebrow">Governança</span><h1>Histórico de importações</h1><p>Compare cada lote, os resultados dos indicadores e a evolução de pedidos por loja.</p></div><button className="refresh" type="button" onClick={onReload} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={16} />{loading ? "Atualizando…" : "Atualizar histórico"}</button></section>
    {warning && <p className="history-warning" role="status">{warning}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}
    <section className="panel history-controls"><div className="history-control"><label>Origem<select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value as typeof typeFilter)}><option value="all">Todas as importações</option><option value="indicators">Indicadores</option><option value="orders">Pedidos</option></select></label><label>Importadas de<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label>Até<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></div><div className="history-store-filter"><span>Loja em análise</span><div className="history-store-chips"><button type="button" className={storeFilter === "all" ? "selected" : ""} onClick={() => setStoreFilter("all")}>Todas</button>{stores.map(([key, store]) => <button type="button" key={key} className={storeFilter === key ? "selected" : ""} onClick={() => setStoreFilter(storeFilter === key ? "all" : key)}><Store size={14} />{store.store}</button>)}</div></div></section>

    <section className="summary-grid four history-summary"><article><span>{currentOrders?.isBaseline ? "Base atual de pedidos" : "Última importação de pedidos"}</span><strong>{formatCount(currentTotal)}</strong><small>{currentOrders ? dateTime.format(new Date(currentOrders.importedAt)) : "Sem importações com resumo"} · {comparisonLabel}</small></article><article><span>Importação anterior</span><strong>{formatCount(priorTotal)}</strong><small>{priorOrders ? dateTime.format(new Date(priorOrders.importedAt)) : "Sem snapshot anterior para comparar"}</small></article><article><span>Variação de pedidos</span><strong className={orderDelta.className}>{orderDelta.text}</strong><small>{currentOrders && priorOrders ? (Number(currentTotal) > Number(priorTotal) ? "Aumentou" : Number(currentTotal) < Number(priorTotal) ? "Diminuiu" : "Sem alteração") : "Comparações detalhadas começam na base inicial"}</small></article><article><span>Importações no período</span><strong>{integer.format(importsInRange)}</strong><small>{typeFilter === "all" ? "Indicadores e pedidos" : typeFilter === "orders" ? "Planilhas de pedidos" : "Planilhas de indicadores"}</small></article></section>

    <section className="panel history-imports-panel"><div className="section-title"><div><h2>Todos os lotes registrados</h2><p>Importações antigas sem retrato de resultados continuam listadas; suas diferenças não são reconstruídas.</p></div><span className="table-hint">{integer.format(visible.length)} registros</span></div>{loading ? <div className="history-empty"><RefreshCw className="spin" /><span>Carregando histórico…</span></div> : !visible.length ? <div className="history-empty"><Database /><span>Nenhuma importação encontrada nesse filtro.</span></div> : <div className="table-wrap"><table className="history-table"><thead><tr><th>Data e hora</th><th>Origem</th><th>Arquivo</th><th>Resultado do lote</th><th>Variação</th><th>Situação</th></tr></thead><tbody>{visible.map((item) => {
      const previous = previousSnapshot(ordered, item);
      const total = item.sourceType === "orders" ? orderValue(item, "total", storeFilter === "all" ? "" : storeFilter) : null;
      const before = item.sourceType === "orders" && previous ? orderValue(previous, "total", storeFilter === "all" ? "" : storeFilter) : null;
      const delta = formatDelta(total, before, "count");
      const changes = item.sourceType === "indicators" ? changedIndicatorCount(item, previous) : null;
      return <tr key={item.id} className={item.isBaseline ? "baseline-row" : ""}><td>{dateTime.format(new Date(item.importedAt))}{item.isBaseline && <small>Marco inicial</small>}</td><td><span className={`history-type ${item.sourceType}`}>{item.sourceType === "orders" ? "Pedidos" : "Indicadores"}</span></td><td><strong>{item.fileName}</strong>{item.importedBy && <small>{item.importedBy}</small>}</td><td>{item.snapshot ? item.sourceType === "orders" ? `${formatCount(total)} pedidos acumulados` : `${Object.keys(item.snapshot.indicators || {}).length} indicadores · ${item.snapshot.stores?.length || 0} lojas` : item.recordCount != null ? `${formatCount(item.recordCount)} registros recebidos` : "Resultado detalhado não guardado"}</td><td>{item.sourceType === "orders" ? delta.text : changes == null ? "Sem comparação" : `${changes} indicadores alterados`}</td><td>{item.isBaseline ? "Base para comparação" : item.snapshot ? item.note || "Comparação disponível" : item.note || "Sem retrato detalhado"}</td></tr>;
    })}</tbody></table></div>}</section>

    <section className="panel history-orders-panel"><div className="section-title"><div><h2>Pedidos por importação</h2><p>Total = retirada + entrega, sem cancelados. Percentuais são recalculados por importação.</p></div></div>{!orderEvents.length ? <p className="muted">Ainda não há retratos de pedidos para comparar.</p> : <div className="table-wrap"><table className="history-table orders-history-table"><thead><tr><th>Data da importação</th><th>Total de pedidos</th><th>Diferença</th><th>Retirada</th><th>Entrega</th><th>OMNI</th><th>Revendedor</th><th>Cancelados</th><th>Itens</th></tr></thead><tbody>{orderEvents.filter((item) => visible.includes(item)).map((item) => {
      const previous = previousSnapshot(ordered, item);
      const current = (key: string) => orderValue(item, key, storeFilter === "all" ? "" : storeFilter);
      const before = (key: string) => previous ? orderValue(previous, key, storeFilter === "all" ? "" : storeFilter) : null;
      const delta = formatDelta(current("total"), before("total"), "count");
      return <tr key={item.id} className={item.isBaseline ? "baseline-row" : ""}><td>{dateTime.format(new Date(item.importedAt))}{item.isBaseline && <small>Marco inicial</small>}</td><td><strong>{formatCount(current("total"))}</strong></td><td><span className={delta.className}>{delta.text}</span></td><td>{formatCount(current("retirada"))}<small>{formatDelta(current("retirada"), before("retirada"), "count").text}</small></td><td>{formatCount(current("entrega"))}<small>{formatDelta(current("entrega"), before("entrega"), "count").text}</small></td><td>{formatCount(current("omni"))}<small>{formatDelta(current("omni"), before("omni"), "count").text}</small></td><td>{formatCount(current("revendedor"))}<small>{formatDelta(current("revendedor"), before("revendedor"), "count").text}</small></td><td>{formatCount((current("retiradaCancelados") || 0) + (current("entregaCancelados") || 0))}</td><td>{formatCount(current("itens"))}</td></tr>;
    })}</tbody></table></div>}</section>

    <section className="history-indicators-section"><div className="section-title"><div><h2>Variação por indicador · {comparisonLabel}</h2><p>Percentuais mostram a diferença em pontos percentuais; contagens mostram a diferença inteira.</p></div></div>{!indicatorEntries.some((item) => item.snapshot) ? <article className="panel history-empty"><Database /><span>Os indicadores detalhados passam a ser comparáveis a partir da base inicial.</span></article> : <div className="history-indicator-grid">{indicatorIds.map((id) => {
      const series = indicatorEntries.filter((item) => indicatorValue(item, id, storeFilter === "all" ? "" : storeFilter) != null);
      if (!series.length) return null;
      const latest = series[0]; const latestValue = indicatorValue(latest, id, storeFilter === "all" ? "" : storeFilter);
      const previous = series[1] || null; const previousValue = previous ? indicatorValue(previous, id, storeFilter === "all" ? "" : storeFilter) : null;
      const unit = latest.snapshot?.indicators?.[id]?.unit || (COUNT_INDICATORS.has(id) ? "count" : "percent");
      const latestDelta = formatDelta(latestValue, previousValue, unit);
      return <details className="panel history-indicator-card" key={id}><summary><span><strong>{latest.snapshot?.indicators?.[id]?.label || INDICATOR_LABELS[id] || id}</strong><small>{series.length} importação(ões) com resultado</small></span><span className="history-latest-value">{formatMetric(latestValue, unit)}<small className={latestDelta.className}>{latestDelta.text}</small></span></summary><div className="table-wrap"><table className="history-table"><thead><tr><th>Data de importação</th><th>Resultado</th><th>Importação anterior</th><th>Variação</th></tr></thead><tbody>{series.map((item, index) => {
        const value = indicatorValue(item, id, storeFilter === "all" ? "" : storeFilter);
        const beforeEntry = series[index + 1] || null;
        const beforeValue = beforeEntry ? indicatorValue(beforeEntry, id, storeFilter === "all" ? "" : storeFilter) : null;
        const delta = formatDelta(value, beforeValue, unit);
        return <tr key={item.id} className={item.isBaseline ? "baseline-row" : ""}><td>{dateTime.format(new Date(item.importedAt))}{item.isBaseline && <small>Marco inicial</small>}</td><td><strong>{formatMetric(value, unit)}</strong></td><td>{formatMetric(beforeValue, unit)}</td><td><span className={delta.className}>{delta.text}</span></td></tr>;
      })}</tbody></table></div></details>;
    })}</div>}</section>

    <section className="panel history-stores-panel"><div className="section-title"><div><h2>Histórico por loja</h2><p>Clique numa unidade para filtrar os lotes, pedidos e todos os indicadores.</p></div></div>{!stores.length ? <p className="muted">As lojas aparecerão assim que houver uma base de comparação.</p> : <div className="history-store-grid"><button type="button" className={`history-store-card ${storeFilter === "all" ? "selected" : ""}`} onClick={() => setStoreFilter("all")}><Store /><strong>Todas as lojas</strong><small>Visão consolidada</small></button>{stores.map(([key, store]) => {
      const latest = orderEvents.find((item) => storeIn(item, key)); const previous = latest ? previousSnapshot(ordered, latest) : null;
      const total = latest ? orderValue(latest, "total", key) : null; const before = latest && previous ? orderValue(previous, "total", key) : null;
      const delta = formatDelta(total, before, "count");
      return <button type="button" key={key} className={`history-store-card ${storeFilter === key ? "selected" : ""}`} onClick={() => setStoreFilter(storeFilter === key ? "all" : key)}><Store /><strong>{store.store}</strong><small>Código {store.storeCode || "—"}</small><span>{formatCount(total)} pedidos</span><em className={delta.className}>{delta.text}</em></button>;
    })}</div>}</section>
  </>;
}
