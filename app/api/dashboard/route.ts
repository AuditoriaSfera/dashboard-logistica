import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const snapshotPath = path.join(process.cwd(), "data", "dashboard-snapshot.json");
const ordersPath = path.join(process.cwd(), "data", "pedidos-cumulativos.json");

function readSnapshot() {
  if (!fs.existsSync(snapshotPath)) throw new Error("Snapshot de dados não encontrado no servidor.");
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  if (fs.existsSync(ordersPath)) {
    const orders = JSON.parse(fs.readFileSync(ordersPath, "utf8"));
    snapshot.orders = orders ? (({ records, ...summary }: Record<string, unknown>) => summary)(orders) : orders;
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
