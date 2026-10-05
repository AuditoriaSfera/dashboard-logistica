// Carga inicial/atualização do Supabase a partir dos JSON versionados em data/.
// Uso:  DATABASE_URL=postgresql://... npm run db:seed
import fs from "node:fs";
import { closeSql, getSql, syncDashboardToDatabase } from "../server/db.mjs";

const sql = getSql();
if (!sql) {
  console.error("Defina DATABASE_URL (URL do transaction pooler do Supabase, porta 6543).");
  process.exit(1);
}

const read = (name) => JSON.parse(fs.readFileSync(new URL(`../data/${name}`, import.meta.url), "utf8"));
try {
  const snapshot = read("dashboard-snapshot.json");
  const ordersFile = new URL("../data/pedidos-cumulativos.json", import.meta.url);
  const orders = fs.existsSync(ordersFile) ? read("pedidos-cumulativos.json") : snapshot.orders;
  const saved = await syncDashboardToDatabase(sql, { ...snapshot, orders });
  const [{ snapshots }] = await sql`select count(*)::int as snapshots from public.dashboard_snapshots`;
  const [{ records }] = await sql`select count(*)::int as records from public.order_records`;
  console.log(`Banco atualizado: ${snapshots} snapshot(s), ${records} registro(s) de pedidos (${saved} gravados agora).`);
} finally {
  await closeSql();
}
