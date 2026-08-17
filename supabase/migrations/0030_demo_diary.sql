-- The diary half of the demo reset.
--
-- Without a `business_hours` row the demo org has no availability, `free_slots` returns
-- nothing, and the prompt says nothing about appointments at all — so the one question a
-- walk-in always asks ("can I book?") is answered by the bot offering to check with the
-- team. Seeding the week is what makes booking demoable.
--
-- The hours are written here as literals rather than snapshotted the way the KB is: the
-- KB is prospect-editable text with a body worth preserving, whereas this is seven short
-- rows that are the same on every reset.
--
-- 09:30 to 19:00, Monday to Saturday, matching what the seeded KB already tells customers
-- in words. A bot that says "we're open till 7" and then offers a 7:30 slot is the exact
-- kind of contradiction a prospect notices, and it is free to avoid by seeding both from
-- the same fact.
create or replace function app.demo_restore_defaults()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  demo_org uuid := app.demo_org();
begin
  if demo_org is null then
    return;
  end if;

  update organizations
  set name = 'Demo Institute',
      sector = 'general',
      voice = 'warm and unhurried; explains before it sells; mirrors the customer''s Hinglish',
      reply_max_words = 120,
      languages = 'English, Hindi, Kannada'
  where id = demo_org;

  -- Delete-then-insert rather than an upsert on title: a demo may have edited a seeded
  -- document in place instead of deleting it, and there is no unique index on
  -- (org_id, title) to conflict against anyway.
  delete from kb_documents where org_id = demo_org;

  insert into kb_documents (org_id, title, raw)
  select demo_org, s.title, s.raw from app.demo_kb_seed s;

  -- Every booking, not just the ones a walk-in made. A slot held by the last prospect is
  -- a slot the next one is not offered, and a demo whose diary fills up over a week of
  -- walk-ins would eventually have nothing to show. Deleted rather than cancelled: the
  -- cancelled row exists to prove a real customer was told they had a time, and nobody
  -- here was.
  delete from appointments where org_id = demo_org;

  delete from business_hours where org_id = demo_org;

  insert into business_hours (org_id, weekday, opens_at, closes_at, slot_minutes)
  select demo_org, d, time '09:30', time '19:00', 30
  from generate_series(1, 6) as d;
end;
$$;

comment on function app.demo_restore_defaults() is
  'Restores the demo org to its seeded identity, KB and diary. Called by demo_reset() and by demo-seed.sql.';
