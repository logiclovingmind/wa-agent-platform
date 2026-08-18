-- Load a saved setup, reset, and the same overlay was filed a second time.
--
-- `app.demo_setup_snapshot()` always inserted. Its only guard was "the KB holds a document
-- the seed did not write" — which is true again the moment `demo_setup_load()` puts the
-- prospect's documents back, so showing one prospect twice a week apart left two rows
-- saying the same thing, then four, and the list 0028 exists to provide stops being
-- readable.
--
-- A snapshot whose identity and KB already exist for the org now returns that row instead
-- of inserting. Nothing is overwritten and nothing is deleted, so no setup can be lost
-- this way: two overlays that differ by one word are still two rows, which is the right
-- answer for "the version before I changed the fees".

/*
 * The KB compared as a set rather than an array.
 *
 * `demo_setup_snapshot` captures in paste order (`created_at, title`), but a restored KB
 * is inserted by a single statement, so every document shares one `created_at` and the
 * capture collapses to title order. The same overlay therefore has two legitimate
 * orderings, and `=` on the raw jsonb would call them different — which is the duplicate
 * this migration is here to stop.
 */
create function app.demo_kb_sorted(p_kb jsonb)
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_agg(e order by e ->> 'title', e ->> 'raw'), '[]'::jsonb)
    from jsonb_array_elements(p_kb) e
$$;

comment on function app.demo_kb_sorted(jsonb) is
  'A saved setup''s KB in a canonical order, so two captures of one overlay compare equal.';

-- ---------------------------------------------------------------------------

create or replace function app.demo_setup_snapshot(p_label text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  demo_org uuid := app.demo_org();
  org organizations;
  setup_id uuid;
  captured jsonb;
begin
  if demo_org is null then
    return null;
  end if;

  select * into org from organizations o where o.id = demo_org;

  -- Ordered so a restored setup rebuilds the KB in the order it was pasted, and so two
  -- snapshots of the same state compare equal.
  select coalesce(jsonb_agg(jsonb_build_object('title', d.title, 'raw', d.raw)
                            order by d.created_at, d.title), '[]'::jsonb)
    into captured
    from kb_documents d
   where d.org_id = demo_org;

  if p_label is null
     and not exists (
       select 1 from kb_documents d
        where d.org_id = demo_org
          and d.title not in (select title from app.demo_kb_seed)
     )
  then
    return null;
  end if;

  -- The twin check. Identity compared with `is not distinct from` because voice, word cap
  -- and languages are all nullable and `null = null` would make every unset overlay unique.
  select s.id into setup_id
    from demo_setups s
   where s.org_id = demo_org
     and s.name is not distinct from org.name
     and s.sector is not distinct from org.sector
     and s.voice is not distinct from org.voice
     and s.reply_max_words is not distinct from org.reply_max_words
     and s.languages is not distinct from org.languages
     and app.demo_kb_sorted(s.kb) = app.demo_kb_sorted(captured)
   order by s.created_at
   limit 1;

  if setup_id is not null then
    -- Only an operator who typed a name gets to rename the twin. The reset's auto-label is
    -- "<org> — <date>", and letting that path write would replace "Sharma, first visit"
    -- with a timestamp every time the room turned over.
    if p_label is not null then
      update demo_setups set label = p_label where id = setup_id;
    end if;
    return setup_id;
  end if;

  insert into demo_setups (org_id, label, name, sector, voice, reply_max_words, languages, kb)
  values (demo_org,
          -- Invariant 12: stored UTC everywhere, but a label is display text and the
          -- operator reading this list is in IST.
          coalesce(p_label, org.name || ' — ' ||
                   to_char(now() at time zone 'Asia/Kolkata', 'DD Mon YYYY, HH12:MI am')),
          org.name, org.sector, org.voice, org.reply_max_words, org.languages, captured)
  returning id into setup_id;

  return setup_id;
end;
$$;

comment on function app.demo_setup_snapshot(text) is
  'Captures the demo org''s identity and KB as a demo_setups row, or returns the existing '
  'row when that overlay is already saved. Null label means auto-name and skip when the '
  'walk-in added no KB.';

-- ---------------------------------------------------------------------------

-- The duplicates already filed, folded into the row they duplicate. The oldest of each
-- group survives because it carries the name the operator first gave it; the later copies
-- are byte-identical overlays and there is nothing in them to lose.
delete from demo_setups s
 using demo_setups keep
 where keep.org_id = s.org_id
   and (keep.created_at, keep.id) < (s.created_at, s.id)
   and keep.name is not distinct from s.name
   and keep.sector is not distinct from s.sector
   and keep.voice is not distinct from s.voice
   and keep.reply_max_words is not distinct from s.reply_max_words
   and keep.languages is not distinct from s.languages
   and app.demo_kb_sorted(keep.kb) = app.demo_kb_sorted(s.kb);
