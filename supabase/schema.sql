-- Dispatch persistence schema. Run this in Supabase SQL Editor before starting the app.
-- Global operational tables have no anon/authenticated access. Only explicitly scoped unit
-- tables expose authenticated reads, enforced by per-unit RLS policies below.
create table if not exists public.dispatch_state (
  id smallint primary key check (id between 1 and 8),
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
-- Row 1 is the hot dispatch state; row 2 holds the traffic history so that polls, messages and
-- SOS alerts never rewrite megabytes. Older installs were created with "check (id = 1)": relax it.
alter table public.dispatch_state drop constraint if exists dispatch_state_id_check;
alter table public.dispatch_state add constraint dispatch_state_id_check check (id between 1 and 8);
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
-- signed-in operators provision accounts; field users receive a single-unit RLS mapping.

-- Per-unit identity, state projection and GPS archive. Field clients read only their
-- own projection through the Supabase JWT; the server continues to write with service_role.
create table if not exists public.dispatch_unit_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  officer_id text not null unique,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.dispatch_unit_accounts enable row level security;
revoke all on table public.dispatch_unit_accounts from public, anon, authenticated;
grant select on table public.dispatch_unit_accounts to authenticated;
grant select, insert, update, delete on table public.dispatch_unit_accounts to service_role;
drop policy if exists dispatch_unit_accounts_read_self on public.dispatch_unit_accounts;
create policy dispatch_unit_accounts_read_self on public.dispatch_unit_accounts
  for select to authenticated using (user_id = auth.uid());

create table if not exists public.dispatch_unit_state (
  officer_id text primary key,
  payload jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.dispatch_unit_state enable row level security;
revoke all on table public.dispatch_unit_state from public, anon, authenticated;
grant select on table public.dispatch_unit_state to authenticated;
grant select, insert, update, delete on table public.dispatch_unit_state to service_role;
drop policy if exists dispatch_unit_state_read_assigned on public.dispatch_unit_state;
create policy dispatch_unit_state_read_assigned on public.dispatch_unit_state
  for select to authenticated using (
    exists (select 1 from public.dispatch_unit_accounts a
            where a.user_id = auth.uid() and a.officer_id = dispatch_unit_state.officer_id)
  );

create table if not exists public.dispatch_locations (
  event_id text primary key,
  officer_id text not null,
  received_at timestamptz not null,
  payload jsonb not null
);
create index if not exists dispatch_locations_officer_received_idx
  on public.dispatch_locations (officer_id, received_at desc);
alter table public.dispatch_locations enable row level security;
revoke all on table public.dispatch_locations from public, anon, authenticated;
grant select on table public.dispatch_locations to authenticated;
grant select, insert, update, delete on table public.dispatch_locations to service_role;
drop policy if exists dispatch_locations_read_assigned on public.dispatch_locations;
create policy dispatch_locations_read_assigned on public.dispatch_locations
  for select to authenticated using (
    exists (select 1 from public.dispatch_unit_accounts a
            where a.user_id = auth.uid() and a.officer_id = dispatch_locations.officer_id)
  );

-- Compact legacy GPS history out of the hot state row, preserving it in the indexed archive.
insert into public.dispatch_locations (event_id, officer_id, received_at, payload)
select coalesce(nullif(point->>'eventId',''), md5(officer->>'id' || ':' || point::text)),
       officer->>'id', coalesce(nullif(point->>'receivedAt','')::timestamptz, now()), point
from public.dispatch_state d
cross join lateral jsonb_array_elements(coalesce(d.payload->'officers','[]'::jsonb)) officer
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(officer->'history')='array' then officer->'history' else '[]'::jsonb end
) point
where nullif(officer->>'id','') is not null
on conflict (event_id) do nothing;

update public.dispatch_state d
set payload = jsonb_set(
  d.payload,
  '{officers}',
  coalesce((
    select jsonb_agg(
      (officer - 'history') || jsonb_build_object(
        'historyCount', coalesce(nullif(officer->>'historyCount','')::integer,
          jsonb_array_length(case when jsonb_typeof(officer->'history')='array' then officer->'history' else '[]'::jsonb end)),
        'latestHistoryAt', coalesce(officer->'latestHistoryAt',
          (case when jsonb_typeof(officer->'history')='array' then officer->'history' else '[]'::jsonb end)->-1->'receivedAt'),
        'historyTail', coalesce((select jsonb_agg(tail.point order by tail.ordinality) from (
          select point.value as point, point.ordinality from jsonb_array_elements(case when jsonb_typeof(officer->'history')='array' then officer->'history' else '[]'::jsonb end) with ordinality as point(value,ordinality)
          order by point.ordinality desc limit 10) tail),'[]'::jsonb)
      ) order by ordinal
    )
    from jsonb_array_elements(coalesce(d.payload->'officers','[]'::jsonb)) with ordinality as rows(officer,ordinal)
  ), '[]'::jsonb), true
)
where d.id=1 and exists (
  select 1 from jsonb_array_elements(coalesce(d.payload->'officers','[]'::jsonb)) o
  where o ? 'history'
);

create or replace function public.dispatch_sync_unit_state()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  unit jsonb;
  unit_id text;
  unit_group text;
  unit_site text;
  projection jsonb;
begin
  for unit in select value from jsonb_array_elements(coalesce(new.payload->'officers','[]'::jsonb)) loop
    unit_id := unit->>'id';
    if unit_id is null then continue; end if;
    unit_group := unit->>'group';
    unit_site := unit->>'siteId';
    projection := jsonb_build_object(
      'officer', unit - 'history' - 'historyTail',
      'officers', jsonb_build_array(jsonb_build_object('id',unit->'id','name',unit->'name','callSign',unit->'callSign','shiftId',unit->'shiftId','status',unit->'status')),
      'sites', coalesce((select jsonb_agg(site.value) from jsonb_array_elements(coalesce(new.payload->'sites','[]'::jsonb)) as site(value)
        where site.value->>'areaType'='work' and unit_site is not null and site.value->>'id'=unit_site), '[]'::jsonb),
      'messages', coalesce((select jsonb_agg(items.message order by items.message->>'createdAt' desc) from (
        select message.value as message from jsonb_array_elements(coalesce(new.payload->'messages','[]'::jsonb)) as message(value)
        where message.value->>'to'=unit_id or (message.value->>'to'='all' and (nullif(message.value->>'group','') is null or message.value->>'group'=unit_group))
        order by message.value->>'createdAt' desc limit 40) items), '[]'::jsonb),
      'alerts', coalesce((select jsonb_agg(items.alert order by items.alert->>'raisedAt' desc) from (
        select alert.value as alert from jsonb_array_elements(coalesce(new.payload->'alerts','[]'::jsonb)) as alert(value)
        where alert.value->>'type'='sos' and alert.value->>'officerId'=unit_id and alert.value->>'status'<>'handled'
        order by alert.value->>'raisedAt' desc limit 3) items), '[]'::jsonb),
      'settings', jsonb_build_object('locationInterval',coalesce(new.payload->'settings'->'locationInterval','15'::jsonb))
    );
    insert into public.dispatch_unit_state(officer_id,payload,updated_at)
    values(unit_id,projection,new.updated_at)
    on conflict(officer_id) do update set payload=excluded.payload,updated_at=now()
      where public.dispatch_unit_state.payload is distinct from excluded.payload;
  end loop;
  delete from public.dispatch_unit_state where officer_id not in (
    select value->>'id' from jsonb_array_elements(coalesce(new.payload->'officers','[]'::jsonb)) value where value ? 'id'
  );
  return new;
end;
$$;
revoke all on function public.dispatch_sync_unit_state() from public, anon, authenticated;
grant execute on function public.dispatch_sync_unit_state() to service_role;
drop trigger if exists dispatch_state_sync_unit_state on public.dispatch_state;
create trigger dispatch_state_sync_unit_state after insert or update of payload on public.dispatch_state
  for each row execute function public.dispatch_sync_unit_state();

-- Materialize unit projections for existing deployments immediately.
update public.dispatch_state set payload = payload where id=1;

-- Bounded archive read in one round trip; the JSON result avoids PostgREST's row cap.
create or replace function public.dispatch_read_locations(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_officer_id text default null,
  p_limit integer default 20001
) returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(jsonb_agg(to_jsonb(page) order by page.received_at desc), '[]'::jsonb)
  from (
    select event_id, officer_id, received_at, payload
    from public.dispatch_locations
    where (p_officer_id is null or officer_id = p_officer_id)
      and (p_from is null or received_at >= p_from)
      and (p_to is null or received_at < p_to)
    order by received_at desc
    limit greatest(1, least(coalesce(p_limit, 20001), 20001))
  ) page;
$$;
revoke all on function public.dispatch_read_locations(timestamptz,timestamptz,text,integer) from public, anon, authenticated;
grant execute on function public.dispatch_read_locations(timestamptz,timestamptz,text,integer) to service_role;

create or replace function public.dispatch_purge_simulated_locations()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare result jsonb;
begin
  delete from public.dispatch_locations
  where event_id like 'sim-%' or payload->>'source'='simulation';
  select coalesce(jsonb_object_agg(officer_id,jsonb_build_object('count',count_rows,'latest',latest_at)),'{}'::jsonb)
    into result
  from (select officer_id,count(*) as count_rows,max(received_at) as latest_at
        from public.dispatch_locations group by officer_id) counts;
  return result;
end;
$$;
revoke all on function public.dispatch_purge_simulated_locations() from public, anon, authenticated;
grant execute on function public.dispatch_purge_simulated_locations() to service_role;

-- Commit compact state, GPS points and per-unit projection trigger atomically in one request.
create or replace function public.dispatch_save_snapshot(
  p_payload jsonb,
  p_updated_at timestamptz,
  p_locations jsonb default '[]'::jsonb
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(coalesce(p_locations,'[]'::jsonb))='array' then
    insert into public.dispatch_locations(event_id,officer_id,received_at,payload)
    select item->>'event_id',item->>'officer_id',(item->>'received_at')::timestamptz,item->'payload'
    from jsonb_array_elements(coalesce(p_locations,'[]'::jsonb)) item
    where coalesce(item->>'event_id','')<>'' and coalesce(item->>'officer_id','')<>''
    on conflict(event_id) do nothing;
  end if;
  insert into public.dispatch_state(id,payload,updated_at)
  values(1,p_payload,coalesce(p_updated_at,now()))
  on conflict(id) do update set payload=excluded.payload,updated_at=excluded.updated_at;
end;
$$;
revoke all on function public.dispatch_save_snapshot(jsonb,timestamptz,jsonb) from public, anon, authenticated;
grant execute on function public.dispatch_save_snapshot(jsonb,timestamptz,jsonb) to service_role;

create or replace function public.dispatch_create_backup(p_file text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  state_payload jsonb;
  archive jsonb;
  full_payload jsonb;
  created timestamptz := now();
  bytes bigint;
begin
  select payload into state_payload from public.dispatch_state where id=1;
  if state_payload is null then raise exception 'Dispatch state is not initialized'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('eventId',event_id,'officerId',officer_id,'receivedAt',received_at,'point',payload) order by received_at),'[]'::jsonb)
    into archive from public.dispatch_locations;
  full_payload := state_payload || jsonb_build_object('locationArchive',archive);
  bytes := octet_length(full_payload::text);
  insert into public.dispatch_backups(file,payload,size_bytes,created_at)
  values(p_file,full_payload,bytes,created);
  return jsonb_build_object('file',p_file,'createdAt',created,'size',bytes);
end;
$$;
revoke all on function public.dispatch_create_backup(text) from public, anon, authenticated;
grant execute on function public.dispatch_create_backup(text) to service_role;

create or replace function public.dispatch_restore_backup(p_file text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  backup_payload jsonb;
  restored_state jsonb;
begin
  select payload into backup_payload from public.dispatch_backups where file=p_file;
  if backup_payload is null then raise exception 'Backup file not found'; end if;
  delete from public.dispatch_locations;
  if jsonb_typeof(backup_payload->'locationArchive')='array' then
    insert into public.dispatch_locations(event_id,officer_id,received_at,payload)
    select coalesce(nullif(item->>'eventId',''),md5(coalesce(item->>'officerId','')||':'||(item->'point')::text)),
           item->>'officerId',coalesce(nullif(item->>'receivedAt','')::timestamptz,now()),item->'point'
    from jsonb_array_elements(backup_payload->'locationArchive') item
    where coalesce(item->>'officerId','')<>'' and jsonb_typeof(item->'point')='object'
    on conflict(event_id) do nothing;
    restored_state := backup_payload - 'locationArchive';
  else
    insert into public.dispatch_locations(event_id,officer_id,received_at,payload)
    select coalesce(nullif(point->>'eventId',''),md5(officer->>'id'||':'||point::text)),officer->>'id',coalesce(nullif(point->>'receivedAt','')::timestamptz,now()),point
    from jsonb_array_elements(coalesce(backup_payload->'officers','[]'::jsonb)) officer
    cross join lateral jsonb_array_elements(case when jsonb_typeof(officer->'history')='array' then officer->'history' else '[]'::jsonb end) point
    where nullif(officer->>'id','') is not null
    on conflict(event_id) do nothing;
    select jsonb_set(backup_payload,'{officers}',coalesce(jsonb_agg((officer-'history')||jsonb_build_object(
      'historyCount',coalesce(nullif(officer->>'historyCount','')::integer,jsonb_array_length(case when jsonb_typeof(officer->'history')='array' then officer->'history' else '[]'::jsonb end)),
      'latestHistoryAt',coalesce(officer->'latestHistoryAt',(case when jsonb_typeof(officer->'history')='array' then officer->'history' else '[]'::jsonb end)->-1->'receivedAt'),
      'historyTail',coalesce((select jsonb_agg(tail.point order by tail.ordinality) from (
        select point.value as point,point.ordinality from jsonb_array_elements(case when jsonb_typeof(officer->'history')='array' then officer->'history' else '[]'::jsonb end) with ordinality as point(value,ordinality)
        order by point.ordinality desc limit 10) tail),'[]'::jsonb)) order by ordinal),'[]'::jsonb),true)
    into restored_state from jsonb_array_elements(coalesce(backup_payload->'officers','[]'::jsonb)) with ordinality as units(officer,ordinal);
  end if;
  insert into public.dispatch_state(id,payload,updated_at) values(1,restored_state,now())
  on conflict(id) do update set payload=excluded.payload,updated_at=excluded.updated_at;
  return jsonb_build_object('restoredAt',now(),'unitCount',jsonb_array_length(coalesce(restored_state->'officers','[]'::jsonb)));
end;
$$;
revoke all on function public.dispatch_restore_backup(text) from public, anon, authenticated;
grant execute on function public.dispatch_restore_backup(text) to service_role;

create or replace function public.dispatch_unit_schema_ready()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select to_regclass('public.dispatch_unit_accounts') is not null
    and to_regclass('public.dispatch_unit_state') is not null
    and to_regclass('public.dispatch_locations') is not null
    and to_regprocedure('public.dispatch_read_locations(timestamp with time zone,timestamp with time zone,text,integer)') is not null
    and to_regprocedure('public.dispatch_save_snapshot(jsonb,timestamp with time zone,jsonb)') is not null
    and to_regprocedure('public.dispatch_purge_simulated_locations()') is not null
    and to_regprocedure('public.dispatch_prune_locations(timestamp with time zone)') is not null
    and to_regprocedure('public.dispatch_create_backup(text)') is not null
    and to_regprocedure('public.dispatch_restore_backup(text)') is not null
    and exists(select 1 from pg_trigger where tgname='dispatch_state_sync_unit_state' and not tgisinternal)
    and (select relrowsecurity from pg_class where oid='public.dispatch_unit_accounts'::regclass)
    and (select relrowsecurity from pg_class where oid='public.dispatch_unit_state'::regclass)
    and (select relrowsecurity from pg_class where oid='public.dispatch_locations'::regclass)
    and exists(select 1 from pg_policies where schemaname='public' and tablename='dispatch_unit_accounts' and policyname='dispatch_unit_accounts_read_self')
    and exists(select 1 from pg_policies where schemaname='public' and tablename='dispatch_unit_state' and policyname='dispatch_unit_state_read_assigned')
    and exists(select 1 from pg_policies where schemaname='public' and tablename='dispatch_locations' and policyname='dispatch_locations_read_assigned');
$$;
revoke all on function public.dispatch_unit_schema_ready() from public, anon, authenticated;
grant execute on function public.dispatch_unit_schema_ready() to service_role;


create or replace function public.dispatch_prune_locations(p_before timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare removed bigint; unit_counts jsonb;
begin
  delete from public.dispatch_locations where received_at < p_before;
  get diagnostics removed = row_count;
  select coalesce(jsonb_object_agg(officer_id,jsonb_build_object('count',point_count,'latest',latest_at)),'{}'::jsonb)
    into unit_counts from (select officer_id,count(*) as point_count,max(received_at) as latest_at from public.dispatch_locations group by officer_id) summary;
  return jsonb_build_object('deleted',removed,'units',unit_counts);
end;
$$;
revoke all on function public.dispatch_prune_locations(timestamptz) from public, anon, authenticated;
grant execute on function public.dispatch_prune_locations(timestamptz) to service_role;
