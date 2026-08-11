-- Runtime controls per client — docs/admin-panel.md §3, build order step 2.
--
-- Every control here is a row edit. None of them is a deploy. That is the whole point:
-- "client #21 is an INSERT, not a deploy" only holds if the knobs a client asks us to
-- turn are data. If a control in this file ever starts needing a code change per
-- client, the design is wrong.
--
-- All of them are nullable-or-defaulted so that the twenty-one rows that already exist
-- keep behaving exactly as they did before this migration ran.

alter table organizations
  -- The kill switch. "The bot said something wrong, stop it now" — the DO reads this
  -- before every LLM call and hands off to a person instead of answering.
  add column if not exists ai_paused boolean not null default false,

  -- Monthly ceiling in micros of INR, matching usage_events.cost_micros. NULL means
  -- uncapped, which is what every existing client is. On exceed the DO hands off
  -- rather than replying: one client cannot drain the shared wallet (§8), and the
  -- customer still gets a person rather than silence.
  add column if not exists cap_micros bigint,

  -- Retention overrides. NULL means the platform default (12 months of text, 30 days
  -- of media), which is what the cron applied to everyone until now.
  add column if not exists retention_months int,
  add column if not exists media_retention_days int,

  -- Business hours in IST, as wall-clock times. Both NULL means always open, so
  -- nothing changes for a client who never asked for hours. Open > close is allowed
  -- and means the window crosses midnight.
  add column if not exists hours_open_ist time,
  add column if not exists hours_close_ist time,

  -- What happens outside those hours. 'reply' is today's behaviour and stays the
  -- default; 'handoff' says so to the customer and puts it in the inbox.
  add column if not exists out_of_hours text not null default 'reply';

alter table organizations
  drop constraint if exists organizations_out_of_hours_check;
alter table organizations
  add constraint organizations_out_of_hours_check
  check (out_of_hours in ('reply', 'handoff'));

alter table organizations
  drop constraint if exists organizations_cap_micros_check;
alter table organizations
  add constraint organizations_cap_micros_check
  check (cap_micros is null or cap_micros > 0);

alter table organizations
  drop constraint if exists organizations_retention_check;
alter table organizations
  add constraint organizations_retention_check
  check (
    (retention_months is null or retention_months between 1 and 84)
    and (media_retention_days is null or media_retention_days between 1 and 3650)
  );

-- ---------------------------------------------------------------------------
-- The audit hole, closed before the first admin write lands
-- ---------------------------------------------------------------------------
-- docs/admin-panel.md §1 says every admin write appends to audit_log, no exceptions.
-- That was already impossible: org_id is `not null` with an FK to organizations, so an
-- admin action belonging to no org — granting is_platform_admin by email (§6), or
-- creating the org itself (§4 step 1) — could not be written at all. Nullable now,
-- while the first admin write is being added, rather than after "no exceptions" has
-- quietly become false.
--
-- RLS is unaffected: the audit_log policy is app.is_platform_admin(), not
-- app.is_member(org_id) (0001_init.sql:363), so a null org_id is still admin-only.
alter table audit_log alter column org_id drop not null;

-- ---------------------------------------------------------------------------
-- Month-to-date spend, for the cap check
-- ---------------------------------------------------------------------------
-- The DO needs one number before it calls the model, and only for a client that has a
-- cap — which is nobody by default, so this costs an uncapped client nothing at all.
--
-- Deliberately NOT security definer and deliberately not a denormalised counter on
-- organizations. Invoker keeps usage_events' own RLS in force, so a client owner
-- calling this for their own org gets the right answer and for anyone else's gets
-- zero; the Worker holds service_role and bypasses RLS as it does everywhere else. A
-- counter would be a second source of truth for a number admin_orgs() already computes
-- live from usage_events, and the two would drift.
create or replace function public.org_month_spend(p_org_id uuid)
returns bigint
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(cost_micros), 0)::bigint
  from usage_events
  where org_id = p_org_id
    -- Invariant 12: the IST calendar month, same boundary as admin_orgs(), because a
    -- cap the client reads as "this month" has to end when their month ends.
    and created_at >= (
      date_trunc('month', (now() at time zone 'Asia/Kolkata')) at time zone 'Asia/Kolkata'
    );
$$;

revoke all on function public.org_month_spend(uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.org_month_spend(uuid) to authenticated';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The panel needs the controls next to the health
-- ---------------------------------------------------------------------------
-- Same row, same screen, one round trip. Dropped and recreated rather than replaced
-- because the return type changes.
drop function if exists public.admin_health();

create or replace function public.admin_health()
returns table (
  org_id uuid,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  last_failed_at timestamptz,
  open_windows bigint,
  waiting_since timestamptz,
  open_flags_by_kind jsonb,
  media_bytes bigint,
  ai_paused boolean,
  cap_micros bigint,
  month_spend_micros bigint,
  retention_months int,
  media_retention_days int,
  hours_open_ist text,
  hours_close_ist text,
  out_of_hours text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  media_map jsonb := '{}'::jsonb;
begin
  if not exists (
    select 1 from users
     where id = auth.uid()
       and is_platform_admin
  ) then
    raise exception 'admin only' using errcode = '42501';
  end if;

  -- storage.objects does not exist on a plain local cluster, and a migration that
  -- cannot be applied locally cannot be rehearsed. Same dodge as 0006.
  if to_regclass('storage.objects') is not null then
    execute $q$
      select coalesce(jsonb_object_agg(prefix, bytes), '{}'::jsonb)
      from (
        select split_part(name, '/', 1) as prefix,
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
    coalesce((media_map ->> o.id::text)::bigint, 0),
    o.ai_paused,
    o.cap_micros,
    coalesce(u.spend, 0)::bigint,
    o.retention_months,
    o.media_retention_days,
    to_char(o.hours_open_ist, 'HH24:MI'),
    to_char(o.hours_close_ist, 'HH24:MI'),
    o.out_of_hours
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
      count(*) filter (where conv.window_expires_at > now() + interval '10 minutes') as open_windows,
      -- Handoff has no timestamp of its own, so the wait is dated from the last
      -- message; updated_at covers a conversation handed off before anyone wrote.
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
  left join lateral (
    select sum(cost_micros) as spend
    from usage_events ue
    where ue.org_id = o.id
      and ue.created_at >= (
        date_trunc('month', (now() at time zone 'Asia/Kolkata')) at time zone 'Asia/Kolkata'
      )
  ) u on true
  order by o.is_demo, o.name;
end;
$$;

-- Same lesson as 0007, 0010 and 0012: Supabase grants EXECUTE on new public functions
-- to anon and authenticated by name, so revoking from public alone leaves a definer
-- function the signed-out world can call.
revoke all on function public.admin_health() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.admin_health() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.admin_health() to authenticated';
  end if;
end;
$$;
