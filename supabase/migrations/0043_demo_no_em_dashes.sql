-- Em dashes out of the demo's customer-facing strings.
--
-- The seed script is edited in place, but the diary is not seeded from it: it is written
-- by `app.demo_restore_diary()`, which a cron re-runs every night at 01:30 IST. So the one
-- appointment whose service name carried a dash would come back the next morning however
-- many times the row was fixed by hand. The body is restated rather than diffed because
-- 0040 is already applied and this is `create or replace`.

create or replace function app.demo_restore_diary()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  demo_org uuid := app.demo_org();
  today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if demo_org is null then
    return;
  end if;

  -- Every booking, including the seeded ones below, which are rewritten rather than kept:
  -- they are pinned to *this* week by construction, so a run a fortnight later has to
  -- move them or the diary opens on appointments in the past.
  delete from appointments where org_id = demo_org;
  delete from business_hours where org_id = demo_org;

  -- 09:30 to 19:00, Monday to Saturday, matching what the seeded KB already tells
  -- customers in words. A bot that says "we're open till 7" and then offers a 7:30 slot is
  -- the exact kind of contradiction a prospect notices, and it is free to avoid by seeding
  -- both from the same fact.
  insert into business_hours (org_id, weekday, opens_at, closes_at, slot_minutes)
  select demo_org, d, time '09:30', time '19:00', 30
  from generate_series(1, 6) as d;

  -- Positions in the free list rather than literal times, so that the seed lands on the
  -- grid `free_slots` actually generates whatever day and hour this is run. Writing
  -- "tomorrow 11am" here would put an appointment at 11:00 on a Sunday the org is shut,
  -- which `book_appointment` would have refused and which makes the diary a liar.
  --
  -- Still spread over the week rather than bunched into the next two days: the month grid
  -- draws a dot per booked day, and that dot is the thing being demonstrated.
  --
  -- ⚠️ The services are the institute's, not a salon's. They once read "Haircut" while the
  -- same seed names the org "Demo Institute" and sells a 12-week Data Science course.
  insert into appointments
    (org_id, conversation_id, starts_at, duration_minutes, customer_name, service)
  select demo_org, c.id, s.starts_at, 30, v.customer_name, v.service
  from (
    select starts_at, row_number() over (order by starts_at) as rn
    from public.free_slots(demo_org, 7, 200)
  ) s
  join (
    values
      (2,  'Priya Nair',      'Course counselling',        null::text),
      (9,  'Anjali Rao',      'Admission and fees',        null),
      -- The one the assistant took itself. Named for the seeded conversation it is joined
      -- to below, because the diary row and the thread it opens must not disagree about
      -- who this is. Deliberately not ...0008, the thread the erase demo exists to
      -- destroy — erasing it would take the "booked on WhatsApp" line off this row.
      (16, 'Vikram Nair',     'Data Science demo class',   '919990010003'),
      (27, 'Rahul Shetty',    'Admission and fees',        null),
      (46, 'Meera Pillai',    'Weekend batch enquiry',     null),
      (74, 'Aditya Verma',    'Course counselling',        null)
  ) as v (rn, customer_name, service, wa_id) on v.rn = s.rn
  -- Left, and matched on a wa_id that is null for most rows: `demo-seed.sql` may not have
  -- been run, and the conversation this points at is one an operator can delete during the
  -- erase demo. A missing thread has to mean an unlinked booking, not a missing booking.
  left join conversations c
    on c.org_id = demo_org and c.customer_wa_id = v.wa_id;

  -- One blocked-out hour, read *after* the bookings above so it cannot land on one.
  --
  -- Adjacent positions in the free list are not adjacent times — a booking sitting between
  -- two free slots is absent from the list but still an hour on the calendar, which is why
  -- the old seed drew a "blocked" afternoon with somebody's appointment in the middle of
  -- it. Matching a slot to the one 30 minutes after it is the only thing that makes the
  -- two rows read as one stretch.
  with free as (
    select starts_at
    from public.free_slots(demo_org, 7, 200)
  ),
  pair as (
    select f.starts_at
    from free f
    join free g on g.starts_at = f.starts_at + interval '30 minutes'
    -- Not the next free slot: a block on this afternoon's first opening buries the
    -- bookings the day pane is meant to open on.
    where f.starts_at > now() + interval '1 day'
    order by f.starts_at
    limit 1
  )
  insert into appointments (org_id, starts_at, duration_minutes, service, kind)
  select demo_org, p.starts_at + (i * interval '30 minutes'), 30, 'Staff training', 'block'
  from pair p, generate_series(0, 1) as i;

  -- This morning, already answered for. Counted backwards from now so the two rows sit
  -- just above the current hour whenever this runs, rather than at opening time with a gap
  -- the day never explains.
  --
  -- ⚠️ Backwards from *11:30 at the earliest*, because the caller that matters is a cron at
  -- 01:30 IST: at that hour no slot today has passed, "before now" selects nothing, and the
  -- pair below is silently absent from every demo shown that day. `not exists` then keeps
  -- the pair off the upcoming bookings written above, which at that hour are this morning's
  -- slots — `slot_grid` is every slot, booked or not, unlike the free list.
  --
  -- One of each, because the pair is the point: "Came" is the row that settles, and the
  -- no-show is the one that keeps working after the diary — `desk_queue` reads it and puts
  -- the customer back on the desk to be called, which is why it, and not the other, is
  -- joined to a real conversation. The attended one stays unlinked on purpose: it is what
  -- a booking taken over the phone and typed in by hand looks like.
  insert into appointments
    (org_id, conversation_id, starts_at, duration_minutes, customer_name, service, status)
  select demo_org, c.id, s.starts_at, 30, v.customer_name, v.service, v.status
  from (
    select g.starts_at, row_number() over (order by g.starts_at desc) as rn
    from app.slot_grid(demo_org, today, today) g
    where g.starts_at < greatest(now(), (today + time '11:30') at time zone 'Asia/Kolkata')
      and not exists (
        select 1 from appointments a where a.org_id = demo_org and a.starts_at = g.starts_at
      )
  ) s
  join (
    values
      -- ⚠️ Not a flagged or handed-off thread. `desk_queue` labels a row by the first
      -- reason that fits and "did not turn up" sits below both, so linking the no-show to
      -- one of those spends the appointment and shows the desk beat that was already there.
      (1, 'Ananya Rao', 'Course counselling', 'no_show',  '919990010001'),
      (3, 'Harsh Vora', 'Admission and fees', 'attended', null::text)
  ) as v (rn, customer_name, service, status, wa_id) on v.rn = s.rn
  left join conversations c
    on c.org_id = demo_org and c.customer_wa_id = v.wa_id;
end;
$$;

-- The rows already on the demo org, so the diary reads right before the next nightly run
-- rather than after it.
update appointments
set service = 'Data Science demo class'
where service = 'Demo class — Data Science';
