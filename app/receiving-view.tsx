"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ClipboardList, FileSpreadsheet, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import * as XLSX from "xlsx";
import { findReceivingColumns, normalizeReceivingHeader } from "./receiving-import.mjs";

type StoreOption = { storeCode: string; store: string };
type Invoice = {
  id: string; invoiceNumber: string; storeCode: string; store: string; receivedDate: string; volumes: number;
  entryDate: string | null; entryImportFile: string | null; entryRegisteredBy: string | null;
  entryRegisteredByType: string | null; createdBy: string; conferenceDays: number | null; lateDays: number | null;
};
type Props = { onUpdated: () => void };
const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`; };
const normalizeInvoice = (value: unknown) => String(value ?? "").trim().replace(/\D/g, "").replace(/^0+(?=\d)/, "");
function parseDate(value: unknown): string | null {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number" && value > 20000 && value < 100000) {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (parsed) return `${parsed.y}-${String(parsed.m).padStart(2, "0")}-${String(parsed.d).padStart(2, "0")}`;
  }
  const text = String(value ?? "").trim();
  const br = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})/);
  if (br) return `${br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}
const brDate = (value: string | null) => value ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeZone: "UTC" }).format(new Date(`${value}T12:00:00Z`)) : "—";

export function ReceivingView({ onUpdated }: Props) {
  const [tab, setTab] = useState<"register" | "list">("register");
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [storeCode, setStoreCode] = useState("");
  const [receivedDate, setReceivedDate] = useState(today);
  const [rows, setRows] = useState([{ invoiceNumber: "", volumes: "" }]);
  const [filterStore, setFilterStore] = useState("");
  const [filterStatus, setFilterStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  async function load() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/receiving", { cache: "no-store" });
      const body = await response.json() as { error?: string; invoices?: Invoice[]; stores?: StoreOption[] };
      if (!response.ok) throw new Error(body.error || "Não foi possível carregar as notas.");
      setStores(body.stores || []); setInvoices(body.invoices || []); setLoaded(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao carregar as notas."); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (!loaded) void load(); }, [loaded]);

  const filtered = useMemo(() => invoices.filter((invoice) => (!filterStore || invoice.storeCode === filterStore)
    && (filterStatus === "all" || filterStatus === "open" && !invoice.entryDate || filterStatus === "late" && invoice.lateDays !== null && invoice.lateDays > 0 || filterStatus === "on-time" && invoice.entryDate && invoice.lateDays === 0)
    && (!search || `${invoice.invoiceNumber} ${invoice.store} ${invoice.storeCode} ${invoice.createdBy || ""}`.toLocaleLowerCase("pt-BR").includes(search.toLocaleLowerCase("pt-BR"))))
    .sort((a, b) => b.receivedDate.localeCompare(a.receivedDate) || a.store.localeCompare(b.store, "pt-BR")), [invoices, filterStore, filterStatus, search]);
  const summary = useMemo(() => ({ total: invoices.length, open: invoices.filter((item) => !item.entryDate).length, late: invoices.filter((item) => item.lateDays !== null && item.lateDays > 0).length, volumes: invoices.reduce((total, item) => total + item.volumes, 0) }), [invoices]);

  async function submit() {
    setBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch("/api/receiving", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "register", storeCode, receivedDate, rows: rows.map((row) => ({ invoiceNumber: row.invoiceNumber, volumes: Number(row.volumes) })) }) });
      const body = await response.json() as { error?: string; invoices?: Invoice[]; created?: Invoice[]; duplicates?: string[] };
      if (!response.ok) throw new Error(body.error || "Não foi possível salvar as notas.");
      setInvoices(body.invoices || []); setRows([{ invoiceNumber: "", volumes: "" }]);
      setMessage(`${body.created?.length || 0} nota(s) cadastrada(s); ${body.duplicates?.length || 0} duplicada(s) ignorada(s).`);
      onUpdated();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao salvar."); }
    finally { setBusy(false); }
  }

  async function importEntries(file?: File) {
    if (!file) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true });
      let parsed: Array<{ invoiceNumber: string; storeCode: string; entryDate: string }> = [];
      for (const sheet of workbook.SheetNames) {
        const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[sheet], { header: 1, raw: true, defval: "" });
        const columns = findReceivingColumns(matrix);
        if (!columns) continue;
        const imported = matrix.slice(columns.headerRow + 1).flatMap((line) => {
          const invoiceNumber = String(line[columns.invoice] ?? "").trim();
          const entryDate = parseDate(line[columns.entry]);
          const rawStore = columns.store >= 0 ? String(line[columns.store] ?? "").trim() : "";
          const matchedStores = rawStore ? stores.filter((item) => item.storeCode === rawStore || normalizeReceivingHeader(item.store) === normalizeReceivingHeader(rawStore) || normalizeReceivingHeader(`${item.storeCode}${item.store}`) === normalizeReceivingHeader(rawStore)) : (storeCode ? stores.filter((item) => item.storeCode === storeCode) : stores.filter((item) => invoices.some((invoice) => normalizeInvoice(invoice.invoiceNumber) === normalizeInvoice(invoiceNumber) && invoice.storeCode === item.storeCode)));
          if (!invoiceNumber || !entryDate || matchedStores.length !== 1) return [];
          return [{ invoiceNumber, storeCode: matchedStores[0].storeCode, entryDate }];
        });
        if (imported.length) { parsed = imported; break; }
      }
      if (!parsed.length) throw new Error("Não encontrei linhas com número da NF, data de entrada e loja identificável na planilha.");
      const response = await fetch("/api/receiving", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "import-entries", fileName: file.name, rows: parsed }) });
      const body = await response.json() as { error?: string; invoices?: Invoice[]; updated?: number; unchanged?: number; unmatched?: string[] };
      if (!response.ok) throw new Error(body.error || "Não foi possível conferir as entradas.");
      setInvoices(body.invoices || []); setMessage(`${body.updated || 0} entrada(s) atualizada(s); ${body.unchanged || 0} já estava(m) atualizada(s); ${body.unmatched?.length || 0} linha(s) sem correspondência.`); onUpdated();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Falha ao importar a planilha."); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  return <div className="receiving-page">
    <section className="page-head"><div><span className="eyebrow">Operação / Recebimento</span><h1>Recebimento de notas fiscais</h1><p>Registre as NFs recebidas, acompanhe volumes e confira a data de entrada.</p></div><button className="receiving-refresh" onClick={() => void load()} disabled={busy}><RefreshCw size={16} className={busy ? "spin" : ""} /> Atualizar</button></section>
    <div className="receiving-summary"><article><span>Notas cadastradas</span><strong>{summary.total.toLocaleString("pt-BR")}</strong></article><article><span>Em aberto</span><strong>{summary.open.toLocaleString("pt-BR")}</strong></article><article><span>Em atraso</span><strong>{summary.late.toLocaleString("pt-BR")}</strong></article><article><span>Volumes registrados</span><strong>{summary.volumes.toLocaleString("pt-BR")}</strong></article></div>
    <div className="receiving-tabs"><button className={tab === "register" ? "active" : ""} onClick={() => setTab("register")}><Plus size={16} /> Cadastrar notas</button><button className={tab === "list" ? "active" : ""} onClick={() => setTab("list")}><ClipboardList size={16} /> Notas registradas</button></div>
    {(message || error) && <div className={`receiving-notice${error ? " error" : ""}`} role="status">{error || message}</div>}
    {tab === "register" ? <section className="panel receiving-form"><div className="receiving-section-head"><div><h2>Cadastro de recebimento</h2><p>Uma data e uma loja podem ter várias notas, cada uma com seu volume.</p></div></div><div className="receiving-fields"><label>Loja<select value={storeCode} onChange={(event) => setStoreCode(event.target.value)}><option value="">Selecione a loja</option>{stores.map((item) => <option key={item.storeCode} value={item.storeCode}>{item.store} ({item.storeCode})</option>)}</select></label><label>Data de recebimento<input type="date" value={receivedDate} onChange={(event) => setReceivedDate(event.target.value)} /></label></div><div className="receiving-row-heading"><span>Nº da Nota Fiscal</span><span>Quantidade de volumes</span><span /></div>{rows.map((row, index) => <div className="receiving-input-row" key={index}><input aria-label={`Número da nota fiscal ${index + 1}`} value={row.invoiceNumber} onChange={(event) => setRows((current) => current.map((item, rowIndex) => rowIndex === index ? { ...item, invoiceNumber: event.target.value } : item))} placeholder="Ex.: 871073" /><input aria-label={`Volumes da nota ${index + 1}`} type="number" min="0" step="1" value={row.volumes} onChange={(event) => setRows((current) => current.map((item, rowIndex) => rowIndex === index ? { ...item, volumes: event.target.value } : item))} placeholder="0" /><button className="receiving-icon-button" title="Remover nota" onClick={() => setRows((current) => current.length === 1 ? current : current.filter((_, rowIndex) => rowIndex !== index))}><Trash2 size={16} /></button></div>)}<button className="receiving-add" onClick={() => setRows((current) => [...current, { invoiceNumber: "", volumes: "" }])}><Plus size={16} /> Adicionar outra nota</button><div className="receiving-form-footer"><span><Check size={15} /> Duplicatas de uma mesma loja são identificadas e ignoradas.</span><button className="primary" onClick={() => void submit()} disabled={busy || !storeCode || rows.some((row) => !row.invoiceNumber.trim() || row.volumes === "")}>{busy ? "Salvando…" : "Salvar recebimento"}</button></div></section> : <section className="panel receiving-list"><div className="receiving-section-head"><div><h2>Notas cadastradas</h2><p>O perfil que cadastrou a nota aparece em cada registro; a entrada é conferida separadamente.</p></div><input ref={fileRef} type="file" accept=".xlsx,.xls,.xlsm,.csv" hidden onChange={(event) => void importEntries(event.target.files?.[0])} /><button className="receiving-refresh" onClick={() => fileRef.current?.click()} disabled={busy}><Upload size={16} /> Importar data de entrada</button></div><div className="receiving-filters"><label>Buscar<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="NF, loja ou perfil cadastrante" /></label><label>Loja<select value={filterStore} onChange={(event) => setFilterStore(event.target.value)}><option value="">Todas as lojas</option>{stores.map((item) => <option key={item.storeCode} value={item.storeCode}>{item.store} ({item.storeCode})</option>)}</select></label><label>Status<select value={filterStatus} onChange={(event) => setFilterStatus(event.target.value)}><option value="all">Todos</option><option value="open">Em aberto</option><option value="late">Em atraso</option><option value="on-time">Dentro do prazo</option></select></label></div><div className="receiving-table-wrap"><table className="receiving-table"><thead><tr><th>Loja</th><th>Nota fiscal</th><th>Recebida em</th><th>Volumes</th><th>Entrada registrada</th><th>Perfil que cadastrou a NF</th><th>Prazo</th></tr></thead><tbody>{filtered.map((invoice) => <tr key={invoice.id}><td><strong>{invoice.store}</strong><small>{invoice.storeCode}</small></td><td>{invoice.invoiceNumber}</td><td>{brDate(invoice.receivedDate)}</td><td>{invoice.volumes.toLocaleString("pt-BR")}</td><td>{brDate(invoice.entryDate)}</td><td>{invoice.createdBy ? <strong>{invoice.createdBy}</strong> : "—"}</td><td><span className={`receiving-status ${!invoice.entryDate ? "open" : invoice.lateDays && invoice.lateDays > 0 ? "late" : "ok"}`}>{!invoice.entryDate ? "Em aberto" : invoice.lateDays && invoice.lateDays > 0 ? `${invoice.lateDays} dia(s) em atraso` : "Dentro do prazo"}</span></td></tr>)}{!filtered.length && <tr><td colSpan={7} className="receiving-empty">Nenhuma nota corresponde aos filtros selecionados.</td></tr>}</tbody></table></div><div className="receiving-table-foot">Mostrando {filtered.length.toLocaleString("pt-BR")} de {invoices.length.toLocaleString("pt-BR")} notas. {busy && <span><FileSpreadsheet size={14} /> Processando planilha…</span>}</div></section>}
  </div>;
}
