import { createRequire } from "node:module";
import path from "node:path";

// O driver é carregado em tempo de execução (e não importado estaticamente) de propósito: o empacotador do
// vinext usa a condição "workerd" e embutiria a variante do Cloudflare (importa cloudflare:sockets), que
// quebra no Node do Railway com ERR_UNSUPPORTED_ESM_URL_SCHEME. Não troque por `import postgres from "postgres"`.
const nodeRequire = createRequire(path.join(process.cwd(), "package.json"));
const loadPostgres = () => {
  const loaded = nodeRequire("postgres");
  return loaded.default ?? loaded;
};

// Conexão com o Supabase (Postgres). Só existe quando DATABASE_URL está definida; sem ela o sistema
// continua usando arquivos locais (data/*.json), como antes.
// Use a URL do *transaction pooler* (porta 6543): o Railway não alcança o host direto (IPv6).
const TEXT_ARRAY = 1009;
const SNAPSHOT_KEY = "dashboard";
const ORDERS_KEY = "orders";
const BATCH = 500;

let cached = null;

export function databaseConfigured(environment = process.env) {
  return Boolean(environment.DATABASE_URL);
}

export function getSql(environment = process.env) {
  const url = environment.DATABASE_URL;
  if (!url) return null;
  if (cached?.url === url) return cached.sql;
  if (cached) cached.sql.end({ timeout: 1 }).catch(() => {});
  const sql = loadPostgres()(url, {
    ssl: environment.DATABASE_SSL === "disable" ? false : "require",
    prepare: false, // exigido pelo pooler em modo transaction
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => {},
  });
  cached = { url, sql };
  return sql;
}

export async function closeSql() {
  if (!cached) return;
  const { sql } = cached;
  cached = null;
  await sql.end({ timeout: 5 });
}

// A single canonical workbook lets the online refresh button reread the last
// uploaded source without requiring the administrator to upload it again.
export async function saveSourceWorkbook(sql, { fileName, bytes }) {
  await sql`
    insert into public.source_workbooks (key, file_name, content)
    values ('operations', ${fileName}, ${bytes})
    on conflict (key) do update set file_name = excluded.file_name, content = excluded.content, updated_at = now()`;
}

export async function loadSourceWorkbook(sql) {
  const [row] = await sql`select file_name, content from public.source_workbooks where key = 'operations'`;
  return row?.content ? { fileName: row.file_name, bytes: Buffer.from(row.content) } : null;
}

// ───────────── Acesso (usuários, sessões, tentativas de login) ─────────────

const ACCESS_LOCK = 727001;

function rowToUser(row) {
  const user = {
    id: row.id, name: row.name, email: row.email, accountType: row.account_type,
    stores: [...(row.stores || [])], status: row.status, active: row.active,
    mustChangePassword: row.must_change_password, passwordHash: row.password_hash,
  };
  if (row.phone != null) user.phone = row.phone;
  if (row.company != null) user.company = row.company;
  if (row.requested_at != null) user.requestedAt = row.requested_at;
  return user;
}

export async function loadAccessStore(tx) {
  const users = await tx`select * from public.access_users order by created_at, id`;
  const sessions = await tx`select token_hash, user_id, expires_at from public.access_sessions`;
  const attempts = await tx`select key, count, expires_at from public.access_login_attempts`;
  const [meta] = await tx`select value from public.access_meta where key = 'resetRequests'`;
  return {
    version: 2,
    users: users.map(rowToUser),
    sessions: sessions.map((row) => ({ tokenHash: row.token_hash, userId: row.user_id, expiresAt: Number(row.expires_at) })),
    loginAttempts: Object.fromEntries(attempts.map((row) => [row.key, { count: Number(row.count), expiresAt: Number(row.expires_at) }])),
    resetRequests: Array.isArray(meta?.value) ? meta.value : [],
  };
}

export async function saveAccessStore(tx, store) {
  const userIds = store.users.map((user) => user.id);
  // Remove primeiro (cascade apaga as sessões do usuário) e depois grava o estado atual.
  await tx`delete from public.access_users where not (id = any(${tx.array(userIds, TEXT_ARRAY)}))`;
  for (const user of store.users) {
    await tx`
      insert into public.access_users (id, name, email, account_type, stores, status, active, must_change_password, password_hash, phone, company, requested_at)
      values (${user.id}, ${user.name}, ${user.email}, ${user.accountType}, ${tx.array(user.stores, TEXT_ARRAY)}, ${user.status}, ${user.active}, ${user.mustChangePassword}, ${user.passwordHash}, ${user.phone ?? null}, ${user.company ?? null}, ${user.requestedAt ?? null})
      on conflict (id) do update set
        name = excluded.name, email = excluded.email, account_type = excluded.account_type, stores = excluded.stores,
        status = excluded.status, active = excluded.active, must_change_password = excluded.must_change_password,
        password_hash = excluded.password_hash, phone = excluded.phone, company = excluded.company,
        requested_at = excluded.requested_at, updated_at = now()`;
  }
  const hashes = store.sessions.map((session) => session.tokenHash);
  await tx`delete from public.access_sessions where not (token_hash = any(${tx.array(hashes, TEXT_ARRAY)}))`;
  for (const session of store.sessions) {
    await tx`
      insert into public.access_sessions (token_hash, user_id, expires_at)
      values (${session.tokenHash}, ${session.userId}, ${session.expiresAt})
      on conflict (token_hash) do update set expires_at = excluded.expires_at`;
  }
  const keys = Object.keys(store.loginAttempts);
  await tx`delete from public.access_login_attempts where not (key = any(${tx.array(keys, TEXT_ARRAY)}))`;
  for (const [key, attempt] of Object.entries(store.loginAttempts)) {
    await tx`
      insert into public.access_login_attempts (key, count, expires_at) values (${key}, ${attempt.count}, ${attempt.expiresAt})
      on conflict (key) do update set count = excluded.count, expires_at = excluded.expires_at`;
  }
  await tx`
    insert into public.access_meta (key, value) values ('resetRequests', ${tx.json(store.resetRequests || [])})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

/**
 * Executa `work(tx, helpers)` numa transação com lock global do módulo de acesso (equivalente ao
 * arquivo .lock). `work` devolve { value, thrown }: um erro de negócio (ex.: login inválido) precisa
 * confirmar a transação (contadores de tentativa) e só depois ser relançado.
 */
export async function withAccessTransaction(sql, work) {
  const outcome = await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${ACCESS_LOCK})`;
    return work(tx);
  });
  if (outcome.thrown) throw outcome.thrown;
  return outcome.value;
}

// ───────────── Dados do dashboard (snapshot e pedidos) ─────────────

const withoutRecords = (orders) => (orders ? (({ records, ...summary }) => summary)(orders) : orders);

export async function saveSnapshotToDatabase(sql, { snapshot, orders }) {
  const { orders: _ignored, ...dashboard } = snapshot;
  const sourceFile = dashboard.source?.fileName ?? null;
  const modifiedAt = dashboard.source?.modifiedAt ?? null;
  await sql`
    insert into public.dashboard_snapshots (key, data, source_file, source_modified_at)
    values (${SNAPSHOT_KEY}, ${sql.json(dashboard)}, ${sourceFile}, ${modifiedAt})
    on conflict (key) do update set data = excluded.data, source_file = excluded.source_file,
      source_modified_at = excluded.source_modified_at, updated_at = now()`;
  const summary = withoutRecords(orders ?? snapshot.orders);
  if (summary) {
    await sql`
      insert into public.dashboard_snapshots (key, data, source_file, source_modified_at)
      values (${ORDERS_KEY}, ${sql.json(summary)}, ${summary.source?.fileName ?? null}, ${summary.source?.modifiedAt ?? null})
      on conflict (key) do update set data = excluded.data, source_file = excluded.source_file,
        source_modified_at = excluded.source_modified_at, updated_at = now()`;
  }
}

const recordKey = (record) => String(record.orderCode || `${record.storeCode || record.store || ""}|${record.date || ""}|${record.reseller || ""}|${record.value || 0}`);

export async function saveOrderRecords(sql, records) {
  let saved = 0;
  for (let start = 0; start < records.length; start += BATCH) {
    const rows = records.slice(start, start + BATCH).map((record) => ({
      record_key: recordKey(record),
      order_code: record.orderCode ? String(record.orderCode) : null,
      reseller: String(record.reseller ?? ""),
      channel: String(record.channel ?? ""),
      role: String(record.role ?? ""),
      city: String(record.city ?? ""),
      store: record.store ?? null,
      store_code: record.storeCode ?? null,
      cycle: record.cycle ?? null,
      value: Number(record.value) || 0,
      order_date: /^\d{4}-\d{2}-\d{2}/.test(String(record.date ?? "")) ? String(record.date).slice(0, 10) : null,
      canceled: Boolean(record.canceled),
    }));
    // Mesma chave dentro do lote não pode aparecer duas vezes no upsert.
    const unique = [...new Map(rows.map((row) => [row.record_key, row])).values()];
    await sql`
      insert into public.order_records ${sql(unique, "record_key", "order_code", "reseller", "channel", "role", "city", "store", "store_code", "cycle", "value", "order_date", "canceled")}
      on conflict (record_key) do update set reseller = excluded.reseller, channel = excluded.channel, role = excluded.role,
        city = excluded.city, store = excluded.store, store_code = excluded.store_code, cycle = excluded.cycle,
        value = excluded.value, order_date = excluded.order_date, canceled = excluded.canceled, imported_at = now()`;
    saved += unique.length;
  }
  return saved;
}

export async function logOrderImport(sql, { fileName, recordCount, importedBy = null, note = null }) {
  await sql`insert into public.order_imports (file_name, record_count, imported_by, note) values (${fileName}, ${recordCount ?? null}, ${importedBy}, ${note})`;
}

/** Grava o resultado completo de um refresh/importação (snapshot + resumo + registros detalhados). */
export async function syncDashboardToDatabase(sql, snapshot) {
  await saveSnapshotToDatabase(sql, { snapshot, orders: snapshot.orders });
  const records = snapshot.orders?.records || [];
  return records.length ? saveOrderRecords(sql, records) : 0;
}

/** Último snapshot salvo no banco, no mesmo formato de data/dashboard-snapshot.json (orders sem registros). */
export async function loadDashboardFromDatabase(sql) {
  const rows = await sql`select key, data from public.dashboard_snapshots where key in (${SNAPSHOT_KEY}, ${ORDERS_KEY})`;
  const dashboard = rows.find((row) => row.key === SNAPSHOT_KEY)?.data;
  if (!dashboard) return null;
  const orders = rows.find((row) => row.key === ORDERS_KEY)?.data;
  return orders ? { ...dashboard, orders } : dashboard;
}

export async function loadOrderRecordsFromDatabase(sql) {
  const [summary] = await sql`select data from public.dashboard_snapshots where key = ${ORDERS_KEY}`;
  const rows = await sql`
    select order_code, reseller, channel, role, city, store, store_code, cycle, value, order_date, canceled
    from public.order_records order by order_date desc nulls last, record_key`;
  return {
    records: rows.map((row) => ({
      orderCode: row.order_code || "", reseller: row.reseller, channel: row.channel, role: row.role, city: row.city,
      store: row.store ?? undefined, storeCode: row.store_code ?? undefined, cycle: row.cycle, value: Number(row.value),
      date: row.order_date ? (row.order_date instanceof Date ? row.order_date.toISOString().slice(0, 10) : String(row.order_date).slice(0, 10)) : null,
      canceled: row.canceled,
    })),
    source: summary?.data?.source ?? null,
    period: summary?.data?.period ?? null,
  };
}
