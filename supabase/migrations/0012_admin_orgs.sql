-- The all-clients view (CLAUDE.md §5). "Client #21 is an INSERT, not a deploy" is the
-- promise the whole architecture is built on, and until now there was nowhere to see
-- that it held — no screen listed org #1 through #21 side by side.
--
-- ## Why this is `security definer`, when 0010 argued against it
--
-- `usage_daily` is invoker precisely so a client's own RLS still applies inside it.
-- Here crossing orgs *is* the function: RLS scopes every table to the caller's
-- org_members rows, so an invoker function would return exactly one org to a platform
-- admin — their own — which is the opposite of the screen.
--
-- The exception is bounded by the guard below, which is the first statement and reads
-- `is_platform_admin` off `users`. That flag is deliberately not an `org_role` (see
-- .claude/rules/data-model.md), so no bug in the org role logic can reach this: a
-- client owner promoting themselves inside their own org still fails here.
--
-- ## Why aggregate in SQL
--
-- Twenty-one orgs' worth of usage_events and conversations is thousands of rows to
-- render one table. That is the 5GB/mo egress budget, which is shared, and a 402 on it
-- takes every client down at once. Postgres counts them on Supabase's CPU instead.
create or replace function public.admin_orgs()
returns table (
  org_id uuid,
  name text,
  sector text,
  month_cost_micros bigint,
  month_events bigint,
  open_flags bigint,
  waiting bigint,
  conversations bigint,
  last_message_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from users
     where id = auth.uid()
       and is_platform_admin
  ) then
    raise exception 'admin only' using errcode = '42501';
  end if;

  return query
  select
    o.id,
    o.name,
    o.sector,
    coalesce(u.cost, 0)::bigint,
    coalesce(u.events, 0)::bigint,
    coalesce(f.open, 0)::bigint,
    coalesce(c.waiting, 0)::bigint,
    coalesce(c.total, 0)::bigint,
    c.last_at
  from organizations o
  -- Lateral rather than a group-by join: an org with no conversations still has to
  -- appear, and it is the org that was just INSERTed which most needs to show up.
  left join lateral (
    select
      sum(cost_micros) as cost,
      count(*) as events
    from usage_events ue
    where ue.org_id = o.id
      -- Invariant 12: IST calendar month, because that is the month the client is
      -- thinking of when they ask what they spent.
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
      -- 'requested' is the bot asking for a person; 'human' is a person already
      -- holding it. Both are a customer waiting on someone, which is the thing worth
      -- seeing across every client at once.
      count(*) filter (where handoff_state in ('requested', 'human')) as waiting,
      max(conv.last_message_at) as last_at
    from conversations conv
    where conv.org_id = o.id
  ) c on true
  order by o.name;
end;
$$;

-- Same lesson as 0007 and 0010: Supabase grants EXECUTE on new public functions to anon
-- and authenticated by default, and this one is `security definer`, so an unrevoked
-- anon grant would be every client's spend behind a key that ships in the browser
-- bundle. The guard would still reject it (auth.uid() is null for anon), but a
-- definer function the signed-out world can invoke is not something to leave standing.
revoke all on function public.admin_orgs() from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.admin_orgs() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.admin_orgs() to authenticated';
  end if;
end;
$$;
