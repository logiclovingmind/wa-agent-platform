-- Bookings in the seeded demo diary.
--
-- 0030 gave the demo org a week of opening hours and then deleted every appointment on
-- reset, which is right for the ones a walk-in made — a slot held by the last prospect is
-- a slot the next one is not offered. The side effect was that the Diary tab, the screen
-- the whole calendar exists for, opened completely empty at every demo. An empty calendar
-- does not read as "nothing booked yet", it reads as broken.
--
-- So the reset now puts a few back, the same way it puts the KB back: they are part of the
-- seeded backdrop, not residue from the last prospect.
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

  -- Every booking, including the seeded ones below, which are rewritten rather than kept:
  -- they are pinned to *this* week by construction, so a reset a fortnight later has to
  -- move them or the diary opens on three appointments in the past.
  delete from appointments where org_id = demo_org;

  delete from business_hours where org_id = demo_org;

  -- 09:30 to 19:00, Monday to Saturday, matching what the seeded KB already tells customers
  -- in words. A bot that says "we're open till 7" and then offers a 7:30 slot is the exact
  -- kind of contradiction a prospect notices, and it is free to avoid by seeding both from
  -- the same fact.
  insert into business_hours (org_id, weekday, opens_at, closes_at, slot_minutes)
  select demo_org, d, time '09:30', time '19:00', 30
  from generate_series(1, 6) as d;

  -- Positions in the free list rather than literal times, so that the seed lands on the
  -- grid `free_slots` actually generates whatever day and hour the reset is run. Writing
  -- "tomorrow 11am" here would put an appointment at 11:00 on a Sunday the org is shut,
  -- which `book_appointment` would have refused and which makes the diary a liar.
  --
  -- Spread across the week on purpose: three bookings on one day demonstrates a busy
  -- Tuesday, three days with one each demonstrates a calendar.
  insert into appointments (org_id, starts_at, duration_minutes, customer_name, service)
  select demo_org, s.starts_at, 30, v.customer_name, v.service
  from (
    select starts_at, row_number() over (order by starts_at) as rn
    from public.free_slots(demo_org, 7, 200)
  ) s
  join (
    values
      (3, 'Priya Nair', 'Haircut'),
      (7, 'Rahul Menon', 'Beard trim'),
      (24, 'Anjali Rao', 'Colour and blow-dry'),
      (41, 'Imran Shaikh', 'Haircut')
  ) as v (rn, customer_name, service) on v.rn = s.rn;
end;
$$;

comment on function app.demo_restore_defaults() is
  'Restores the demo org to its seeded identity, KB, opening hours and a few upcoming bookings. Called by demo_reset() and by demo-seed.sql.';
