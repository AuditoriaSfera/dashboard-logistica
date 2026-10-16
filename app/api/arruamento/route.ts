import { NextResponse } from "next/server";
import { authorize } from "../../../server/auth.mjs";
import { databaseConfigured, getSql, loadArruamentoWorkbook, loadArruamentoWorkbookMeta, saveArruamentoWorkbook } from "../../../server/db.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 100 * 1024 * 1024;

function allowed(user: { accountType: string; stores: string[] }, store: string) {
  return user.accountType === "admin" || user.stores.some((item) => item.trim().toLocaleLowerCase("pt-BR") === store.trim().toLocaleLowerCase("pt-BR"));
}

async function access(request: Request) {
  const result = await authorize(request);
  if (result.error) return { response: result.error };
  const store = new URL(request.url).searchParams.get("store")?.trim() || "";
  if (!store) return { response: NextResponse.json({ error: "Informe a loja da planilha de arruamento." }, { status: 400 }) };
  if (!allowed(result.user, store)) return { response: NextResponse.json({ error: "Você não tem acesso à planilha desta loja." }, { status: 403 }) };
  return { user: result.user, store };
}

function cycleOf(request: Request, required = false) {
  const raw = new URL(request.url).searchParams.get("cycle")?.trim() || "";
  const cycle = Number(raw);
  if (!Number.isInteger(cycle) || cycle < 1 || cycle > 99) {
    if (required) return { error: NextResponse.json({ error: "Selecione um ciclo válido para a planilha de arruamento." }, { status: 400 }) };
    return { cycle: 0 };
  }
  return { cycle };
}

export async function GET(request: Request) {
  const current = await access(request);
  if (current.response) return current.response;
  if (!databaseConfigured()) return NextResponse.json({ error: "O banco de dados não está configurado para guardar as planilhas de arruamento." }, { status: 503 });
  const sql = getSql();
  const download = new URL(request.url).searchParams.get("download") === "1";
  const selected = cycleOf(request);
  const workbook = download ? await loadArruamentoWorkbook(sql, current.store, selected.cycle) : await loadArruamentoWorkbookMeta(sql, current.store, selected.cycle);
  if (!workbook) return NextResponse.json({ exists: false, store: current.store, cycle: selected.cycle || null });
  if (!download) return NextResponse.json({ exists: true, store: current.store, cycle: workbook.cycle, fileName: workbook.fileName, bytes: workbook.bytes, updatedAt: workbook.updatedAt });
  return new Response(workbook.bytes, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(workbook.fileName)}`,
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(request: Request) {
  const current = await access(request);
  if (current.response) return current.response;
  const selected = cycleOf(request, true);
  if (selected.error) return selected.error;
  if (current.user.accountType !== "admin") return NextResponse.json({ error: "Somente administradores podem importar a planilha de arruamento." }, { status: 403 });
  if (!databaseConfigured()) return NextResponse.json({ error: "O banco de dados não está configurado para guardar as planilhas de arruamento." }, { status: 503 });
  const form = await request.formData();
  const file = form.get("workbook");
  if (!(file instanceof File)) return NextResponse.json({ error: "Selecione a planilha da loja." }, { status: 400 });
  if (!file.name.toLowerCase().match(/\.(xlsx|xls|xlsm|csv)$/)) return NextResponse.json({ error: "Use uma planilha Excel ou CSV." }, { status: 400 });
  if (!file.size || file.size > MAX_BYTES) return NextResponse.json({ error: "A planilha está vazia ou excede o limite de 100 MB." }, { status: 413 });
  const storeCode = new URL(request.url).searchParams.get("storeCode")?.trim() || null;
  const fileName = file.name.replace(/[^\p{L}\p{N}._ -]/gu, "_");
  await saveArruamentoWorkbook(getSql(), { store: current.store, storeCode: storeCode ?? undefined, cycle: selected.cycle, fileName, bytes: Buffer.from(await file.arrayBuffer()) });
  return NextResponse.json({ ok: true, store: current.store, cycle: selected.cycle, fileName });
}
