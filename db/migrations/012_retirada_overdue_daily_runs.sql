-- Guarda a primeira apuração de retirada feita em cada data local, mesmo quando não há pedidos atrasados.
create table if not exists retirada_overdue_daily_runs (
  overdue_date date primary key,
  source_imported_at timestamptz not null,
  completed_at timestamptz not null default now(),
  event_count integer not null default 0
);
