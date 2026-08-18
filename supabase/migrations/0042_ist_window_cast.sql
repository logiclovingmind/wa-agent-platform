-- Every "last N IST days" window was 5h30m too late on Supabase, and the Desk's "today"
-- panel was empty because of it.
--
-- `<date> at time zone 'Asia/Kolkata'` looks like it means "IST midnight as an instant".
-- It does not. `date` has an implicit cast to both `timestamp` and `timestamptz`, and
-- `timestamptz` is the preferred type in the datetime category, so Postgres resolves the
-- call to `timezone(text, timestamptz) -> timestamp` — the *opposite* direction. The date
-- is first read as midnight in the **server's** TimeZone, then rendered as IST wall clock,
-- and the result is a naive timestamp that the comparison against `created_at` casts back
-- using the server TimeZone again.
--
-- On a server running IST the two mistakes cancel exactly, which is why local dev, the
-- test suite and every review of this code said it was right. Supabase runs UTC, where
-- they compound into a +5:30 shift:
--
--   p_days => 1, IST 2026-08-19 05:08
--   server TimeZone = Asia/Kolkata  ->  since = 2026-08-19 00:00+05:30   (correct)
--   server TimeZone = UTC           ->  since = 2026-08-19 05:30+00      (5h30m in the future)
--
-- A `since` in the future matches nothing, so `pulse_daily(org, 1)` returned zero rows and
-- the Desk read 0 enquiries / 0 after hours / no typical reply while the org had 156
-- messages that same IST day. At p_days >= 2 the boundary is in the past and the window
-- looks fine, which is why Flowin's 30 day chart still drew — it was quietly losing the
-- first 5h30m of its earliest day.
--
-- `::timestamp` makes the intended overload unambiguous: `timezone(text, timestamp) ->
-- timestamptz`, "this wall clock reading, in IST, as an instant". Day bucketing was never
-- affected — `created_at at time zone 'Asia/Kolkata'` starts from a timestamptz and already
-- resolves the right way.

create or replace function public.usage_daily(p_days int default 30)
returns table (day date, events bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    (created_at at time zone 'Asia/Kolkata')::date as day,
    count(*)::bigint
  from usage_events
  where created_at >= (
    ((now() at time zone 'Asia/Kolkata')::date - (least(greatest(p_days, 1), 400) - 1))::timestamp
      at time zone 'Asia/Kolkata'
  )
  group by 1
  order by 1;
$$;

create or replace function public.pulse_daily(p_org_id uuid, p_days int default 30)
returns table (
  day date,
  inbound bigint,
  outbound bigint,
  ai_replies bigint,
  conversations bigint,
  after_hours bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with bounds as (
    select
      ((now() at time zone 'Asia/Kolkata')::date - (least(greatest(p_days, 1), 400) - 1))::timestamp
        at time zone 'Asia/Kolkata' as since,
      (select hours_open_ist from organizations where id = p_org_id) as open_at,
      (select hours_close_ist from organizations where id = p_org_id) as close_at
  ),
  msg as (
    select
      (m.created_at at time zone 'Asia/Kolkata')::date as day,
      count(*) filter (where m.direction = 'inbound') as inbound,
      count(*) filter (where m.direction = 'outbound') as outbound,
      count(distinct m.conversation_id) as conversations,
      count(*) filter (
        where m.direction = 'outbound'
          and b.open_at is not null
          and (m.created_at at time zone 'Asia/Kolkata')::time not between b.open_at and b.close_at
      ) as after_hours
    from messages m
    cross join bounds b
    where m.org_id = p_org_id and m.created_at >= b.since
    group by 1
  ),
  ai as (
    select (u.created_at at time zone 'Asia/Kolkata')::date as day, count(*) as ai_replies
    from usage_events u
    cross join bounds b
    where u.org_id = p_org_id and u.created_at >= b.since
    group by 1
  )
  select
    coalesce(msg.day, ai.day),
    coalesce(msg.inbound, 0),
    coalesce(msg.outbound, 0),
    coalesce(ai.ai_replies, 0),
    coalesce(msg.conversations, 0),
    coalesce(msg.after_hours, 0)
  from msg
  full join ai on ai.day = msg.day
  where app.is_member(p_org_id)
  order by 1;
$$;

create or replace function public.pulse_hourly(p_org_id uuid, p_days int default 30)
returns table (dow int, hour int, messages bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    extract(dow from m.created_at at time zone 'Asia/Kolkata')::int,
    extract(hour from m.created_at at time zone 'Asia/Kolkata')::int,
    count(*)::bigint
  from messages m
  where m.org_id = p_org_id
    and m.direction = 'inbound'
    and m.created_at >= (
      ((now() at time zone 'Asia/Kolkata')::date - (least(greatest(p_days, 1), 400) - 1))::timestamp
        at time zone 'Asia/Kolkata'
    )
    and app.is_member(p_org_id)
  group by 1, 2;
$$;

create or replace function public.pulse_reply_seconds(p_org_id uuid, p_days int default 30)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with paired as (
    select
      m.created_at as asked,
      lead(m.created_at) over (partition by m.conversation_id order by m.created_at) as answered,
      lead(m.direction) over (partition by m.conversation_id order by m.created_at) as answered_dir,
      m.direction
    from messages m
    where m.org_id = p_org_id
      and m.created_at >= (
        ((now() at time zone 'Asia/Kolkata')::date - (least(greatest(p_days, 1), 400) - 1))::timestamp
          at time zone 'Asia/Kolkata'
      )
  )
  select percentile_cont(0.5) within group (
    order by extract(epoch from (answered - asked))
  )
  from paired
  where direction = 'inbound'
    and answered_dir = 'outbound'
    and app.is_member(p_org_id);
$$;
