import { NextResponse } from "next/server";
import { authorize } from "../../../../server/auth.mjs";
import { databaseConfigured, getSql, listArruamentoPortalSnapshots, listArruamentoPortalSources, loadArruamentoPortalSource } from "../../../../server/db.mjs";
import cyclePeriodsSource from "../../../../config/cycles.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const cyclePeriods = cyclePeriodsSource as Record<string, { start: string; end: string }>;
const normalize = (value: unknown) => String(value ?? "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");

function parseCsv(bytes: Buffer) {
  const text = bytes.toString("utf8").replace(/^\ufeff/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] || "";
  const delimiter = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { row.push(cell); cell = ""; }
    else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(cell); if (row.some((value) => value.trim())) rows.push(row);
      row = []; cell = "";
    } else cell += char;
  }
  row.push(cell); if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function headerMap(row: string[]) { return new Map(row.map((value, index) => [normalize(value).replace(/[^a-z0-9]/g, ""), index])); }
function findIndex(headers: Map<string, number>, ...names: string[]) {
  for (const name of names) { const index = headers.get(name); if (index !== undefined) return index; }
  return -1;
}
function numberFrom(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const text = String(value ?? "").trim().replace(/\s/g, "");
  const parsed = Number(text.includes(",") ? text.replace(/\./g, "").replace(",", ".") : text);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function legacySnapshot(sql: ReturnType<typeof getSql>, sourceGroup: any[]) {
  const identity = sourceGroup[0];
  const [addressMeta, salesMeta] = ["addresses", "sales"].map((type) => sourceGroup.find((item) => item.source_type === type));
  if (!salesMeta) return null;
  const [addressFile, salesFile] = await Promise.all([
    addressMeta ? loadArruamentoPortalSource(sql!, identity.store, identity.year, identity.cycle, "addresses") : null,
    loadArruamentoPortalSource(sql!, identity.store, identity.year, identity.cycle, "sales"),
  ]);
  if (!salesFile) return null;
  const addressRows = addressFile ? parseCsv(addressFile.bytes) : [];
  const salesRows = parseCsv(salesFile.bytes);
  const addressHeaderIndex = addressRows.findIndex((row) => row.some((value) => normalize(value).replace(/[^a-z0-9]/g, "") === "sku"));
  const salesHeaderIndex = salesRows.findIndex((row) => row.some((value) => normalize(value).replace(/[^a-z0-9]/g, "") === "sku"));
  const addresses = new Map<string, { desc: string; category: string; locations: string[] }>();
  if (addressHeaderIndex >= 0) {
    const header = headerMap(addressRows[addressHeaderIndex]);
    const skuAt = findIndex(header, "sku"), descAt = findIndex(header, "produto", "descricao"), categoryAt = findIndex(header, "categoria", "familia"), addressAt = findIndex(header, "endereco", "localizacao", "enderecocompleto");
    for (const row of addressRows.slice(addressHeaderIndex + 1)) {
      const sku = String(row[skuAt] ?? "").trim(); if (!sku) continue;
      const key = normalize(sku); const current = addresses.get(key) || { desc: "", category: "", locations: [] };
      const location = addressAt >= 0 ? String(row[addressAt] ?? "").trim() : row.slice(4, 8).filter(Boolean).join(" / ");
      current.desc ||= String(row[descAt] ?? "").trim(); current.category ||= String(row[categoryAt] ?? "").trim();
      for (const part of location.split(/\s*;\s*/).filter(Boolean)) if (!current.locations.includes(part)) current.locations.push(part);
      addresses.set(key, current);
    }
  }
  if (salesHeaderIndex < 0) return null;
  const header = headerMap(salesRows[salesHeaderIndex]);
  const skuAt = findIndex(header, "sku"), descAt = findIndex(header, "produto", "descricao"), categoryAt = findIndex(header, "categoria", "familia");
  const curveAt = findIndex(header, "curvaabc", "curva"), qtyAt = findIndex(header, "quantidadevendida", "qtdevendida", "qtdvendida", "vendido");
  const revenueAt = findIndex(header, "faturamento", "faturamentocomendereco", "receita", "valorvendido");
  const stockAt = findIndex(header, "saldo", "estoque", "quantidadeestoque");
  const rows = new Map<string, any>();
  for (const row of salesRows.slice(salesHeaderIndex + 1)) {
    const sku = String(row[skuAt] ?? "").trim(); if (!sku) continue;
    const key = normalize(sku), address = addresses.get(key), locations = address?.locations || [];
    const complete = locations.some((location) => { const parts = location.split(/\s*\/\s*/); return parts.length >= 4 && parts.slice(0, 4).every((part) => part && part !== "—"); });
    const partial = locations.length > 0 && !complete;
    rows.set(key, {
      sku, desc: String(row[descAt] ?? address?.desc ?? "").trim(), category: String(row[categoryAt] ?? address?.category ?? "").trim(),
      curve: String(row[curveAt] ?? "").trim().toUpperCase(), qty: numberFrom(row[qtyAt]), revenue: numberFrom(row[revenueAt]), stock: numberFrom(row[stockAt]),
      profit: 0, arruado: complete, partial, locations, matched: Boolean(address),
    });
  }
  const period = String(identity.year) === "2026" ? cyclePeriods[String(identity.cycle)] : undefined;
  const importedAt = [addressMeta?.updatedAt, salesMeta?.updatedAt].filter(Boolean).sort().at(-1) || new Date().toISOString();
  const snapshot = {
    parserVersion: 3, store: identity.store, code: String(identity.store_code || "00000"), year: Number(identity.year), cycle: Number(identity.cycle),
    periodStart: period?.start || null, periodEnd: period?.end || null, inventoryDate: null, importedAt,
    sources: { route: addressMeta?.file_name || "", abc: salesMeta.file_name || "" }, rows: [...rows.values()],
    checks: { matchedSkus: addresses.size, inventorySkus: addresses.size, completeInventorySkus: [...addresses.values()].filter((item) => item.locations.length).length, duplicatesAbc: 0, invalidAbc: 0, notMatched: Math.max(0, rows.size - addresses.size), otherStores: [] },
  };
  return snapshot.checks.matchedSkus > 0 && snapshot.rows.length ? snapshot : null;
}

export async function GET(request: Request) {
  const access = await authorize(request);
  if (access.error) return access.error;
  if (!databaseConfigured()) return NextResponse.json({ error: "O banco online ainda não está disponível." }, { status: 503 });
  const sql = getSql();
  const admin = access.user.accountType === "admin";
  const stored = await listArruamentoPortalSnapshots(sql, access.user.stores, admin);
  const listing = await listArruamentoPortalSources(sql, access.user.stores, admin);
  const snapshots = new Map(stored.map((snapshot: any) => [`${snapshot.year}-${snapshot.cycle}|${snapshot.code}`, snapshot]));
  const groups = new Map<string, any[]>();
  for (const source of listing.sources) {
    const key = `${source.year}-${source.cycle}|${source.store_code || source.store}`;
    if (snapshots.has(key)) continue;
    const groupKey = `${normalize(source.store)}|${source.year}|${source.cycle}`;
    groups.set(groupKey, [...(groups.get(groupKey) || []), source]);
  }
  for (const group of groups.values()) {
    const snapshot = await legacySnapshot(sql, group);
    if (snapshot) snapshots.set(`${snapshot.year}-${snapshot.cycle}|${snapshot.code}`, snapshot);
  }
  const result = [...snapshots.values()].filter((snapshot: any) => admin || access.user.stores.some((store: string) => normalize(store) === normalize(snapshot.store)));
  const stores = [...new Map(result.map((snapshot: any) => [String(snapshot.code), { code: String(snapshot.code), store: String(snapshot.store), regional: "" }])).values()];
  return NextResponse.json({ snapshots: result, stores, canImport: false }, { headers: { "Cache-Control": "no-store" } });
}
