-- Papel dedicado do servidor (privilégio mínimo). NÃO commite a senha: substitua <SENHA> ao executar.
-- A senha real vive só na variável DATABASE_URL do Railway.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'dashboard_app') then
    create role dashboard_app login password '<SENHA>' nosuperuser nocreatedb nocreaterole;
  end if;
end $$;

grant usage on schema public to dashboard_app;
grant select, insert, update, delete on
  public.access_users, public.access_sessions, public.access_login_attempts, public.access_meta,
  public.dashboard_snapshots, public.order_records, public.order_imports
to dashboard_app;
grant usage, select on all sequences in schema public to dashboard_app;

do $$
declare t text;
begin
  foreach t in array array['access_users','access_sessions','access_login_attempts','access_meta','dashboard_snapshots','order_records','order_imports']
  loop
    execute format('drop policy if exists app_full_access on public.%I', t);
    execute format('create policy app_full_access on public.%I for all to dashboard_app using (true) with check (true)', t);
  end loop;
end $$;
