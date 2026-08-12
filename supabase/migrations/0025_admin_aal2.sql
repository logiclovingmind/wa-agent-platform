-- The second factor, enforced in the database as well as in the Worker.
--
-- The Worker's `denyAdmin()` covers `/api/admin/*` and the wallet, and it would be easy
-- to stop there and believe the panel was locked. It is not: `Admin.tsx` calls
-- `admin_orgs()` and `admin_health()` **straight from the browser** over PostgREST, and
-- `audit_log`, `users` and `org_members` are read the same way under RLS policies whose
-- whole condition is `app.is_platform_admin()`. None of that traffic passes through the
-- Worker, so none of it saw the guard. A password alone still read every client's
-- health, the org list, the flag queue and the audit log.
--
-- One function is the fix, because every one of those paths already funnels through it.
--
-- The rule is conditional, exactly as it is in `auth.ts`: an admin with no verified
-- factor is owed nothing. That is not laxity, it is what makes the change deployable —
-- the screen that enrols a factor is reached with the same session this function gates,
-- so an unconditional aal2 requirement would lock out the only account that could ever
-- satisfy it, with no way back in short of SQL.
--
-- `auth.jwt()` is the session's own claims; `aal` is absent on anything but a real
-- GoTrue session, and `coalesce` reads absent as aal1 — deny, never allow.
create or replace function app.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select u.is_platform_admin from users u where u.id = auth.uid()), false)
     and (
       not exists (
         select 1
           from auth.mfa_factors f
          where f.user_id = auth.uid()
            and f.status = 'verified'
       )
       or coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
     );
$$;

-- The function is security definer and reads a table in `auth`, which `authenticated`
-- has no rights to. The definer's owner does, and that is the point: a client can never
-- read the factor list, only be judged against it.
comment on function app.is_platform_admin() is
  'True when the caller is a platform admin AND, if they have enrolled a verified MFA '
  'factor, the current session has actually used it (aal2). No factor enrolled means no '
  'aal2 requirement, so enrolment stays reachable.';

-- ---------------------------------------------------------------------------
-- The three admin RPCs, whose guards did not go through the helper above.
--
-- Rewriting `app.is_platform_admin()` alone would have looked like a fix and covered
-- only the RLS policies. `admin_orgs()`, `admin_health()` and `admin_flags()` each
-- **inlined** the same test — `select 1 from users where id = auth.uid() and
-- is_platform_admin` — so they would have kept answering an aal1 session, and they are
-- exactly what the browser calls directly. Every guard now goes through one function,
-- which is the only reason the rule above is worth anything.
--
-- Bodies are otherwise byte-for-byte what was already deployed: taken from
-- `pg_get_functiondef` on the migrated local cluster, with the guard block swapped and
-- nothing else touched. `create or replace` keeps the return type, so no drop is
-- needed and no grant is lost.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_flags()
 RETURNS TABLE(id uuid, org_id uuid, org_name text, conversation_id uuid, kind safety_kind, detected_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- `users.id`, not `id`: this function returns a column called `id`, and in plpgsql a
  -- RETURNS TABLE name is a variable that an unqualified column reference collides with.
  if not app.is_platform_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
  select sf.id, sf.org_id, o.name, sf.conversation_id, sf.kind, sf.detected_at
  from safety_flags sf
  join organizations o on o.id = sf.org_id
  where sf.resolved_at is null
  order by sf.detected_at
  limit 200;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_health()
 RETURNS TABLE(org_id uuid, last_inbound_at timestamp with time zone, last_outbound_at timestamp with time zone, last_failed_at timestamp with time zone, open_windows bigint, waiting_since timestamp with time zone, open_flags_by_kind jsonb, media_bytes bigint, ai_paused boolean, cap_micros bigint, month_spend_micros bigint, retention_months integer, media_retention_days integer, hours_open_ist text, hours_close_ist text, out_of_hours text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  media_map jsonb := '{}'::jsonb;
begin
  if not app.is_platform_admin() then
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
$function$;

CREATE OR REPLACE FUNCTION public.admin_orgs()
 RETURNS TABLE(org_id uuid, name text, sector text, is_demo boolean, month_cost_micros bigint, month_events bigint, open_flags bigint, waiting bigint, conversations bigint, last_message_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not app.is_platform_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  return query
  select
    o.id,
    o.name,
    o.sector,
    o.is_demo,
    coalesce(u.cost, 0)::bigint,
    coalesce(u.events, 0)::bigint,
    coalesce(f.open, 0)::bigint,
    coalesce(c.waiting, 0)::bigint,
    coalesce(c.total, 0)::bigint,
    c.last_at
  from organizations o
  left join lateral (
    select
      sum(cost_micros) as cost,
      count(*) as events
    from usage_events ue
    where ue.org_id = o.id
      and ue.created_at >= (
        date_trunc('month', (now() at time zone 'Asia/Kolkata')) at time zone 'Asia/Kolkata'
      )
  ) u on true
  left join lateral (
    select count(*) as open
    from safety_flags sf
    where sf.org_id = o.id
      and sf.resolved_at is null
  ) f on true
  left join lateral (
    select
      count(*) as total,
      count(*) filter (where handoff_state in ('requested', 'human')) as waiting,
      max(conv.last_message_at) as last_at
    from conversations conv
    where conv.org_id = o.id
  ) c on true
  -- Paying clients first, the demo last: this table is read to find out who needs
  -- attention, and the showcase org never does.
  order by o.is_demo, o.name;
end;
$function$;
