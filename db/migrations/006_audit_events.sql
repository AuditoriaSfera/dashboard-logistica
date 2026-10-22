create table if not exists audit_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  actor_user_id text,
  actor_name text,
  actor_email text,
  action text not null,
  entity_type text,
  entity_id text,
  metadata jsonb not null default '{}'::jsonb,
  ip_address text,
  user_agent text
);

create index if not exists audit_events_created_at_idx on audit_events (created_at desc);
create index if not exists audit_events_action_idx on audit_events (action, created_at desc);

alter table audit_events enable row level security;
