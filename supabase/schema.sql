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

-- Shared serverless coordination for Vercel function instances.
create table if not exists public.dispatch_state_lock (
  id smallint primary key check (id = 1),
  owner_token text,
  lease_until timestamptz not null default now()
);
insert into public.dispatch_state_lock (id, owner_token, lease_until)
values (1, null, now()) on conflict (id) do nothing;
alter table public.dispatch_state_lock enable row level security;
revoke all on table public.dispatch_state_lock from public, anon, authenticated;
grant select, insert, update, delete on table public.dispatch_state_lock to service_role;

create or replace function public.dispatch_try_acquire_state_lock(p_owner_token text, p_lease_seconds integer default 60)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare acquired_owner text;
begin
  insert into public.dispatch_state_lock as lock_row (id, owner_token, lease_until)
  values (1, p_owner_token, now() + make_interval(secs => greatest(10, least(p_lease_seconds, 120))))
  on conflict (id) do update
    set owner_token = excluded.owner_token, lease_until = excluded.lease_until
    where lock_row.lease_until < now() or lock_row.owner_token = p_owner_token
  returning owner_token into acquired_owner;
  return acquired_owner = p_owner_token;
end;
$$;
revoke all on function public.dispatch_try_acquire_state_lock(text, integer) from public, anon, authenticated;
grant execute on function public.dispatch_try_acquire_state_lock(text, integer) to service_role;

create or replace function public.dispatch_release_state_lock(p_owner_token text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.dispatch_state_lock set owner_token = null, lease_until = now()
  where id = 1 and owner_token = p_owner_token;
$$;
revoke all on function public.dispatch_release_state_lock(text) from public, anon, authenticated;
grant execute on function public.dispatch_release_state_lock(text) to service_role;

-- Durable voice signaling shared across independent serverless function instances.
create table if not exists public.dispatch_rtc_peers (
  peer_id text primary key,
  role text not null check (role in ('field', 'control')),
  officer_id text,
  label text not null default '',
  last_seen timestamptz not null default now()
);
create index if not exists dispatch_rtc_peers_last_seen_idx on public.dispatch_rtc_peers (last_seen desc);
alter table public.dispatch_rtc_peers enable row level security;
revoke all on table public.dispatch_rtc_peers from public, anon, authenticated;
grant select, insert, update, delete on table public.dispatch_rtc_peers to service_role;

create table if not exists public.dispatch_rtc_signals (
  id text primary key,
  recipient_peer_id text not null,
  from_peer_id text not null,
  call_id text not null,
  signal_type text not null check (signal_type in ('offer', 'answer', 'ice', 'hangup', 'reject')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists dispatch_rtc_signals_recipient_created_idx on public.dispatch_rtc_signals (recipient_peer_id, created_at);
alter table public.dispatch_rtc_signals enable row level security;
revoke all on table public.dispatch_rtc_signals from public, anon, authenticated;
grant select, insert, update, delete on table public.dispatch_rtc_signals to service_role;

-- Keep public sign-up disabled. Create the initial account through Supabase Auth;
-- after sign-in, all authenticated Dispatch users have the same application access.
