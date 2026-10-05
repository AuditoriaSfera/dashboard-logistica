import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NextResponse } from "next/server";
import { GET as authGet } from "../auth/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_WORKBOOK_BYTES = 150 * 1024 * 1024;

function dataDirectory() {
  // Match auth storage: Railway can run without a volume, using container disk
  // temporarily; when mounted, both users and snapshots use the persistent path.
  return process.env.ACCESS_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(process.cwd(), "data");
}

async function requireAdministrator(request: Request) {
  const authUrl = new URL("/api/auth?action=users", request.url);
  const authRequest = new Request(authUrl, { headers: { cookie: request.headers.get("cookie") || "" } });
  const authResponse = await authGet(authRequest);
  if (!authResponse.ok) throw new Error(authResponse.status === 401 ? "Entre novamente para atualizar os dados." : "Somente um administrador pode atualizar a planilha operacional.");
}

function writeJsonAtomically(filePath: string, value: unknown) {
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

export async function POST(request: Request) {
  let temporaryWorkbook: string | null = null;
  try {
    await requireAdministrator(request);
    const form = await request.formData();
    const file = form.get("workbook");
    if (!(file instanceof File) || !file.name.toLowerCase().match(/\.(xlsx|xls|xlsm)$/)) {
      return NextResponse.json({ error: "Selecione a planilha operacional em formato Excel (.xlsx, .xls ou .xlsm)." }, { status: 400 });
    }
    if (file.size === 0 || file.size > MAX_WORKBOOK_BYTES) {
      return NextResponse.json({ error: "A planilha está vazia ou excede o limite de 150 MB." }, { status: 413 });
    }

    const directory = dataDirectory();
    fs.mkdirSync(directory, { recursive: true });
    const id = randomUUID();
    const safeName = file.name.replace(/[^\p{L}\p{N}._ -]/gu, "_");
    temporaryWorkbook = path.join(directory, `.upload-${id}.xlsx`);
    const bytes = Buffer.from(await file.arrayBuffer());
    fs.writeFileSync(temporaryWorkbook, bytes, { flag: "wx", mode: 0o600 });

    // Load the Node ESM parser at runtime: its XLSX dependency is CommonJS and
    // should not be folded into the app-router client/server bundle.
    const parserUrl = pathToFileURL(path.resolve(process.cwd(), "server", "parser.mjs")).href;
    const { parseWorkbook } = await import(parserUrl);
    const snapshot = parseWorkbook(temporaryWorkbook);
    if (!snapshot?.stores?.length || !snapshot?.indicators || !Object.keys(snapshot.indicators).length) {
      throw new Error("A planilha não contém dados válidos de indicadores; a versão atual foi preservada.");
    }

    const workbookPath = path.join(directory, "Novas Premiações.xlsx");
    const snapshotPath = path.join(directory, "dashboard-snapshot.json");
    const ordersPath = path.join(directory, "pedidos-cumulativos.json");
    const stat = fs.statSync(temporaryWorkbook);
    snapshot.source = { ...snapshot.source, path: safeName, fileName: safeName, modifiedAt: stat.mtime.toISOString(), size: stat.size, uploadedAt: new Date().toISOString() };
    if (fs.existsSync(ordersPath)) {
      const orders = JSON.parse(fs.readFileSync(ordersPath, "utf8"));
      if (orders) {
        const summary = { ...orders };
        delete summary.records;
        snapshot.orders = summary;
      } else snapshot.orders = orders;
    } else if (fs.existsSync(snapshotPath)) {
      // Refreshing the indicator workbook must not erase an existing Orders
      // summary when that history is maintained separately.
      const previousSnapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
      if (previousSnapshot.orders) snapshot.orders = previousSnapshot.orders;
    }

    // Parse and validate completely before replacing the previous workbook or snapshot.
    fs.renameSync(temporaryWorkbook, workbookPath);
    temporaryWorkbook = null;
    writeJsonAtomically(snapshotPath, snapshot);
    return NextResponse.json({ ok: true, fileName: safeName, modifiedAt: snapshot.source.modifiedAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao atualizar a planilha operacional.";
    const status = /administrador|Entre novamente/.test(message) ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
  } finally {
    if (temporaryWorkbook && fs.existsSync(temporaryWorkbook)) fs.unlinkSync(temporaryWorkbook);
  }
}
