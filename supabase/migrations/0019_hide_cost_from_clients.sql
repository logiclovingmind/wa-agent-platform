-- The client's Usage screen showed what the model costs us: a month total, and a
-- per-reply average to four decimal places. That is our cost of goods, on a screen we
-- hand to the person we invoice. Anyone comparing it to their monthly fee has our
-- margin.
--
-- Deleting the numbers from the React component would not have done it. `usage_read`
-- (0001) grants the owner select on `usage_events`, so the browser could ask PostgREST
-- for `cost_micros` directly and read the same figures out of devtools. The screen is
-- the last place to fix this; these grants are the first.

-- Column privileges, not a dropped policy. The owner still needs to *count* their
-- replies — that is the whole replacement screen — and RLS decides rows, not columns.
-- Postgres has no per-column filter inside a table-wide grant, so the table-wide select
-- goes and the harmless columns come back by name.
--
-- `currency` goes with it. On its own it leaks nothing, but it exists only to label
-- `cost_micros`, and a column whose only purpose is to describe a hidden one is a
-- footgun for whoever adds the next screen.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke select on usage_events from authenticated';
    execute 'grant select (id, org_id, conversation_id, pricing_category, created_at)
             on usage_events to authenticated';
  end if;
end;
$$;

-- `usage_daily` returned the costs itself, so the return type has to change, which
-- means drop and recreate rather than `create or replace`.
--
-- Still security invoker, and now that matters more than before: the owner-only policy
-- from 0001 is what stops staff counting the org's replies, and the column grants above
-- are what stop the owner pricing them. A definer function here would bypass both and
-- have to re-implement them by hand.
drop function if exists public.usage_daily(int);

create function public.usage_daily(p_days int default 30)
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
  -- Invariant 12: stored UTC, bucketed on IST calendar days, so "today" on the screen
  -- is the owner's today. Bounded so a caller cannot ask for the whole table.
  where created_at >= (
    ((now() at time zone 'Asia/Kolkata')::date - (least(greatest(p_days, 1), 400) - 1))
      at time zone 'Asia/Kolkata'
  )
  group by 1
  order by 1;
$$;

revoke all on function public.usage_daily(int) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.usage_daily(int) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.usage_daily(int) to authenticated';
  end if;
end;
$$;

-- `org_month_spend` returns the month's spend in micro-rupees as a single number, which
-- is the leak in its purest form. Its only caller is the Worker's spend-cap check
-- (`packages/shared/src/db.ts`), which holds service_role and never needed this grant.
--
-- The cap itself is unaffected: the client still sees "monthly spend cap reached" on
-- their controls, which is the fact they need. What they no longer get is the figure
-- the cap is measured against.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.org_month_spend(uuid) from authenticated';
  end if;
end;
$$;
