-- Booking. `prompt.ts` has told every healthcare client since day one that the assistant
-- "books and reschedules appointments", and until this migration there was no availability
-- data anywhere in the repo — so the model either deferred to the team or invented a time.
-- This is the data that makes the sentence true.
--
-- Deliberately NOT Google Calendar. Per-client OAuth means a token, a refresh loop and a
-- consent screen per client, and onboarding stops being an INSERT.

-- Recurring weekly hours. The owner sets these once; there is no per-date variant, because
-- a one-off closure is expressible as a `block` row in `appointments` below and a second
-- mechanism for "the clinic is shut" is a second thing to keep in sync.
--
-- `weekday` is Postgres `extract(dow)`: 0 = Sunday .. 6 = Saturday, and it is extracted
-- from the IST date, never the UTC one. A 22:00 IST slot is the *next* day in UTC, so
-- taking dow from the stored timestamptz would file Saturday evening under Sunday.
create table business_hours (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  weekday smallint not null check (weekday between 0 and 6),
  -- Wall-clock IST, not timestamptz: "we open at 9:30" is a fact about the clock on the
  -- clinic wall and stays true across any date. Invariant 12 governs instants; this is
  -- not an instant.
  opens_at time not null,
  closes_at time not null,
  slot_minutes smallint not null default 30 check (slot_minutes between 5 and 240),
  created_at timestamptz not null default now(),
  check (closes_at > opens_at),
  -- One window per weekday per org. A clinic that shuts for lunch is two rows, which is
  -- why this is not a primary key on (org_id, weekday).
  unique (org_id, weekday, opens_at)
);
create index business_hours_org_idx on business_hours (org_id, weekday);

alter table business_hours enable row level security;
alter table business_hours force row level security;

-- Staff read them (they answer the inbox and get asked "are you open Sunday?"), owners
-- set them. Same split as the KB.
create policy business_hours_read on business_hours
  for select to authenticated
  using (app.is_member(org_id));
create policy business_hours_write on business_hours
  for all to authenticated
  using (app.is_owner(org_id))
  with check (app.is_owner(org_id));

grant select, insert, update, delete on business_hours to authenticated;
revoke all on business_hours from anon;

-- One row per booked slot. `kind` is what keeps this to one table: a holiday, a lunch
-- break or a walk-in the owner is blocking out is an appointment with no customer, so
-- "this time is not available" has exactly one meaning and one index enforcing it.
create table appointments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  -- Null for a `block`, and null for anything the owner enters by hand. A booking that
  -- came from WhatsApp carries the thread it was agreed in, which is the only way the
  -- owner can check what was actually promised.
  conversation_id uuid,
  starts_at timestamptz not null,
  duration_minutes smallint not null default 30 check (duration_minutes between 5 and 240),
  customer_name text,
  service text,
  status text not null default 'booked' check (status in ('booked', 'cancelled')),
  kind text not null default 'appointment' check (kind in ('appointment', 'block')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (conversation_id, org_id) references conversations (id, org_id) on delete set null
);

-- The arbiter for the double-booking race. A Durable Object is per-conversation, not
-- per-org, so two customers offered the same slot can be told it is free at the same
-- instant and both try to take it. Nothing in the Worker can serialise that; this index
-- can. `book_appointment` below turns the violation into a null return rather than an
-- error, and the caller sends a person instead of a confirmation.
create unique index appointments_slot_idx
  on appointments (org_id, starts_at)
  where status <> 'cancelled';

create index appointments_org_time_idx on appointments (org_id, starts_at);

create trigger appointments_touch
  before update on appointments
  for each row execute function app.touch_updated_at();

alter table appointments enable row level security;
alter table appointments force row level security;

-- Staff mark bookings (data-model.md roles table), so this is not owner-gated.
create policy appointments_read on appointments
  for select to authenticated
  using (app.is_member(org_id));
create policy appointments_write on appointments
  for all to authenticated
  using (app.is_member(org_id))
  with check (app.is_member(org_id));

grant select, insert, update, delete on appointments to authenticated;
revoke all on appointments from anon;

-- The slots offered to the model.
--
-- In SQL rather than TypeScript because of the 10ms CPU budget: waiting on Postgres is
-- I/O and free, generating a week of slots and subtracting the booked ones in the Worker
-- is not. The Worker receives a short list and formats it.
--
-- `p_lead_minutes` keeps the assistant from confirming a time that has already effectively
-- passed while the customer was typing.
create function public.free_slots(
  p_org_id uuid,
  p_days int default 7,
  p_limit int default 12,
  p_lead_minutes int default 30
) returns table (starts_at timestamptz)
language sql stable security definer set search_path = public
as $$
  with days as (
    select ((now() at time zone 'Asia/Kolkata')::date + offs) as d
    from generate_series(0, greatest(p_days, 1) - 1) as offs
  ),
  slots as (
    select s.starts_at
    from days
    join business_hours h
      on h.org_id = p_org_id
     and h.weekday = extract(dow from days.d)::smallint
    cross join lateral (
      -- `closes_at` is the moment the last slot *ends*, so the final start is one slot
      -- earlier. Without the subtraction a 09:00-17:00 day offers a 17:00 appointment.
      select generate_series(
               days.d + h.opens_at,
               days.d + h.closes_at - make_interval(mins => h.slot_minutes),
               make_interval(mins => h.slot_minutes)
             ) at time zone 'Asia/Kolkata' as starts_at
    ) s
  )
  select s.starts_at
  from slots s
  where s.starts_at >= now() + make_interval(mins => greatest(p_lead_minutes, 0))
    and not exists (
      select 1 from appointments a
      where a.org_id = p_org_id
        and a.starts_at = s.starts_at
        and a.status <> 'cancelled'
    )
  order by s.starts_at
  limit greatest(p_limit, 1);
$$;

revoke all on function public.free_slots(uuid, int, int, int) from public, anon;
grant execute on function public.free_slots(uuid, int, int, int) to authenticated;

-- Takes a slot, or returns null if it could not.
--
-- Null has two causes and the caller treats them identically: the slot is not a real slot
-- (outside business hours, off the grid, in the past), or someone else took it between the
-- prompt being built and the reply being written. Both mean the confirmation the model
-- just wrote is false and must not be sent.
--
-- The business-hours check is not redundant with only ever offering generated slots. The
-- model is the thing choosing, the KB sits in the same prompt and can contradict its
-- instructions, and safety.md is explicit that guardrails in a prompt are enforced by a
-- check in code. This is that check.
create function public.book_appointment(
  p_org_id uuid,
  p_conversation_id uuid,
  p_starts_at timestamptz,
  p_name text default null,
  p_service text default null
) returns uuid
language plpgsql volatile security definer set search_path = public
as $$
declare
  local_time time := (p_starts_at at time zone 'Asia/Kolkata')::time;
  local_dow smallint := extract(dow from (p_starts_at at time zone 'Asia/Kolkata'))::smallint;
  slot_len smallint;
  new_id uuid;
begin
  if p_starts_at <= now() then
    return null;
  end if;

  select h.slot_minutes into slot_len
  from business_hours h
  where h.org_id = p_org_id
    and h.weekday = local_dow
    and local_time >= h.opens_at
    and local_time < h.closes_at
    -- On the grid the day actually offers. 09:17 is inside 09:00-17:00 and is still not
    -- a slot anyone was shown.
    and mod(
      extract(epoch from (local_time - h.opens_at))::int,
      h.slot_minutes * 60
    ) = 0
  limit 1;

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

-- Definer and cross-org by signature. The Worker calls it as service_role; a browser that
-- could reach it could book into any org.
revoke all on function public.book_appointment(uuid, uuid, timestamptz, text, text)
  from public, anon, authenticated;
