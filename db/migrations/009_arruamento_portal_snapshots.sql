-- Mantém o snapshot original recebido do Portal para exibir todos os dados do módulo.
create table if not exists arruamento_portal_snapshots (
  store_key text not null,
  store text not null,
  store_code text not null,
  year integer not null,
  cycle integer not null,
  snapshot jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (store_key, year, cycle)
);

create index if not exists arruamento_portal_snapshots_store_idx
  on arruamento_portal_snapshots (store_key, year desc, cycle desc);
