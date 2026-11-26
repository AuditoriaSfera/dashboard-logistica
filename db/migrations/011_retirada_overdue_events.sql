-- Registro imutável dos pedidos que passaram a constar como atrasados.
create table if not exists retirada_overdue_events (
  id uuid primary key,
  store_code text not null,
  store_name text not null,
  order_code text not null,
  cycle integer,
  capture_date date not null,
  overdue_date date not null,
  delivery_type text not null,
  capture_time text,
  created_at timestamptz not null default now(),
  unique (store_code, order_code)
);

create index if not exists retirada_overdue_cycle_store_idx
  on retirada_overdue_events (cycle, store_code, overdue_date);

create index if not exists retirada_overdue_date_idx
  on retirada_overdue_events (overdue_date desc);
