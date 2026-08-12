-- One search box over the three things an owner looks for: a person, what somebody
-- wanted, and something they remember being said.
--
-- One function rather than three queries because each one is a round trip and a
-- separate RLS evaluation, and because the browser would then have to merge and rank
-- them — which means fetching more rows than it shows. Everything here is filtered,
-- ranked and limited in Postgres; the browser receives at most 30 rows.
--
-- Security definer with the guard re-imposed by hand, the same call as pulse_* in 0020:
-- it reads three tables under one org filter, and an invoker version would evaluate
-- three policies per keystroke.
create or replace function public.search_everything(p_org_id uuid, p_query text)
returns table (
  kind text,
  conversation_id uuid,
  customer_name text,
  customer_wa_id text,
  snippet text,
  at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  q text := trim(coalesce(p_query, ''));
begin
  if not app.is_member(p_org_id) then
    raise exception 'not a member of this organization';
  end if;

  -- Two characters match most of the alphabet and would return the whole inbox ranked
  -- by nothing. The caller shows a hint instead.
  if length(q) < 3 then
    return;
  end if;

  return query
  -- A person, by the name WhatsApp reports or by their number. Digits are matched with
  -- any +, spaces or dashes stripped, because nobody types a wa_id the way Meta stores
  -- it.
  (
    select 'person'::text, c.id, c.customer_name, c.customer_wa_id,
           null::text, c.last_message_at
    from conversations c
    where c.org_id = p_org_id
      and (
        c.customer_name ilike '%' || q || '%'
        or (
          regexp_replace(q, '\D', '', 'g') <> ''
          and c.customer_wa_id like '%' || regexp_replace(q, '\D', '', 'g') || '%'
        )
      )
    order by c.last_message_at desc nulls last
    limit 10
  )
  union all
  -- What somebody wanted. The lead's own columns, not the conversation's — searching
  -- "budget" should find the person who named one.
  (
    select 'lead'::text, l.conversation_id, c.customer_name, c.customer_wa_id,
           concat_ws(' · ', l.intent, l.timeframe, l.budget, l.notes), l.updated_at
    from leads l
    join conversations c on c.id = l.conversation_id and c.org_id = l.org_id
    where l.org_id = p_org_id
      and concat_ws(' ', l.name, l.intent, l.timeframe, l.budget, l.notes)
          ilike '%' || q || '%'
    order by l.updated_at desc
    limit 10
  )
  union all
  -- Something they remember being said. Last because it is the expensive one and the
  -- least often what the owner meant, and capped hardest: `body` is the widest column
  -- in the database and this is the only screen that reads it without a conversation
  -- filter.
  (
    select 'message'::text, m.conversation_id, c.customer_name, c.customer_wa_id,
           left(m.body, 160), m.created_at
    from messages m
    join conversations c on c.id = m.conversation_id and c.org_id = m.org_id
    where m.org_id = p_org_id
      and m.body ilike '%' || q || '%'
    order by m.created_at desc
    limit 10
  );
end;
$$;

-- Supabase's default privileges grant EXECUTE on a new public function to anon and
-- authenticated regardless of any revoke from public, and this one crosses three tables
-- as definer. Revoke by role name, then curl it with the anon key after deploy — a
-- revoke that was never verified has been wrong four times in this repo.
revoke all on function public.search_everything(uuid, text) from public, anon;
grant execute on function public.search_everything(uuid, text) to authenticated;

-- No index, and no pg_trgm. `ilike '%x%'` cannot use a btree, so all three of these are
-- sequential scans — over one org's rows, which is tens of thousands at twelve months of
-- retention. That is milliseconds, and it is Postgres time rather than the Worker's 10ms
-- budget.
--
-- The index worth having would be a GIN trigram one on `messages.body`, and it is the
-- one to avoid today: body is the widest column on the biggest table, a trigram index
-- runs several times the size of the text it covers, and the database ceiling on this
-- plan is 500MB. Add it when a real client's search is actually slow, not before.
