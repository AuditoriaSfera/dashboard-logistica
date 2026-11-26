import { NextResponse } from "next/server";
import { authorize } from "../../../server/auth.mjs";
import { databaseConfigured, getSql } from "../../../server/db.mjs";
import { storeDirectory } from "../../../server/backlog.mjs";
import { createReceivingInvoices, listReceivingInvoices, normalizeInvoice, updateReceivingEntries } from "../../../server/receiving.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store, private", Vary: "Cookie" };
const normalizeText = (value: unknown) => String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const validDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers });

async function contextFor(user: { accountType: string; stores: string[] }) {
  const directory: Record<string, string> = await storeDirectory();
  const assigned = new Set((user.stores || []).map(normalizeText));
  const stores = Object.entries(directory)
    .filter(([code, name]) => user.accountType === "admin" || assigned.has(normalizeText(name)))
    .map(([storeCode, store]) => ({ storeCode, store }))
    .sort((a, b) => a.store.localeCompare(b.store, "pt-BR"));
  return { directory, stores, storeCodes: stores.map((item) => item.storeCode) };
}

function sameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const url = new URL(request.url);
  const allowed = new Set([url.origin]);
  // Railway terminates TLS before forwarding HTTP to the app process.
  if (request.headers.get("x-forwarded-proto") === "https") allowed.add(`https://${url.host}`);
  if (process.env.RAILWAY_PUBLIC_DOMAIN) {
    try {
      const publicUrl = /^https?:\/\//i.test(process.env.RAILWAY_PUBLIC_DOMAIN)
        ? process.env.RAILWAY_PUBLIC_DOMAIN
        : `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
      allowed.add(new URL(publicUrl).origin);
    } catch { /* Invalid platform values do not grant an origin. */ }
  }
  if (process.env.ACCESS_APP_ORIGIN) {
    try { allowed.add(new URL(process.env.ACCESS_APP_ORIGIN).origin); } catch { /* Invalid configuration grants no origin. */ }
  }
  return Boolean(origin && allowed.has(origin) && request.headers.get("sec-fetch-site") !== "cross-site");
}

export async function GET(request: Request) {
  const access = await authorize(request);
  if (access.error) return access.error;
  if (!databaseConfigured()) return json({ error: "O banco compartilhado do recebimento não está disponível." }, 503);
  try {
    const sql = getSql();
    const { stores, storeCodes } = await contextFor(access.user);
    const invoices = await listReceivingInvoices(sql, access.user.accountType === "admin" ? null : storeCodes);
    return json({ invoices, stores, cutoverDate: "2026-11-26" });
  } catch {
    return json({ error: "Não foi possível carregar as notas fiscais. Tente novamente." }, 503);
  }
}

export async function POST(request: Request) {
  const access = await authorize(request);
  if (access.error) return access.error;
  if (!sameOrigin(request) || !/^application\/json(?:;|$)/i.test(request.headers.get("content-type") || "")) return json({ error: "Origem da solicitação não permitida." }, 403);
  if (!databaseConfigured()) return json({ error: "O banco compartilhado do recebimento não está disponível." }, 503);
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > 4 * 1024 * 1024) return json({ error: "O arquivo ou a lista excede o limite permitido." }, 413);
  let body: any;
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > 4 * 1024 * 1024) return json({ error: "O arquivo ou a lista excede o limite permitido." }, 413);
    body = JSON.parse(text);
  } catch { return json({ error: "Envie informações válidas." }, 400); }
  try {
    const sql = getSql();
    const { directory, storeCodes } = await contextFor(access.user);
    if (body?.action === "register") {
      const storeCode = String(body.storeCode ?? "").trim();
      const store = directory[storeCode];
      const receivedDate = String(body.receivedDate ?? "");
      const rows = body.rows;
      if (!store || !storeCodes.includes(storeCode)) return json({ error: "Selecione uma loja vinculada ao seu acesso." }, 403);
      if (!validDate(receivedDate) || !Array.isArray(rows) || !rows.length || rows.length > 200) return json({ error: "Informe a data e pelo menos uma nota fiscal." }, 400);
      const normalized = rows.map((row: any) => ({
        invoiceNumber: String(row?.invoiceNumber ?? "").trim(), storeCode, store, receivedDate,
        volumes: Number(row?.volumes),
      }));
      if (normalized.some((row: any) => !row.invoiceNumber || row.invoiceNumber.length > 50 || !normalizeInvoice(row.invoiceNumber) || !Number.isInteger(row.volumes) || row.volumes < 0 || row.volumes > 1000000)) return json({ error: "Confira o número da nota e informe volumes como número inteiro igual ou maior que zero." }, 400);
      const keys = new Set<string>();
      for (const row of normalized) {
        const key = normalizeInvoice(row.invoiceNumber);
        if (keys.has(key)) return json({ error: `A nota ${row.invoiceNumber} está repetida nesta lista.` }, 400);
        keys.add(key);
      }
      const result = await createReceivingInvoices(sql, { rows: normalized, user: access.user });
      const invoices = await listReceivingInvoices(sql, access.user.accountType === "admin" ? null : storeCodes);
      return json({ ...result, invoices });
    }
    if (body?.action === "import-entries") {
      const fileName = String(body.fileName ?? "").trim().slice(0, 255);
      const rows = body.rows;
      if (!fileName || !Array.isArray(rows) || rows.length > 20000) return json({ error: "O arquivo de conferência está vazio ou é inválido." }, 400);
      const normalized = rows.map((row: any) => ({ invoiceNumber: String(row?.invoiceNumber ?? "").trim(), storeCode: String(row?.storeCode ?? "").trim(), entryDate: String(row?.entryDate ?? "") }));
      if (normalized.some((row: any) => !normalizeInvoice(row.invoiceNumber) || !storeCodes.includes(row.storeCode) || !validDate(row.entryDate))) return json({ error: "A planilha contém nota, loja ou data de entrada inválida ou fora do seu acesso." }, 400);
      const result = await updateReceivingEntries(sql, { rows: normalized, fileName, storeCodes, user: access.user });
      const invoices = await listReceivingInvoices(sql, access.user.accountType === "admin" ? null : storeCodes);
      return json({ ...result, invoices });
    }
    return json({ error: "Ação de recebimento não reconhecida." }, 400);
  } catch (error) {
    console.error("[recebimento] Falha ao salvar NFs:", error instanceof Error ? error.message : "erro desconhecido");
    return json({ error: "Não foi possível salvar as informações de recebimento." }, 503);
  }
}
