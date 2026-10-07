import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { authorize } from "../../../../server/auth.mjs";
import { databaseConfigured, getSql, loadOrderRecordsFromDatabase } from "../../../../server/db.mjs";

export const runtime = "nodejs";

function readFromFiles() {
  const ordersPath = path.join(process.cwd(), "data", "pedidos-cumulativos.json");
  const orders = fs.existsSync(ordersPath) ? JSON.parse(fs.readFileSync(ordersPath, "utf8")) : {};
  return { records: orders.records || [], source: orders.source || null, period: orders.period || null };
}

export async function GET(request: Request) {
  const access = await authorize(request);
  if (access.error) return access.error;
  try {
    if (databaseConfigured()) {
      try {
        const sql = getSql();
        const fromDatabase = sql ? await loadOrderRecordsFromDatabase(sql) : null;
        if (fromDatabase?.records.length) return NextResponse.json(fromDatabase);
      } catch (error) {
        console.error("[pedidos] Banco indisponível, usando arquivos:", (error as { code?: string })?.code || (error as Error)?.message);
      }
    }
    return NextResponse.json(readFromFiles());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Falha ao carregar os pedidos." }, { status: 503 });
  }
}
