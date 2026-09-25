"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, BarChart3, Building2, ChevronRight, CircleGauge, Database,
  LayoutDashboard, Menu, RefreshCw, Settings, Store, Trophy, UserCircle, Users, X,
} from "lucide-react";
import {
  Bar, BarChart, CartesianGrid, Line, LineChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis, ReferenceLine, LabelList,
} from "recharts";
import cyclePeriodsSource from "../config/cycles.json";

const API = process.env.NEXT_PUBLIC_OPERATIONS_API_URL || "http://127.0.0.1:8788";
const STATUS = {
  good: { icon: "✓", label: "Dentro da meta", className: "good" },
  warning: { icon: "▲", label: "Atenção", className: "warning" },
  bad: { icon: "×", label: "Fora da meta", className: "bad" },
  unknown: { icon: "○", label: "Sem informação", className: "unknown" },
} as const;

type StatusKey = keyof typeof STATUS;
type Result = { value: number | null; target: number | null; status: StatusKey; count: number; lateCount?: number; totalCount?: number };
type RecordItem = {
  store: string; storeCode: string | null; cycle: number | null; date: string | null;
  periodStart?: string | null; periodEnd?: string | null;
  value: number | null; target: number | null; volume: number | null;
  numerator?: number | null; denominator?: number | null; statusSource?: string | null;
  notes?: string | null; complaints?: string | null; raw?: Record<string, unknown>;
};
type Indicator = {
  id: string; label: string; direction: "higher" | "lower"; latestKey: string | number | null;
  configuredTarget?: number | null;
  generalByCycle?: Record<string, number>;
  current: Result; ranking: Array<Result & { store: string; storeCode?: string | null }>;
  trend: Array<Result & { period: string }>; records: RecordItem[];
};
type DashboardData = {
  source: { fileName: string; modifiedAt: string; resolvedSheets: Record<string, string> };
  meta: { storeCount: number; recordCount: number; loadedAt: string };
  filters: { stores: string[]; cycles: number[]; indicators: Array<{ id: string; label: string }> };
  indicators: Record<string, Indicator>;
  stores: Array<{ store: string; storeCode: string | null; indicators: Record<string, Result> }>;
  alerts: Array<Result & { store: string; storeCode?: string | null; indicator: string }>;
  quality: { issues: Array<{ severity: string; code: string; message: string; indicator?: string }>; summary: Record<string, number> };
  orders?: { source: { fileName: string; modifiedAt: string; lastImportAt?: string }; period: { start: string | null; end: string | null; days: number }; stores: Array<{ store: string; storeCode: string; total: number; retirada: number; entrega: number; revendedor: number; omni: number; revendedorCategorias?: Record<string, number>; cancelamentoMotivos?: Record<string, [number, number]>; cancelamentoFiscal?: Record<string, [number, number]>; pctEntrega: number; pctRetirada: number; retiradaCancelados: number; entregaCancelados: number; itens: number; mediaRetirada: number; mediaEntrega: number; mediaOmni: number; mediaItens: number }>; daily?: Array<{ date: string; store: string; storeCode: string; total: number; retirada: number; entrega: number; revendedor: number; omni: number; retiradaCancelados: number; entregaCancelados: number; itens: number; revendedorCategorias?: Record<string, number>; cancelamentoMotivos?: Record<string, [number, number]>; cancelamentoFiscal?: Record<string, [number, number]> }>; records?: OrderRecord[] } | null;
};

type OrderRecord = {
  orderCode: string;
  reseller: string;
  channel: string;
  role: string;
  city: string;
  store?: string;
  cycle?: number | null;
  value: number;
  date: string | null;
  canceled?: boolean;
};

const percent = new Intl.NumberFormat("pt-BR", { style: "percent", maximumFractionDigits: 2 });
// Contagens de pedidos/itens são sempre inteiras; a média diária continua
// usando sua própria formatação decimal quando necessário.
const integer = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 0 });
const shortDate = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "short" });
const COUNT_INDICATORS = new Set(["retirada", "trilogo"]);
const ZERO_WHEN_ABSENT = new Set(["retirada", "trilogo"]);
const INFORMATIONAL_INDICATORS = new Set<string>();
const DETAILED_INDICATORS = new Set(["arruamento", "recebimento", "retirada", "trilogo", "quebra-estoque"]);
const CYCLE_PERIODS = cyclePeriodsSource as Record<string, { start: string; end: string }>;
const cycleOptions = Object.keys(CYCLE_PERIODS).sort((a, b) => Number(a) - Number(b));
const isInformational = (id: string) => INFORMATIONAL_INDICATORS.has(id);
const isWithdrawal = (id: string) => id === "retirada";
const trendUnit = (id: string) => COUNT_INDICATORS.has(id) ? "quantidade do total" : "percentual do total (%)";
const trendTitle = (indicator: Pick<Indicator, "id" | "label">) => `Evolução ${indicator.label} p/${trendUnit(indicator.id)}`;
const formatValue = (value: number | null, id?: string) => value == null ? "—" : id && COUNT_INDICATORS.has(id) ? integer.format(value) : percent.format(value);
const formatResult = (result: Result | null | undefined, id?: string) => {
  if (!result) return "—";
  if (id === "recebimento" && result.totalCount != null) return `${integer.format(result.totalCount)} NFs / ${integer.format(result.lateCount ?? 0)} atrasadas`;
  return formatValue(result.value, id);
};
const formatGap = (gap: number, id: string) => COUNT_INDICATORS.has(id)
  ? `${integer.format(Math.abs(gap))} acima do limite`
  : `desvio ${(Math.abs(gap) * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} p.p.`;
const formatDay = (value: string | null | undefined) => {
  if (!value) return null;
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" }).format(new Date(`${day}T00:00:00`));
};
const platformPeriodLabel = (indicator: Indicator, selectedCycle: string) => {
  if (indicator.id !== "plataforma-logistica" || !indicator.records.length) return null;
  const latestCycle = selectedCycle
    ? Number(selectedCycle)
    : Math.max(...indicator.records.map((row) => Number(row.cycle)).filter(Number.isFinite));
  const periodRows = indicator.records.filter((row) => Number(row.cycle) === latestCycle);
  const rows = periodRows.length ? periodRows : indicator.records;
  const starts = rows.map((row) => row.periodStart || row.date).filter((value): value is string => Boolean(value)).sort();
  const ends = rows.map((row) => row.periodEnd || row.date).filter((value): value is string => Boolean(value)).sort();
  const start = formatDay(starts[0]);
  const end = formatDay(ends.at(-1));
  return start && end ? `${start} a ${end}` : null;
};
function ResultValue({ result, id }: { result: Result | null | undefined; id: string }) {
  if (id === "recebimento" && result?.totalCount != null) return <span className="receiving-value"><span>{formatValue(result.value, id)}</span><small>{integer.format(result.totalCount)} NFs / {integer.format(result.lateCount ?? 0)} atrasadas</small></span>;
  return <>{formatValue(result?.value ?? null, id)}</>;
}
const formatTarget = (id: string, value: number | null) => isWithdrawal(id) ? "3 Pedidos" : id === "trilogo" ? `${integer.format(value ?? 2)} Chamados` : formatValue(value, id);
const normalizeText = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const statusFor = (value: number | null, target: number | null, direction: "higher" | "lower", sourceStatus = ""): StatusKey => {
  if (value == null) return "unknown";
  if (target != null) {
    const delta = direction === "lower" ? target - value : value - target;
    return delta >= 0 ? "good" : "bad";
  }
  const source = normalizeText(sourceStatus);
  if (source.includes("fora") || source.includes("nao conforme")) return "bad";
  if (source.includes("dentro") || source.includes("conforme")) return "good";
  return "unknown";
};
const aggregateRows = (rows: RecordItem[], indicator: Pick<Indicator, "id" | "direction" | "configuredTarget">): Result => {
  const valid = rows.filter((row) => row.value != null);
  const weighted = valid.filter((row) => row.numerator != null && Number(row.denominator) > 0);
  let value: number | null = null;
  if (weighted.length) {
    const denominator = weighted.reduce((sum, row) => sum + Number(row.denominator), 0);
    value = denominator ? weighted.reduce((sum, row) => sum + Number(row.numerator), 0) / denominator : null;
  } else if (COUNT_INDICATORS.has(indicator.id)) {
    value = valid.length ? valid.reduce((sum, row) => sum + Number(row.value), 0) : ZERO_WHEN_ABSENT.has(indicator.id) ? 0 : null;
  } else if (valid.length) {
    const byVolume = valid.filter((row) => Number(row.volume) > 0);
    value = byVolume.length
      ? byVolume.reduce((sum, row) => sum + Number(row.value) * Number(row.volume), 0) / byVolume.reduce((sum, row) => sum + Number(row.volume), 0)
      : valid.reduce((sum, row) => sum + Number(row.value), 0) / valid.length;
  }
  const targets = valid.map((row) => row.target).filter((target): target is number => target != null);
  const target = targets.length
    ? targets.reduce((sum, item) => sum + item, 0) / targets.length
    : indicator.configuredTarget ?? null;
  const statuses = valid.map((row) => row.statusSource).filter(Boolean).join(" | ");
  const lateCount = indicator.id === "recebimento" ? valid.filter((row) => row.value === 0).length : undefined;
  const totalCount = indicator.id === "recebimento" ? valid.length : undefined;
  return { value, target, count: valid.length, lateCount, totalCount, status: statusFor(value, target, indicator.direction, statuses) };
};
const periodOf = (row: RecordItem) => row.cycle != null ? String(row.cycle) : row.date || "";
const recomputeIndicator = (
  indicator: Pick<Indicator, "id" | "direction" | "configuredTarget" | "generalByCycle">, store: string, cycle: string, startDate: string, endDate: string,
  allStores: Array<{ store: string; storeCode: string | null }>,
): Indicator => {
  const recordDate = (row: RecordItem) => (row.date || row.periodEnd || row.periodStart || "").slice(0, 10);
  const cyclePeriod = cycle ? CYCLE_PERIODS[cycle] : null;
  // Para Trilogo o próprio ciclo da planilha já é a competência definida
  // pela abertura; não reaplicamos o intervalo visual do ciclo sobre ele.
  const cycleUsesSourceColumn = COUNT_INDICATORS.has(indicator.id) || indicator.id === "recebimento";
  const cycleStart = cycleUsesSourceColumn ? "" : cyclePeriod?.start;
  const cycleEnd = cycleUsesSourceColumn ? "" : cyclePeriod?.end;
  const effectiveStart = [startDate, cycleStart].filter(Boolean).sort().at(-1) || "";
  const effectiveEnd = [endDate, cycleEnd].filter(Boolean).sort().at(0) || "";
  const records = indicator.records.filter((row) => {
    const date = recordDate(row);
    const rowCyclePeriod = row.cycle != null ? CYCLE_PERIODS[String(row.cycle)] : null;
    let matchesCycle = true;
    if (cycle) {
      // Retirada e Trilogo já trazem o ciclo atribuído pela planilha. Essa
      // competência é a fonte oficial da apuração; a data continua disponível
      // para filtros explícitos de período.
      if (cycleUsesSourceColumn && row.cycle != null) matchesCycle = String(row.cycle) === cycle;
      else if (date) matchesCycle = date >= cyclePeriod!.start && date <= cyclePeriod!.end;
      else matchesCycle = row.cycle != null && String(row.cycle) === cycle;
    }
    const dateForStart = date || rowCyclePeriod?.end || "";
    const dateForEnd = date || rowCyclePeriod?.start || "";
    return (!store || row.store === store)
      && matchesCycle
      && (!effectiveStart || Boolean(dateForStart) && dateForStart >= effectiveStart)
      && (!effectiveEnd || Boolean(dateForEnd) && dateForEnd <= effectiveEnd);
  });
  const hasDateFilter = Boolean(effectiveStart || effectiveEnd);
  const cycleRows = records.filter((row) => row.cycle != null);
  const latestKey = cyclePeriod
    ? `Ciclo ${cycle}`
    : hasDateFilter
    ? `${startDate || "início"} a ${endDate || "fim"}`
    : cycleRows.length
    ? Math.max(...cycleRows.map((row) => Number(row.cycle)))
    : records.map((row) => row.date || "").sort().at(-1) || null;
    // Retirada é uma apuração acumulada por ciclo. Sem nenhum filtro
    // explícito, a tabela deve exibir todos os ciclos disponíveis; quando o
    // usuário escolhe ciclo ou período, o recorte continua sendo respeitado.
    const showAllWithdrawalCycles = indicator.id === "retirada" && !cycle && !startDate && !endDate;
    const latestRows = showAllWithdrawalCycles || cycle || hasDateFilter
      ? records
      : records.filter((row) => row.cycle != null ? row.cycle === latestKey : row.date === latestKey);
  // A escolha de ciclo define o recorte atual, mas não deve apagar o
  // histórico. A evolução continua usando os ciclos mais recentes; filtros
  // de data explícitos ainda limitam a janela histórica.
  const historyRecords = indicator.records.filter((row) => {
    const date = recordDate(row);
    return (!store || row.store === store)
      && (!startDate || Boolean(date) && date >= startDate)
      && (!endDate || Boolean(date) && date <= endDate);
  });
  const grouped = new Map<string, RecordItem[]>();
  historyRecords.forEach((row) => { const key = periodOf(row); if (key) grouped.set(key, [...(grouped.get(key) || []), row]); });
  const trend = [...grouped.entries()]
    .sort(([a], [b]) => Number.isFinite(Number(a)) && Number.isFinite(Number(b)) ? Number(a) - Number(b) : a.localeCompare(b))
    .map(([period, rows]) => ({ period, ...aggregateRows(rows, indicator) }));
  const byStore = new Map<string, RecordItem[]>();
  latestRows.forEach((row) => { if (row.store) byStore.set(row.store, [...(byStore.get(row.store) || []), row]); });
  const ranking = allStores.map(({ store: name, storeCode }) => ({ store: name, storeCode, ...aggregateRows(byStore.get(name) || [], indicator) }))
    .sort((a, b) => a.value == null ? 1 : b.value == null ? -1 : b.value - a.value || a.store.localeCompare(b.store, "pt-BR"));
  const aggregate = aggregateRows(latestRows, indicator);
  const generalCycle = cycle || String(latestRows.map((row) => row.cycle).filter((value): value is number => value != null).sort((a, b) => a - b).at(-1) ?? "");
  const generalKeys = Object.keys(indicator.generalByCycle || {}).sort((a, b) => Number(a) - Number(b));
  const generalValue = indicator.generalByCycle?.[generalCycle]
    ?? indicator.generalByCycle?.[generalKeys.filter((key) => Number(key) <= Number(generalCycle)).at(-1) || ""]
    ?? null;
  const generalAggregate = generalValue == null
    ? aggregate
    : { ...aggregate, value: generalValue, status: statusFor(generalValue, aggregate.target, indicator.direction) };
  const current = isWithdrawal(indicator.id)
    ? {
      ...aggregate,
      value: store ? ranking.find((row) => row.store === store)?.value ?? 0 : null,
      status: store ? ranking.find((row) => row.store === store)?.status || "unknown" as StatusKey : "unknown" as StatusKey,
    }
    : generalAggregate;
  return { ...indicator, latestKey, records, current, trend, ranking };
};
const deltaText = (value: number | null, target: number | null, direction: string, id: string) => {
  if (value == null || target == null) return "Meta não definida";
  const delta = direction === "lower" ? target - value : value - target;
  if (COUNT_INDICATORS.has(id)) return delta >= 0 ? "Dentro do limite" : `${integer.format(Math.abs(delta))} acima do limite`;
  return `${delta >= 0 ? "+" : ""}${(delta * 100).toLocaleString("pt-BR", { maximumFractionDigits: 2 })} p.p.`;
};

function Badge({ status, informational = false }: { status: StatusKey; informational?: boolean }) {
  if (informational) return <span className="badge unknown"><span aria-hidden>○</span>Apenas visualização</span>;
  const item = STATUS[status] || STATUS.unknown;
  return <span className={`badge ${item.className}`}><span aria-hidden>{item.icon}</span>{item.label}</span>;
}

function KpiCard({ indicator, onOpen, storeSelected = false }: { indicator: Indicator; onOpen: () => void; storeSelected?: boolean }) {
  const statusOnly = isWithdrawal(indicator.id);
  return (
    <button className="kpi-card" onClick={onOpen}>
      <span className="kpi-label">{indicator.label}</span>
      <strong>{statusOnly ? storeSelected ? STATUS[indicator.current.status].label : "\u00a0" : formatResult(indicator.current, indicator.id)}</strong>
      <span className="kpi-meta">{isInformational(indicator.id) ? "Sem meta • apenas visualização" : `Meta: ${formatTarget(indicator.id, indicator.current.target)}`}</span>
      <span className="kpi-delta">{statusOnly ? "Resultado exibido por loja" : isInformational(indicator.id) ? "Indicador informativo" : deltaText(indicator.current.value, indicator.current.target, indicator.direction, indicator.id)}</span>
      {(!statusOnly || storeSelected) && <Badge status={indicator.current.status} informational={isInformational(indicator.id)} />}
      <ChevronRight className="kpi-arrow" size={17} />
    </button>
  );
}

function AvailableDatePicker({ value, onChange, dates, placeholder }: { value: string; onChange: (value: string) => void; dates: string[]; placeholder: string }) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => (value || dates[0] || new Date().toISOString().slice(0, 10)).slice(0, 7));
  const months = [...new Set(dates.map((date) => date.slice(0, 7)))].sort();
  const lastAllowedDate = dates.at(-1) || "2026-01-01";
  const first = new Date(`${month}-01T00:00:00`);
  const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const offset = (first.getDay() + 6) % 7;
  const monthLabel = first.toLocaleDateString("pt-BR", { month: "long" }) + " de " + first.getFullYear();
  const label = value ? new Date(`${value}T00:00:00`).toLocaleDateString("pt-BR") : placeholder;
  const shiftMonth = (delta: number) => { const index = months.indexOf(month); const next = months[index + delta]; if (next) setMonth(next); };
  const monthIndex = months.indexOf(month);
  return <div className="date-picker"><button type="button" className={`date-picker-trigger ${value ? "has-value" : ""}`} onClick={(event) => { event.preventDefault(); setMonth((value || dates[0] || "2026-01-01").slice(0, 7)); setOpen((current) => !current); }}>{label}<span aria-hidden>▣</span></button>{open && <div className="date-picker-menu calendar-menu"><button type="button" className="date-picker-clear" onClick={() => { onChange(""); setOpen(false); }}>Todas as datas</button><div className="calendar-head"><button type="button" disabled={monthIndex <= 0} onClick={() => shiftMonth(-1)}>‹</button><strong>{monthLabel}</strong><button type="button" disabled={monthIndex < 0 || monthIndex >= months.length - 1} onClick={() => shiftMonth(1)}>›</button></div><div className="calendar-weekdays">{["seg", "ter", "qua", "qui", "sex", "sáb", "dom"].map((day) => <span key={day}>{day}</span>)}</div><div className="calendar-grid">{Array.from({ length: offset + days }, (_, index) => { if (index < offset) return <span className="calendar-empty" key={`empty-${index}`} />; const day = index - offset + 1; const date = `${month}-${String(day).padStart(2, "0")}`; const enabled = date <= lastAllowedDate; return <button type="button" key={date} disabled={!enabled} className={date === value ? "selected" : ""} onClick={() => { onChange(date); setOpen(false); }}>{day}</button>; })}</div></div>}</div>;
}

function Filters({
  data, store, setStore, cycle, setCycle, startDate, setStartDate, endDate, setEndDate,
  indicator, setIndicator, status, setStatus,
}: {
  data: DashboardData; store: string; setStore: (v: string) => void;
  cycle: string; setCycle: (v: string) => void; indicator: string; setIndicator: (v: string) => void;
  startDate: string; setStartDate: (v: string) => void; endDate: string; setEndDate: (v: string) => void;
  status: string; setStatus: (v: string) => void;
}) {
  const availableDates = Object.values(data.indicators).flatMap((item) => item.records.map((row) => (row.date || row.periodEnd || row.periodStart || "").slice(0, 10))).filter(Boolean).sort();
  const today = new Date();
  const lastDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  const uniqueDates: string[] = [];
  for (let cursor = new Date("2026-01-01T00:00:00"); cursor <= new Date(`${lastDate}T00:00:00`); cursor.setDate(cursor.getDate() + 1)) uniqueDates.push(cursor.toISOString().slice(0, 10));
  const setAvailableDate = (value: string, setter: (value: string) => void) => { if (!value || uniqueDates.includes(value)) setter(value); };
  return (
    <section className="filter-bar" aria-label="Filtros globais">
      <label>Ciclo<select value={cycle} onChange={(e) => setCycle(e.target.value)}><option value="">Todos</option>{cycleOptions.map((value) => <option key={value} value={value}>Ciclo {value}</option>)}</select></label>
      <label>Data inicial<AvailableDatePicker value={startDate} onChange={(value) => setAvailableDate(value, setStartDate)} dates={uniqueDates} placeholder="dd/mm/aaaa" /></label>
      <label>Data final<AvailableDatePicker value={endDate} onChange={(value) => setAvailableDate(value, setEndDate)} dates={uniqueDates} placeholder="dd/mm/aaaa" /></label>
      <label>Loja<select value={store} onChange={(e) => setStore(e.target.value)}><option value="">Todas</option>{data.filters.stores.map((value) => { const code = data.stores.find((item) => item.store === value)?.storeCode; return <option key={value} value={value}>{code ? `${code} • ` : ""}{value}</option>; })}</select></label>
      <label>Indicador<select value={indicator} onChange={(e) => setIndicator(e.target.value)}><option value="">Todos</option>{data.filters.indicators.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>Status<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Todos</option><option value="good">Dentro da meta</option><option value="warning">Atenção</option><option value="bad">Fora da meta</option><option value="unknown">Sem informação</option></select></label>
      <button className="clear" onClick={() => { setStore(""); setCycle(""); setStartDate(""); setEndDate(""); setIndicator(""); setStatus(""); }}>Limpar filtros</button>
    </section>
  );
}

function Trend({ indicator, selectedCycle = "" }: { indicator: Indicator; selectedCycle?: string }) {
  const isCount = COUNT_INDICATORS.has(indicator.id);
  const showTarget = !new Set(["retirada", "arruamento", "trilogo", "quebra-estoque"]).has(indicator.id);
  const rows = indicator.trend.map((item) => {
    // Quando a planilha fornece um Resultado Geral por ciclo (ex.: NPS
    // Total), ele é a fonte oficial da evolução; não usamos a média das
    // lojas para representar esse ponto histórico.
    const generalValue = indicator.generalByCycle?.[String(item.period)];
    const value = generalValue ?? item.value;
    return {
    ...item, value, status: statusFor(value, item.target, indicator.direction),
    chartValue: value == null ? null : isCount ? value : value * 100,
    chartTarget: !showTarget || item.target == null ? null : isCount ? item.target : item.target * 100,
    };
  });
  const latest = rows.at(-1);
  const previous = rows.at(-2);
  const selected = selectedCycle ? rows.find((row) => row.period === selectedCycle) : null;
  const streak = rows.slice().reverse().reduce((count, row) => count === 0 && row.status === "bad" ? 1 : count > 0 && row.status === "bad" ? count + 1 : count, 0);
  if (rows.length < 2) return <div className="empty-chart">Histórico insuficiente para uma curva de evolução confiável.</div>;
  return (
    <>
      <div className="trend-compare" aria-label="Comparação com a meta">
        <div><span>Último ciclo</span><strong><ResultValue result={latest} id={indicator.id} /></strong></div>
        <div><span>Ciclo anterior</span><strong><ResultValue result={previous} id={indicator.id} /></strong></div>
        {showTarget && <div><span>Meta</span><strong>{formatTarget(indicator.id, latest?.target ?? indicator.configuredTarget ?? null)}</strong></div>}
        <div><span>{selected ? `Ciclo ${selectedCycle}` : "Ciclos fora da meta"}</span><strong>{selected ? <ResultValue result={selected} id={indicator.id} /> : `${streak} consecutivo${streak === 1 ? "" : "s"}`}</strong></div>
      </div>
      <div className="chart" role="img" aria-label={`Evolução de ${indicator.label}`}>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={rows} margin={{ top: 12, right: 12, left: -10, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e7e9ed" />
            <XAxis dataKey="period" tick={{ fontSize: 11 }} tickFormatter={(v) => Number.isFinite(Number(v)) ? `Ciclo ${v}` : String(v).slice(0, 10)} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => isCount ? integer.format(Number(v)) : `${v}%`} />
            <Tooltip labelFormatter={(label) => Number.isFinite(Number(label)) ? `Ciclo ${label}` : label} formatter={(v) => [isCount ? integer.format(Number(v)) : `${Number(v).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`, "Resultado"]} />
            <Line type="monotone" dataKey="chartValue" stroke="#3157d5" strokeWidth={2.5} dot={(props: { cx?: number; cy?: number; payload?: { status?: StatusKey } }) => { const color = props.payload?.status === "good" ? "#16845b" : props.payload?.status === "bad" ? "#dc3545" : props.payload?.status === "warning" ? "#d97706" : "#64748b"; return <circle cx={props.cx} cy={props.cy} r={5} fill={color} stroke="#fff" strokeWidth={2} />; }} activeDot={{ r: 6 }} connectNulls><LabelList dataKey="chartValue" position="top" offset={8} formatter={(value) => isCount ? integer.format(Number(value)) : `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`} /></Line>
            {rows.some((row) => row.chartTarget != null) && <Line type="monotone" dataKey="chartTarget" stroke="#2e3645" strokeDasharray="6 5" dot={false} />}
            {selected && <ReferenceLine x={selectedCycle} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: `Ciclo ${selectedCycle}`, position: "insideTopRight", fill: "#b45309", fontSize: 11 }} />}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </>
  );
}

function StoreComparisonChart({ indicator }: { indicator: Indicator }) {
  const isCount = COUNT_INDICATORS.has(indicator.id);
  const maxPercent = indicator.id === "quebra-estoque" ? 5 : 100;
  const rows = indicator.ranking.filter((row) => row.value != null).slice().reverse().map((row) => ({ ...row, chartValue: isCount ? Number(row.value) : Number(row.value) * 100, chartTarget: row.target == null ? null : isCount ? Number(row.target) : Number(row.target) * 100 }));
  if (!rows.length) return null;
  const target = rows.find((row) => row.chartTarget != null)?.chartTarget;
  return <section className="panel store-comparison"><h2>Resultado por loja — {indicator.label}</h2><p className="muted">Comparação do resultado atual por loja.</p><div className="chart chart-scroll"><div className="chart-inner"><ResponsiveContainer width="100%" height={340}><BarChart data={rows} margin={{ top: 16, right: 20, left: 8, bottom: 58 }}><CartesianGrid vertical={false} stroke="#e7e9ed" /><XAxis dataKey="store" tick={{ fontSize: 10 }} angle={-35} textAnchor="end" interval={0} /><YAxis domain={isCount ? [0, "auto"] : [0, maxPercent]} unit={isCount ? "" : "%"} tick={{ fontSize: 11 }} /><Tooltip formatter={(value) => [isCount ? integer.format(Number(value)) : `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`, "Resultado"]} /><Bar dataKey="chartValue" fill="#3157d5" radius={[5, 5, 0, 0]}><LabelList dataKey="chartValue" position="top" formatter={(value) => isCount ? integer.format(Number(value)) : `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`} /></Bar>{target != null && <ReferenceLine y={target} stroke="#2e3645" strokeDasharray="6 5" label={{ value: `Meta ${isCount ? integer.format(target) : `${Number(target).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`}`, position: "insideTopRight", fill: "#2e3645", fontSize: 11 }} />}</BarChart></ResponsiveContainer></div></div></section>;
}

function Ranking({ indicator, onStore, showMedalliaDetails = false }: { indicator: Indicator; onStore: (store: string) => void; showMedalliaDetails?: boolean }) {
  const rows = indicator.ranking;
  return (
    <div className={`ranking ${indicator.id === "recebimento" ? "receiving-ranking" : ""} ${indicator.id === "medallia" && showMedalliaDetails ? "medallia-ranking" : ""}`}>
      {rows.map((row, index) => (
        <button key={row.store} onClick={() => onStore(row.store)}>
          <span className="rank">{index + 1}</span><span className="store-name">{row.store}<small>{row.storeCode || "Código não informado"}</small>{indicator.id === "medallia" && showMedalliaDetails && <><small className="ranking-detail">{integer.format(indicator.records.filter((item) => item.store === row.store).reduce((sum, item) => sum + Number(item.volume || 0), 0))} respostas</small>{indicator.records.filter((item) => item.store === row.store && item.complaints).map((item, complaintIndex) => <small className="ranking-complaint" key={complaintIndex}>{item.complaints}</small>)}</>}</span>
          <strong><ResultValue result={row} id={indicator.id} /></strong><Badge status={row.status} informational={isInformational(indicator.id)} />
        </button>
      ))}
      {!rows.length && <p className="muted">Nenhuma loja disponível neste recorte.</p>}
    </div>
  );
}

function RankingCharts({ indicator }: { indicator: Indicator }) {
  const rows = indicator.ranking.filter((row) => row.value != null);
  const statusData = [
    { name: "Dentro", value: rows.filter((row) => row.status === "good").length },
    { name: "Fora", value: rows.filter((row) => row.status === "bad").length },
    { name: "Atenção", value: rows.filter((row) => row.status === "warning").length },
  ];
  const isCount = COUNT_INDICATORS.has(indicator.id);
  const valueData = rows.slice().sort((a, b) => Number(b.value) - Number(a.value)).slice(0, 6).map((row) => ({ name: row.store.split(" ")[0], value: isCount ? Number(row.value) : Number(row.value) * 100 }));
  return <div className="ranking-charts"><div className="mini-chart"><h3>Distribuição por situação</h3><ResponsiveContainer width="100%" height="100%"><BarChart data={statusData} margin={{ top: 18, right: 16, left: -16, bottom: 8 }}><CartesianGrid vertical={false} stroke="#edf0f4" /><XAxis dataKey="name" tick={{ fontSize: 11 }} /><YAxis allowDecimals={false} tick={{ fontSize: 11 }} /><Tooltip /><Bar dataKey="value" fill="#3157d5" radius={[4, 4, 0, 0]}><LabelList dataKey="value" position="top" /></Bar></BarChart></ResponsiveContainer></div><div className="mini-chart"><h3>Melhores resultados</h3><ResponsiveContainer width="100%" height="100%"><BarChart data={valueData} layout="vertical" margin={{ top: 8, right: 32, left: 46, bottom: 8 }}><CartesianGrid horizontal={false} stroke="#edf0f4" /><XAxis type="number" hide /><YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={48} /><Tooltip formatter={(value) => [isCount ? integer.format(Number(value)) : `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`, "Resultado"]} /><Bar dataKey="value" fill="#4e9f77" radius={[0, 4, 4, 0]}><LabelList dataKey="value" position="right" formatter={(value) => isCount ? integer.format(Number(value)) : `${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}%`} /></Bar></BarChart></ResponsiveContainer></div></div>;
}

function IndicatorDetailTable({ indicator }: { indicator: Indicator }) {
  const rows = indicator.ranking;
  const receivingDateKeys = indicator.id === "recebimento"
    ? indicator.records.map((item) => String(item.date || item.periodEnd || item.periodStart || "").slice(0, 10)).filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)).sort()
    : [];
  const receivingDays = receivingDateKeys.length
    ? Math.max(1, Math.round((new Date(`${receivingDateKeys.at(-1)}T00:00:00`).getTime() - new Date(`${receivingDateKeys[0]}T00:00:00`).getTime()) / 86400000) + 1)
    : 7;
  const receivingWeeks = Math.max(1, receivingDays / 7);
  const weeklyVolume = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 1 });
  const detail = (row: (typeof rows)[number]): { primary: string; secondary: string; late?: string; volumes?: string; weeklyVolumes?: string; sold?: string; occurrences?: string; issueBreakdown?: string; skuTotal?: string; arranged?: string; withoutArrangement?: string } => {
    let records = indicator.records.filter((item) => item.store === row.store);
    if (indicator.id === "recebimento") {
      // `indicator.records` já chega recortado pelo ciclo/data global. Não
      // restringimos novamente ao último ciclo, pois “Todos” deve somar todas
      // as linhas da planilha.
      const matchedVolumes = records.map((item) => Number(item.raw?.receivingVolumes)).filter((value) => Number.isFinite(value));
      const volumeTotal = matchedVolumes.reduce((sum, value) => sum + value, 0);
      const late = records.filter((item) => item.value === 0).length;
      return { primary: integer.format(records.length), secondary: "", late: integer.format(late), volumes: matchedVolumes.length ? integer.format(volumeTotal) : "—", weeklyVolumes: matchedVolumes.length ? `${weeklyVolume.format(volumeTotal / receivingWeeks)}/semana` : "—" };
    }
    if (indicator.id === "arruamento") {
      const cycles = records.map((item) => item.cycle).filter((value): value is number => value != null);
      const latestCycle = cycles.length ? Math.max(...cycles) : null;
      if (latestCycle != null) records = records.filter((item) => item.cycle === latestCycle);
      const source = records.at(-1)?.raw || {};
      const numberFrom = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
      return {
        primary: "", secondary: "",
        skuTotal: integer.format(numberFrom(source["Quantidade total de SKU vendidos no período"], records.at(-1)?.volume || 0)),
        arranged: integer.format(numberFrom(source["Quantidade produto arruado"])),
        withoutArrangement: integer.format(numberFrom(source["Quantidade produto sem arruamento"])),
      };
    }
    if (indicator.id === "recebimento") {
      const late = records.filter((item) => item.value === 0).length;
      return { primary: integer.format(records.length), secondary: "", late: integer.format(late), label: "Recebimentos" };
    }
    if (indicator.id === "retirada") {
      const pedidos = records.reduce((sum, item) => {
        const entries = String(item.notes || "").split(",").map((value) => value.trim()).filter(Boolean);
        return sum + (entries.length || 0);
      }, 0);
      return { primary: integer.format(pedidos), secondary: "", label: "Pedidos" };
    }
    if (indicator.id === "trilogo") {
      const open = records.filter((item) => normalizeText(item.statusSource).includes("aberto")).length;
      return { primary: integer.format(records.length), secondary: open ? `${integer.format(open)} em aberto` : "Status conforme planilha", label: "Chamados" };
    }
    if (indicator.id === "quebra-estoque") {
      const broken = records.reduce((sum, item) => sum + Number(item.raw?.brokenItems || 0), 0);
      const sold = records.reduce((sum, item) => sum + Number(item.raw?.soldItems || 0), 0);
      return { primary: integer.format(broken), secondary: "", sold: integer.format(sold), label: "Itens quebrados" };
    }
    const notes = records.filter((item) => item.notes).length;
    return { primary: integer.format(records.length), secondary: notes ? `${integer.format(notes)} observações` : "Sem observações", label: "Registros" };
  };
  const columns = indicator.id === "arruamento"
      ? ["Loja / código", "SKUs vendidos", "Produtos arruados", "Sem arrumamento", "Resultado", "Situação"]
    : indicator.id === "recebimento"
      ? ["Loja / código", "Recebimentos", "Volumes", "Atrasados", "Resultado", "Situação"]
    : indicator.id === "retirada"
      ? ["Loja / código", "Pedidos", "Resultado", "Situação"]
      : indicator.id === "quebra-estoque"
        ? ["Loja / código", "Itens quebrados", "Itens vendidos", "Índice", "Situação"]
        : indicator.id === "trilogo"
          ? ["Loja / código", "Chamados", "Resultado", "Situação"]
          : ["Loja / código", "Registros", "Resultado", "Situação"];
  return <div className="indicator-detail-table-wrap"><table className="indicator-detail-table"><thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead><tbody>{rows.map((row) => { const item = detail(row); const receiving = indicator.id === "recebimento"; const stockBreak = indicator.id === "quebra-estoque"; const arrangement = indicator.id === "arruamento"; return <tr key={row.store}><th><button onClick={() => onStore(row.store)}><span>{row.store}</span><small>{row.storeCode || "Código não informado"}</small></button></th>{arrangement ? <><td><strong>{item.skuTotal}</strong></td><td><strong>{item.arranged}</strong></td><td><strong>{item.withoutArrangement}</strong></td></> : <td><strong>{item.primary}</strong>{item.secondary && <small>{item.secondary}</small>}</td>}{receiving && <td><strong>{item.volumes}</strong><small>{item.weeklyVolumes ? `Média ${item.weeklyVolumes}` : ""}</small></td>}{receiving && <td><strong>{item.late}</strong></td>}{stockBreak && <td><strong>{item.sold}</strong></td>}<td><strong>{indicator.id === "retirada" ? integer.format(row.count) : formatValue(row.value, indicator.id)}</strong><small>{row.target == null ? "Sem meta" : `Meta: ${formatTarget(indicator.id, row.target)}`}</small></td><td><Badge status={row.status} informational={isInformational(indicator.id)} /></td></tr>; })}</tbody></table>{!rows.length && <p className="muted">Nenhuma loja disponível neste recorte.</p>}</div>;
}

function RankingSummary({ indicator }: { indicator: Indicator }) {
  const period = platformPeriodLabel(indicator, "");
  const periodNote = period ? <p className="ranking-period">Período do resultado: <strong>{period}</strong></p> : null;
  if (indicator.id === "recebimento") {
    const receivedNfs = indicator.records.length;
    const lateNfs = indicator.records.filter((item) => item.value === 0).length;
    return <>{periodNote}<p className="ranking-summary">Resultado geral: <strong>{integer.format(receivedNfs)} NFs recebidas · {integer.format(lateNfs)} em atraso</strong></p></>;
  }
  const overall = isWithdrawal(indicator.id) ? "Apuração por loja" : formatResult(indicator.current, indicator.id);
  return <>{periodNote}<p className="ranking-summary">Resultado geral: <strong>{overall}</strong></p></>;
}

function MedalliaTable({ indicator }: { indicator: Indicator }) {
  return <div className="medallia-table-wrap"><table className="medallia-table"><thead><tr><th>Loja</th><th>Respostas</th><th>Resultado</th><th>Situação</th><th>Reclamações</th></tr></thead><tbody>{indicator.ranking.map((row) => {
    const records = indicator.records.filter((item) => item.store === row.store);
    const responses = records.reduce((sum, item) => sum + Number(item.volume || 0), 0);
    const complaints = records.filter((item) => item.complaints).map((item) => item.complaints).join(" • ");
    return <tr key={row.store}><th><span>{row.store}</span><small>{row.storeCode || "Código não informado"}</small></th><td>{integer.format(responses)}</td><td><strong>{formatValue(row.value, "medallia")}</strong></td><td><Badge status={row.status} /></td><td className="medallia-table-complaint">{complaints || "—"}</td></tr>;
  })}</tbody></table></div>;
}

function Matrix({ data, onStore }: { data: DashboardData; onStore: (store: string) => void }) {
  const visible = data.filters.indicators.slice(0, 9);
  return (
    <div className="table-wrap">
      <table className="matrix">
        <thead><tr><th>Loja</th>{visible.map((item) => <th key={item.id}>{item.label.replace("Plataforma ", "")}</th>)}</tr></thead>
        <tbody>{data.stores.map((entry) => (
          <tr key={entry.store}>
            <th><button onClick={() => onStore(entry.store)}>{entry.store}<small>{entry.storeCode || "Código não informado"}</small></button></th>
            {visible.map((item) => {
              const result = entry.indicators[item.id] || { status: "unknown" as StatusKey, value: null, target: null };
              const meta = STATUS[result.status] || STATUS.unknown;
              const label = isInformational(item.id) ? "Apenas visualização" : meta.label;
              const targetLabel = isInformational(item.id) ? "Sem meta" : `Meta: ${formatTarget(item.id, result.target)}`;
              const title = `${label} • Resultado: ${formatResult(result, item.id)} • ${targetLabel}`;
              return <td key={item.id}><span className={`matrix-dot ${meta.className}`} title={title}>{meta.icon}<span className="sr-only">{label}</span></span></td>;
            })}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function OrdersView({ data, selectedStore, cycle, startDate, endDate, onImported }: { data: DashboardData; selectedStore: string; cycle: string; startDate: string; endDate: string; onImported: () => Promise<void> }) {
  const orders = data.orders;
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const fields = ["Quantidade de pedidos de retirada", "Quantidade de pedidos de entrega", "Quantidade de pedidos de revendedor", "Quantidade de pedidos de OMNI", "% de pedidos de entrega", "% de pedidos de retirada", "Quantidade de pedidos de retirada cancelado", "Quantidade de pedidos de entrega cancelados", "Quantidade de itens por loja", "Média de pedidos de retirada por dia", "Média de pedidos de entrega por dia", "Média de pedidos de OMNI por dia", "Média de itens por dia"];
  const resellerCategories = [
    ["bronze", "Bronze"], ["cobre", "Cobre"], ["diamante", "Diamante"],
    ["esmeralda gb", "Esmeralda GB"], ["ouro", "Ouro"], ["platina", "Platina"], ["prata", "Prata"],
    ["rubi", "Rubi"], ["revendedor", "Revendedor"],
  ] as const;
  const cancellationReasons = [
    ["usuario", "Cancelado Pelo Usuário"], ["inatividade", "Cancelado Por Inatividade"],
    ["prazoPendencia", "Cancelado por Prazo de Pendência Excedido"], ["analisePagamento", "Cancelado por análise do pagamento"],
    ["estoque", "Cancelado por inconsistência de estoque"], ["antifraude", "Cancelado por Autorização Antifraude"],
    ["inconsistencia", "Cancelado por inconsistência"], ["recusaExterna", "Cancelado por recusa de autorização Externa"],
    ["prazoAnalisePagamento", "Cancelado por prazo da análise do pagamento excedido"], ["outros", "Outros motivos de cancelamento"],
  ] as const;
  const fiscalSituations = [
    ["disp faturamento", "Disp. Faturamento"], ["nao faturado", "Não Faturado"],
    ["nf cancelada", "NF Cancelada"], ["nf emitida", "NF Emitida"],
  ] as const;
  const importFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true); setUploadError("");
    try {
      const response = await fetch(`${API}/api/orders/upload`, { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", "X-File-Name": file.name }, body: await file.arrayBuffer() });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Não foi possível importar o arquivo.");
      await onImported();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Falha ao importar a planilha.");
    } finally {
      setUploading(false); event.target.value = "";
    }
  };
  if (!orders || orders.error || !orders.stores.length) return <><section className="page-head"><div><span className="eyebrow">Pedidos</span><h1>Indicadores de pedidos</h1><p>Importe a planilha atualizada para preencher automaticamente este menu.</p>{(uploadError || orders?.error) && <p className="error-text">{uploadError || orders?.error}</p>}</div><label className="refresh upload-button"><input type="file" accept=".xlsx,.xls,.csv" onChange={importFile} disabled={uploading} />{uploading ? "Importando…" : "Importar planilha"}</label></section><section className="kpi-grid order-kpi-grid">{fields.map((label) => <article className="kpi-card order-kpi" key={label}><span className="kpi-label">{label}</span><strong>—</strong><span className="kpi-meta">Aguardando importação</span></article>)}</section></>;

  const periodStart = orders.period.start?.slice(0, 10) || "";
  const periodEnd = orders.period.end?.slice(0, 10) || "";
  const cyclePeriod = cycle ? CYCLE_PERIODS[cycle] : null;
  // O ciclo usa exatamente o mesmo período do filtro global. Datas manuais,
  // quando combinadas com o ciclo, estreitam o intervalo (interseção).
  const filterStart = [startDate, cyclePeriod?.start].filter(Boolean).sort().at(-1) || "";
  const filterEnd = [endDate, cyclePeriod?.end].filter(Boolean).sort().at(0) || "";
  const outsidePeriod = Boolean((filterStart && periodEnd && filterStart > periodEnd) || (filterEnd && periodStart && filterEnd < periodStart) || (filterStart && filterEnd && filterStart > filterEnd));
  const inRange = (date: string) => (!filterStart || date >= filterStart) && (!filterEnd || date <= filterEnd);
  const selectedDaily = !outsidePeriod && orders.daily?.length
    ? orders.daily.filter((item) => inRange(item.date) && (!selectedStore || item.store === selectedStore))
    : [];
  // Sem filtro de data, o resumo deve usar o agregado por loja persistido.
  // A série diária é usada somente quando o usuário escolhe um intervalo.
  const useDailyRows = Boolean(orders.daily?.length && (filterStart || filterEnd));
  const rows = useDailyRows
    ? [...selectedDaily.reduce((map, item) => {
        const current = map.get(item.storeCode) || { ...item, total: 0, retirada: 0, entrega: 0, revendedor: 0, omni: 0, retiradaCancelados: 0, entregaCancelados: 0, itens: 0 };
        current.total += item.total; current.retirada += item.retirada; current.entrega += item.entrega; current.revendedor += item.revendedor; current.omni += item.omni; current.retiradaCancelados += item.retiradaCancelados; current.entregaCancelados += item.entregaCancelados; current.itens += item.itens;
        for (const [key, value] of Object.entries(item.revendedorCategorias || {})) current.revendedorCategorias = { ...(current.revendedorCategorias || {}), [key]: (current.revendedorCategorias?.[key] || 0) + Number(value) };
        for (const [key, value] of Object.entries(item.cancelamentoMotivos || {})) { const pair = value as [number, number]; const prev = current.cancelamentoMotivos?.[key] || [0, 0]; current.cancelamentoMotivos = { ...(current.cancelamentoMotivos || {}), [key]: [prev[0] + pair[0], prev[1] + pair[1]] }; }
        for (const [key, value] of Object.entries(item.cancelamentoFiscal || {})) { const pair = value as [number, number]; const prev = current.cancelamentoFiscal?.[key] || [0, 0]; current.cancelamentoFiscal = { ...(current.cancelamentoFiscal || {}), [key]: [prev[0] + pair[0], prev[1] + pair[1]] }; }
        map.set(item.storeCode, current); return map;
      }, new Map<string, any>()).values()].map((item) => ({ ...item, pctEntrega: item.total ? item.entrega / item.total : 0, pctRetirada: item.total ? item.retirada / item.total : 0 }))
    : (outsidePeriod ? [] : (selectedStore ? orders.stores.filter((item) => item.store === selectedStore) : orders.stores));
  const totals = rows.reduce((a, r) => ({ total: a.total + r.total, retirada: a.retirada + r.retirada, entrega: a.entrega + r.entrega, revendedor: a.revendedor + r.revendedor, omni: a.omni + r.omni, retiradaCancelados: a.retiradaCancelados + r.retiradaCancelados, entregaCancelados: a.entregaCancelados + r.entregaCancelados, itens: a.itens + r.itens }), { total: 0, retirada: 0, entrega: 0, revendedor: 0, omni: 0, retiradaCancelados: 0, entregaCancelados: 0, itens: 0 });
  const resellerBreakdown = resellerCategories.map(([key, label]) => ({
    key, label, value: rows.reduce((sum, row) => sum + (row.revendedorCategorias?.[key] || 0), 0),
  }));
  const cancellationBreakdown = cancellationReasons.map(([key, label]) => {
    const entrega = rows.reduce((sum, row) => sum + (row.cancelamentoMotivos?.[key]?.[0] || 0), 0);
    const retirada = rows.reduce((sum, row) => sum + (row.cancelamentoMotivos?.[key]?.[1] || 0), 0);
    return { key, label, entrega, retirada, total: entrega + retirada };
  }).filter((reason) => reason.total > 0).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, "pt-BR"));
  const cancellationReasonTotal = cancellationBreakdown.reduce((sum, reason) => sum + reason.total, 0);
  const fiscalBreakdown = fiscalSituations.map(([key, label]) => {
    const entrega = rows.reduce((sum, row) => sum + (row.cancelamentoFiscal?.[key]?.[0] || 0), 0);
    const retirada = rows.reduce((sum, row) => sum + (row.cancelamentoFiscal?.[key]?.[1] || 0), 0);
    return { key, label, entrega, retirada, total: entrega + retirada };
  }).sort((a, b) => b.total - a.total || a.label.localeCompare(b.label, "pt-BR"));
  const fiscalTotal = fiscalBreakdown.reduce((sum, item) => sum + item.total, 0);
  const days = Math.max(1, orders.daily?.length && (filterStart || filterEnd) ? new Set(selectedDaily.map((item) => item.date)).size : orders.period.days);
  const scope = selectedStore || "Todas as lojas";
  const orderTotal = totals.retirada + totals.entrega;
  // Os dados legados podem conter meios pedidos nas séries diárias. Para a
  // apresentação, arredondamos uma parte e calculamos a outra pelo total,
  // evitando que a soma visual dos cards fique diferente do total.
  const displayOrderTotal = Math.round(orderTotal);
  const displayRetirada = Math.round(totals.retirada);
  const displayEntrega = displayOrderTotal - displayRetirada;
  const MetricCard = ({ title, value, average, share }: { title: string; value: number; average: number; share?: number }) => <article className="order-group-card"><h3>{title}</h3><strong>{integer.format(value)}</strong><div className="order-card-stats compact">{share != null && <span><small>Participação no total</small><b>{percent.format(share)}</b></span>}<span><small>Média por dia</small><b>{average.toLocaleString("pt-BR", { maximumFractionDigits: 1 })}</b></span></div><p>{scope}</p></article>;

  return <>
    <section className="page-head"><div><span className="eyebrow">Pedidos</span><h1>Indicadores de pedidos</h1>{orders.source.lastImportAt && <p>Última importação: {new Date(orders.source.lastImportAt).toLocaleString("pt-BR")}</p>}</div><label className="refresh upload-button"><input type="file" accept=".xlsx,.xls,.csv" onChange={importFile} disabled={uploading} />{uploading ? "Importando…" : "Importar planilha"}</label></section>
    <section className="order-section"><h2>Tipo de entrega</h2><div className="order-groups order-three"><MetricCard title="Pedidos de retirada" value={displayRetirada} share={orderTotal ? totals.retirada / orderTotal : 0} average={displayRetirada / days} /><MetricCard title="Pedidos de entrega" value={displayEntrega} share={orderTotal ? totals.entrega / orderTotal : 0} average={displayEntrega / days} /><article className="order-group-card order-total-card"><h3>Total de pedidos</h3><strong>{integer.format(displayOrderTotal)}</strong><div className="order-card-stats compact"><span><small>Média por dia</small><b>{(displayOrderTotal / days).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}</b></span></div><p>Retirada + entrega, sem cancelados · {scope}</p></article></div></section>
    <section className="order-section"><h2>Perfil do pedido</h2><div className="order-groups profile-groups"><article className="order-group-card omni-card"><h3>Pedidos de OMNI</h3><strong>{integer.format(totals.omni)}</strong><div className="order-card-stats compact"><span><small>Participação no total</small><b>{percent.format(orderTotal ? totals.omni / orderTotal : 0)}</b></span><span><small>Média por dia</small><b>{(totals.omni / days).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}</b></span></div><div className="items-inline"><h4>Itens</h4><strong>{integer.format(totals.itens)}</strong><div className="order-card-stats compact"><span><small>Média por loja</small><b>{(totals.itens / Math.max(1, rows.length)).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}</b></span><span><small>Média por dia</small><b>{(totals.itens / days).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}</b></span></div></div><p>{scope}</p></article><article className="order-group-card reseller-card"><h3>Pedidos de revendedor</h3><strong>{integer.format(totals.revendedor)}</strong><div className="order-card-stats compact"><span><small>Participação no total</small><b>{percent.format(orderTotal ? totals.revendedor / orderTotal : 0)}</b></span><span><small>Média por dia</small><b>{(totals.revendedor / days).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}</b></span></div><div className="reseller-breakdown"><h4>Participação por categoria</h4><div>{resellerBreakdown.map((category) => <span key={category.key}><small>{category.label}</small><b>{integer.format(category.value)}</b><em>{percent.format(totals.revendedor ? category.value / totals.revendedor : 0)}</em></span>)}</div></div><p>{scope}</p></article></div></section>
    <section className="order-section"><article className="order-group-card cancellation-card"><h3>Pedidos cancelados</h3><div className="order-card-stats cancellation-summary"><span><small>Entrega</small><b>{integer.format(totals.entregaCancelados)}</b></span><span><small>Retirada</small><b>{integer.format(totals.retiradaCancelados)}</b></span><span><small>Total</small><b>{integer.format(totals.retiradaCancelados + totals.entregaCancelados)}</b></span></div><div className="cancellation-breakdown"><div className="breakdown-head"><h4>Detalhamento por motivo</h4><strong>{integer.format(cancellationReasonTotal)} cancelados</strong></div><div className="cancellation-table"><div className="cancellation-row header"><span>Motivo</span><span>Resultado</span><span>Participação do total</span></div>{cancellationBreakdown.map((reason) => <div className="cancellation-row" key={reason.key}><strong>{reason.label}</strong><b>{integer.format(reason.total)}</b><em>{percent.format(cancellationReasonTotal ? reason.total / cancellationReasonTotal : 0)}</em></div>)}</div></div><div className="fiscal-breakdown"><div className="breakdown-head"><h4>Situação fiscal dos pedidos cancelados</h4><strong>{integer.format(fiscalTotal)} pedidos</strong></div><div className="cancellation-table fiscal-table"><div className="cancellation-row header"><span>Situação fiscal</span><span>Resultado</span><span>Participação do total</span></div>{fiscalBreakdown.map((item) => <div className="cancellation-row" key={item.key}><strong>{item.label}</strong><b>{integer.format(item.total)}</b><em>{percent.format(fiscalTotal ? item.total / fiscalTotal : 0)}</em></div>)}</div></div><p>{scope}</p></article></section>
    <section className="panel orders-results-panel"><div className="section-title"><div><h2>Resultados por loja</h2><p>Comparativo detalhado, ordenado pelo total de pedidos.</p></div><span className="table-hint">Deslize para ver todas as colunas</span></div><div className="table-wrap orders-table-wrap"><table className="orders-table"><thead><tr className="group-row"><th rowSpan={2}>Loja / código</th><th colSpan={5}>Pedidos por canal</th><th colSpan={2}>Participação</th><th colSpan={2}>Cancelados</th><th rowSpan={2}>Itens</th></tr><tr><th>Total</th><th>Retirada</th><th>Entrega</th><th>Revendedor</th><th>OMNI</th><th>% entrega</th><th>% retirada</th><th>Retirada</th><th>Entrega</th></tr></thead><tbody>{rows.filter((r) => r.storeCode !== "21732").map((r) => <tr key={r.store}><th className="store-cell"><strong>{r.store}</strong><small>{r.storeCode || "—"}</small></th><td className="emphasis-cell">{integer.format(r.total)}</td><td>{integer.format(r.retirada)}</td><td>{integer.format(r.entrega)}</td><td>{integer.format(r.revendedor)}</td><td>{integer.format(r.omni)}</td><td className="percent-cell">{percent.format(r.pctEntrega)}</td><td className="percent-cell">{percent.format(r.pctRetirada)}</td><td>{integer.format(r.retiradaCancelados)}</td><td>{integer.format(r.entregaCancelados)}</td><td>{integer.format(r.itens)}</td></tr>)}</tbody></table></div></section>
  </>;
}

function OrderRecurrenceView({ data, records, loading, error, selectedStore, cycle, startDate, endDate }: { data: DashboardData; records: OrderRecord[]; loading: boolean; error: string; selectedStore: string; cycle: string; startDate: string; endDate: string }) {
  const [city, setCity] = useState("");
  const [name, setName] = useState("");
  const [countOrder, setCountOrder] = useState<"desc" | "asc">("desc");
  const [valueOrder, setValueOrder] = useState<"none" | "desc" | "asc">("none");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const pageSize = 100;
  const cities = useMemo(() => [...new Set(records.map((item) => item.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, "pt-BR")), [records]);
  const cyclePeriod = cycle ? CYCLE_PERIODS[cycle] : null;
  const effectiveStart = [startDate, cyclePeriod?.start].filter(Boolean).sort().at(-1) || "";
  const effectiveEnd = [endDate, cyclePeriod?.end].filter(Boolean).sort().at(0) || "";
  const inRange = (date: string | null) => (!effectiveStart || Boolean(date) && date! >= effectiveStart) && (!effectiveEnd || Boolean(date) && date! <= effectiveEnd);
  const filtered = useMemo(() => records.filter((item) => !item.canceled && (!selectedStore || item.store === selectedStore) && (!cycle || (item.cycle != null ? String(item.cycle) === cycle : inRange(item.date))) && inRange(item.date) && (!city || item.city === city) && (!name || normalizeText(item.reseller).includes(normalizeText(name)))), [records, selectedStore, cycle, effectiveStart, effectiveEnd, city, name]);
  const ranking = useMemo(() => {
    const groups = new Map<string, { reseller: string; channel: string; role: string; city: string; totalValue: number; count: number; orders: OrderRecord[] }>();
    for (const item of filtered) {
      const current = groups.get(item.reseller) || { reseller: item.reseller, channel: item.channel || "—", role: item.role || "—", city: item.city || "—", totalValue: 0, count: 0, orders: [] };
      current.totalValue += Number(item.value || 0); current.count += 1; current.orders.push(item); groups.set(item.reseller, current);
    }
    return [...groups.values()].sort((a, b) => {
      if (valueOrder !== "none") return valueOrder === "desc" ? b.totalValue - a.totalValue || b.count - a.count : a.totalValue - b.totalValue || a.count - b.count;
      return countOrder === "desc" ? b.count - a.count || b.totalValue - a.totalValue : a.count - b.count || a.totalValue - b.totalValue;
    });
  }, [filtered, countOrder, valueOrder]);
  const visibleRanking = ranking.slice(page * pageSize, (page + 1) * pageSize);
  const pageCount = Math.max(1, Math.ceil(ranking.length / pageSize));
  useEffect(() => { setPage(0); setExpanded(null); }, [selectedStore, cycle, startDate, endDate, city, name, countOrder, valueOrder]);
  const totalValue = filtered.reduce((sum, item) => sum + Number(item.value || 0), 0);
  const period = effectiveStart || effectiveEnd ? `${formatDay(effectiveStart) || "início"} a ${formatDay(effectiveEnd) || "fim"}` : "Toda a planilha acumulada";
  return <>
    <section className="page-head"><div><span className="eyebrow">Pedidos</span><h1>Recorrência de pedidos</h1><p>Ranking de revendedores no período selecionado. Cada importação semanal é somada ao histórico anterior.</p></div><span className="data-chip">{cycle ? `Ciclo ${cycle} · ` : ""}{selectedStore || "Todas as lojas"} · {period}</span></section>
    <section className="panel recurrence-filters"><div className="section-title"><div><h2>Filtros da recorrência</h2><p>Sem filtro de data, o ranking considera toda a planilha acumulada.</p></div><span className="table-hint">Cancelados não entram na contagem</span></div><div className="recurrence-filter-grid"><label>Revendedor<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Buscar por nome" /></label><label>Cidade<select value={city} onChange={(event) => setCity(event.target.value)}><option value="">Todas as cidades</option>{cities.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>Pedidos<select value={countOrder} onChange={(event) => setCountOrder(event.target.value as "desc" | "asc")}><option value="desc">Mais pedidos primeiro</option><option value="asc">Menos pedidos primeiro</option></select></label><label>Valor gasto<select value={valueOrder} onChange={(event) => setValueOrder(event.target.value as "none" | "desc" | "asc")}><option value="none">Sem ordenar por valor</option><option value="desc">Mais caro primeiro</option><option value="asc">Mais barato primeiro</option></select></label></div></section>
    <section className="summary-grid three recurrence-summary"><article><span>Pessoas no ranking</span><strong>{integer.format(ranking.length)}</strong><small>Após filtros</small></article><article><span>Pedidos no período</span><strong>{integer.format(filtered.length)}</strong><small>Importações acumuladas</small></article><article><span>Valor total</span><strong>{totalValue.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</strong><small>Pedidos não cancelados</small></article></section>
    <section className="panel recurrence-panel"><div className="section-title"><div><h2>Ranking de recorrência</h2><p>Selecione uma pessoa para abrir os pedidos individualmente.</p></div><span className="table-hint">{loading ? "Carregando pedidos…" : `${integer.format(ranking.length)} resultados`}</span></div>{loading ? <div className="recurrence-empty"><RefreshCw className="spin" size={24} /><strong>Carregando pedidos detalhados</strong><p>A planilha foi importada; preparando o ranking.</p></div> : error ? <div className="recurrence-empty"><Database size={24} /><strong>Não foi possível carregar os pedidos</strong><p>{error}</p></div> : !records.length ? <div className="recurrence-empty"><Users size={24} /><strong>Importe a primeira planilha semanal</strong><p>Quando a planilha de pedidos for importada, os novos registros serão adicionados ao histórico e aparecerão neste ranking.</p></div> : !ranking.length ? <p className="muted">Nenhum pedido encontrado para os filtros selecionados.</p> : <><div className="table-wrap recurrence-table-wrap"><table className="recurrence-table"><thead><tr><th>Revendedor</th><th>Canal de distribuição</th><th>Papel</th><th>Cidade</th><th>Total gasto</th><th>Pedidos</th><th aria-label="Detalhes" /></tr></thead><tbody>{visibleRanking.map((person) => <><tr key={person.reseller} className={expanded === person.reseller ? "is-expanded" : ""} onClick={() => setExpanded(expanded === person.reseller ? null : person.reseller)}><th><strong>{person.reseller}</strong></th><td>{person.channel}</td><td>{person.role}</td><td>{person.city}</td><td className="emphasis-cell">{person.totalValue.toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</td><td className="emphasis-cell">{integer.format(person.count)}</td><td><ChevronRight size={16} className={expanded === person.reseller ? "rotate-90" : ""} /></td></tr>{expanded === person.reseller && <tr className="recurrence-details-row"><td colSpan={7}><div className="recurrence-details"><strong>Pedidos de {person.reseller}</strong><table><thead><tr><th>Código do pedido</th><th>Data de captação</th><th>Valor</th></tr></thead><tbody>{person.orders.map((order) => <tr key={`${person.reseller}-${order.orderCode}-${order.date}`}><td>{order.orderCode}</td><td>{formatDay(order.date) || "—"}</td><td>{Number(order.value || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}</td></tr>)}</tbody></table></div></td></tr>}</>)}</tbody></table></div><div className="recurrence-pagination"><button type="button" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>Anterior</button><span>Página {page + 1} de {pageCount}</span><button type="button" disabled={page >= pageCount - 1} onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}>Próxima</button></div></>}</section>
  </>;
}
const TEMP_PASSWORD = "Sfera@2026";
type AccessUser = { id: string; name: string; email: string; phone?: string; company?: string; accountType: "admin" | "unit"; stores: string[]; password?: string; mustChangePassword?: boolean; resetNotice?: string; status: "pending" | "approved" | "rejected" | "inactive"; requestedAt?: string; active: boolean };
type PasswordResetRequest = { id: string; userId: string; name: string; email: string; requestedAt: string; status: "pending" | "approved" | "rejected" };

function AuthScreen({ users, onUsersChange, resetRequests, onResetRequestsChange, onLogin }: { users: AccessUser[]; onUsersChange: (users: AccessUser[]) => void; resetRequests: PasswordResetRequest[]; onResetRequestsChange: (requests: PasswordResetRequest[]) => void; onLogin: (user: AccessUser) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [message, setMessage] = useState("");
  const [form, setForm] = useState({ name: "", email: "", phone: "", company: "", store: "", password: "", confirm: "" });
  const update = (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [key]: event.target.value }));
  const submit = (event: React.FormEvent) => {
    event.preventDefault(); setMessage("");
    if (mode === "login") {
      const user = users.find((item) => item.email.toLowerCase() === form.email.trim().toLowerCase());
      if (user?.resetNotice) return setMessage(user.resetNotice);
      if (!user || user.password !== form.password) return setMessage("E-mail ou senha inválidos.");
      if (user.status === "pending") return setMessage("Seu cadastro ainda está aguardando aprovação do administrador.");
      if (user.status === "rejected") return setMessage("Seu acesso à Sfera não foi aprovado. Entre em contato com o administrador responsável.");
      if (user.status === "inactive") return setMessage("Seu acesso está inativo. Entre em contato com um administrador.");
      return onLogin(user);
    }
    if (!form.name || !form.email || !form.company || !form.store || form.password.length < 6) return setMessage("Preencha todos os campos obrigatórios. A senha deve ter pelo menos 6 caracteres.");
    if (form.password !== form.confirm) return setMessage("As senhas não coincidem.");
    if (users.some((item) => item.email.toLowerCase() === form.email.trim().toLowerCase())) return setMessage("Este e-mail já possui um cadastro.");
    const user: AccessUser = { id: `${Date.now()}`, name: form.name.trim(), email: form.email.trim(), phone: form.phone.trim(), company: form.company.trim(), accountType: "unit", stores: [form.store], password: form.password, status: "pending", requestedAt: new Date().toISOString(), active: true };
    onUsersChange([...users, user]); setMessage("Cadastro realizado com sucesso! Seu acesso à Sfera está aguardando aprovação de um administrador. Assim que sua conta for aprovada, você poderá acessar a plataforma."); setMode("login");
  };
  const requestReset = () => {
    const email = form.email.trim().toLowerCase();
    const user = users.find((item) => item.email.toLowerCase() === email);
    if (!email || !user) return setMessage("Informe um e-mail cadastrado para solicitar a redefinição.");
    if (user.status !== "approved") return setMessage("A redefinição só pode ser solicitada por usuários aprovados.");
    if (resetRequests.some((item) => item.userId === user.id && item.status === "pending")) return setMessage("Já existe uma solicitação aguardando aprovação do administrador.");
    onResetRequestsChange([...resetRequests, { id: `${Date.now()}`, userId: user.id, name: user.name, email: user.email, requestedAt: new Date().toISOString(), status: "pending" }]);
    setMessage("Solicitação enviada ao administrador. Aguarde a aprovação para receber a senha temporária novamente.");
  };
  return <main className="auth-shell"><section className="auth-card"><div className="auth-brand"><img src="/dashboard-logo.png" alt="Sfera Operações" /></div>{mode === "login" ? <><p className="eyebrow">Plataforma de Logística</p><h1>Bem-vindo à Sfera</h1><p className="auth-subtitle">Acesse sua operação e acompanhe o desempenho das unidades.</p></> : <><p className="eyebrow">Novo acesso</p><h1>Criar uma conta</h1><p className="auth-subtitle">Seu cadastro será analisado por um administrador.</p></>}<form className="auth-form" onSubmit={submit}>{mode === "register" && <><label>Nome completo<input value={form.name} onChange={update("name")} required /></label><label>Telefone<input value={form.phone} onChange={update("phone")} /></label><label>Empresa<input value={form.company} onChange={update("company")} required /></label><label>Loja/Unidade<input value={form.store} onChange={update("store")} placeholder="Nome ou código da unidade" required /></label></>}<label>E-mail{mode === "register" && <small>E-mail corporativo</small>}<input type="email" value={form.email} onChange={update("email")} required /></label><label>Senha<input type="password" value={form.password} onChange={update("password")} required /></label>{mode === "register" && <label>Confirmação de senha<input type="password" value={form.confirm} onChange={update("confirm")} required /></label>}<button className="primary-button" type="submit">{mode === "login" ? "Entrar" : "Enviar cadastro"}</button></form>{message && <p className="auth-message">{message}</p>}{mode === "login" ? <div className="auth-links"><button onClick={requestReset}>Esqueci minha senha</button><button onClick={() => { setMode("register"); setMessage(""); }}>Criar uma conta</button></div> : <button className="auth-back" onClick={() => { setMode("login"); setMessage(""); }}>Voltar para o login</button>}<small className="auth-note">Em caso de dúvidas, entrar em contato com: carlos.saraiva@sferamultifranquias.com</small></section></main>;
}

function PasswordChangeScreen({ user, users, onUsersChange, onComplete }: { user: AccessUser; users: AccessUser[]; onUsersChange: (users: AccessUser[]) => void; onComplete: (user: AccessUser) => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (password.length < 6) return setMessage("A nova senha deve ter pelo menos 6 caracteres.");
    if (password !== confirm) return setMessage("As senhas não coincidem.");
    const updated = { ...user, password, mustChangePassword: false };
    onUsersChange(users.map((item) => item.id === user.id ? updated : item));
    onComplete(updated);
  };
  return <main className="auth-shell"><section className="auth-card"><div className="auth-brand"><span>S</span><strong>Sfera</strong></div><p className="eyebrow">Primeiro acesso</p><h1>Defina sua senha</h1><p className="auth-subtitle">Por segurança, troque a senha temporária antes de continuar.</p><form className="auth-form" onSubmit={submit}><label>Nova senha<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={6} required autoFocus /></label><label>Confirmação de senha<input type="password" value={confirm} onChange={(event) => setConfirm(event.target.value)} minLength={6} required /></label><button className="primary-button" type="submit">Salvar nova senha</button></form>{message && <p className="auth-message">{message}</p>}<small className="auth-note">Em caso de dúvidas, entrar em contato com: carlos.saraiva@sferamultifranquias.com</small></section></main>;
}

function ProfileView({ user, stores }: { user: AccessUser; stores: Array<{ store: string; storeCode: string | null }> }) {
  const allowedStores = user.accountType === "admin" ? stores : stores.filter((item) => user.stores.includes(item.store));
  const statusLabel = { pending: "Aguardando aprovação", approved: "Aprovado", rejected: "Recusado", inactive: "Inativo" }[user.status];
  return <><section className="page-head"><div><span className="eyebrow">Conta</span><h1>Meu perfil</h1><p>Confira suas informações cadastrais e permissões de acesso.</p></div><UserCircle size={34} /></section><section className="profile-grid"><article className="panel profile-card"><div className="profile-avatar">{user.name.trim().charAt(0).toUpperCase()}</div><div><h2>{user.name}</h2><p>{user.email}</p><span className={`access-status ${user.status}`}>{statusLabel}</span></div></article><article className="panel profile-details"><h2>Informações cadastrais</h2><dl><div><dt>Nome completo</dt><dd>{user.name}</dd></div><div><dt>E-mail</dt><dd>{user.email}</dd></div><div><dt>Telefone</dt><dd>{user.phone || "Não informado"}</dd></div><div><dt>Empresa</dt><dd>{user.company || "Não informado"}</dd></div><div><dt>Tipo de conta</dt><dd>{user.accountType === "admin" ? "Administrador" : "Usuário da Unidade"}</dd></div><div><dt>Cadastro realizado em</dt><dd>{user.requestedAt ? new Date(user.requestedAt).toLocaleString("pt-BR") : "Não informado"}</dd></div></dl></article><article className="panel profile-stores"><h2>Lojas/unidades com acesso</h2>{user.accountType === "admin" ? <p className="profile-all-stores">Administrador: acesso a todas as lojas.</p> : allowedStores.length ? <div className="profile-store-list">{allowedStores.map((item) => <div key={item.store}><strong>{item.store}</strong><small>Código {item.storeCode || "—"}</small></div>)}</div> : <p className="muted">Nenhuma loja vinculada.</p>}</article></section></>;
}

function CadastroView({
  stores, users, onUsersChange, resetRequests, onResetRequestsChange, onViewStore,
}: {
  stores: Array<{ store: string; storeCode: string | null }>;
  users: AccessUser[];
  onUsersChange: (users: AccessUser[]) => void;
  resetRequests: PasswordResetRequest[];
  onResetRequestsChange: (requests: PasswordResetRequest[]) => void;
  onViewStore: (store: string) => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [accountType, setAccountType] = useState<AccessUser["accountType"]>("unit");
  const [selectedStores, setSelectedStores] = useState<string[]>(stores[0] ? [stores[0].store] : []);
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editType, setEditType] = useState<AccessUser["accountType"]>("unit");
  const [editStatus, setEditStatus] = useState<AccessUser["status"]>("approved");
  const [userFilters, setUserFilters] = useState({ name: "", email: "", type: "", pdv: "", status: "" });
  const normalizedSearch = normalizeText(search);
  const filteredStores = stores.filter((item) => !normalizedSearch || normalizeText(`${item.store} ${item.storeCode}`).includes(normalizedSearch));
  const visibleUsers = users.filter((user) => {
    const type = user.accountType === "admin" ? "Administrador" : "Usuário da Unidade";
    const status = { pending: "Aguardando aprovação", approved: "Aprovado", rejected: "Recusado", inactive: "Inativo" }[user.status];
    const pdvText = user.accountType === "admin" ? "todas as lojas" : user.stores.join(" ");
    return (!userFilters.name || normalizeText(user.name).includes(normalizeText(userFilters.name))) && (!userFilters.email || normalizeText(user.email).includes(normalizeText(userFilters.email))) && (!userFilters.type || type === userFilters.type) && (!userFilters.pdv || normalizeText(pdvText).includes(normalizeText(userFilters.pdv))) && (!userFilters.status || status === userFilters.status);
  });
  const addUser = (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !email.trim() || (accountType === "unit" && !selectedStores.length)) return;
    const next = [...users, { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, name: name.trim(), email: email.trim(), accountType, stores: accountType === "admin" ? [] : selectedStores, password: TEMP_PASSWORD, mustChangePassword: true, status: "approved" as const, active: true }];
    onUsersChange(next); setName(""); setEmail(""); setShowForm(false);
  };
  const removeUser = (id: string) => onUsersChange(users.filter((user) => user.id !== id));
  const updateUserStores = (userId: string, store: string, checked: boolean) => onUsersChange(users.map((user) => user.id !== userId || user.accountType === "admin" ? user : { ...user, stores: checked ? [...new Set([...user.stores, store])] : user.stores.filter((item) => item !== store) }));
  const openUserEditor = (user: AccessUser) => { setEditingUserId(user.id); setEditName(user.name); setEditEmail(user.email); setEditType(user.accountType); setEditStatus(user.status); };
  const saveUserEditor = () => { if (!editingUserId || !editName.trim() || !editEmail.trim()) return; onUsersChange(users.map((user) => user.id === editingUserId ? { ...user, name: editName.trim(), email: editEmail.trim(), accountType: editType, status: editStatus, active: editStatus === "approved", stores: editType === "admin" ? [] : user.stores } : user)); setEditingUserId(null); };
  const updateResetRequest = (request: PasswordResetRequest, status: PasswordResetRequest["status"]) => {
    onResetRequestsChange(resetRequests.map((item) => item.id === request.id ? { ...item, status } : item));
    if (status === "approved") onUsersChange(users.map((item) => item.id === request.userId ? { ...item, password: TEMP_PASSWORD, mustChangePassword: true, resetNotice: undefined } : item));
    if (status === "rejected") onUsersChange(users.map((item) => item.id === request.userId ? { ...item, resetNotice: "Sua solicitação de redefinição de senha foi negada pelo administrador. Entre em contato com o responsável." } : item));
  };
  return <div className="cadastro-page">
    <section className="panel users-master-panel"><div className="section-title"><div><h2>Usuários cadastrados</h2><p>Aprovados e pendentes em uma única lista. Use os filtros para localizar qualquer cadastro.</p></div><Users size={20} /></div><div className="table-wrap users-master-table-wrap"><table className="cadastro-table users-master-table"><thead><tr><th><details className="column-filter"><summary>Nome ↕</summary><div className="column-filter-menu"><input value={userFilters.name} onChange={(event) => setUserFilters((current) => ({ ...current, name: event.target.value }))} placeholder="Buscar nome..." /></div></details></th><th><details className="column-filter"><summary>Usuário ↕</summary><div className="column-filter-menu"><input value={userFilters.email} onChange={(event) => setUserFilters((current) => ({ ...current, email: event.target.value }))} placeholder="Buscar usuário..." /></div></details></th><th><details className="column-filter"><summary>Perfil ↕</summary><div className="column-filter-menu"><select value={userFilters.type} onChange={(event) => setUserFilters((current) => ({ ...current, type: event.target.value }))}><option value="">Todos</option><option>Administrador</option><option>Usuário da Unidade</option></select></div></details></th><th><details className="column-filter"><summary>PDVs vinculados ⌄</summary><div className="column-filter-menu"><input value={userFilters.pdv} onChange={(event) => setUserFilters((current) => ({ ...current, pdv: event.target.value }))} placeholder="Buscar PDV..." /></div></details></th><th><details className="column-filter"><summary>Status ↕</summary><div className="column-filter-menu"><select value={userFilters.status} onChange={(event) => setUserFilters((current) => ({ ...current, status: event.target.value }))}><option value="">Todos</option><option>Aguardando aprovação</option><option>Aprovado</option><option>Recusado</option><option>Inativo</option></select></div></details></th><th>AÇÕES</th></tr></thead><tbody>{visibleUsers.map((user) => { const statusLabel = { pending: "Aguardando aprovação", approved: "Aprovado", rejected: "Recusado", inactive: "Inativo" }[user.status]; const updateStatus = (status: AccessUser["status"]) => onUsersChange(users.map((item) => item.id === user.id ? { ...item, status, active: status === "approved" } : item)); return <tr key={user.id}><th>{user.name}</th><td>{user.email}</td><td>{user.accountType === "admin" ? "Administrador" : "Usuário da Unidade"}</td><td>{user.accountType === "admin" ? "Todas as lojas" : `${user.stores.length} loja${user.stores.length === 1 ? "" : "s"}`}</td><td><span className={`access-status ${user.status}`}>{statusLabel}</span></td><td><button type="button" className="table-action" onClick={() => setEditingUserId(editingUserId === user.id ? null : user.id)}>{editingUserId === user.id ? "Fechar PDVs" : "Ver/editar PDVs"}</button>{user.status === "pending" && <button type="button" className="table-action" onClick={() => updateStatus("approved")}>Aprovar</button>}<button type="button" className="table-action danger" onClick={() => removeUser(user.id)}>Remover</button></td></tr>; })}</tbody></table>{!visibleUsers.length && <p className="muted cadastro-empty">Nenhum usuário encontrado.</p>}</div></section>
    <section className="panel user-directory-panel"><div className="section-title"><div><h2>Lista de usuários</h2><p>Consulte os dados de cada pessoa e gerencie as unidades permitidas.</p></div><Users size={20} /></div><div className="user-directory-list">{users.map((user) => { const selected = editingUserId === user.id; const statusLabel = { pending: "Aguardando aprovação", approved: "Aprovado", rejected: "Recusado", inactive: "Inativo" }[user.status]; const allowed = user.accountType === "admin" ? "Todas as lojas" : `${user.stores.length} loja${user.stores.length === 1 ? "" : "s"}`; return <div className="user-directory-row" key={user.id}><div><strong>{user.name}</strong><small>{user.email}</small></div><div className="user-directory-meta"><span>{user.accountType === "admin" ? "Administrador" : "Usuário da Unidade"}</span><span>{allowed}</span><span className={`access-status ${user.status}`}>{statusLabel}</span><button type="button" className="table-action" onClick={() => setEditingUserId(selected ? null : user.id)}>{selected ? "Fechar PDVs" : "Ver/editar PDVs"}</button></div></div>; })}{!users.length && <p className="muted cadastro-empty">Nenhum usuário cadastrado ainda.</p>}</div></section>
    {editingUserId && (() => { const user = users.find((item) => item.id === editingUserId); if (!user) return null; return <section className="panel user-edit-modal"><div className="section-title"><div><h2>Editar usuário</h2><p>Atualize as informações cadastrais e permissões.</p></div><button type="button" className="table-action icon-action" aria-label="Fechar editor" onClick={() => setEditingUserId(null)}>×</button></div><div className="user-edit-form"><label>Nome<input value={editName} onChange={(event) => setEditName(event.target.value)} /></label><label>Usuário / e-mail<input value={editEmail} onChange={(event) => setEditEmail(event.target.value)} /></label><label>Perfil<select value={editType} onChange={(event) => setEditType(event.target.value as AccessUser["accountType"])}><option value="admin">Administrador</option><option value="unit">Usuário da Unidade</option></select></label><label>Status<select value={editStatus} onChange={(event) => setEditStatus(event.target.value as AccessUser["status"])}><option value="approved">Aprovado</option><option value="pending">Aguardando aprovação</option><option value="rejected">Recusado</option><option value="inactive">Inativo</option></select></label></div>{editType === "admin" ? <p className="muted">Administrador tem acesso a todas as lojas.</p> : <div className="user-store-options">{stores.map((item) => <label key={item.store}><input type="checkbox" checked={user.stores.includes(item.store)} onChange={(event) => updateUserStores(user.id, item.store, event.target.checked)} /><span>{item.store}<small>{item.storeCode || "sem código"}</small></span></label>)}</div>}<div className="user-edit-actions"><button type="button" className="table-action" onClick={() => setEditingUserId(null)}>Cancelar</button><button type="button" className="primary-button" onClick={saveUserEditor}>Salvar</button></div></section>; })()}
    <section className="page-head"><div><span className="eyebrow">Administração</span><h1>Usuários</h1><p>Usuários cadastrados, perfis e permissões de acesso.</p></div><button className="primary-button cadastro-new-button" onClick={() => setShowForm((current) => !current)}>{showForm ? "Fechar cadastro" : "Cadastrar nova pessoa"}</button></section>
    <section className="cadastro-grid">
      {false && <article className="panel cadastro-panel"><div className="section-title"><div><h2>PDVs cadastrados</h2><p>Somente unidades já presentes na base de dados.</p></div><Store size={20} /></div><input className="cadastro-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar loja ou código" /><div className="pdv-list">{filteredStores.map((item) => { const linkedUsers = users.filter((user) => user.accountType === "admin" || user.stores.includes(item.store)); return <div className="pdv-row" key={item.store}><div><strong>{item.store}</strong><small>Código {item.storeCode || "—"}</small>{linkedUsers.length > 0 ? <div className="pdv-users"><small>Usuários vinculados</small>{linkedUsers.map((user) => <span key={user.id}><strong>{user.name}</strong><small>{user.email} · {user.accountType === "admin" ? "Administrador" : "Usuário da Unidade"}</small></span>)}</div> : <small className="pdv-users-empty">Nenhum usuário vinculado</small>}</div></div>; })}{!filteredStores.length && <p className="muted">Nenhum PDV encontrado.</p>}</div></article>}
      {showForm && <article className="panel cadastro-panel"><div className="section-title"><div><h2>Novo usuário</h2><p>Defina o tipo de conta e o escopo de visualização.</p></div><Users size={20} /></div><form className="cadastro-form" onSubmit={addUser}><label>Nome<input value={name} onChange={(event) => setName(event.target.value)} placeholder="Nome completo" required /></label><label>E-mail<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="usuario@empresa.com" required /></label><label>Tipo de Conta<select value={accountType} onChange={(event) => setAccountType(event.target.value as AccessUser["accountType"])}><option value="admin">Administrador</option><option value="unit">Usuário da Unidade</option></select></label>{accountType === "unit" && <fieldset className="store-selector"><legend>Lojas/unidades permitidas</legend>{stores.map((item) => <label key={item.store}><input type="checkbox" checked={selectedStores.includes(item.store)} onChange={(event) => setSelectedStores((current) => event.target.checked ? [...current, item.store] : current.filter((store) => store !== item.store))} /><span>{item.store}<small>{item.storeCode || "sem código"}</small></span></label>)}</fieldset>}<button className="primary-button" type="submit">Cadastrar usuário</button></form></article>}
    </section>
    <section className="panel cadastro-users-panel"><div className="section-title"><div><h2>Usuários e permissões</h2><p>Administradores têm acesso completo; usuários da unidade veem somente as lojas vinculadas.</p></div></div><div className="table-wrap"><table className="cadastro-table"><thead><tr><th>Usuário</th><th>Tipo de Conta</th><th>Lojas permitidas</th><th>Status</th><th>Ação</th></tr></thead><tbody>{users.map((user) => { const allowed = user.accountType === "admin" ? "Todas as lojas" : user.stores.map((store) => stores.find((item) => item.store === store)?.storeCode ? `${store} (${stores.find((item) => item.store === store)?.storeCode})` : store).join(", "); const statusLabel = { pending: "Aguardando aprovação", approved: "Aprovado", rejected: "Recusado", inactive: "Inativo" }[user.status]; const updateStatus = (status: AccessUser["status"]) => onUsersChange(users.map((item) => item.id === user.id ? { ...item, status, active: status === "approved" } : item)); return <tr key={user.id}><th><strong>{user.name}</strong><small>{user.email}</small></th><td>{user.accountType === "admin" ? "Administrador" : "Usuário da Unidade"}</td><td>{allowed || "—"}</td><td><span className={`access-status ${user.status}`}>{statusLabel}</span></td><td>{user.status === "pending" && <><button className="table-action" onClick={() => updateStatus("approved")}>Aprovar</button><button className="table-action danger" onClick={() => updateStatus("rejected")}>Recusar</button></>}{user.accountType === "unit" && user.stores[0] && user.status === "approved" && <button className="table-action" onClick={() => onViewStore(user.stores[0])}>Visualizar PDV</button>}<button className="table-action danger" onClick={() => removeUser(user.id)}>Remover</button></td></tr>; })}</tbody></table>{!users.length && <p className="muted cadastro-empty">Nenhum usuário cadastrado ainda.</p>}</div></section>
    <section className="panel cadastro-reset-panel"><div className="section-title"><div><h2>Solicitações de redefinição</h2><p>Aprove ou recuse pedidos de recuperação de senha.</p></div></div><div className="table-wrap"><table className="cadastro-table"><thead><tr><th>Usuário</th><th>Data</th><th>Status</th><th>Ação</th></tr></thead><tbody>{resetRequests.map((request) => <tr key={request.id}><th><strong>{request.name}</strong><small>{request.email}</small></th><td>{new Date(request.requestedAt).toLocaleString("pt-BR")}</td><td><span className={`access-status ${request.status}`}>{request.status === "pending" ? "Aguardando aprovação" : request.status === "approved" ? "Aprovada" : "Recusada"}</span></td><td>{request.status === "pending" && <><button className="table-action" onClick={() => updateResetRequest(request, "approved")}>Aprovar</button><button className="table-action danger" onClick={() => updateResetRequest(request, "rejected")}>Recusar</button></>}</td></tr>)}</tbody></table>{!resetRequests.length && <p className="muted cadastro-empty">Nenhuma solicitação pendente.</p>}</div></section>
    <p className="cadastro-disclaimer">Os vínculos são salvos neste navegador. A autenticação real e o controle de sessão ainda precisam ser conectados ao servidor para restringir acessos de forma segura.</p>
  </div>;
}

export default function Home() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [recurrenceRecords, setRecurrenceRecords] = useState<OrderRecord[]>([]);
  const [recurrenceLoading, setRecurrenceLoading] = useState(false);
  const [recurrenceError, setRecurrenceError] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [view, setView] = useState("overview");
  const [menuOpen, setMenuOpen] = useState(false);
  const [store, setStore] = useState("");
  const [cycle, setCycle] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [indicatorFilter, setIndicatorFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [activeIndicator, setActiveIndicator] = useState("");
  const [activeStore, setActiveStore] = useState("");
  const [accessUsers, setAccessUsers] = useState<AccessUser[]>([]);
  const [resetRequests, setResetRequests] = useState<PasswordResetRequest[]>([]);
  const [sessionUserId, setSessionUserId] = useState("");
  const [authReady, setAuthReady] = useState(false);
  const [overviewRotation, setOverviewRotation] = useState(0);
  const [rotationPulse, setRotationPulse] = useState(false);
  const lastOverviewInteraction = useRef(Date.now());

  useEffect(() => {
    if (view !== "overview") return;
    const markInteraction = () => { lastOverviewInteraction.current = Date.now(); };
    const events = ["pointerdown", "keydown", "scroll", "touchstart"] as const;
    events.forEach((event) => window.addEventListener(event, markInteraction, { passive: true }));
    const timer = window.setInterval(() => {
      if (Date.now() - lastOverviewInteraction.current < 10000) return;
      setOverviewRotation((current) => current + 1);
      setRotationPulse(true);
      window.setTimeout(() => setRotationPulse(false), 650);
      lastOverviewInteraction.current = Date.now();
    }, 1000);
    return () => { window.clearInterval(timer); events.forEach((event) => window.removeEventListener(event, markInteraction)); };
  }, [view]);

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem("operacoes-access-users");
      if (saved) {
        const resetKey = "sfera-password-reset-2026-09-v3";
        const shouldReset = !window.localStorage.getItem(resetKey);
        const normalized = (JSON.parse(saved) as Array<Partial<AccessUser> & { store?: string }>).map((user) => ({
          id: user.id || `${Date.now()}-${Math.random()}`,
          name: user.name || "Usuário",
          email: user.email || "",
          accountType: user.accountType || "unit",
          stores: user.stores || (user.store ? [user.store] : []),
          password: shouldReset ? TEMP_PASSWORD : (user.password || TEMP_PASSWORD),
          mustChangePassword: shouldReset ? true : Boolean(user.mustChangePassword),
          status: user.status || "approved",
          active: user.active !== false,
        }));
        setAccessUsers(normalized);
        if (shouldReset) {
          window.localStorage.setItem("operacoes-access-users", JSON.stringify(normalized));
          window.localStorage.setItem(resetKey, "1");
        }
      }
      const session = window.localStorage.getItem("operacoes-session-user");
      if (session) setSessionUserId(session);
      const savedRequests = window.localStorage.getItem("operacoes-password-reset-requests");
      if (savedRequests) setResetRequests(JSON.parse(savedRequests) as PasswordResetRequest[]);
    } catch { /* storage indisponível */ } finally { setAuthReady(true); }
  }, []);
  const saveAccessUsers = (users: AccessUser[]) => { setAccessUsers(users); try { window.localStorage.setItem("operacoes-access-users", JSON.stringify(users)); } catch { /* storage indisponível */ } };
  const saveResetRequests = (requests: PasswordResetRequest[]) => { setResetRequests(requests); try { window.localStorage.setItem("operacoes-password-reset-requests", JSON.stringify(requests)); } catch { /* storage indisponível */ } };
  useEffect(() => { if (authReady && !accessUsers.length) { const admin: AccessUser = { id: "admin-inicial", name: "Administrador Sfera", email: "admin@sfera.local", accountType: "admin", stores: [], password: TEMP_PASSWORD, mustChangePassword: true, status: "approved", active: true }; saveAccessUsers([admin]); } }, [authReady, accessUsers.length]);

  const load = useCallback(async (manual = false) => {
    setRefreshing(true); setError("");
    try {
      const response = await fetch(`${API}/api/${manual ? "refresh" : "dashboard"}`, { method: manual ? "POST" : "GET", cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Não foi possível carregar os dados.");
      setData(body);
      setRecurrenceRecords([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Falha ao carregar a API local.");
    } finally { setRefreshing(false); }
  }, []);

  useEffect(() => {
    // A leitura inicial sincroniza a interface com a API local do Excel.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  useEffect(() => {
    if (view !== "recurrence" || !data || recurrenceRecords.length) return;
    let cancelled = false;
    setRecurrenceLoading(true);
    setRecurrenceError("");
    fetch(`${API}/api/orders/records`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Não foi possível carregar os pedidos detalhados.");
        if (!cancelled) setRecurrenceRecords(Array.isArray(body.records) ? body.records : []);
      })
      .catch((caught) => { if (!cancelled) setRecurrenceError(caught instanceof Error ? caught.message : "Falha ao carregar os pedidos detalhados."); })
      .finally(() => { if (!cancelled) setRecurrenceLoading(false); });
    return () => { cancelled = true; };
  }, [view, data, recurrenceRecords.length]);

  const workingData = useMemo(() => {
    if (!data) return null;
    const storeEntries = (store ? data.stores.filter((item) => item.store === store) : data.stores)
      .map(({ store: name, storeCode }) => ({ store: name, storeCode }));
    const indicators = Object.fromEntries(Object.values(data.indicators).map((item) => {
      const recomputed = recomputeIndicator(item, store, cycle, startDate, endDate, storeEntries);
      return [recomputed.id, recomputed];
    }));
    const stores = storeEntries.map(({ store: name, storeCode }) => ({
      store: name, storeCode,
      indicators: Object.fromEntries(Object.values(indicators).map((item) => [
        item.id,
        item.ranking.find((row) => row.store === name) || { value: null, target: item.current.target, status: "unknown" as StatusKey, count: 0 },
      ])),
    }));
  const alerts = Object.values(indicators).flatMap((item) => item.ranking
      .filter((row) => row.status === "bad")
      .map((row) => ({ ...row, indicator: item.id })));
    return { ...data, indicators, stores, alerts };
  }, [data, store, cycle, startDate, endDate]);

  const filteredIndicators = useMemo(() => {
    if (!workingData) return [];
    return Object.values(workingData.indicators).filter((item) => !indicatorFilter || item.id === indicatorFilter);
  }, [workingData, indicatorFilter]);
  const priorityAlerts = useMemo(() => {
    if (!workingData) return [];
    return workingData.alerts
      .filter((item) => !indicatorFilter || item.indicator === indicatorFilter)
      .map((item) => {
        const metric = workingData.indicators[item.indicator];
        const gap = item.value != null && item.target != null
          ? metric.direction === "lower" ? item.value - item.target : item.target - item.value
          : 0;
        return { ...item, gap };
      })
      .sort((a, b) => b.gap - a.gap || a.store.localeCompare(b.store, "pt-BR"))
      .slice(0, 8);
  }, [workingData, indicatorFilter]);
  const presentationData = useMemo(() => workingData ? {
    ...workingData,
    filters: { ...workingData.filters, indicators: workingData.filters.indicators.filter((item) => !indicatorFilter || item.id === indicatorFilter) },
  } : null, [workingData, indicatorFilter]);

  const openIndicator = (id: string) => { setActiveIndicator(id); setView("indicator"); setMenuOpen(false); };
  const openStore = (name: string) => { setActiveStore(name); setView("store"); setMenuOpen(false); };
  const chosen = workingData?.indicators[activeIndicator] || filteredIndicators[0];
  const storeRow = workingData?.stores.find((item) => item.store === activeStore);
  const currentStatuses = workingData ? Object.values(workingData.indicators).map((item) => item.current.status) : [];
  const good = currentStatuses.filter((item) => item === "good").length;
  const bad = currentStatuses.filter((item) => item === "bad").length;
  const rotationEntries = useMemo(() => {
    if (!workingData) return [] as Array<{ kind: "store-summary"; store: DashboardData["stores"][number] }>;
    const entries: Array<{ kind: "store-summary"; store: DashboardData["stores"][number] }> = [];
    for (const storeRow of workingData.stores) entries.push({ kind: "store-summary", store: storeRow });
    return entries;
  }, [workingData]);
  const rotationTotal = rotationEntries.length;
  const rotationPosition = rotationTotal ? overviewRotation % rotationTotal : 0;
  const rotationEntry = rotationEntries[rotationPosition];
  const evolutionIndicator = filteredIndicators.find((item) => item.trend.length > 1) || chosen;
  const nav = [
    ["overview", "Visão Geral", LayoutDashboard], ["stores", "360° Por Loja", Store],
    ["ranking", "Ranking", Trophy], ["performance", "Pedidos", CircleGauge], ["recurrence", "Recorrência", Users],
    ["quality", "Qualidade dos dados", Database], ["cadastro", "Usuários", Users], ["profile", "Meu perfil", UserCircle], ["settings", "Configurações", Settings],
  ] as const;

  if (!authReady) return <main className="fatal"><RefreshCw className="spin" size={36} /><h1>Preparando acesso</h1></main>;
  const currentUser = accessUsers.find((user) => user.id === sessionUserId);
  if (!currentUser) return <AuthScreen users={accessUsers} onUsersChange={saveAccessUsers} resetRequests={resetRequests} onResetRequestsChange={saveResetRequests} onLogin={(user) => { setSessionUserId(user.id); try { window.localStorage.setItem("operacoes-session-user", user.id); } catch { /* storage indisponível */ } }} />;
  if (currentUser.mustChangePassword) return <PasswordChangeScreen user={currentUser} users={accessUsers} onUsersChange={saveAccessUsers} onComplete={(user) => { setSessionUserId(user.id); try { window.localStorage.setItem("operacoes-session-user", user.id); } catch { /* storage indisponível */ } }} />;
  if (!data && error) return <main className="fatal"><Database size={42} /><h1>Fonte de dados indisponível</h1><p>{error}</p><code>{API}</code><button onClick={() => load()}>Tentar novamente</button></main>;
  if (!data || !workingData) return <main className="fatal"><RefreshCw className="spin" size={36} /><h1>Preparando a operação</h1><p>Lendo e normalizando as 11 abas do Excel.</p></main>;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <div className="brand"><img className="sidebar-logo" src="/dashboard-mark-transparent.png" alt="Sfera Operações" /><div><small>Performance de lojas</small></div><button className="close-menu" onClick={() => setMenuOpen(false)}><X /></button></div>
        <nav>{nav.map(([id, label, Icon]) => <button key={id} className={view === id ? "active" : ""} onClick={() => { setView(id); setMenuOpen(false); }}><Icon size={18} />{label}</button>)}</nav>
        <div className="nav-group"><span>Indicadores</span>{data.filters.indicators.map((item) => <button key={item.id} className={view === "indicator" && activeIndicator === item.id ? "active" : ""} onClick={() => openIndicator(item.id)}><BarChart3 size={16} />{item.label}</button>)}</div>
        <div className="source-mini"><Database size={16} /><div><strong>Fonte conectada</strong><small>{data.source.fileName}</small></div></div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <button className="menu-button" onClick={() => setMenuOpen(true)}><Menu /></button>
          <div><p>Dashboard de Operações</p><span>Última atualização: {shortDate.format(new Date(data.source.modifiedAt))}</span></div><img className="topbar-logo" src="/dashboard-logo.png" alt="Sfera Operações" />
          <div className="topbar-actions"><button className="refresh" onClick={() => load(true)} disabled={refreshing}><RefreshCw className={refreshing ? "spin" : ""} size={17} />Atualizar dados</button><button className="refresh logout-button" onClick={() => { setSessionUserId(""); try { window.localStorage.removeItem("operacoes-session-user"); } catch { /* storage indisponível */ } }}>Sair</button></div>
        </header>

        <Filters data={data} store={store} setStore={setStore} cycle={cycle} setCycle={setCycle} startDate={startDate} setStartDate={setStartDate} endDate={endDate} setEndDate={setEndDate} indicator={indicatorFilter} setIndicator={setIndicatorFilter} status={statusFilter} setStatus={setStatusFilter} />

        <div className="content">
          {view === "overview" && <>
            <section className="page-head"><div><span className="eyebrow">Visão executiva</span><h1>Visão Geral da Operação</h1><p>O que está saudável, onde agir e quais lojas exigem atenção.</p></div><span className="data-chip">{filteredIndicators.reduce((sum, item) => sum + item.records.length, 0).toLocaleString("pt-BR")} registros no recorte</span></section>
            {rotationEntry && <section className={`panel overview-rotation-card${rotationPulse ? " rotation-pulse" : ""}`}><div className="section-title"><div><h2>Resumo rotativo</h2><p>Visão 360° de cada loja, com todos os indicadores.</p></div><span className="rotation-timer">Troca após 10s sem interação</span></div><div className="rotation-store-card"><div className="rotation-heading"><span>Visão 360° da loja</span><strong>{rotationEntry.store.store}</strong><small>{rotationEntry.store.storeCode || "—"}</small></div><div className="rotation-store-metrics">{filteredIndicators.map((metric) => { const result = rotationEntry.store.indicators[metric.id]; return <div key={metric.id}><span>{metric.label}</span><strong><ResultValue result={result} id={metric.id} /></strong><Badge status={result?.status || "unknown"} informational={isInformational(metric.id)} /></div>; })}</div></div><div className="rotation-dots" aria-label="Navegação do resumo rotativo"><button type="button" onClick={() => { lastOverviewInteraction.current = Date.now(); setOverviewRotation((rotationPosition - 1 + rotationTotal) % rotationTotal); }}>‹</button><span>{rotationPosition + 1} / {rotationTotal}</span><button type="button" onClick={() => { lastOverviewInteraction.current = Date.now(); setOverviewRotation((rotationPosition + 1) % rotationTotal); }}>›</button></div></section>}
            <section className="summary-grid">
              <article><Building2 /><span>Lojas analisadas</span><strong>{workingData.stores.length}</strong></article>
              <article><CircleGauge /><span>Indicadores dentro</span><strong>{good}</strong></article>
              <article><AlertTriangle /><span>Indicadores fora</span><strong>{bad}</strong></article>
            </section>
            <section><div className="section-title"><div><h2>Indicadores principais</h2><p>Resultado do período e dos filtros selecionados.</p></div></div><div className="kpi-grid">{filteredIndicators.filter((item) => !statusFilter || item.current.status === statusFilter).map((item) => <KpiCard key={item.id} indicator={item} storeSelected={Boolean(store)} onOpen={() => openIndicator(item.id)} />)}</div></section>
            <section className="two-col">
              <article className="panel"><div className="section-title"><div><h2>{evolutionIndicator ? (isWithdrawal(evolutionIndicator.id) ? evolutionIndicator.label : trendTitle(evolutionIndicator)) : "Evolução do indicador"}</h2><p>{evolutionIndicator ? `Valores exibidos em ${trendUnit(evolutionIndicator.id)}.` : "Selecione um indicador"}</p></div></div>{evolutionIndicator && (isWithdrawal(evolutionIndicator.id) ? <Ranking indicator={evolutionIndicator} onStore={openStore} /> : <Trend indicator={evolutionIndicator} selectedCycle={cycle} />)}</article>
            </section>
            <section className="panel"><div className="section-title"><div><h2>Mapa de performance</h2><p>Clique em uma loja para abrir a visão 360°.</p></div></div><Matrix data={presentationData || workingData} onStore={openStore} /></section>
          </>}

          {view === "indicator" && chosen && <>
            <section className="page-head"><div><span className="eyebrow">Indicador</span><h1>{chosen.label}</h1><p>Meta, evolução, ranking e registros normalizados.</p></div>{(!isWithdrawal(chosen.id) || Boolean(store)) && <Badge status={chosen.current.status} informational={isInformational(chosen.id)} />}</section>
             <section className="summary-grid three"><article><span>{isWithdrawal(chosen.id) ? "Situação" : "Resultado geral"}</span><strong>{isWithdrawal(chosen.id) ? store ? <><ResultValue result={chosen.current} id={chosen.id} /> pedidos em atraso</> : "\u00a0" : <ResultValue result={chosen.current} id={chosen.id} />}</strong></article><article><span>Meta</span><strong>{isInformational(chosen.id) ? "Apenas visualização" : formatTarget(chosen.id, chosen.current.target)}</strong></article><article><span>{isWithdrawal(chosen.id) ? "Apuração" : "Diferença"}</span><strong>{isWithdrawal(chosen.id) ? chosen.label : isInformational(chosen.id) ? "Não se aplica" : deltaText(chosen.current.value, chosen.current.target, chosen.direction, chosen.id)}</strong></article></section>
             {isWithdrawal(chosen.id)
                  ? <><section className="panel"><h2>{chosen.label}</h2><RankingSummary indicator={chosen} /><IndicatorDetailTable indicator={chosen} /></section><StoreComparisonChart indicator={chosen} /><section className="panel"><h2>{trendTitle(chosen)}</h2><Trend indicator={chosen} selectedCycle={cycle} /></section></>
                : chosen.id === "medallia"
                  ? <><section className="panel medallia-list-panel"><h2>{chosen.label}</h2><RankingSummary indicator={chosen} /><MedalliaTable indicator={chosen} /></section><StoreComparisonChart indicator={chosen} /><section className="panel"><h2>{trendTitle(chosen)}</h2><Trend indicator={chosen} selectedCycle={cycle} /></section></>
                  : <><section className="panel"><h2>{chosen.label}</h2><RankingSummary indicator={chosen} />{DETAILED_INDICATORS.has(chosen.id) ? <IndicatorDetailTable indicator={chosen} /> : <Ranking indicator={chosen} onStore={openStore} showMedalliaDetails={Boolean(cycle)} />}</section><StoreComparisonChart indicator={chosen} /><section className="panel"><h2>{trendTitle(chosen)}</h2><Trend indicator={chosen} selectedCycle={cycle} /></section></>}
             {chosen.id === "medallia" && !cycle && <section className="panel"><h2>Principais reclamações</h2><div className="complaints">{chosen.records.filter((item) => item.complaints).slice(-12).map((item, index) => <button key={index} onClick={() => openStore(item.store)}><strong>{item.store} <small>{item.storeCode}</small></strong><span>{item.complaints}</span></button>)}</div></section>}
            {chosen.id.endsWith("cancelados") && <section className="panel"><h2>Saldo Total por loja</h2><p className="muted">Percentual direto da planilha — abaixo de 2% é melhor.</p><div className="chart"><ResponsiveContainer width="100%" height={360}><BarChart data={chosen.ranking.slice().reverse().map((item) => ({ ...item, valuePct: (item.value || 0) * 100 }))} layout="vertical"><CartesianGrid horizontal={false} stroke="#e7e9ed" /><XAxis type="number" unit="%" domain={[0, 100]} /><YAxis dataKey="store" type="category" width={110} tick={{ fontSize: 11 }} /><Tooltip formatter={(value) => [`${Number(value).toLocaleString("pt-BR", { maximumFractionDigits: 2 })}%`, "Saldo Total"]} /><ReferenceLine x={2} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: "Meta 2%", position: "insideTopRight", fill: "#b45309", fontSize: 11 }} /><Bar dataKey="valuePct" fill="#3157d5" radius={[0, 5, 5, 0]} /></BarChart></ResponsiveContainer></div></section>}
          </>}

          {view === "store" && storeRow && <>
            <section className="page-head"><div><span className="eyebrow">Visão 360° da Loja</span><h1 className="store-title">{storeRow.store} <small>{storeRow.storeCode}</small></h1><p>Todos os indicadores disponíveis no período selecionado.</p></div><button className="back" onClick={() => setView("overview")}>Voltar à visão geral</button></section>
            <div className="kpi-grid">{(presentationData || workingData).filters.indicators.map((item) => {
              const result = storeRow.indicators[item.id]; const source = workingData.indicators[item.id];
              return <button className="kpi-card" key={item.id} onClick={() => openIndicator(item.id)}><span className="kpi-label">{item.label}</span><strong><ResultValue result={result} id={item.id} /></strong><span className="kpi-meta">{isInformational(item.id) ? "Sem meta • apenas visualização" : `Meta: ${formatTarget(item.id, result?.target ?? null)}`}</span><Badge status={result?.status || "unknown"} informational={isInformational(item.id)} /><ChevronRight className="kpi-arrow" size={17} />{source?.records.some((r) => r.store === storeRow.store && r.complaints) && <span className="has-note">Possui reclamações registradas</span>}</button>;
            })}</div>
          </>}

          {view === "stores" && <><section className="page-head"><div><span className="eyebrow">Lojas</span><h1>Visão 360° por loja</h1><p>Selecione uma unidade para detalhar sua operação.</p></div></section><div className="store-grid">{workingData.stores.map((item) => <button key={item.store} onClick={() => openStore(item.store)}><Store /><strong>{item.store}</strong><small className="store-code">{item.storeCode}</small><span>{Object.values(item.indicators).filter((result) => result.status === "bad").length} pontos de atenção</span><ChevronRight /></button>)}</div></>}

          {view === "ranking" && <><section className="page-head"><div><span className="eyebrow">Benchmark interno</span><h1>Ranking de Lojas</h1><p>Melhores e piores resultados por indicador.</p></div></section><article className="panel attention ranking-priority-card"><div className="section-title"><div><h2>Prioridade de ação</h2><p>Ocorrências fora da meta, ordenadas pelo maior desvio.</p></div></div><div className="alert-list">{priorityAlerts.map((item, index) => <button key={`${item.store}-${item.indicator}-${index}`} onClick={() => openStore(item.store)}><AlertTriangle size={17} /><span><strong>{item.store} <small>{item.storeCode}</small></strong><small>{workingData.indicators[item.indicator]?.label} • {formatResult(item, item.indicator)} • {formatGap(item.gap, item.indicator)}</small></span><ChevronRight size={16} /></button>)}{!priorityAlerts.length && <p className="muted">Nenhuma ocorrência crítica calculável.</p>}</div></article><div className="indicator-panels">{filteredIndicators.map((item) => <article className="panel" key={item.id}><h2>{item.label}</h2><Ranking indicator={item} onStore={openStore} /></article>)}</div></>}

          {view === "performance" && <OrdersView data={data} selectedStore={store} cycle={cycle} startDate={startDate} endDate={endDate} onImported={() => load(true)} />}

          {view === "recurrence" && (
            <OrderRecurrenceView
              data={data}
              records={recurrenceRecords}
              loading={recurrenceLoading}
              error={recurrenceError}
              selectedStore={store}
              cycle={cycle}
              startDate={startDate}
              endDate={endDate}
            />
          )}

          {view === "quality" && <><section className="page-head"><div><span className="eyebrow">Governança</span><h1>Qualidade dos Dados</h1><p>Problemas registrados sem interromper o restante do dashboard.</p></div></section><section className="summary-grid three"><article><span>Críticos</span><strong>{data.quality.summary.critical || 0}</strong></article><article><span>Altos</span><strong>{data.quality.summary.high || 0}</strong></article><article><span>Médios</span><strong>{data.quality.summary.medium || 0}</strong></article></section><section className="panel issue-list">{data.quality.issues.slice(0, 100).map((item, index) => <div key={index}><span className={`severity ${item.severity}`}>{item.severity}</span><strong>{item.message}</strong><small>{item.indicator ? data.indicators[item.indicator]?.label : item.code}</small></div>)}</section></>}

          {view === "cadastro" && <CadastroView stores={data.stores.map(({ store, storeCode }) => ({ store, storeCode }))} users={accessUsers} onUsersChange={saveAccessUsers} resetRequests={resetRequests} onResetRequestsChange={saveResetRequests} onViewStore={(name) => { setStore(name); setActiveStore(name); setView("store"); }} />}

          {view === "profile" && <ProfileView user={currentUser} stores={data.stores.map(({ store, storeCode }) => ({ store, storeCode }))} />}

          {view === "settings" && <><section className="page-head"><div><span className="eyebrow">Configuração</span><h1>Metas e Score Operacional</h1><p>Metas operacionais aprovadas e arquitetura pronta para pesos configuráveis.</p></div></section><section className="panel settings-note"><Settings /><div><h2>Metas aplicadas</h2><p>PEC / OMNI 99%, Medallia 93%, Plataforma Logística 93%, Recebimento 100% no prazo, Arruamento 92%, Retirada até 3 pedidos, Chamados Sfera até 2 chamados e Quebra de Estoque até 1%. O Score Operacional permanece desativado até que a liderança aprove os pesos.</p></div></section></>}
        </div>
      </main>
      {menuOpen && <button aria-label="Fechar menu" className="scrim" onClick={() => setMenuOpen(false)} />}
    </div>
  );
}


