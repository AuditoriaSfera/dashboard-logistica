import { createPublicKey, verify } from "node:crypto";
import { NextResponse } from "next/server";
import { databaseConfigured, deleteArruamentoPortalSources, getSql, loadArruamentoPortalSnapshot, loadArruamentoPortalSource, saveArruamentoPortalSnapshot, saveArruamentoPortalSource } from "../../../../server/db.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 15 * 1024 * 1024;
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnyW8vQ2YY0fiNdr8k5CV
FOtn7ImF3YP5VeNvcI4HNUs/+Gw9S8wUxRRjRao6k/r277lJZ3H5uM2GLBO5aqD4
5d7xD7xfswHH8tuoW16L3Zbf2M53wDcJbMLcvpvU6jVkjZf+WD74Y5APhru/VFFh
qB7fBWKvEDSr4VEGMB039ae5DQWd5YkqU2dg55c9k1/iTgFu/qILJ2ICJqiTEsWY
29H9fbSSQLY2N/RlEEeb/lqg7hshBUtwTnzq6HIalSyL7dWLtgKAz+o41fJ6UF7S
yKjSWFnvCzT8hoTBetzWwNowrZe1NmNX+4yVf8I/+gKoYMLuH2ntfg6lT0tm14xL
CwIDAQAB
-----END PUBLIC KEY-----`;

const csvCell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
const csv = (columns: string[], rows: unknown[][]) => Buffer.from(`\ufeff${[columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n")}`, "utf8");

function validSnapshot(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Record<string, any>;
  if (snapshot.deleted === true) return /^\d{5}$/.test(String(snapshot.code)) && Number.isInteger(snapshot.year) && Number.isInteger(snapshot.cycle) && typeof snapshot.store === "string";
  if (!/^\d{5}$/.test(String(snapshot.code)) || !Number.isInteger(snapshot.year) || snapshot.year < 2020 || snapshot.year > 2100) return false;
  if (!Number.isInteger(snapshot.cycle) || snapshot.cycle < 1 || snapshot.cycle > 30 || snapshot.parserVersion !== 3) return false;
  if (!snapshot.checks?.matchedSkus || !Array.isArray(snapshot.rows) || !snapshot.rows.length || snapshot.rows.length > 40000) return false;
  if (typeof snapshot.store !== "string" || !snapshot.store.trim() || snapshot.store.length > 150 || !Number.isFinite(Date.parse(snapshot.importedAt))) return false;
  const seen = new Set<string>();
  return snapshot.rows.every((row: any) => {
    const sku = String(row?.sku ?? "").trim();
    if (!sku || sku.length > 80 || seen.has(sku) || typeof row.arruado !== "boolean" || !Number.isFinite(Number(row.stock)) || !Array.isArray(row.locations)) return false;
    if (row.locations.some((location: unknown) => typeof location !== "string" || location.length > 500)) return false;
    seen.add(sku);
    return true;
  });
}

function snapshotCsvs(snapshot: Record<string, any>) {
  const salesRows = snapshot.rows.map((row: any) => [row.sku, row.desc, row.category, row.curve, row.qty, row.revenue, row.stock]);
  const addressRows: unknown[][] = [];
  for (const row of snapshot.rows) {
    const locations: string[] = Array.isArray(row.locations) ? row.locations : [];
    addressRows.push([row.sku, row.desc, row.category, locations.join("; ")]);
  }
  const suffix = `${snapshot.code}_C${snapshot.cycle}_${snapshot.year}`;
  return [
    { sourceType: "addresses", fileName: `Portal_Arruamento_${suffix}_enderecos.csv`, bytes: csv(["SKU", "Produto", "Categoria", "Endereço"], addressRows) },
    { sourceType: "sales", fileName: `Portal_Arruamento_${suffix}_curva_abc.csv`, bytes: csv(["SKU", "Produto", "Categoria", "Curva ABC", "Quantidade vendida", "Faturamento", "Saldo"], salesRows) },
  ];
}

async function signedRequest(request: Request, rawBody: string) {
  const timestamp = request.headers.get("x-arruamento-timestamp") || "";
  const signature = request.headers.get("x-arruamento-signature") || "";
  const milliseconds = Number(timestamp);
  if (!/^\d{13}$/.test(timestamp) || Math.abs(Date.now() - milliseconds) > 5 * 60 * 1000 || !signature) return false;
  try {
    return verify("sha256", Buffer.from(`${timestamp}\n${rawBody}`, "utf8"), createPublicKey(PUBLIC_KEY), Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  if (!databaseConfigured()) return NextResponse.json({ error: "O banco do dashboard está indisponível para sincronização." }, { status: 503 });
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_BYTES) return NextResponse.json({ error: "A base de Arruamento excede o limite de sincronização." }, { status: 413 });

  const rawBody = await request.text();
  if (!rawBody || Buffer.byteLength(rawBody, "utf8") > MAX_BYTES) return NextResponse.json({ error: "A base de Arruamento está vazia ou excede o limite de sincronização." }, { status: 413 });
  if (!(await signedRequest(request, rawBody))) return NextResponse.json({ error: "Assinatura de sincronização inválida ou expirada." }, { status: 401 });

  let snapshot: Record<string, any>;
  try { snapshot = JSON.parse(rawBody); }
  catch { return NextResponse.json({ error: "Dados de Arruamento inválidos." }, { status: 400 }); }
  if (!validSnapshot(snapshot)) return NextResponse.json({ error: "A base de Arruamento não passou na validação." }, { status: 422 });

  const sql = getSql();
  const store = snapshot.store.trim();
  const storeCode = String(snapshot.code);
  const year = Number(snapshot.year);
  const cycle = Number(snapshot.cycle);
  if (snapshot.deleted === true) {
    await deleteArruamentoPortalSources(sql, { store, year, cycle });
    return NextResponse.json({ ok: true, deleted: true, store, year, cycle }, { headers: { "Cache-Control": "no-store" } });
  }

  const existingSnapshot = await loadArruamentoPortalSnapshot(sql, store, year, cycle);
  if (JSON.stringify(existingSnapshot) !== JSON.stringify(snapshot)) await saveArruamentoPortalSnapshot(sql, snapshot);

  const imported = snapshotCsvs(snapshot);
  let changed = false;
  for (const item of imported) {
    const existing = await loadArruamentoPortalSource(sql, store, year, cycle, item.sourceType);
    if (existing?.bytes.equals(item.bytes)) continue;
    await saveArruamentoPortalSource(sql, {
      store, storeCode, year, cycle, sourceType: item.sourceType,
      fileName: item.fileName, bytes: item.bytes,
    });
    changed = true;
  }
  return NextResponse.json({ ok: true, changed, store, storeCode, year, cycle, importedAt: snapshot.importedAt }, { headers: { "Cache-Control": "no-store" } });
}
