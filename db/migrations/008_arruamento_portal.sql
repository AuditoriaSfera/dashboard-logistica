-- Fontes independentes do módulo Arruamento do Portal de Pedidos.
create table if not exists arruamento_portal_workbooks (
  store_key text not null,
  store text not null,
  store_code text,
  year integer not null default 2026,
  cycle integer not null,
  source_type text not null check (source_type in ('addresses', 'sales')),
  file_name text not null,
  content bytea not null,
  updated_at timestamptz not null default now(),
  primary key (store_key, year, cycle, source_type)
);

create index if not exists arruamento_portal_store_cycle_idx
  on arruamento_portal_workbooks (store_key, year, cycle);

create table if not exists arruamento_portal_import_history (
  id bigserial primary key,
  store_key text not null,
  store text not null,
  store_code text,
  year integer not null default 2026,
  cycle integer not null,
  source_type text not null check (source_type in ('addresses', 'sales')),
  file_name text not null,
  bytes integer not null,
  imported_at timestamptz not null default now()
);

create index if not exists arruamento_portal_history_store_idx
  on arruamento_portal_import_history (store_key, imported_at desc);
