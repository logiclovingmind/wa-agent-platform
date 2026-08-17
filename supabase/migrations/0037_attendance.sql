-- Did they turn up?
--
-- Until now a booking had two ends: it existed, or it was cancelled before the day. What
-- actually happens at the appointed hour — the person came, or they did not — had nowhere
-- to live, so the diary described the morning as still pending for the rest of the year and
-- a no-show left no trace anybody could act on. That second one is the expensive half: a
-- customer who books and does not arrive is the customer most worth calling, and they were
-- indistinguishable from one who is sitting in the waiting room.
--
-- Two new terminal statuses, and the two things a person does about a no-show: give them
-- another time, or put them back on the desk to be called.

alter table appointments drop constraint appointments_status_check;
alter table appointments add constraint appointments_status_check
  check (status in ('booked', 'cancelled', 'attended', 'no_show'));

-- ⚠️ `attended` and `no_show` deliberately keep the slot. Every reader of availability —
-- `free_slots`, `day_slots`, `block_time`, and the unique index behind them — asks the same
-- question, `status <> 'cancelled'`, and all four are right to: the hour was spent either
-- way. Adding `no_show` to those exclusions would offer this morning's 10:30 to somebody
-- new, which is only ever a lie about the past.

-- ---------------------------------------------------------------------------------------
-- Moving a booking.
--
-- Not an `update ... set starts_at`, which was the obvious version. A cancelled row is kept
-- forever because it is the proof a customer was once promised that time (see the Diary),
-- and overwriting `starts_at` in place erases exactly that. So a reschedule is the pair of
-- writes it actually is: take the new slot, then close the old row.
--
-- The old row is only cancelled when it was still `booked`. Rescheduling somebody who did
-- not turn up must leave the no-show standing — it is the reason the new time exists, and
-- it is what the desk is reading to know they are still owed a call.
create function public.reschedule_appointment(
  p_org_id uuid,
  p_id uuid,
  p_starts_at timestamptz
) returns uuid
-- Invoker, like `book_manual` and for the same reason: this is called from a browser with
-- an org id it supplied, so `appointments`' own policies decide whose diary it touches.
language plpgsql volatile security invoker set search_path = public
as $$
declare
  prev appointments;
  slot_len smallint;
  new_id uuid;
begin
  select * into prev
  from appointments
  where id = p_id
    and org_id = p_org_id
    -- A block is not moved, it is unblocked and blocked again; and a cancelled booking is
    -- not a booking. Both would otherwise arrive here as a silent no-op.
    and kind = 'appointment'
    and status <> 'cancelled';

  if not found then
    return null;
  end if;

  slot_len := app.slot_length(p_org_id, p_starts_at);

  if slot_len is null then
    return null;
  end if;

  insert into appointments (
    org_id, conversation_id, starts_at, duration_minutes, customer_name, service
  )
  values (
    p_org_id, prev.conversation_id, p_starts_at, slot_len, prev.customer_name, prev.service
  )
  -- Null out means somebody took the slot in between, exactly as in `book_manual`. The old
  -- booking is then still standing, which is the only safe end to a half-done move.
  on conflict do nothing
  returning id into new_id;

  if new_id is null then
    return null;
  end if;

  if prev.status = 'booked' then
    update appointments set status = 'cancelled' where id = prev.id;
  end if;

  return new_id;
end;
$$;

revoke all on function public.reschedule_appointment(uuid, uuid, timestamptz)
  from public, anon;
grant execute on function public.reschedule_appointment(uuid, uuid, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------------------
-- The other half: a no-show is a call to make.
--
-- Marking one is the whole follow-up action — there is no second button and no second
-- list. The desk already is the list of people owed something, so the conversation the
-- booking came from joins it with its own reason, and leaves it the moment somebody marks
-- the callback done. A "follow-ups" screen next to the desk would be a second answer to
-- the question the desk exists to answer.
--
-- Body restated in full; `desk_queue` is `create or replace` and 0036 is already applied.
create or replace function public.desk_queue(p_org_id uuid, p_limit int default 200)
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
  ),
  -- Only bookings that came from WhatsApp carry a conversation, so a walk-in who did not
  -- arrive never reaches the desk. There is no thread to open and no number to call back
  -- from — that one is rescheduled in the diary or not at all.
  no_shows as (
    select distinct a.conversation_id
    from appointments a
    where a.org_id = p_org_id
      and a.status = 'no_show'
      and a.conversation_id is not null
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
      -- Above the lead's own label on purpose: "did not turn up" is the more specific
      -- true thing to say about somebody who is both.
      when n.conversation_id is not null then 'did not turn up'
      else 'never called back'
    end,
    -- The order the day should be worked. A safety flag outranks everything, then a
    -- customer who asked for a human, then one the owner took over and never handed
    -- back, then the callbacks — a missed appointment being one of those.
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
  left join no_shows n on n.conversation_id = c.id
  left join leads l on l.conversation_id = c.id and l.org_id = c.org_id
  where c.org_id = p_org_id
    and (
      g.kinds is not null
      or c.handoff_state in ('requested', 'human')
      or (l.conversation_id is not null and c.followed_up_at is null)
      or (n.conversation_id is not null and c.followed_up_at is null)
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

revoke all on function public.desk_queue(uuid, int) from public, anon;
grant execute on function public.desk_queue(uuid, int) to authenticated;

-- ---------------------------------------------------------------------------------------
-- The demo, which cannot show any of this without a booking whose hour has already passed.
--
-- Every seeded booking comes off `free_slots` and is therefore in the future, so a demo run
-- at any hour of the day showed fifteen appointments and not one place to press "Came" or
-- "No show". Two rows earlier today fix that; before opening time there are no past slots
-- and the seed inserts nothing, which is correct rather than unlucky.
--
-- Whole body restated — 0033 is already applied, so editing it in place changes nothing.
create or replace function app.demo_restore_defaults()
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

  -- This morning, already answered for. Counted backwards from now so that the two rows
  -- sit just above the current hour whenever the reset is run, rather than at opening time
  -- with a gap the day never explains. One of each, because the pair is the point: the
  -- second is what puts a name on the desk under "did not turn up".
  insert into appointments (org_id, starts_at, duration_minutes, customer_name, service, status)
  select demo_org, s.starts_at, 30, v.customer_name, v.service, v.status
  from (
    select g.starts_at, row_number() over (order by g.starts_at desc) as rn
    from app.slot_grid(demo_org, today, today) g
    where g.starts_at < now()
  ) s
  join (
    values
      (1, 'Ritu Bansal', 'Course counselling',  'no_show'),
      (3, 'Harsh Vora',  'Admission and fees',  'attended')
  ) as v (rn, customer_name, service, status) on v.rn = s.rn;
end;
$$;

comment on function app.demo_restore_defaults() is
  'Restores the demo org to its seeded identity, KB, opening hours, upcoming bookings, one blocked-out stretch and two settled appointments earlier today. Called by demo_reset() and by demo-seed.sql.';
