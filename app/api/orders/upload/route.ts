import { NextResponse } from "next/server";
import { authorize } from "../../../../server/auth.mjs";
import { databaseConfigured, getSql, loadOrderRecordsFromDatabase, loadDashboardFromDatabase, logOrderImport, saveOrderRecords, saveOrdersSnapshotToDatabase } from "../../../../server/db.mjs";
import { parseOrdersWorkbookBuffer } from "../../../../server/parser.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 300 * 1024 * 1024;
const keyOf = (record: { orderCode?: string; storeCode?: string; store?: string; date?: string | null; reseller?: string; value?: number }) => String(record.orderCode || `${record.storeCode || record.store || ""}|${record.date || ""}|${record.reseller || ""}|${record.value || 0}`);
const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;

function emptyStore(record: { store?: string; storeCode?: string }) {
  return { store: record.store || "", storeCode: record.storeCode || "", total: 0, retirada: 0, entrega: 0, revendedor: 0, omni: 0, itens: 0, retiradaCancelados: 0, entregaCancelados: 0, revendedorCategorias: {} as Record<string, number>, cancelamentoMotivos: {} as Record<string, [number, number]>, cancelamentoFiscal: {} as Record<string, [number, number]> };
}

function summarizeRecords(records: Array<Record<string, any>>, source: { fileName: string; modifiedAt: string }) {
  const stores = new Map<string, any>(); const daily = new Map<string, any>(); const dates = new Set<string>();
  const apply = (bucket: any, record: Record<string, any>) => {
    const pickup = Boolean(record.pickup); const canceled = Boolean(record.canceled);
    if (canceled) {
      bucket[pickup ? "retiradaCancelados" : "entregaCancelados"] += 1;
      const reason = String(record.cancellationReason || "outros"); const counts = bucket.cancelamentoMotivos[reason] || [0, 0]; counts[pickup ? 1 : 0] += 1; bucket.cancelamentoMotivos[reason] = counts;
      const fiscal = String(record.fiscalSituation || ""); if (fiscal) { const fiscalCounts = bucket.cancelamentoFiscal[fiscal] || [0, 0]; fiscalCounts[pickup ? 1 : 0] += 1; bucket.cancelamentoFiscal[fiscal] = fiscalCounts; }
      return;
    }
    bucket.total += 1; bucket.itens += number(record.items); bucket[pickup ? "retirada" : "entrega"] += 1;
    const role = String(record.role || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
    if (role === "consumidor final") bucket.omni += 1;
    else { bucket.revendedor += 1; const category = role === "diamante gb" ? "diamante" : role; bucket.revendedorCategorias[category] = number(bucket.revendedorCategorias[category]) + 1; }
  };
  for (const record of records) {
    const storeKey = String(record.storeCode || record.store || "unknown"); const bucket = stores.get(storeKey) || emptyStore(record); apply(bucket, record); stores.set(storeKey, bucket);
    const date = record.date ? String(record.date).slice(0, 10) : null;
    if (date) { dates.add(date); const dayKey = `${storeKey}|${date}`; const day = daily.get(dayKey) || emptyStore(record); apply(day, record); daily.set(dayKey, day); }
  }
  const days = Math.max(1, dates.size);
  const finalize = (bucket: any) => ({ ...bucket, pctEntrega: bucket.total ? bucket.entrega / bucket.total : 0, pctRetirada: bucket.total ? bucket.retirada / bucket.total : 0, mediaRetirada: bucket.retirada / days, mediaEntrega: bucket.entrega / days, mediaOmni: bucket.omni / days, mediaItens: bucket.itens / days });
  return { source: { ...source, lastImportAt: new Date().toISOString() }, period: { start: [...dates].sort()[0] || null, end: [...dates].sort().at(-1) || null, days }, stores: [...stores.values()].map(finalize).sort((a, b) => b.total - a.total), daily: [...daily.entries()].map(([key, value]) => ({ ...finalize(value), date: key.split("|", 2)[1] })), records };
}

function addSummaries(previous: any, current: any) {
  if (!previous) return current;
  const stores = new Map<string, any>((previous.stores || []).map((item: any) => [String(item.storeCode || item.store), { ...item, revendedorCategorias: { ...(item.revendedorCategorias || {}) }, cancelamentoMotivos: { ...(item.cancelamentoMotivos || {}) }, cancelamentoFiscal: { ...(item.cancelamentoFiscal || {}) } }] as [string, any]));
  for (const item of current.stores || []) {
    const target = stores.get(item.storeCode || item.store) || emptyStore(item);
    for (const field of ["total", "retirada", "entrega", "revendedor", "omni", "itens", "retiradaCancelados", "entregaCancelados"]) target[field] = number(target[field]) + number(item[field]);
    for (const [key, value] of Object.entries(item.revendedorCategorias || {})) target.revendedorCategorias[key] = number(target.revendedorCategorias[key]) + number(value);
    for (const field of ["cancelamentoMotivos", "cancelamentoFiscal"]) for (const [key, value] of Object.entries(item[field] || {})) { const pair = value as [number, number]; const old = target[field][key] || [0, 0]; target[field][key] = [old[0] + number(pair[0]), old[1] + number(pair[1])]; }
    stores.set(item.storeCode || item.store, target);
  }
  const dates = new Set([...(previous.daily || []).map((item: any) => item.date), ...(current.daily || []).map((item: any) => item.date)].filter(Boolean));
  return { ...current, source: { ...(current.source || {}), ...(previous.source || {}), lastImportAt: new Date().toISOString() }, period: { start: [previous.period?.start, current.period?.start].filter(Boolean).sort()[0] || null, end: [previous.period?.end, current.period?.end].filter(Boolean).sort().at(-1) || null, days: Math.max(1, dates.size) }, stores: [...stores.values()].map((item: any) => ({ ...item, pctEntrega: item.total ? item.entrega / item.total : 0, pctRetirada: item.total ? item.retirada / item.total : 0 })).sort((a, b) => b.total - a.total), daily: [...(previous.daily || []), ...(current.daily || [])] };
}

export async function POST(request: Request) {
  try {
    const access = await authorize(request);
    if (access.error) return access.error;
    if (access.user.accountType !== "admin") return NextResponse.json({ error: "Somente administradores podem importar a planilha de pedidos." }, { status: 403 });
    if (!databaseConfigured()) return NextResponse.json({ error: "O banco de dados não está configurado no Railway para receber os pedidos." }, { status: 503 });
    const contentType = request.headers.get("content-type") || "";
    let bytes: Buffer;
    let originalName = request.headers.get("x-file-name") || "pedidos-importados.xlsx";
    if (contentType.toLowerCase().includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("workbook") || form.get("file");
      if (!(file instanceof File)) return NextResponse.json({ error: "Selecione a planilha de pedidos." }, { status: 400 });
      bytes = Buffer.from(await file.arrayBuffer());
      originalName = file.name;
    } else {
      bytes = Buffer.from(await request.arrayBuffer());
    }
    if (!bytes.length || bytes.length > MAX_BYTES) return NextResponse.json({ error: "A planilha está vazia ou excede o limite de 300 MB." }, { status: 413 });
    const fileName = originalName.replace(/^UTF-8''/i, "").replace(/[^\p{L}\p{N}._ -]/gu, "_");
    const parsed = parseOrdersWorkbookBuffer(bytes, fileName);
    if (!parsed.records.length || !parsed.stores.length) return NextResponse.json({ error: "A aba Pag não contém pedidos válidos das lojas cadastradas." }, { status: 400 });
    const sql = getSql();
    const previousSummary = (await loadDashboardFromDatabase(sql))?.orders || null;
    const previousRecords = (await loadOrderRecordsFromDatabase(sql)).records || [];
    const known = new Set(previousRecords.map(keyOf));
    const uniqueCurrent = [...new Map(parsed.records.map((record) => [keyOf(record), record])).values()];
    const newRecords = uniqueCurrent.filter((record) => !known.has(keyOf(record)));
    const currentSummary = summarizeRecords(newRecords, parsed.source);
    const orders = previousSummary ? addSummaries(previousSummary, currentSummary) : summarizeRecords(uniqueCurrent, parsed.source);
    await saveOrdersSnapshotToDatabase(sql, orders);
    await saveOrderRecords(sql, uniqueCurrent);
    await logOrderImport(sql, { fileName, recordCount: newRecords.length, importedBy: null, note: `Importação online; ${uniqueCurrent.length - newRecords.length} duplicidades ignoradas.` });
    return NextResponse.json({ ok: true, fileName, imported: newRecords.length, ignoredDuplicates: uniqueCurrent.length - newRecords.length, totalRecords: previousRecords.length + newRecords.length, persisted: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao importar a planilha de pedidos.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
