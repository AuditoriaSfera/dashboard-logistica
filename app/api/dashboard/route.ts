import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

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

export async function GET() {
  try { return NextResponse.json(readSnapshot()); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao carregar os dados." }, { status: 503 }); }
}

export async function POST() {
  return GET();
}
