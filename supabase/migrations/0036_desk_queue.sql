-- The desk's queue, decided in Postgres.
--
-- ⚠️ This exists because the browser cannot do it. The desk used to read the fifty most
-- recent conversations and sort them into "waiting on you" and "call today". Both groups
-- were therefore only ever true about those fifty rows: a customer who asked for a person
-- last Tuesday, and every callback older than the last fifty messages, were invisible —
-- and invisible on this screen reads as "nothing to do", which is an instruction to stop
-- looking. Raising the limit does not fix it, it only moves the cliff and pulls the whole
-- table through the 5GB egress budget on every page load.
--
-- So the filter goes where the rows are. What comes back is the queue itself, already
-- ordered, already carrying the two labels the list needs — so this replaces three
-- round trips (conversations, flags, leads) with one.
--
-- `security invoker`, like the booking functions: the tables' own RLS policies stay the
-- only thing deciding whose desk this is. A definer version would take `p_org_id` at its
-- word, and this one is called with an org id straight from the browser.
create function public.desk_queue(p_org_id uuid, p_limit int default 200)
returns table (
  id uuid,
  customer_wa_id text,
  customer_name text,
  handoff_state handoff_state,
  last_message_at timestamptz,
  window_expires_at timestamptz,
  followed_up_at timestamptz,
  reason text,
  rank int,
  flag_kinds text[],
  intent text
)
language sql
stable
set search_path = public
as $$
  with open_flags as (
    select f.conversation_id, array_agg(distinct f.kind::text) as kinds
    from safety_flags f
    where f.org_id = p_org_id
      and f.resolved_at is null
    group by f.conversation_id
  )
  select
    c.id,
    c.customer_wa_id,
    c.customer_name,
    c.handoff_state,
    c.last_message_at,
    c.window_expires_at,
    c.followed_up_at,
    case
      when g.kinds is not null then 'flagged'
      when c.handoff_state = 'requested' then 'asked for a person'
      when c.handoff_state = 'human' then 'you are replying'
      else 'never called back'
    end,
    -- The order the day should be worked. A safety flag outranks everything, then a
    -- customer who asked for a human, then one the owner took over and never handed
    -- back, then the callbacks.
    case
      when g.kinds is not null then 0
      when c.handoff_state = 'requested' then 1
      when c.handoff_state = 'human' then 2
      else 3
    end,
    coalesce(g.kinds, '{}'::text[]),
    l.intent
  from conversations c
  left join open_flags g on g.conversation_id = c.id
  left join leads l on l.conversation_id = c.id and l.org_id = c.org_id
  where c.org_id = p_org_id
    and (
      g.kinds is not null
      or c.handoff_state in ('requested', 'human')
      or (l.conversation_id is not null and c.followed_up_at is null)
    )
  order by
    -- The rank, by output position. Naming it would resolve to the RETURNS TABLE column
    -- of the same name rather than the expression above.
    9,
    -- Within the three waiting ranks, by how long is left to reply rather than by who
    -- spoke last: Meta shuts the free window 24h after the customer's last message, and
    -- after that the only way to answer is a paid template the client had to have
    -- approved in advance. The callbacks have no such deadline, so the case yields null
    -- for all of them and they fall through to recency.
    case when c.handoff_state in ('requested', 'human') or g.kinds is not null
         then c.window_expires_at end asc nulls last,
    c.last_message_at desc nulls last
  limit p_limit;
$$;

-- Supabase grants EXECUTE on every new public function to anon regardless of any revoke
-- from public, and this one names customers.
revoke all on function public.desk_queue(uuid, int) from public, anon;
grant execute on function public.desk_queue(uuid, int) to authenticated;
