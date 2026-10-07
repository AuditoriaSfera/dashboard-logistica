-- Canonical online source workbook. The administrator uploads it once;
-- subsequent refreshes reread this same file.
create table if not exists public.source_workbooks (
  key text primary key,
  file_name text not null,
  content bytea not null,
  updated_at timestamptz not null default now()
);

alter table public.source_workbooks enable row level security;
grant select, insert, update, delete on public.source_workbooks to dashboard_app;
drop policy if exists app_full_access on public.source_workbooks;
create policy app_full_access on public.source_workbooks for all to dashboard_app using (true) with check (true);
