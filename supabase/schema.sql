-- Dispatch persistence schema. Run this in Supabase SQL Editor before starting the app.
-- There are intentionally no policies for anon/authenticated: the app accesses these
-- tables only from its server using the service-role key, after server-side auth checks.
create table if not exists public.dispatch_state (
  id smallint primary key check (id = 1),
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.dispatch_state enable row level security;
revoke all on table public.dispatch_state from public, anon, authenticated;
grant select, insert, update, delete on table public.dispatch_state to service_role;

create table if not exists public.dispatch_backups (
  id uuid primary key default gen_random_uuid(),
  file text not null unique,
  payload jsonb not null,
  size_bytes bigint not null default 0,
  created_at timestamptz not null default now()
);
alter table public.dispatch_backups enable row level security;
revoke all on table public.dispatch_backups from public, anon, authenticated;
grant select, insert, update, delete on table public.dispatch_backups to service_role;

-- Keep public sign-up disabled. Create the initial account through Supabase Auth;
-- after sign-in, all authenticated Dispatch users have the same application access.
