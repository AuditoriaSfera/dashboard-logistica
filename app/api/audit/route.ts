import { NextResponse } from "next/server";
import { authorize } from "../../../server/auth.mjs";
import { databaseConfigured, getSql, loadAuditEvents, logAuditEvent } from "../../../server/db.mjs";

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

const CLIENT_ACTIONS = new Set(["session-start", "session-heartbeat", "session-end", "view-open"]);

export async function POST(request: Request) {
  const access = await authorize(request);
  if (access.error) return access.error;
  if (!databaseConfigured()) return NextResponse.json({ ok: false, warning: "A auditoria exige o banco de dados configurado." });
  try {
    const body = await request.json() as { action?: string; sessionId?: string; view?: string; durationSeconds?: number };
    if (!body.action || !CLIENT_ACTIONS.has(body.action)) return NextResponse.json({ error: "Evento de auditoria inválido." }, { status: 400 });
    const metadata = {
      sessionId: typeof body.sessionId === "string" ? body.sessionId.slice(0, 80) : null,
      view: typeof body.view === "string" ? body.view.slice(0, 80) : null,
      durationSeconds: Number.isFinite(body.durationSeconds) ? Math.max(0, Math.round(Number(body.durationSeconds))) : null,
    };
    await logAuditEvent(getSql(), { actor: access.user, action: body.action, entityType: body.action === "view-open" ? "dashboard-view" : "session", entityId: metadata.view || metadata.sessionId, request, metadata });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Não foi possível registrar a auditoria." }, { status: 400 });
  }
}
