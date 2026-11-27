create table if not exists portal_supervisor_contacts (
  regional text primary key,
  supervisor_name text not null,
  phone text not null,
  updated_by text,
  updated_at timestamptz not null default now()
);
