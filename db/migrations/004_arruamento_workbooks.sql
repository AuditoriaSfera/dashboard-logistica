-- Planilhas de conferência de arruamento, uma versão atual por loja.
create table if not exists arruamento_workbooks (
  store_key text primary key,
  store text not null,
  store_code text,
  file_name text not null,
  content bytea not null,
  updated_at timestamptz not null default now()
);

create index if not exists arruamento_workbooks_store_code_idx on arruamento_workbooks (store_code);

alter table arruamento_workbooks enable row level security;
