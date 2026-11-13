create table if not exists import_history (
  id bigint generated always as identity primary key,
  source_type text not null check (source_type in ('indicators', 'orders')),
  file_name text not null,
  imported_at timestamptz not null default now(),
  source_modified_at timestamptz,
  imported_by text,
  record_count integer,
  note text,
  snapshot jsonb,
  is_baseline boolean not null default false,
  legacy_ref text unique
);

create index if not exists import_history_source_date_idx on import_history (source_type, imported_at desc);
create unique index if not exists import_history_one_baseline_per_source_idx on import_history (source_type) where is_baseline;
alter table import_history enable row level security;

-- Mantém as datas e os registros anteriores; os dados detalhados de comparação
-- passam a ser registrados nas próximas importações, sem inventar valores antigos.
insert into import_history (source_type, file_name, imported_at, imported_by, record_count, note, legacy_ref)
select 'orders', file_name, imported_at, imported_by, record_count, note, 'order:' || id::text
from order_imports
on conflict (legacy_ref) do nothing;

insert into import_history (source_type, file_name, imported_at, imported_by, note, legacy_ref)
select 'indicators', coalesce(metadata->>'fileName', entity_id, 'Novas Premiações.xlsx'), created_at,
  coalesce(actor_email, actor_name),
  case when action = 'dashboard-import' then 'Importação anterior à captura detalhada dos resultados.'
       else 'Atualização anterior à captura detalhada dos resultados.' end,
  'audit:' || id::text
from audit_events
where action in ('dashboard-import', 'dashboard-refresh')
on conflict (legacy_ref) do nothing;

-- Salva um marco com a situação atual do banco para que a próxima importação
-- já tenha uma referência comparável, sem atribuir resultados a lotes antigos.
insert into import_history (source_type, file_name, imported_at, source_modified_at, note, snapshot, is_baseline)
select 'indicators', coalesce(source_file, data->'source'->>'fileName', 'Novas Premiações.xlsx'),
  coalesce(nullif(data->'source'->>'uploadedAt', '')::timestamptz, updated_at), source_modified_at,
  'Marco inicial: estado disponível quando o histórico foi ativado; diferenças anteriores não são reconstruídas.',
  jsonb_build_object('indicators', coalesce((
    select jsonb_object_agg(key, jsonb_build_object(
      'label', value->>'label', 'unit', coalesce(value->>'unit', 'percent'),
      'value', value->'current'->'value', 'target', value->'current'->'target',
      'status', value->'current'->'status', 'count', value->'current'->'count'))
    from jsonb_each(data->'indicators')
  ), '{}'::jsonb), 'stores', coalesce((
    select jsonb_agg(jsonb_build_object('store', item->>'store', 'storeCode', item->>'storeCode',
      'indicators', coalesce((select jsonb_object_agg(key, jsonb_build_object('value', value->'value', 'target', value->'target', 'status', value->'status', 'count', value->'count')) from jsonb_each(item->'indicators')), '{}'::jsonb)))
    from jsonb_array_elements(data->'stores') item
  ), '[]'::jsonb)), true
from dashboard_snapshots where key = 'dashboard'
on conflict do nothing;

insert into import_history (source_type, file_name, imported_at, source_modified_at, note, snapshot, is_baseline)
select 'orders', coalesce(source_file, data->'source'->>'fileName', 'ConsultaPedidos.xlsx'),
  coalesce(nullif(data->'source'->>'lastImportAt', '')::timestamptz, updated_at), source_modified_at,
  'Marco inicial: estado de pedidos disponível quando o histórico foi ativado; diferenças anteriores não são reconstruídas.',
  jsonb_build_object(
    'total', coalesce((select sum((item->>'total')::numeric) from jsonb_array_elements(data->'stores') item), 0),
    'retirada', coalesce((select sum((item->>'retirada')::numeric) from jsonb_array_elements(data->'stores') item), 0),
    'entrega', coalesce((select sum((item->>'entrega')::numeric) from jsonb_array_elements(data->'stores') item), 0),
    'omni', coalesce((select sum((item->>'omni')::numeric) from jsonb_array_elements(data->'stores') item), 0),
    'revendedor', coalesce((select sum((item->>'revendedor')::numeric) from jsonb_array_elements(data->'stores') item), 0),
    'retiradaCancelados', coalesce((select sum((item->>'retiradaCancelados')::numeric) from jsonb_array_elements(data->'stores') item), 0),
    'entregaCancelados', coalesce((select sum((item->>'entregaCancelados')::numeric) from jsonb_array_elements(data->'stores') item), 0),
    'itens', coalesce((select sum((item->>'itens')::numeric) from jsonb_array_elements(data->'stores') item), 0),
    'pctRetirada', case when coalesce((select sum((item->>'total')::numeric) from jsonb_array_elements(data->'stores') item), 0) = 0 then 0 else (select sum((item->>'retirada')::numeric) from jsonb_array_elements(data->'stores') item) / (select sum((item->>'total')::numeric) from jsonb_array_elements(data->'stores') item) end,
    'pctEntrega', case when coalesce((select sum((item->>'total')::numeric) from jsonb_array_elements(data->'stores') item), 0) = 0 then 0 else (select sum((item->>'entrega')::numeric) from jsonb_array_elements(data->'stores') item) / (select sum((item->>'total')::numeric) from jsonb_array_elements(data->'stores') item) end,
    'stores', coalesce((select jsonb_agg(jsonb_build_object('store', item->>'store', 'storeCode', item->>'storeCode',
      'total', coalesce((item->>'total')::numeric, 0), 'retirada', coalesce((item->>'retirada')::numeric, 0), 'entrega', coalesce((item->>'entrega')::numeric, 0),
      'omni', coalesce((item->>'omni')::numeric, 0), 'revendedor', coalesce((item->>'revendedor')::numeric, 0),
      'retiradaCancelados', coalesce((item->>'retiradaCancelados')::numeric, 0), 'entregaCancelados', coalesce((item->>'entregaCancelados')::numeric, 0),
      'itens', coalesce((item->>'itens')::numeric, 0),
      'pctRetirada', case when coalesce((item->>'total')::numeric, 0) = 0 then 0 else coalesce((item->>'retirada')::numeric, 0) / (item->>'total')::numeric end,
      'pctEntrega', case when coalesce((item->>'total')::numeric, 0) = 0 then 0 else coalesce((item->>'entrega')::numeric, 0) / (item->>'total')::numeric end)) from jsonb_array_elements(data->'stores') item), '[]'::jsonb)
  ), true
from dashboard_snapshots where key = 'orders'
on conflict do nothing;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'dashboard_app') then
    execute 'grant select, insert, update, delete on import_history to dashboard_app';
    execute 'grant usage, select on sequence import_history_id_seq to dashboard_app';
    execute 'drop policy if exists app_full_access on import_history';
    execute 'create policy app_full_access on import_history for all to dashboard_app using (true) with check (true)';
  end if;
end $$;
