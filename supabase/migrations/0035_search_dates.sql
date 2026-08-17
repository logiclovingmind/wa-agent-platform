-- A date range on the search box.
--
-- ⚠️ This cannot be done in the browser, which is the whole reason it is a migration.
-- Each of the three branches below is `limit 10` ordered by recency, so the rows that
-- reach the browser are already only the ten most recent matches. Filtering those by date
-- client-side answers "of the ten newest matches, which fall in March" — an owner
-- searching a customer's name over last March gets nothing, and the absence looks like
-- proof the conversation never happened. The bound has to sit inside each subquery, above
-- the limit.
--
-- The old two-argument function is dropped rather than left beside this one. Two
-- overloads that differ only by defaulted arguments make an unqualified two-argument call
-- ambiguous, and Postgres answers that with `function is not unique` — the search box
-- would break for every client the moment this migration ran. PostgREST calls by named
-- argument and fills the rest from defaults, so a browser tab still running the old
-- dashboard keeps working against this signature.
drop function if exists public.search_everything(uuid, text);

create function public.search_everything(
  p_org_id uuid,
  p_query text,
  p_from date default null,
  p_to date default null
)
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
  -- The dates arrive from a date input, so they mean IST calendar days, and the range is
  -- inclusive at both ends the way a person reading "1 March to 3 March" expects. `p_to`
  -- therefore becomes the start of the following IST day and the comparison is strict —
  -- an exclusive `<= p_to` would silently drop everything said after midnight UTC on the
  -- last day, which in IST is most of the working afternoon.
  lo timestamptz := (p_from::timestamp at time zone 'Asia/Kolkata');
  hi timestamptz := ((p_to + 1)::timestamp at time zone 'Asia/Kolkata');
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
      -- A conversation that has never had a message has a null here and falls outside
      -- every range, which is the honest answer to "who did I speak to in March".
      and (lo is null or c.last_message_at >= lo)
      and (hi is null or c.last_message_at < hi)
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
      and (lo is null or l.updated_at >= lo)
      and (hi is null or l.updated_at < hi)
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
      and (lo is null or m.created_at >= lo)
      and (hi is null or m.created_at < hi)
    order by m.created_at desc
    limit 10
  );
end;
$$;

-- Supabase's default privileges grant EXECUTE on a new public function to anon and
-- authenticated regardless of any revoke from public, and this one crosses three tables
-- as definer. The drop above threw the old grants away with the old function, so this is
-- not merely a repeat of 0024 — without it the new signature is reachable with the anon
-- key.
revoke all on function public.search_everything(uuid, text, date, date) from public, anon;
grant execute on function public.search_everything(uuid, text, date, date) to authenticated;
