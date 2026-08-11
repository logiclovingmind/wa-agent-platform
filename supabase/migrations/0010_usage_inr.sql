-- `usage_events.currency` has said 'INR' since 0001, but `llm.ts` was pricing replies
-- off OpenAI's USD list, so every row so far holds micro-USD wearing an INR label.
-- The wallet that actually gets debited is an aicredits.in wallet in rupees, so INR was
-- the right label and the constants were the wrong half. Those are now ₹14 / ₹57 per
-- 1M input / output tokens.
--
-- No backfill. Every row written before this is a test message or a demo row, worth
-- fractions of a paisa, and rewriting fake history to be precisely fake is work for
-- nobody. Rows from here on are correct, which is the half that gets shown to a client.

-- The cost screen reads through this rather than pulling raw rows: a month of replies
-- is thousands of rows to send a browser 30 numbers, and egress is the budget that
-- kills every client at once. Aggregation is Postgres's cheapest trick and this runs on
-- Supabase's CPU, not the Worker's 10ms.
--
-- security INVOKER (the default, stated because it is the point): usage_events is
-- owner-only under RLS, and an invoker function keeps it that way. A definer function
-- here would hand staff their org's billing and, worse, need its own org filter.
create or replace function public.usage_daily(p_days int default 30)
returns table (day date, cost_micros bigint, events bigint)
language sql
stable
security invoker
set search_path = public
as $$
  select
    (created_at at time zone 'Asia/Kolkata')::date as day,
    sum(usage_events.cost_micros)::bigint,
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

-- Same lesson as 0007: Supabase grants EXECUTE on new public functions to anon and
-- authenticated by default, and an explicit grant survives a revoke from PUBLIC. anon
-- would get nothing back (RLS), but a function the signed-out world can call is still
-- a query it can make us run.
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
