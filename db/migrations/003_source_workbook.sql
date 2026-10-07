-- Canonical online source workbook. The administrator uploads it once;
-- subsequent refreshes reread this same file.
create table if not exists source_workbooks (
  key text primary key,
  file_name text not null,
  content bytea not null,
  updated_at timestamptz not null default now()
);

alter table source_workbooks enable row level security;

-- O papel dashboard_app só existe no Supabase; no Railway (usuário dono do banco) o bloco não faz nada.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'dashboard_app') then
    execute 'grant select, insert, update, delete on source_workbooks to dashboard_app';
    execute 'drop policy if exists app_full_access on source_workbooks';
    execute 'create policy app_full_access on source_workbooks for all to dashboard_app using (true) with check (true)';
  end if;
end $$;
