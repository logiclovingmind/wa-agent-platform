-- A blocked stretch in the seeded demo diary.
--
-- 0032 gave the owner a way to block time out, and the Diary renders a block differently
-- from an appointment — dashed, greyed, "Unblock" rather than "Cancel". None of that is
-- visible at a walk-in demo unless the seed contains one, and the reset wipes every
-- appointment, so it has to be seeded here rather than left behind by whoever demoed last.
--
-- The whole body is restated because that is how this function has been changed before
-- (0031 replaced 0030's version wholesale). 0031 is already applied, so editing it in
-- place would change nothing anywhere it has already run.
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
  -- Spread across the whole open week on purpose. Four bookings on three days left the
  -- calendar looking like a product nobody uses, and the month grid — whose per-day count
  -- badge is the thing being demonstrated — had a badge on three cells out of thirty.
  --
  -- ⚠️ The services are the institute's, not a salon's. They used to read "Haircut" and
  -- "Colour and blow-dry" while the same function names the org "Demo Institute" and the
  -- seeded KB sells a 12-week Data Science course. That is exactly the contradiction the
  -- comment above is about, sitting on the one screen a prospect is invited to click.
  insert into appointments (org_id, starts_at, duration_minutes, customer_name, service)
  select demo_org, s.starts_at, 30, v.customer_name, v.service
  from (
    select starts_at, row_number() over (order by starts_at) as rn
    from public.free_slots(demo_org, 7, 200)
  ) s
  join (
    values
      (2,  'Priya Nair',      'Course counselling'),
      (5,  'Rahul Menon',     'Demo class — Data Science'),
      (9,  'Anjali Rao',      'Admission and fees'),
      (16, 'Imran Shaikh',    'Course counselling'),
      (21, 'Sneha Kulkarni',  'Demo class — Data Science'),
      (27, 'Vikram Iyer',     'Admission and fees'),
      (34, 'Fatima Begum',    'Weekend batch enquiry'),
      (39, 'Arjun Reddy',     'Course counselling'),
      (46, 'Meera Pillai',    'Demo class — Data Science'),
      (52, 'Karthik Shetty',  'Admission and fees'),
      (58, 'Divya Prasad',    'Course counselling'),
      (67, 'Sameer Joshi',    'Weekday batch enquiry'),
      (74, 'Nandini Gowda',   'Demo class — Data Science'),
      (88, 'Aditya Verma',    'Course counselling'),
      (97, 'Lakshmi Narayan', 'Admission and fees')
  ) as v (rn, customer_name, service) on v.rn = s.rn;

  -- Read *after* the inserts above, so the free list has already dropped the four booked
  -- slots and a block cannot land on one. Consecutive positions are consecutive slots, so
  -- four of them read as a blocked-out couple of hours rather than scattered holes.
  insert into appointments (org_id, starts_at, duration_minutes, service, kind)
  select demo_org, s.starts_at, 30, 'Staff training', 'block'
  from (
    select starts_at, row_number() over (order by starts_at) as rn
    from public.free_slots(demo_org, 7, 200)
  ) s
  where s.rn between 12 and 15;
end;
$$;

comment on function app.demo_restore_defaults() is
  'Restores the demo org to its seeded identity, KB, opening hours, a few upcoming bookings and one blocked-out stretch. Called by demo_reset() and by demo-seed.sql.';
