import { NextResponse } from "next/server";
import { authorize } from "../../../server/auth.mjs";
import fs from "node:fs";
import path from "node:path";
import { databaseConfigured, getSql, loadDashboardFromDatabase } from "../../../server/db.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function dataDirectory() {
  return process.env.ACCESS_DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(process.cwd(), "data");
}

function readSnapshot() {
  const storedSnapshot = path.join(dataDirectory(), "dashboard-snapshot.json");
  const bundledSnapshot = path.join(process.cwd(), "data", "dashboard-snapshot.json");
  const snapshotPath = fs.existsSync(storedSnapshot) ? storedSnapshot : bundledSnapshot;
  const ordersPath = path.join(dataDirectory(), "pedidos-cumulativos.json");
  if (!fs.existsSync(snapshotPath)) throw new Error("Snapshot de dados não encontrado no servidor.");
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  if (fs.existsSync(ordersPath)) {
    const orders = JSON.parse(fs.readFileSync(ordersPath, "utf8"));
    if (orders) {
      const summary = { ...orders };
      delete summary.records;
      snapshot.orders = summary;
    } else snapshot.orders = orders;
  }
  return snapshot;
}

// Banco (Supabase) primeiro: sobrevive a deploys. Sem banco, vazio ou indisponível, usa os arquivos.
async function readSnapshotPreferringDatabase() {
  if (databaseConfigured()) {
    try {
      const sql = getSql();
      const fromDatabase = sql ? await loadDashboardFromDatabase(sql) : null;
      if (fromDatabase) return fromDatabase;
    } catch (error) {
      console.error("[dados] Banco indisponível, usando arquivos:", (error as { code?: string })?.code || (error as Error)?.message);
    }
  }
  return readSnapshot();
}

export async function GET(request: Request) {
  const access = await authorize(request);
  if (access.error) return access.error;
  try { return NextResponse.json(await readSnapshotPreferringDatabase()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao carregar os dados." }, { status: 503 }); }
}

export async function POST(request: Request) {
  return GET(request);
}
