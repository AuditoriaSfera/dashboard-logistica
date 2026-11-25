import { NextResponse } from "next/server";
import fs from "node:fs/promises";
import path from "node:path";
import { authorize } from "../../../server/auth.mjs";
import { databaseConfigured, getSql, listArruamentoPortalSources, loadArruamentoPortalSource, logAuditEvent, saveArruamentoPortalSource } from "../../../server/db.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const MAX_BYTES = 100 * 1024 * 1024;
const LOCAL_FILE = path.join(process.cwd(), "data", "arruamento-portal.json");
const normalize = (value: unknown) => String(value ?? "").trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR");
type LocalSource = { store: string; store_code: string | null; year: number; cycle: number; source_type: string; file_name: string; bytes: number; updatedAt: string; content: string };
type LocalHistory = { store: string; store_code: string | null; year: number; cycle: number; source_type: string; file_name: string; bytes: number; importedAt: string };
type LocalState = { sources: LocalSource[]; history: LocalHistory[] };
let localMutation = Promise.resolve();

async function readLocal(): Promise<LocalState> {
  try { return JSON.parse(await fs.readFile(LOCAL_FILE, "utf8")) as LocalState; }
  catch { return { sources: [], history: [] }; }
}

async function writeLocalSource(source: LocalSource, history: LocalHistory) {
  const write = localMutation.then(async () => {
    const state = await readLocal();
    const key = (item: LocalSource) => `${normalize(item.store)}|${item.year}|${item.cycle}|${item.source_type}`;
    const index = state.sources.findIndex((item) => key(item) === key(source));
    if (index < 0) state.sources.push(source); else state.sources[index] = source;
    state.history.unshift(history); state.history = state.history.slice(0, 500);
    await fs.mkdir(path.dirname(LOCAL_FILE), { recursive: true });
    const temporary = `${LOCAL_FILE}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(state));
    await fs.rename(temporary, LOCAL_FILE);
  });
  localMutation = write.catch(() => {});
  await write;
}

async function currentUser(request: Request) {
  const result = await authorize(request);
  if (result.error) return { response: result.error };
  return { user: result.user };
}

function cycleValue(raw: string | null) {
  const cycle = Number(raw);
  return Number.isInteger(cycle) && cycle >= 1 && cycle <= 99 ? cycle : null;
}
function yearValue(raw: string | null) {
  const year = Number(raw);
  return Number.isInteger(year) && year >= 2020 && year <= 2100 ? year : null;
}

function canAccessStore(user: { accountType: string; stores: string[] }, store: string) {
  return user.accountType === "admin" || user.stores.some((name) => normalize(name) === normalize(store));
}

export async function GET(request: Request) {
  const auth = await currentUser(request);
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const store = url.searchParams.get("store")?.trim() || "";
  const year = yearValue(url.searchParams.get("year"));
  const cycle = cycleValue(url.searchParams.get("cycle"));
  const sourceType = url.searchParams.get("source") || "";
  const download = url.searchParams.get("download") === "1";
  const sql = getSql();
  if (download) {
    if (!store || !year || !cycle || !["addresses", "sales"].includes(sourceType)) return NextResponse.json({ error: "Informe loja, ano, ciclo e planilha." }, { status: 400 });
    if (!canAccessStore(auth.user, store)) return NextResponse.json({ error: "Você não tem acesso aos dados desta loja." }, { status: 403 });
    const workbook = databaseConfigured()
      ? await loadArruamentoPortalSource(sql, store, year, cycle, sourceType)
      : (await readLocal()).sources.find((item) => normalize(item.store) === normalize(store) && item.year === year && item.cycle === cycle && item.source_type === sourceType);
    if (!workbook) return NextResponse.json({ error: "A planilha ainda não foi importada." }, { status: 404 });
    const bytes = "content" in workbook ? Buffer.from(workbook.content, "base64") : workbook.bytes;
    return new Response(bytes, { headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(workbook.file_name)}`,
      "Cache-Control": "no-store",
    } });
  }
  let listing;
  if (databaseConfigured()) listing = await listArruamentoPortalSources(sql, auth.user.stores, auth.user.accountType === "admin");
  else {
    const local = await readLocal();
    const allowed = (name: string) => auth.user.accountType === "admin" || auth.user.stores.some((assigned) => normalize(assigned) === normalize(name));
    listing = {
      sources: local.sources.filter((item) => allowed(item.store)).map(({ content: _content, ...item }) => item),
      history: local.history.filter((item) => allowed(item.store)),
    };
  }
  return NextResponse.json(listing, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request) {
  const auth = await currentUser(request);
  if (auth.response) return auth.response;
  if (auth.user.accountType !== "admin") return NextResponse.json({ error: "Somente administradores podem importar planilhas de Arruamento." }, { status: 403 });
  const form = await request.formData();
  const store = String(form.get("store") || "").trim();
  const storeCode = String(form.get("storeCode") || "").trim() || null;
  const year = yearValue(String(form.get("year") || ""));
  const cycle = cycleValue(String(form.get("cycle") || ""));
  const sourceType = String(form.get("source") || "");
  const file = form.get("workbook");
  if (!store || !year || !cycle) return NextResponse.json({ error: "Selecione a loja, o ano e o ciclo." }, { status: 400 });
  if (!["addresses", "sales"].includes(sourceType)) return NextResponse.json({ error: "Escolha se a planilha contém endereços ou vendas/curva ABC." }, { status: 400 });
  if (!(file instanceof File)) return NextResponse.json({ error: "Selecione a planilha." }, { status: 400 });
  if (!file.name.toLowerCase().match(/\.(xlsx|xls|xlsm|csv)$/)) return NextResponse.json({ error: "Use uma planilha Excel ou CSV." }, { status: 400 });
  if (!file.size || file.size > MAX_BYTES) return NextResponse.json({ error: "A planilha está vazia ou excede o limite de 100 MB." }, { status: 413 });
  const fileName = file.name.replace(/[^\p{L}\p{N}._ -]/gu, "_");
  const bytes = Buffer.from(await file.arrayBuffer());
  if (databaseConfigured()) {
    const sql = getSql();
    await saveArruamentoPortalSource(sql, { store, storeCode: storeCode ?? undefined, year, cycle, sourceType, fileName, bytes });
    await logAuditEvent(sql, { actor: auth.user, action: "arruamento-portal-import", entityType: "arruamento-portal-workbook", entityId: `${store}:${year}:${cycle}:${sourceType}`, request, metadata: { store, year, cycle, sourceType, fileName, bytes: bytes.length } });
  } else {
    const now = new Date().toISOString();
    await writeLocalSource({ store, store_code: storeCode, year, cycle, source_type: sourceType, file_name: fileName, bytes: bytes.length, updatedAt: now, content: bytes.toString("base64") }, { store, store_code: storeCode, year, cycle, source_type: sourceType, file_name: fileName, bytes: bytes.length, importedAt: now });
  }
  return NextResponse.json({ ok: true, store, year, cycle, source: sourceType, fileName });
}
