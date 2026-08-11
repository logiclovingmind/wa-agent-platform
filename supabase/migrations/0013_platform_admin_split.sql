-- Separate the platform admin from the client whose data they can see.
--
-- Until now one account was both: the same login owned the demo org and carried
-- `is_platform_admin`, so "the admin panel" and "the demo client's dashboard" were the
-- same screen behind the same password. That is fine for one person testing and wrong
-- the moment it is shown to a customer — nothing demonstrates that we cannot read a
-- client's inbox if the only admin we can log in as is also a client owner.
--
-- The isolation itself already existed and does not change here: `conversations`,
-- `messages` and `usage_events` are gated on `app.is_member(org_id)` alone, with no
-- `or app.is_platform_admin()` escape (0001). A platform admin holding no `org_members`
-- row therefore reads zero customer rows — enforced by Postgres, not by hiding a tab.
-- What was missing was the ability to *have* such an account.

-- `users.org_id` was NOT NULL, which forced every account into some org and left no way
-- to express "belongs to the platform, not a client". Nothing scopes on this column —
-- the Worker and every policy go through `org_members` — so relaxing it costs nothing
-- and avoids the alternative, a placeholder "Platform" org that would then have to be
-- filtered out of every cross-org query written from here on.
alter table users alter column org_id drop not null;

-- Which org is the showcase. The all-clients list is an internal management screen, so a
-- demo row sitting in it unlabelled is a real client as far as anyone reading the table
-- is concerned — including whoever is looking at the spend figures.
alter table organizations add column if not exists is_demo boolean not null default false;

-- Adds `is_demo` to the return type, so this is a drop-and-recreate rather than a
-- replace. Body is otherwise 0012 unchanged; the header comment there still explains why
-- it is `security definer` and why it aggregates in SQL.
drop function if exists public.admin_orgs();

create function public.admin_orgs()
returns table (
  org_id uuid,
  name text,
  sector text,
  is_demo boolean,
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
$$;

revoke all on function public.admin_orgs() from public;

do $$
begin
  if exists (select from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.admin_orgs() from anon';
  end if;
  if exists (select from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.admin_orgs() to authenticated';
  end if;
end;
$$;
