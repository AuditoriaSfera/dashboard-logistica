-- Registro compartilhado das notas fiscais recebidas por loja.
create table if not exists receiving_invoices (
  id uuid primary key,
  invoice_number text not null,
  invoice_key text not null,
  store_code text not null,
  store_name text not null,
  received_date date not null,
  volumes integer not null check (volumes >= 0),
  entry_date date,
  entry_import_file text,
  entry_imported_at timestamptz,
  entry_registered_by text,
  entry_registered_by_name text,
  entry_registered_by_type text,
  created_by text not null,
  created_by_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_code, invoice_key)
);

create index if not exists receiving_invoices_store_received_idx
  on receiving_invoices (store_code, received_date desc);

create index if not exists receiving_invoices_entry_date_idx
  on receiving_invoices (entry_date);

-- Mantém a migração segura caso a tabela já tenha sido criada em uma versão anterior.
alter table receiving_invoices add column if not exists entry_registered_by text;
alter table receiving_invoices add column if not exists entry_registered_by_name text;
alter table receiving_invoices add column if not exists entry_registered_by_type text;
