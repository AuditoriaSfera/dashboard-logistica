import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { NextResponse } from "next/server";
import { GET as authGet } from "../auth/route";
import { databaseConfigured, getSql, loadDashboardFromDatabase, loadSourceWorkbook, saveSnapshotToDatabase, saveSourceWorkbook } from "../../../server/db.mjs";
import { loadOneDriveWorkbook, oneDriveConfigured } from "../../../server/onedrive.mjs";

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
  let uploaded = false;
  let connectedModifiedAt: string | null = null;
  try {
    await requireAdministrator(request);
    const directory = dataDirectory();
    fs.mkdirSync(directory, { recursive: true });
    let sourceName = "Novas Premiações.xlsx";
    let bytes: Buffer | null = null;
    const contentType = request.headers.get("content-type") || "";
    if (contentType.toLowerCase().startsWith("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("workbook");
      if (file instanceof File) {
        if (!file.name.toLowerCase().match(/\.(xlsx|xls|xlsm)$/)) {
          return NextResponse.json({ error: "Selecione a planilha operacional em formato Excel (.xlsx, .xls ou .xlsm)." }, { status: 400 });
        }
        if (file.size === 0 || file.size > MAX_WORKBOOK_BYTES) {
          return NextResponse.json({ error: "A planilha está vazia ou excede o limite de 150 MB." }, { status: 413 });
        }
        sourceName = file.name;
        bytes = Buffer.from(await file.arrayBuffer());
        uploaded = true;
      }
    }

    const sourcePath = path.join(directory, "Novas Premiações.xlsx");
    if (!bytes && oneDriveConfigured()) {
      const connected = await loadOneDriveWorkbook();
      if (connected) {
        sourceName = connected.fileName;
        bytes = connected.bytes;
        connectedModifiedAt = connected.modifiedAt;
      }
    }
    if (!bytes && fs.existsSync(sourcePath)) bytes = fs.readFileSync(sourcePath);
    if (!bytes && databaseConfigured()) {
      const stored = await loadSourceWorkbook(getSql());
      if (stored) { sourceName = stored.fileName; bytes = stored.bytes; }
    }
    if (!bytes) return NextResponse.json({ error: "Nenhuma planilha-base foi cadastrada. Importe a planilha uma vez como administrador." }, { status: 400 });

    const id = randomUUID();
    const safeName = sourceName.replace(/[^\p{L}\p{N}._ -]/gu, "_");
    temporaryWorkbook = path.join(directory, `.upload-${id}.xlsx`);
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
    snapshot.source = { ...snapshot.source, path: safeName, fileName: safeName, modifiedAt: connectedModifiedAt || stat.mtime.toISOString(), size: stat.size, uploadedAt: new Date().toISOString() };
    // Com banco, o resumo de pedidos já salvo lá é a fonte mais atual (os arquivos do container podem ser antigos).
    let databaseOrders: unknown = null;
    if (databaseConfigured()) {
      try { databaseOrders = (await loadDashboardFromDatabase(getSql()))?.orders ?? null; }
      catch (error) { console.error("[refresh] Banco indisponível ao ler pedidos:", (error as { code?: string })?.code || (error as Error)?.message); }
    }
    if (databaseOrders) {
      snapshot.orders = databaseOrders;
    } else if (fs.existsSync(ordersPath)) {
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
    if (uploaded) {
      fs.renameSync(temporaryWorkbook, workbookPath);
      temporaryWorkbook = null;
      if (databaseConfigured()) await saveSourceWorkbook(getSql(), { fileName: safeName, bytes });
    }
    writeJsonAtomically(snapshotPath, snapshot);
    // Persistência definitiva: o disco do container é apagado a cada deploy, o banco não.
    let persisted = false;
    if (databaseConfigured()) {
      try {
        await saveSnapshotToDatabase(getSql(), { snapshot, orders: snapshot.orders });
        persisted = true;
      } catch (error) {
        console.error("[refresh] Falha ao gravar no banco:", (error as { code?: string })?.code || (error as Error)?.message);
      }
    }
    return NextResponse.json({ ok: true, fileName: safeName, modifiedAt: snapshot.source.modifiedAt, persisted, connectedSource: Boolean(connectedModifiedAt), reusedSource: !uploaded });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha ao atualizar a planilha operacional.";
    const status = /administrador|Entre novamente/.test(message) ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
  } finally {
    if (temporaryWorkbook && fs.existsSync(temporaryWorkbook)) fs.unlinkSync(temporaryWorkbook);
  }
}
