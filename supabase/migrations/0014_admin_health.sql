-- Per-client health, the half of it that lives in our own database.
--
-- `admin_orgs()` (0012/0013) answers "what did this client cost and who is waiting".
-- This answers the different question the panel exists for: **is this client working,
-- and if not, whose fault is it.** The other half — token expiry, whether the app is
-- still subscribed to the WABA, the phone number's quality rating — only Meta knows and
-- reaching it needs a decrypted token, so it goes through the Worker
-- (`GET /api/admin/health/:orgId`). Splitting on that line is deliberate: everything
-- answerable in SQL is answered here, for free, on Supabase's CPU.
--
-- Same shape as `admin_orgs()` and for the same reasons: `security definer` because
-- crossing orgs *is* the function (client tables are gated on `app.is_member(org_id)`
-- and a platform admin is a member of nothing), the `is_platform_admin` guard as the
-- first statement, and every number aggregated in Postgres so the 5GB egress budget
-- pays for one small row per client instead of the rows behind it.

create or replace function public.admin_health()
returns table (
  org_id uuid,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  -- Meta's status webhook, not our send path: a message we accepted and Meta then
  -- rejected. A client whose sends started failing an hour ago looks healthy by every
  -- other measure on this screen.
  last_failed_at timestamptz,
  open_windows bigint,
  -- When the longest-waiting conversation last heard from its customer. The panel turns
  -- this into "waiting 40 minutes", which is the amber rule; a count cannot say that.
  waiting_since timestamptz,
  -- { "minor": 2, "distress": 1 }. Kinds, never content — the admin holds no
  -- `org_members` row precisely so that "we cannot read your customers' messages" stays
  -- true, and a health screen is not a reason to weaken it.
  open_flags_by_kind jsonb,
  media_bytes bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- org id (as text) -> bytes. One dynamic query for every org rather than a lateral
  -- per org, because `storage.objects` has no org column to join on: the org is the
  -- first path segment of the key (`mediaPath()` in packages/shared/src/storage.ts).
  media_map jsonb := '{}'::jsonb;
begin
  if not exists (
    select 1 from users
     where id = auth.uid()
       and is_platform_admin
  ) then
    raise exception 'admin only' using errcode = '42501';
  end if;

  -- Same guard as media_bytes() in 0006: the local PG17 cluster is plain Postgres with
  -- no `storage` schema, and a static reference would fail at function creation, so the
  -- reference is deferred and missing means zero rather than an error.
  if to_regclass('storage.objects') is not null then
    execute $q$
      select coalesce(jsonb_object_agg(prefix, bytes), '{}'::jsonb)
      from (
        select
          split_part(name, '/', 1) as prefix,
          sum((metadata->>'size')::bigint) as bytes
        from storage.objects
        where bucket_id = 'media'
        group by 1
      ) s
    $q$ into media_map;
  end if;

  return query
  select
    o.id,
    m.last_in,
    m.last_out,
    m.last_failed,
    coalesce(c.open_windows, 0)::bigint,
    c.waiting_since,
    coalesce(f.by_kind, '{}'::jsonb),
    coalesce((media_map ->> o.id::text)::bigint, 0)
  from organizations o
  left join lateral (
    select
      max(created_at) filter (where direction = 'inbound') as last_in,
      max(created_at) filter (where direction = 'outbound') as last_out,
      max(status_at) filter (where status = 'failed') as last_failed
    from messages msg
    where msg.org_id = o.id
  ) m on true
  left join lateral (
    select
      -- 23h50m, not 24h, exactly as the send path treats it (message-flow.md). A screen
      -- that counts a window the sender would refuse to use is lying by ten minutes.
      count(*) filter (where conv.window_expires_at > now() + interval '10 minutes')
        as open_windows,
      -- Handoff has no timestamp of its own, and the customer's last message is the
      -- moment the wait actually started. `updated_at` is the fallback rather than a
      -- null: a conversation someone is waiting on must never drop out of the amber
      -- rule just because a column nobody guarantees happens to be empty.
      min(coalesce(conv.last_message_at, conv.updated_at))
        filter (where conv.handoff_state in ('requested', 'human')) as waiting_since
    from conversations conv
    where conv.org_id = o.id
  ) c on true
  left join lateral (
    select jsonb_object_agg(kind, n) as by_kind
    from (
      select kind, count(*) as n
      from safety_flags sf
      where sf.org_id = o.id
        and sf.resolved_at is null
      group by kind
    ) k
  ) f on true
  order by o.is_demo, o.name;
end;
$$;

revoke all on function public.admin_health() from public;

do $$
begin
  -- Supabase's default privileges grant EXECUTE on new public functions to anon and
  -- authenticated by name, so `revoke ... from public` above does not cover them —
  -- media_bytes() was callable with the anon key after exactly this mistake (0007).
  if exists (select from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.admin_health() from anon';
  end if;
  if exists (select from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.admin_health() to authenticated';
  end if;
end;
$$;
