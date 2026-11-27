import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { databaseConfigured, ensureSchema, getSql } from "./db.mjs";

export const RETIRADA_OVERDUE_CUTOVER = "2026-11-26";
const normalize = (value) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const channelCode = (value) => String(value ?? "").match(/^\s*(\d+)(?:\s*[-–—]|\s*$)/)?.[1] || "";
const codeAliases = { "23433": "25915", "23443": "25915", "25195": "25915" };
const storeNames = {
  "19826": "Partage", "20740": "Madureira", "21044": "Alcântara", "21469": "Juiz de Fora", "21470": "Benfica",
  "21483": "Três Rios", "22552": "Raul Soares", "22554": "Além Paraíba", "22555": "Manhuaçu", "22588": "Leopoldina",
  "23318": "Santos Dumont", "23433": "Caratinga", "23443": "Caratinga", "25195": "Caratinga", "25915": "Caratinga",
  "23441": "Carangola", "24064": "Aimorés",
};
const storeState = (code) => ["19826", "20740", "21044", "21483"].includes(String(code)) ? "RJ" : "MG";
const pickupTypes = new Set(["retiradanacentral", "retirarnacentral", "retiradanacentraldeservicos", "retirarnacentraldeservicos"]);
export function isRetiradaDeliveryType(value) { return pickupTypes.has(normalize(value)); }
const isoToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const shiftDay = (iso, amount) => { const date = new Date(`${iso}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10); };

function easterSunday(year) {
  const a=year%19,b=Math.floor(year/100),c=year%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),month=Math.floor((h+l-7*m+114)/31),day=(h+l-7*m+114)%31+1;
  return new Date(Date.UTC(year, month-1, day)).toISOString().slice(0, 10);
}
function holidaySet(year) {
  const fixed = ["01-01", "04-21", "05-01", "09-07", "10-12", "11-02", "11-15", "11-20", "12-25"].map((monthDay) => `${year}-${monthDay}`);
  return new Set([...fixed, shiftDay(easterSunday(year), -2)]);
}
function isHoliday(date, code) {
  if (holidaySet(Number(date.slice(0, 4))).has(date)) return true;
  if (storeState(code) !== "RJ") return false;
  const easter = easterSunday(Number(date.slice(0, 4)));
  return date === `${date.slice(0, 4)}-04-23` || date === shiftDay(easter, -47) || (Number(date.slice(0, 4)) >= 2026 && date === shiftDay(easter, 60));
}
function isBusinessDay(date, code) {
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !isHoliday(date, code);
}
export function businessDaysSinceCapture(captureDate, asOf, code) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(captureDate) || captureDate >= asOf) return 0;
  let days = 0;
  for (let date = shiftDay(captureDate, 1); date <= asOf; date = shiftDay(date, 1)) if (isBusinessDay(date, code)) days += 1;
  return days;
}
function firstOverdueDate(captureDate, code) {
  let days = 0;
  let date = shiftDay(captureDate, 1);
  for (let elapsed = 0; elapsed < 21; elapsed += 1, date = shiftDay(date, 1)) {
    if (isBusinessDay(date, code) && ++days > 3) return date;
  }
  return null;
}
export function filterRetiradaOverdueEvents(events, asOf = isoToday()) {
  return events.filter((event) => {
    if (!isRetiradaDeliveryType(event.deliveryType)) return false;
    const overdueDate = firstOverdueDate(String(event.captureDate || "").slice(0, 10), event.storeCode);
    return overdueDate != null && overdueDate >= RETIRADA_OVERDUE_CUTOVER && overdueDate <= asOf;
  });
}
function cycleNumber(value) {
  const match = String(value ?? "").match(/\d+/);
  return match ? Number(match[0]) : null;
}
function overdueCandidates(base, asOf) {
  if (asOf < RETIRADA_OVERDUE_CUTOVER) return [];
  const result = [];
  for (const row of base?.rows || []) {
    const fiscal = normalize(row.fiscal);
    if (!new Set(["naofaturado", "dispfaturamento"]).has(fiscal) || normalize(row.status).includes("cancel")) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(row.date || "")) || row.date >= asOf) continue;
    if (!isRetiradaDeliveryType(row.delivery)) continue;
    const rawCode = channelCode(row.channel);
    if (!rawCode || !String(row.id || "").trim()) continue;
    const storeCode = codeAliases[rawCode] || rawCode;
    const dueDate = firstOverdueDate(row.date, rawCode);
    if (!dueDate || dueDate < RETIRADA_OVERDUE_CUTOVER || dueDate > asOf) continue;
    result.push({
      id: randomUUID(), storeCode, store: storeNames[rawCode] || storeNames[storeCode] || String(row.channel).split(/\s*[-–—]\s*/).slice(1).join(" - ").trim() || storeCode,
      orderCode: String(row.id).trim(), cycle: cycleNumber(row.cycle), captureDate: row.date,
      overdueDate: dueDate,
      deliveryType: String(row.delivery || ""), captureTime: String(row.time || "").trim() || null,
    });
  }
  return result;
}

const dataDirectory = () => process.env.ACCESS_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(process.cwd(), "data");
const eventsFile = () => path.join(dataDirectory(), "retirada-overdue-events.json");
const dailyRunsFile = () => path.join(dataDirectory(), "retirada-overdue-daily-runs.json");
let fileWrite = Promise.resolve();

function dateInSaoPaulo(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function dateOnly(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10);
  const input = String(value ?? "").trim();
  const isoDate = input.match(/^\d{4}-\d{2}-\d{2}/)?.[0];
  if (isoDate) return isoDate;
  const parsed = new Date(input);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : input.slice(0, 10);
}

export function eventFromRow(row) {
  return {
    id: row.id, storeCode: row.store_code, store: row.store_name, orderCode: row.order_code,
    cycle: row.cycle == null ? null : Number(row.cycle), captureDate: dateOnly(row.capture_date),
    overdueDate: dateOnly(row.overdue_date), deliveryType: row.delivery_type,
    captureTime: row.capture_time || null,
  };
}

async function readFileEvents() {
  try { return JSON.parse(await fs.readFile(eventsFile(), "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
}

async function readFileDailyRuns() {
  try { return JSON.parse(await fs.readFile(dailyRunsFile(), "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return {}; throw error; }
}

async function recordFileDailyRun(asOf, candidates, sourceImportedAt) {
  const write = fileWrite.catch(() => {}).then(async () => {
    const dailyRuns = await readFileDailyRuns();
    if (dailyRuns[asOf]) return;
    const current = await readFileEvents();
    const keys = new Set(current.map((item) => `${item.storeCode}|${item.orderCode}`));
    const added = candidates.filter((item) => { const key = `${item.storeCode}|${item.orderCode}`; if (keys.has(key)) return false; keys.add(key); return true; });
    const directory = dataDirectory();
    await fs.mkdir(directory, { recursive: true });
    if (added.length) {
      const target = eventsFile(); const temp = `${target}.${randomUUID()}.tmp`;
      await fs.writeFile(temp, JSON.stringify([...current, ...added]), { flag: "wx", mode: 0o600 }); await fs.rename(temp, target);
    }
    dailyRuns[asOf] = { sourceImportedAt, completedAt: new Date().toISOString(), eventCount: added.length };
    const target = dailyRunsFile(); const temp = `${target}.${randomUUID()}.tmp`;
    await fs.writeFile(temp, JSON.stringify(dailyRuns), { flag: "wx", mode: 0o600 }); await fs.rename(temp, target);
  });
  fileWrite = write;
  return write;
}

export async function recordNewlyOverdueOrders(base, asOf = isoToday()) {
  const sourceImportedAt = base?.importsByType?.pickup?.importedAt
    || ((base?.rows || []).some((row) => isRetiradaDeliveryType(row.delivery)) ? base?.importedAt : null);
  // A backlog from yesterday must never be used to create today's apuração.
  if (!sourceImportedAt || dateInSaoPaulo(sourceImportedAt) !== asOf) return;
  const candidates = overdueCandidates(base, asOf);
  if (databaseConfigured()) {
    const sql = getSql(); await ensureSchema(sql);
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(727026)`;
      const [existingRun] = await tx`select overdue_date from public.retirada_overdue_daily_runs where overdue_date = ${asOf}::date`;
      if (existingRun) return;
      for (let start = 0; start < candidates.length; start += 500) {
        const batch = candidates.slice(start, start + 500).map((event) => ({
          id: event.id, store_code: event.storeCode, store_name: event.store, order_code: event.orderCode,
          cycle: event.cycle, capture_date: event.captureDate, overdue_date: event.overdueDate,
          delivery_type: event.deliveryType, capture_time: event.captureTime,
        }));
        await tx`insert into public.retirada_overdue_events ${tx(batch, "id", "store_code", "store_name", "order_code", "cycle", "capture_date", "overdue_date", "delivery_type", "capture_time")} on conflict (store_code, order_code) do nothing`;
      }
      await tx`insert into public.retirada_overdue_daily_runs (overdue_date, source_imported_at, event_count) values (${asOf}::date, ${sourceImportedAt}::timestamptz, ${candidates.length}) on conflict (overdue_date) do nothing`;
    });
  } else await recordFileDailyRun(asOf, candidates, sourceImportedAt);
}

export async function listRetiradaOverdueEvents() {
  if (!databaseConfigured()) return filterRetiradaOverdueEvents(await readFileEvents());
  const sql = getSql(); await ensureSchema(sql);
  const rows = await sql`select * from public.retirada_overdue_events where overdue_date >= ${RETIRADA_OVERDUE_CUTOVER}::date order by overdue_date, store_name, order_code`;
  return filterRetiradaOverdueEvents(rows.map(eventFromRow));
}

export function applyRetiradaOverdueEvents(snapshot, events) {
  const indicator = snapshot?.indicators?.retirada;
  if (!indicator) return snapshot;
  const historical = (indicator.records || []).filter((row) => {
    const date = String(row.date || row.periodEnd || row.periodStart || "").slice(0, 10);
    return !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < RETIRADA_OVERDUE_CUTOVER;
  });
  const countedDays = new Set();
  const appended = events.filter((event) => event.overdueDate >= RETIRADA_OVERDUE_CUTOVER).map((event) => {
    const dayKey = `${event.storeCode}|${event.cycle ?? "sem-ciclo"}|${event.overdueDate}`;
    const firstOrderOfDay = !countedDays.has(dayKey);
    countedDays.add(dayKey);
    return {
    indicator: "retirada", storeCode: event.storeCode, store: event.store, cycle: event.cycle,
    sourceRow: null, date: `${event.overdueDate}T12:00:00.000Z`, periodStart: `${event.overdueDate}T12:00:00.000Z`, periodEnd: `${event.overdueDate}T12:00:00.000Z`,
    value: firstOrderOfDay ? 1 : 0, target: null, volume: 1, statusSource: "Pedido em atraso",
    notes: event.orderCode,
    raw: { overdueOrderCode: event.orderCode, captureDate: event.captureDate, overdueDate: event.overdueDate, deliveryType: event.deliveryType, captureTime: event.captureTime, source: "backlog-overdue" },
  };
  });
  const records = [...historical, ...appended];
  const hasCaratingaEvent = appended.some((event) => normalize(event.store) === "caratinga");
  const stores = (snapshot.stores || []).map((store) => hasCaratingaEvent && normalize(store.store) === "caratinga" ? { ...store, storeCode: "25915" } : store);
  const existing = new Set(stores.map((item) => normalize(item.store)));
  for (const event of appended) if (!existing.has(normalize(event.store))) {
    existing.add(normalize(event.store));
    stores.push({ store: event.store, storeCode: event.storeCode, indicators: Object.fromEntries(Object.entries(snapshot.indicators || {}).map(([id, item]) => [id, { value: null, target: item.current?.target ?? item.configuredTarget ?? null, status: "unknown", count: 0 }])) });
  }
  return {
    ...snapshot, stores,
    filters: { ...snapshot.filters, stores: [...new Set([...(snapshot.filters?.stores || []), ...appended.map((row) => row.store)])] },
    indicators: { ...snapshot.indicators, retirada: { ...indicator, records } },
  };
}
