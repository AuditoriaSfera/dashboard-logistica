-- Dashboard Logística — esquema inicial. Aplicado automaticamente (server/db.mjs > ensureSchema) na primeira conexão.
-- Idempotente e portável: roda em qualquer Postgres (Railway, Supabase).

-- Usuários e sessões (antes em data/access-users.json, perdido a cada deploy)
create table if not exists access_users (
  id text primary key,
  name text not null,
  email text not null,
  account_type text not null check (account_type in ('admin','unit')),
  stores text[] not null default '{}',
  status text not null check (status in ('pending','approved','rejected','inactive')),
  active boolean not null,
  must_change_password boolean not null default true,
  password_hash text not null,
  phone text,
  company text,
  requested_at text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists access_users_email_key on access_users (lower(email));

create table if not exists access_sessions (
  token_hash text primary key,
  user_id text not null references access_users(id) on delete cascade,
  expires_at bigint not null
);
create index if not exists access_sessions_user_id_idx on access_sessions (user_id);
create index if not exists access_sessions_expires_at_idx on access_sessions (expires_at);

create table if not exists access_login_attempts (
  key text primary key,
  count integer not null check (count >= 0),
  expires_at bigint not null
);

create table if not exists access_meta (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- Último snapshot calculado (indicadores) e resumo de pedidos; substitui data/*.json versionados
create table if not exists dashboard_snapshots (
  key text primary key,
  data jsonb not null,
  source_file text,
  source_modified_at timestamptz,
  updated_at timestamptz not null default now()
);

-- Registros detalhados de pedidos (aba Recorrência), acumulados entre importações
create table if not exists order_records (
  record_key text primary key,
  order_code text,
  reseller text not null default '',
  channel text not null default '',
  role text not null default '',
  city text not null default '',
  store text,
  store_code text,
  cycle integer,
  value numeric(14,2) not null default 0,
  order_date date,
  canceled boolean not null default false,
  imported_at timestamptz not null default now()
);
create index if not exists order_records_date_idx on order_records (order_date);
create index if not exists order_records_reseller_idx on order_records (reseller);
create index if not exists order_records_store_idx on order_records (store_code);

-- Histórico de importações de planilhas
create table if not exists order_imports (
  id bigint generated always as identity primary key,
  file_name text not null,
  imported_at timestamptz not null default now(),
  imported_by text,
  record_count integer,
  note text
);

-- Acesso somente pelo servidor. RLS ligada e sem policy para anon/authenticated = a API pública do Supabase não lê nada.
alter table access_users enable row level security;
alter table access_sessions enable row level security;
alter table access_login_attempts enable row level security;
alter table access_meta enable row level security;
alter table dashboard_snapshots enable row level security;
alter table order_records enable row level security;
alter table order_imports enable row level security;
