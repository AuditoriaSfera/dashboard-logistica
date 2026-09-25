import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const ordersPath = path.join(process.cwd(), "data", "pedidos-cumulativos.json");
    const orders = fs.existsSync(ordersPath) ? JSON.parse(fs.readFileSync(ordersPath, "utf8")) : {};
    return NextResponse.json({ records: orders.records || [], source: orders.source || null, period: orders.period || null });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao carregar os pedidos." }, { status: 503 });
  }
}
