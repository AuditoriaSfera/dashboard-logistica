"use client";

import { useMemo, useState } from "react";
import { Database, RefreshCw, Store } from "lucide-react";

export type HistoryMetric = { label?: string; unit?: "count" | "percent"; value: number | null; target?: number | null; status?: string };
export type HistoryStore = { store: string; storeCode: string | null; indicators?: Record<string, HistoryMetric> };
export type HistorySnapshot = { indicators?: Record<string, HistoryMetric>; stores?: HistoryStore[] };
export type ImportHistoryEntry = {
  id: string; sourceType: "indicators" | "orders"; fileName: string; importedAt: string;
  sourceModifiedAt?: string | null; importedBy?: string | null; recordCount?: number | null;
  note?: string | null; snapshot?: HistorySnapshot | null; isBaseline?: boolean;
};

const integer = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const dateTime = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const COUNT_INDICATORS = new Set(["retirada", "trilogo"]);
const INDICATOR_ORDER = ["pec-omni", "medallia", "plataforma-logistica", "recebimento", "arruamento", "retirada", "trilogo", "quebra-estoque", "saldo-pedidos", "retirada-cancelados", "entrega-cancelados"];
const INDICATOR_LABELS: Record<string, string> = {
  "pec-omni": "PEC / OMNI", medallia: "Medallia", "plataforma-logistica": "Plataforma Logística",
  recebimento: "Recebimento", arruamento: "Arruamento", retirada: "Retirada", trilogo: "Chamados Sfera",
  "quebra-estoque": "Quebra de Estoque", "saldo-pedidos": "Saldo de Pedidos",
  "retirada-cancelados": "Retirada Cancelados", "entrega-cancelados": "Entrega Cancelados",
};

function day(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function storeKey(store: Pick<HistoryStore, "store" | "storeCode">) { return store.storeCode || store.store; }
function storeIn(entry: ImportHistoryEntry | null, key: string) {
  return entry?.snapshot?.stores?.find((store) => storeKey(store) === key || store.store === key) || null;
}
function valueAt(entry: ImportHistoryEntry | null, indicatorId: string, store: string) {
  if (!entry?.snapshot) return null;
  if (store) return storeIn(entry, store)?.indicators?.[indicatorId]?.value ?? null;
  return entry.snapshot.indicators?.[indicatorId]?.value ?? null;
}
function metricUnit(entry: ImportHistoryEntry | null, indicatorId: string): "count" | "percent" {
  return entry?.snapshot?.indicators?.[indicatorId]?.unit || (COUNT_INDICATORS.has(indicatorId) ? "count" : "percent");
}
function displayValue(value: number | null, unit: "count" | "percent") {
  if (value == null || !Number.isFinite(value)) return "—";
  return unit === "percent" ? `${(value * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%` : integer.format(value);
}
function change(value: number | null, reference: number | null, unit: "count" | "percent", indicatorId: string) {
  if (value == null || reference == null) return { text: "Sem comparação", className: "history-neutral" };
  const delta = value - reference;
  if (Math.abs(delta) < 1e-9) return { text: "Sem alteração", className: "history-neutral" };
  const count = Math.abs(delta);
  const magnitude = unit === "percent"
    ? `${Math.abs(delta * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} p.p.`
    : `${integer.format(count)} ${indicatorId === "trilogo" ? count === 1 ? "chamado" : "chamados" : count === 1 ? "pedido" : "pedidos"}`;
  return {
    text: `${magnitude} ${delta > 0 ? "a mais" : "a menos"}`,
    className: delta > 0 ? "history-up" : "history-down",
  };
}

export function ImportHistoryView({ imports, loading, error, warning, onReload }: {
  imports: ImportHistoryEntry[]; loading: boolean; error: string; warning: string; onReload: () => void;
}) {
  const [storeFilter, setStoreFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [currentId, setCurrentId] = useState("");
  const [referenceId, setReferenceId] = useState("");

  const ordered = useMemo(() => imports.filter((item) => item.sourceType === "indicators")
    .sort((a, b) => b.importedAt.localeCompare(a.importedAt) || Number(b.id) - Number(a.id)), [imports]);
  const visible = useMemo(() => ordered.filter((item) => {
    const importedDay = day(item.importedAt);
    return (!dateFrom || importedDay >= dateFrom) && (!dateTo || importedDay <= dateTo);
  }), [ordered, dateFrom, dateTo]);
  const comparable = visible.filter((item) => Boolean(item.snapshot?.indicators));
  const selectedCurrent = comparable.find((item) => item.id === currentId) || comparable[0] || null;
  const selectedReference = comparable.find((item) => item.id === referenceId && item.id !== selectedCurrent?.id)
    || comparable.find((item) => item.id !== selectedCurrent?.id) || null;

  const stores = useMemo(() => {
    const map = new Map<string, HistoryStore>();
    for (const event of ordered) for (const store of event.snapshot?.stores || []) {
      if (store.store) map.set(storeKey(store), store);
    }
    return [...map.entries()].sort((a, b) => a[1].store.localeCompare(b[1].store, "pt-BR"));
  }, [ordered]);
  const indicatorIds = useMemo(() => {
    const ids = new Set<string>();
    for (const event of [selectedCurrent, selectedReference]) {
      for (const id of Object.keys(event?.snapshot?.indicators || {})) ids.add(id);
    }
    return [...ids].sort((a, b) => {
      const ai = INDICATOR_ORDER.indexOf(a); const bi = INDICATOR_ORDER.indexOf(b);
      return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi) || a.localeCompare(b, "pt-BR");
    });
  }, [selectedCurrent, selectedReference]);
  const comparisonStores = storeFilter === "all" ? stores : stores.filter(([key]) => key === storeFilter);
  const totalChanges = comparisonStores.reduce((sum, [key]) => sum + indicatorIds.filter((id) => {
    const value = valueAt(selectedCurrent, id, key); const reference = valueAt(selectedReference, id, key);
    return value != null && reference != null && Math.abs(value - reference) > 1e-9;
  }).length, 0);
  const noSnapshotCount = visible.filter((item) => !item.snapshot).length;
  const comparisonLabel = (entry: ImportHistoryEntry | null) => entry
    ? `${entry.fileName} · ${dateTime.format(new Date(entry.importedAt))}` : "Selecione uma importação";

  return <>
    <section className="page-head">
      <div><span className="eyebrow">Governança</span><h1>Histórico de importações</h1><p>Compare os resultados dos indicadores entre duas importações e veja as diferenças por loja.</p></div>
      <button className="refresh" type="button" onClick={onReload} disabled={loading}><RefreshCw className={loading ? "spin" : ""} size={16} />{loading ? "Atualizando…" : "Atualizar histórico"}</button>
    </section>
    {warning && <p className="history-warning" role="status">{warning}</p>}
    {error && <p className="error-text" role="alert">{error}</p>}

    <section className="panel history-controls">
      <div className="history-control"><label>Importadas de<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} /></label><label>Até<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} /></label></div>
      <div className="history-store-filter"><span>Loja em análise</span><div className="history-store-chips"><button type="button" className={storeFilter === "all" ? "selected" : ""} onClick={() => setStoreFilter("all")}>Todas</button>{stores.map(([key, store]) => <button type="button" key={key} className={storeFilter === key ? "selected" : ""} onClick={() => setStoreFilter(storeFilter === key ? "all" : key)}><Store size={14} />{store.store}</button>)}</div></div>
    </section>

    <section className="summary-grid four history-summary"><article><span>Importações de indicadores</span><strong>{integer.format(visible.length)}</strong><small>No período filtrado</small></article><article><span>Importação comparada</span><strong className="history-summary-date">{selectedCurrent ? dateTime.format(new Date(selectedCurrent.importedAt)) : "—"}</strong><small>{selectedCurrent?.fileName || "Sem importação com resultados"}</small></article><article><span>Importação de referência</span><strong className="history-summary-date">{selectedReference ? dateTime.format(new Date(selectedReference.importedAt)) : "—"}</strong><small>{selectedReference?.fileName || "Selecione duas importações"}</small></article><article><span>Resultados alterados</span><strong>{integer.format(totalChanges)}</strong><small>{storeFilter === "all" ? "Indicador por loja" : stores.find(([key]) => key === storeFilter)?.[1].store || "Loja selecionada"}</small></article></section>

    <section className="panel history-comparison-panel">
      <div className="section-title"><div><h2>Comparação entre importações</h2><p>Os resultados atuais são comparados com a referência escolhida. Percentuais aparecem em pontos percentuais; contagens, em pedidos ou chamados.</p></div></div>
      <div className="history-import-selectors"><label>Importação comparada<select value={selectedCurrent?.id || ""} onChange={(event) => setCurrentId(event.target.value)}>{!comparable.length && <option value="">Sem importações disponíveis</option>}{comparable.map((item) => <option key={item.id} value={item.id}>{comparisonLabel(item)}</option>)}</select></label><span aria-hidden="true">versus</span><label>Comparar com<select value={selectedReference?.id || ""} onChange={(event) => setReferenceId(event.target.value)}>{!selectedReference && <option value="">Sem referência disponível</option>}{comparable.filter((item) => item.id !== selectedCurrent?.id).map((item) => <option key={item.id} value={item.id}>{comparisonLabel(item)}</option>)}</select></label></div>
      {!selectedCurrent || !selectedReference ? <div className="history-empty"><Database /><span>São necessárias duas importações com resultados guardados para comparar. As importações antigas sem retrato continuam listadas abaixo.</span></div> : !comparisonStores.length ? <div className="history-empty"><Store /><span>Não há lojas disponíveis nesses retratos.</span></div> : <div className="history-store-comparisons">{comparisonStores.map(([key, store]) => {
        const changed = indicatorIds.filter((id) => {
          const value = valueAt(selectedCurrent, id, key); const reference = valueAt(selectedReference, id, key);
          return value != null && reference != null && Math.abs(value - reference) > 1e-9;
        }).length;
        return <details className="panel history-store-comparison" key={key} open={storeFilter !== "all" || undefined}>
          <summary><span><strong>{store.store}</strong><small>Código {store.storeCode || "—"} · {changed} indicador(es) alterado(s)</small></span><span className="history-summary-change">{changed} mudanças</span></summary>
          <div className="table-wrap"><table className="history-table"><thead><tr><th>Indicador</th><th>Referência</th><th>Resultado comparado</th><th>Variação</th></tr></thead><tbody>{indicatorIds.map((id) => {
            const value = valueAt(selectedCurrent, id, key); const reference = valueAt(selectedReference, id, key);
            const unit = metricUnit(selectedCurrent, id); const delta = change(value, reference, unit, id);
            return <tr key={id}><td><strong>{selectedCurrent.snapshot?.indicators?.[id]?.label || INDICATOR_LABELS[id] || id}</strong></td><td>{displayValue(reference, unit)}</td><td>{displayValue(value, unit)}</td><td><span className={delta.className}>{delta.text}</span></td></tr>;
          })}</tbody></table></div>
        </details>;
      })}</div>}
    </section>

    <section className="panel history-imports-panel"><div className="section-title"><div><h2>Importações de indicadores</h2><p>Mostra o histórico da planilha de indicadores. Lotes antigos sem resultados salvos não recebem variação reconstruída.</p></div><span className="table-hint">{integer.format(visible.length)} registros</span></div>{loading ? <div className="history-empty"><RefreshCw className="spin" /><span>Carregando histórico…</span></div> : !visible.length ? <div className="history-empty"><Database /><span>Nenhuma importação encontrada nesse período.</span></div> : <div className="table-wrap"><table className="history-table"><thead><tr><th>Data e hora</th><th>Arquivo</th><th>Resultados</th><th>Registro</th></tr></thead><tbody>{visible.map((item) => <tr key={item.id} className={item.isBaseline ? "baseline-row" : ""}><td>{dateTime.format(new Date(item.importedAt))}{item.isBaseline && <small>Marco inicial</small>}</td><td><strong>{item.fileName}</strong>{item.importedBy && <small>{item.importedBy}</small>}</td><td>{item.snapshot ? `${Object.keys(item.snapshot.indicators || {}).length} indicadores · ${item.snapshot.stores?.length || 0} lojas` : "Resultados não guardados"}</td><td>{item.note || (item.isBaseline ? "Base para comparação" : "Importação registrada")}</td></tr>)}</tbody></table></div>}{noSnapshotCount > 0 && <p className="history-legacy-note">{noSnapshotCount} importação(ões) antiga(s) têm apenas o registro do lote; seus resultados detalhados não foram guardados naquela época.</p>}</section>
  </>;
}
