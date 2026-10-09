import { NextResponse } from "next/server";
import { databaseConfigured, databaseStatus, getSql } from "../../../server/db.mjs";
import { oneDriveConfigured } from "../../../server/onedrive.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Diagnóstico público e SEM dados sensíveis: serve para o TI/outras IAs saberem se o banco está de fato em uso
// (o sistema cai para arquivos quando o banco falha, o que sozinho esconderia o problema).
export async function GET() {
  const configured = databaseConfigured();
  const body: Record<string, unknown> = {
    ok: true,
    time: new Date().toISOString(),
    commit: (process.env.RAILWAY_GIT_COMMIT_SHA || "").slice(0, 7) || null,
    railway: Boolean(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_ID),
    onedriveConfigured: oneDriveConfigured(),
    database: { configured, connected: false },
    dataSource: "files",
  };
  let status = 200;
  if (configured) {
    try {
      const database = await databaseStatus(getSql());
      body.database = { configured: true, connected: true, ...database };
      body.dataSource = database.snapshots.some((snapshot: { key: string }) => snapshot.key === "dashboard") ? "database" : "files (banco ainda vazio: importe a planilha)";
    } catch (error) {
      body.ok = false;
      body.database = { configured: true, connected: false, error: (error as { code?: string })?.code || "ERRO_DE_CONEXAO" };
      body.dataSource = "files (FALLBACK: banco indisponível)";
      status = 503;
    }
  } else {
    body.dataSource = "files (DATABASE_URL não configurada)";
  }
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}
