-- Cada loja pode manter uma planilha de arruamento diferente por ciclo.
alter table arruamento_workbooks add column if not exists cycle integer;
update arruamento_workbooks set cycle = 0 where cycle is null;
alter table arruamento_workbooks alter column cycle set default 0;
alter table arruamento_workbooks alter column cycle set not null;
alter table arruamento_workbooks drop constraint if exists arruamento_workbooks_pkey;
alter table arruamento_workbooks add constraint arruamento_workbooks_pkey primary key (store_key, cycle);
create index if not exists arruamento_workbooks_store_cycle_idx on arruamento_workbooks (store_key, cycle);
