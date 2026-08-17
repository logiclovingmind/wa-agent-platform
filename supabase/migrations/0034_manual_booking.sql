-- Booking somebody in by hand.
--
-- The assistant hands a conversation to a person the moment anything is delicate, and a
-- good half of real bookings are agreed on the phone. Until now neither of those could end
-- up in the diary: `book_appointment` is the only writer and it is revoked from every
-- browser login, deliberately, because its org id is an argument and reaching it from the
-- browser would let any client book into any other client's calendar.
--
-- ⚠️ A manual booking is confined to the same slot grid the assistant offers from, and
-- that is the whole design. `free_slots` decides whether a slot is taken by comparing
-- `starts_at` for equality, so a 09:15 booking entered by hand does not make 09:00 or 09:30
-- unavailable — the assistant would cheerfully book a customer on top of the walk-in and
-- neither the unique index nor anything else would notice. "Let staff type any time" is a
-- one-line change that silently reintroduces double-booking.

-- ---------------------------------------------------------------------------------------
-- The grid, in one place.
--
-- Three callers now need "which instants are slots for this org": `free_slots` (what the
-- assistant may offer), `block_time` (what the owner may take away) and `day_slots` below
-- (what a person may book into). They had two copies of the rule between them already and
-- this would have been the third. The rule is fiddly in exactly the way that rots — dow
-- taken from the IST date and never the UTC instant, and a last start one slot before
-- `closes_at` — so a disagreement between copies shows up as the assistant offering a time
-- the owner thinks they blocked.
create function app.slot_grid(p_org_id uuid, p_from date, p_to date)
returns table (starts_at timestamptz, slot_minutes smallint)
-- Invoker: inside `free_slots`, which is definer, this runs as that function's owner and
-- sees everything, exactly as the inline version did. Called from `block_time` or
-- `day_slots`, which are invoker, RLS on `business_hours` confines it to the caller's org.
-- One body, and the security follows the caller rather than being restated.
language sql stable security invoker set search_path = public
as $$
  select s.starts_at, h.slot_minutes
  from generate_series(p_from, p_to, interval '1 day') as d (day)
  join business_hours h
    on h.org_id = p_org_id
   and h.weekday = extract(dow from d.day)::smallint
  cross join lateral (
    -- `closes_at` is the moment the last slot *ends*, so the final start is one slot
    -- earlier. Without the subtraction a 09:00-17:00 day offers a 17:00 appointment.
    select generate_series(
             d.day::date + h.opens_at,
             d.day::date + h.closes_at - make_interval(mins => h.slot_minutes),
             make_interval(mins => h.slot_minutes)
           ) at time zone 'Asia/Kolkata' as starts_at
  ) s;
$$;

revoke all on function app.slot_grid(uuid, date, date) from public, anon;
grant execute on function app.slot_grid(uuid, date, date) to authenticated, service_role;

-- The other half of the same rule, asked backwards: not "which instants are slots" but "is
-- this instant one, and how long is it". `book_appointment` carried this inline; it is
-- lifted out here so that the hand-entry path below cannot drift from the assistant's.
create function app.slot_length(p_org_id uuid, p_at timestamptz)
returns smallint
language sql stable security invoker set search_path = public
as $$
  select h.slot_minutes
  from business_hours h
  where h.org_id = p_org_id
    and h.weekday = extract(dow from (p_at at time zone 'Asia/Kolkata'))::smallint
    and (p_at at time zone 'Asia/Kolkata')::time >= h.opens_at
    and (p_at at time zone 'Asia/Kolkata')::time < h.closes_at
    -- On the grid the day actually offers. 09:17 is inside 09:00-17:00 and is still not
    -- a slot anyone was shown.
    and mod(
      extract(epoch from ((p_at at time zone 'Asia/Kolkata')::time - h.opens_at))::int,
      h.slot_minutes * 60
    ) = 0
  limit 1;
$$;

revoke all on function app.slot_length(uuid, timestamptz) from public, anon;
grant execute on function app.slot_length(uuid, timestamptz) to authenticated, service_role;

-- ---------------------------------------------------------------------------------------
-- The three callers, now sharing it. Behaviour is unchanged in all three.

create or replace function public.free_slots(
  p_org_id uuid,
  p_days int default 7,
  p_limit int default 12,
  p_lead_minutes int default 30
) returns table (starts_at timestamptz)
language sql stable security definer set search_path = public
as $$
  select g.starts_at
  from app.slot_grid(
         p_org_id,
         (now() at time zone 'Asia/Kolkata')::date,
         (now() at time zone 'Asia/Kolkata')::date + greatest(p_days, 1) - 1
       ) g
  where g.starts_at >= now() + make_interval(mins => greatest(p_lead_minutes, 0))
    and not exists (
      select 1 from appointments a
      where a.org_id = p_org_id
        and a.starts_at = g.starts_at
        and a.status <> 'cancelled'
    )
  order by g.starts_at
  limit greatest(p_limit, 1);
$$;

create or replace function public.block_time(
  p_org_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_note text default null
) returns integer
language plpgsql volatile security invoker set search_path = public
as $$
declare
  blocked integer;
begin
  if p_to <= p_from then
    return 0;
  end if;

  -- A slip of the year field on a date input would otherwise generate slots for a decade
  -- and insert every one of them. Nothing legitimate blocks more than a season.
  if p_to > p_from + interval '90 days' then
    raise exception 'a block may not cover more than 90 days';
  end if;

  insert into appointments (org_id, starts_at, duration_minutes, service, kind)
  select p_org_id, g.starts_at, g.slot_minutes, nullif(trim(p_note), ''), 'block'
  from app.slot_grid(
         p_org_id,
         (p_from at time zone 'Asia/Kolkata')::date,
         (p_to at time zone 'Asia/Kolkata')::date
       ) g
  where g.starts_at >= p_from
    and g.starts_at < p_to
  -- A slot already taken stays taken. A customer who was promised this time is not
  -- unpromised it by the owner marking themselves away — the owner has to see that
  -- booking and cancel it deliberately, which is why the count comes back.
  on conflict do nothing;

  get diagnostics blocked = row_count;
  return blocked;
end;
$$;

create or replace function public.book_appointment(
  p_org_id uuid,
  p_conversation_id uuid,
  p_starts_at timestamptz,
  p_name text default null,
  p_service text default null
) returns uuid
language plpgsql volatile security definer set search_path = public
as $$
declare
  slot_len smallint;
  new_id uuid;
begin
  if p_starts_at <= now() then
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
    p_org_id, p_conversation_id, p_starts_at, slot_len,
    nullif(trim(p_name), ''), nullif(trim(p_service), '')
  )
  on conflict do nothing
  returning id into new_id;

  return new_id;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- What the Diary calls.

-- The bookable slots on one IST day, already minus what is taken. The Diary has the day's
-- bookings in memory and could subtract them itself, but then "is this slot free" would be
-- decided in the browser for the hand-entry path and in SQL for the assistant's, which is
-- the same split this migration exists to close.
create function public.day_slots(p_org_id uuid, p_day date)
returns table (starts_at timestamptz, slot_minutes smallint)
language sql stable security invoker set search_path = public
as $$
  select g.starts_at, g.slot_minutes
  from app.slot_grid(p_org_id, p_day, p_day) g
  where not exists (
    select 1 from appointments a
    where a.org_id = p_org_id
      and a.starts_at = g.starts_at
      and a.status <> 'cancelled'
  )
  order by g.starts_at;
$$;

revoke all on function public.day_slots(uuid, date) from public, anon;
grant execute on function public.day_slots(uuid, date) to authenticated;

-- Takes a slot for a customer the assistant never spoke to. Returns the new id, or null if
-- the slot is not a slot or somebody took it first — the same two answers, meaning the same
-- thing, as `book_appointment`.
create function public.book_manual(
  p_org_id uuid,
  p_starts_at timestamptz,
  p_name text default null,
  p_service text default null
) returns uuid
-- Invoker, so `appointments`' own with-check decides whose diary this writes to. The
-- definer twin above can be trusted with a bare org id because only the Worker can reach
-- it; this one is called straight from a browser and cannot.
language plpgsql volatile security invoker set search_path = public
as $$
declare
  slot_len smallint := app.slot_length(p_org_id, p_starts_at);
  new_id uuid;
begin
  if slot_len is null then
    return null;
  end if;

  -- No "not in the past" guard, unlike `book_appointment`. That guard exists because the
  -- assistant must never confirm a time that has already gone; a person recording the
  -- walk-in who is standing in front of them is the opposite situation, and refusing it
  -- would make the diary disagree with what actually happened this morning.
  insert into appointments (
    org_id, conversation_id, starts_at, duration_minutes, customer_name, service
  )
  values (
    p_org_id, null, p_starts_at, slot_len,
    nullif(trim(p_name), ''), nullif(trim(p_service), '')
  )
  on conflict do nothing
  returning id into new_id;

  return new_id;
end;
$$;

revoke all on function public.book_manual(uuid, timestamptz, text, text) from public, anon;
grant execute on function public.book_manual(uuid, timestamptz, text, text) to authenticated;
