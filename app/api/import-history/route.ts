import { NextResponse } from "next/server";
import { authorize } from "../../../server/auth.mjs";
import { databaseConfigured, getSql, loadImportHistory } from "../../../server/db.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await authorize(request);
  if (access.error) return access.error;
  if (access.user.accountType !== "admin") {
    return NextResponse.json({ error: "Somente administradores podem consultar o histórico de importações." }, { status: 403 });
  }
  if (!databaseConfigured()) {
    return NextResponse.json({ imports: [], warning: "O histórico de importações exige o PostgreSQL conectado." }, { headers: { "cache-control": "no-store" } });
  }
  try {
    const limit = new URL(request.url).searchParams.get("limit") || "1000";
    const imports = await loadImportHistory(getSql(), Number(limit));
    return NextResponse.json({ imports }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Não foi possível carregar o histórico de importações." }, { status: 503 });
  }
}
