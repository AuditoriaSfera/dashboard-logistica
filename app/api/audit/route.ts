import { NextResponse } from "next/server";
import { authorize } from "../../../server/auth.mjs";
import { databaseConfigured, getSql, loadAuditEvents } from "../../../server/db.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const access = await authorize(request);
  if (access.error) return access.error;
  if (access.user.accountType !== "admin") return NextResponse.json({ error: "Somente administradores podem consultar a auditoria." }, { status: 403 });
  if (!databaseConfigured()) return NextResponse.json({ events: [], warning: "A auditoria exige o banco de dados configurado." });
  try {
    const limit = new URL(request.url).searchParams.get("limit") || "200";
    return NextResponse.json({ events: await loadAuditEvents(getSql(), Number(limit)) }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Não foi possível carregar a auditoria." }, { status: 503 });
  }
}
