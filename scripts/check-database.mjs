// Diagnóstico rápido do banco (sem expor dados). Uso:  DATABASE_URL=... npm run db:check
import { closeSql, getSql } from "../server/db.mjs";

const sql = getSql();
if (!sql) {
  console.error("DATABASE_URL não definida — o sistema está usando arquivos locais.");
  process.exit(1);
}

const tables = ["access_users", "access_sessions", "access_login_attempts", "access_meta", "dashboard_snapshots", "order_records", "order_imports"];
try {
  const [{ now, user }] = await sql`select now() as now, current_user as user`;
  console.log(`Conectado como ${user} (${now.toISOString()})`);
  for (const table of tables) {
    const [{ total }] = await sql`select count(*)::int as total from ${sql("public." + table)}`;
    console.log(`  ${table.padEnd(22)} ${total}`);
  }
  const snapshots = await sql`select key, source_file, updated_at from public.dashboard_snapshots order by key`;
  for (const row of snapshots) console.log(`  snapshot ${row.key}: ${row.source_file ?? "-"} (atualizado ${row.updated_at.toISOString()})`);
} catch (error) {
  console.error("Falha ao consultar o banco:", error.code || error.message);
  process.exitCode = 1;
} finally {
  await closeSql();
}
