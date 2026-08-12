-- Aggregates behind the Pulse screen, which replaced the rupee figures 0019 took away.
--
-- All three aggregate in Postgres and hand the browser tens of rows. The obvious
-- alternative — select the month's messages and count them in React — is the egress
-- mistake the 5GB shared budget punishes, and it punishes every client at once. At a
-- thousand conversations a month that read is a few MB per screen load, per client, on
-- a budget that is not per-client.
--
-- security definer, unlike `usage_daily`. `usage_events` is owner-only under RLS
-- (0001) because it held `cost_micros`; staff have no business seeing what the org
-- spends. These functions return counts and no money at all — after 0019 the column is
-- not readable by any browser role — so the reason for excluding staff has gone, and
-- Pulse is the screen everyone lands on. Each one therefore re-imposes the row filter
-- by hand: `app.is_member` and nothing else, checked once, at the top.

-- One row per IST calendar day. Drives the calendar heatmap, the trend line, and every
-- headline number on the screen except reply speed.
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
      ((now() at time zone 'Asia/Kolkata')::date - (least(greatest(p_days, 1), 400) - 1))
        at time zone 'Asia/Kolkata' as since,
      -- Null hours mean the client never set any, so nothing can be "after" them.
      (select hours_open_ist from organizations where id = p_org_id) as open_at,
      (select hours_close_ist from organizations where id = p_org_id) as close_at
  ),
  msg as (
    select
      (m.created_at at time zone 'Asia/Kolkata')::date as day,
      count(*) filter (where m.direction = 'inbound') as inbound,
      count(*) filter (where m.direction = 'outbound') as outbound,
      count(distinct m.conversation_id) as conversations,
      -- The number that sells the product: answers that landed when the shop was shut.
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
    -- One usage row per model reply, which is what makes "the AI answered this, a person
    -- answered that" answerable at all: `messages` has no column saying who sent it.
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

-- 168 rows at most: the week-by-hour grid that tells an owner their customers write at
-- 10pm. Bucketed in IST for the same reason everything else is — a heatmap on UTC hours
-- would put the evening rush in the middle of the afternoon.
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
      ((now() at time zone 'Asia/Kolkata')::date - (least(greatest(p_days, 1), 400) - 1))
        at time zone 'Asia/Kolkata'
    )
    and app.is_member(p_org_id)
  group by 1, 2;
$$;

-- Median, not mean: one conversation left open overnight while someone slept drags an
-- average into the hours and makes a screen that answers in seconds look broken.
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
      -- The next message in the same conversation, whichever way it points. Skipping
      -- straight to the next outbound would measure across a customer's follow-ups and
      -- credit the reply to the wrong question.
      lead(m.created_at) over (partition by m.conversation_id order by m.created_at) as answered,
      lead(m.direction) over (partition by m.conversation_id order by m.created_at) as answered_dir,
      m.direction
    from messages m
    where m.org_id = p_org_id
      and m.created_at >= (
        ((now() at time zone 'Asia/Kolkata')::date - (least(greatest(p_days, 1), 400) - 1))
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

-- Same lesson as 0007 and 0010: Supabase grants EXECUTE on new public functions to anon
-- and authenticated by default. These are definer functions, so an anon grant would be
-- a row filter away from handing the signed-out world every client's message volumes.
revoke all on function public.pulse_daily(uuid, int) from public;
revoke all on function public.pulse_hourly(uuid, int) from public;
revoke all on function public.pulse_reply_seconds(uuid, int) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.pulse_daily(uuid, int) from anon';
    execute 'revoke all on function public.pulse_hourly(uuid, int) from anon';
    execute 'revoke all on function public.pulse_reply_seconds(uuid, int) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.pulse_daily(uuid, int) to authenticated';
    execute 'grant execute on function public.pulse_hourly(uuid, int) to authenticated';
    execute 'grant execute on function public.pulse_reply_seconds(uuid, int) to authenticated';
  end if;
end;
$$;
