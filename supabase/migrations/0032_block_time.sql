-- Blocking time out of the diary.
--
-- `kind = 'block'` has existed since 0029 and every reader already honours it — the
-- calendar renders it, `free_slots` skips it, `book_appointment` collides with it. What
-- was missing was any way to *create* one, so an owner who was away could watch the
-- assistant book customers into an empty clinic and could do nothing about it.
--
-- ⚠️ One row per slot, not one row per range. `appointments_slot_idx` is unique on
-- `(org_id, starts_at)` and `free_slots` matches a booking to a slot by equality on
-- `starts_at`, so a single row covering 14:00-18:00 would free-standingly block 14:00 and
-- leave 14:30 through 17:30 bookable. Expanding the range onto the same grid the slots
-- come from is what makes the block mean what it says.

create function public.block_time(
  p_org_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_note text default null
) returns integer
-- Invoker, not definer: the two policies on the tables it touches are exactly the check
-- this needs, so a caller passing somebody else's org id is refused by `appointments`'
-- with-check rather than by an argument test written here. `org_month_spend` is invoker
-- for the same reason.
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

  -- The grid below is deliberately the same shape as `free_slots`: IST date, `dow` taken
  -- from that date and never from the UTC instant, and the final start one slot before
  -- `closes_at`. If one of the two ever changes, the other has to change with it, or the
  -- owner will block a slot the assistant is still offering.
  with days as (
    select ((p_from at time zone 'Asia/Kolkata')::date + offs) as d
    from generate_series(
      0,
      (p_to at time zone 'Asia/Kolkata')::date - (p_from at time zone 'Asia/Kolkata')::date
    ) as offs
  ),
  slots as (
    select s.starts_at, h.slot_minutes
    from days
    join business_hours h
      on h.org_id = p_org_id
     and h.weekday = extract(dow from days.d)::smallint
    cross join lateral (
      select generate_series(
               days.d + h.opens_at,
               days.d + h.closes_at - make_interval(mins => h.slot_minutes),
               make_interval(mins => h.slot_minutes)
             ) at time zone 'Asia/Kolkata' as starts_at
    ) s
  )
  insert into appointments (org_id, starts_at, duration_minutes, service, kind)
  select p_org_id, slots.starts_at, slots.slot_minutes, nullif(trim(p_note), ''), 'block'
  from slots
  where slots.starts_at >= p_from
    and slots.starts_at < p_to
  -- A slot already taken stays taken. A customer who was promised this time is not
  -- unpromised it by the owner marking themselves away — the owner has to see that
  -- booking and cancel it deliberately, which is why the count comes back.
  on conflict do nothing;

  get diagnostics blocked = row_count;
  return blocked;
end;
$$;

revoke all on function public.block_time(uuid, timestamptz, timestamptz, text) from public, anon;
grant execute on function public.block_time(uuid, timestamptz, timestamptz, text) to authenticated;
