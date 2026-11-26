import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureSchema } from "./db.mjs";

export const RECEIVING_CUTOVER_DATE = "2026-11-26";
const TEXT_ARRAY = 1009;
export const normalizeInvoice = (value) => String(value ?? "").trim().replace(/\D/g, "").replace(/^0+(?=\d)/, "");
const dateOnly = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? "").slice(0, 10);
const projectRoot = fs.existsSync(path.join(process.cwd(), "config", "cycles.json")) ? process.cwd() : path.resolve(process.cwd(), "..");
const CYCLES = JSON.parse(fs.readFileSync(path.join(projectRoot, "config", "cycles.json"), "utf8"));
const canonicalStoreCodes = {
  "19826": "Partage", "20740": "Madureira", "21044": "Alcântara", "21469": "Juiz de Fora", "21470": "Benfica",
  "21483": "Três Rios", "22552": "Raul Soares", "22554": "Além Paraíba", "22555": "Manhuaçu", "22588": "Leopoldina",
  "23318": "Santos Dumont", "25195": "Caratinga", "23433": "Caratinga", "23443": "Caratinga", "23441": "Carangola", "24064": "Aimorés",
};
const stateForStore = (code) => ["19826", "20740", "21044", "21483"].includes(String(code)) ? "RJ" : "MG";
const shiftDay = (iso, amount) => { const date = new Date(`${iso}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10); };
function easterSunday(year) {
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31),day=(h+l-7*m+114)%31+1;
  return new Date(Date.UTC(year, month-1, day)).toISOString().slice(0, 10);
}
function holidaySet(year) {
  const fixed = ["01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "11-20", "12-25"].map((day) => `${year}-${day}`);
  const easter = easterSunday(year);
  return new Set([...fixed, shiftDay(easter, -2)]);
}
function isHoliday(date, storeCode) {
  if (holidaySet(Number(date.slice(0, 4))).has(date)) return true;
  if (stateForStore(storeCode) !== "RJ") return false;
  const easter = easterSunday(Number(date.slice(0, 4)));
  return date.endsWith("-04-23") || date === shiftDay(easter, -47) || date === shiftDay(easter, 60);
}

export function receivingElapsedDays(receivedDate, entryDate, storeCode) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedDate) || !/^\d{4}-\d{2}-\d{2}$/.test(entryDate) || entryDate <= receivedDate) return 0;
  let elapsed = 0;
  for (let day = shiftDay(receivedDate, 1); day <= entryDate; day = shiftDay(day, 1)) {
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && !isHoliday(day, storeCode)) elapsed += 1;
  }
  return elapsed;
}

export function cycleForReceivingDate(date) {
  for (const [cycle, period] of Object.entries(CYCLES)) if (date >= period.start && date <= period.end) return Number(cycle);
  return null;
}

const invoiceFromRow = (row) => ({
  id: row.id, invoiceNumber: row.invoice_number, invoiceKey: row.invoice_key, storeCode: row.store_code,
  store: row.store_name, receivedDate: dateOnly(row.received_date), volumes: Number(row.volumes),
  entryDate: row.entry_date ? dateOnly(row.entry_date) : null, entryImportFile: row.entry_import_file || null,
  entryImportedAt: row.entry_imported_at || null, entryRegisteredBy: row.entry_registered_by_name || null,
  entryRegisteredByType: row.entry_registered_by_type || null, createdBy: row.created_by_name,
  createdAt: row.created_at, updatedAt: row.updated_at,
  conferenceDays: row.entry_date ? receivingElapsedDays(dateOnly(row.received_date), dateOnly(row.entry_date), row.store_code) : null,
  lateDays: row.entry_date ? Math.max(0, receivingElapsedDays(dateOnly(row.received_date), dateOnly(row.entry_date), row.store_code) - 2) : null,
});

/** @param {any} sql @param {string[] | null} [storeCodes] */
export async function listReceivingInvoices(sql, storeCodes = null) {
  await ensureSchema(sql);
  const rows = storeCodes === null
    ? await sql`select * from public.receiving_invoices order by received_date desc, store_name, invoice_number`
    : storeCodes.length
      ? await sql`select * from public.receiving_invoices where store_code = any(${sql.array(storeCodes, TEXT_ARRAY)}) order by received_date desc, store_name, invoice_number`
      : [];
  return rows.map(invoiceFromRow);
}

export async function createReceivingInvoices(sql, { rows, user }) {
  await ensureSchema(sql);
  const result = { created: [], duplicates: [] };
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(727021)`;
    for (const row of rows) {
      const invoiceKey = normalizeInvoice(row.invoiceNumber);
      const id = randomUUID();
      const inserted = await tx`insert into public.receiving_invoices
        (id, invoice_number, invoice_key, store_code, store_name, received_date, volumes, created_by, created_by_name)
        values (${id}, ${row.invoiceNumber.trim()}, ${invoiceKey}, ${row.storeCode}, ${row.store}, ${row.receivedDate}, ${row.volumes}, ${user.id}, ${user.name})
        on conflict (store_code, invoice_key) do nothing returning *`;
      if (inserted.length) result.created.push(invoiceFromRow(inserted[0]));
      else result.duplicates.push(row.invoiceNumber.trim());
    }
  });
  return result;
}

export async function updateReceivingEntries(sql, { rows, fileName, storeCodes, user }) {
  await ensureSchema(sql);
  const result = { updated: 0, unchanged: 0, unmatched: [] };
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(727021)`;
    for (const row of rows) {
      const invoiceKey = normalizeInvoice(row.invoiceNumber);
      if (!storeCodes.includes(row.storeCode)) continue;
      const updated = await tx`update public.receiving_invoices set entry_date = ${row.entryDate}, entry_import_file = ${fileName}, entry_imported_at = now(), entry_registered_by = ${user.id}, entry_registered_by_name = ${user.name}, entry_registered_by_type = ${user.accountType}, updated_at = now()
        where store_code = ${row.storeCode} and invoice_key = ${invoiceKey} and (entry_date is distinct from ${row.entryDate}::date or entry_import_file is distinct from ${fileName} or entry_registered_by is null) returning id`;
      if (updated.length) result.updated += updated.length;
      else {
        const [existing] = await tx`select id from public.receiving_invoices where store_code = ${row.storeCode} and invoice_key = ${invoiceKey} limit 1`;
        if (existing) result.unchanged += 1;
        else result.unmatched.push(row.invoiceNumber);
      }
    }
  });
  return result;
}

export function applyReceivingRegisterToDashboard(snapshot, invoices) {
  const existing = snapshot?.indicators?.recebimento;
  if (!existing) return snapshot;
  const historical = (existing.records || []).filter((row) => {
    const date = String(row.date || row.periodEnd || row.periodStart || "").slice(0, 10);
    return !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < RECEIVING_CUTOVER_DATE;
  });
  const registered = invoices.filter((invoice) => invoice.entryDate && invoice.receivedDate >= RECEIVING_CUTOVER_DATE).map((invoice) => {
    const elapsed = receivingElapsedDays(invoice.receivedDate, invoice.entryDate, invoice.storeCode);
    const within = elapsed <= 2;
    const cycle = cycleForReceivingDate(invoice.receivedDate);
    return {
      indicator: "recebimento", storeCode: invoice.storeCode, store: invoice.store, cycle,
      sourceRow: null, date: `${invoice.receivedDate}T00:00:00.000Z`, periodStart: `${invoice.receivedDate}T00:00:00.000Z`,
      periodEnd: `${invoice.entryDate}T00:00:00.000Z`, value: within ? 1 : 0, target: 1,
      numerator: within ? 1 : 0, denominator: 1, statusSource: within ? "Dentro do prazo" : "Fora do prazo",
      notes: null, raw: { conferenceDays: elapsed, slaDays: 2, invoice: invoice.invoiceKey, receivingVolumes: invoice.volumes, receivingVolumeSource: "registro", receivingSheetRow: null, entryDate: invoice.entryDate, creator: invoice.createdBy },
    };
  });
  const records = [...historical, ...registered];
  const storeCodes = new Map((snapshot.stores || []).map((store) => [store.store, store.storeCode]));
  const stores = [...(snapshot.stores || [])];
  for (const row of registered) if (row.store && !storeCodes.has(row.store)) {
    storeCodes.set(row.store, row.storeCode);
    stores.push({
      store: row.store, storeCode: row.storeCode,
      indicators: Object.fromEntries(Object.entries(snapshot.indicators || {}).map(([id, indicator]) => [id,
        { value: null, target: indicator.current?.target ?? indicator.configuredTarget ?? null, status: "unknown", count: 0 },
      ])),
    });
  }
  return {
    ...snapshot,
    filters: { ...snapshot.filters, stores: [...new Set([...(snapshot.filters?.stores || []), ...registered.map((row) => row.store)])] },
    stores,
    indicators: { ...snapshot.indicators, recebimento: { ...existing, records } },
  };
}
