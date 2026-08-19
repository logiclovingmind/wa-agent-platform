-- Two things a person can now do from the conversation they are reading: correct what the
-- assistant wrote down, and put the customer in the diary.
--
-- Both already existed elsewhere and neither was reachable from the thread, which is the
-- one screen where somebody actually knows the answer. The lead panel was read-only
-- because `leads` is written by the model; the diary's hand-entry form was on the diary,
-- so booking the customer you are talking to meant leaving the conversation, retyping the
-- name and losing the thread.

-- ---------------------------------------------------------------------------------------
-- 1. A lead a person can correct.
--
-- ⚠️ Replace, not merge. `record_lead` coalesces because the model sees ten turns and a
-- reply that never mentions the budget must not erase the budget. A person clearing a
-- field means the opposite: the assistant guessed "₹50,000" from a passing remark and the
-- owner, who has just spoken to the customer, is deleting it. Coalescing here would make
-- a wrong value permanent — the one thing manual entry exists to fix. Two functions with
-- two behaviours, rather than one with a flag nobody would remember to pass.

create policy leads_write on leads
  for insert to authenticated
  with check (app.is_member(org_id));

create policy leads_edit on leads
  for update to authenticated
  using (app.is_member(org_id))
  with check (app.is_member(org_id));

-- Column-scoped, so `org_id` and `conversation_id` cannot be rewritten by a browser: a
-- lead may be corrected, never moved to another customer or another client.
grant insert (org_id, conversation_id, name, intent, timeframe, budget, notes) on leads
  to authenticated;
grant update (name, intent, timeframe, budget, notes, updated_at) on leads to authenticated;

-- Invoker, and no org id in the signature — the two together are what make this safe to
-- call from a browser. The org is read off the conversation under RLS, so a member of org
-- A asking about org B's conversation gets no row and the function returns null rather
-- than writing anything.
create function public.edit_lead(
  p_conversation_id uuid,
  p_name text default null,
  p_intent text default null,
  p_timeframe text default null,
  p_budget text default null,
  p_notes text default null
) returns uuid
language plpgsql volatile security invoker set search_path = public
as $$
declare
  target_org uuid;
  lead_id uuid;
begin
  select org_id into target_org from conversations where id = p_conversation_id;

  if target_org is null then
    return null;
  end if;

  insert into leads (org_id, conversation_id, name, intent, timeframe, budget, notes)
  values (
    target_org, p_conversation_id,
    nullif(trim(p_name), ''), nullif(trim(p_intent), ''), nullif(trim(p_timeframe), ''),
    nullif(trim(p_budget), ''), nullif(trim(p_notes), '')
  )
  -- The insert is the "no lead yet" case: a conversation the assistant never learned
  -- anything from is exactly the one somebody phones about and wants to write down.
  on conflict (conversation_id) do update set
    name       = excluded.name,
    intent     = excluded.intent,
    timeframe  = excluded.timeframe,
    budget     = excluded.budget,
    notes      = excluded.notes,
    updated_at = now()
  returning id into lead_id;

  return lead_id;
end;
$$;

revoke all on function public.edit_lead(uuid, text, text, text, text, text) from public, anon;
grant execute on function public.edit_lead(uuid, text, text, text, text, text) to authenticated;

-- ---------------------------------------------------------------------------------------
-- 2. Who took the booking, as a fact rather than an inference.
--
-- The diary has been reading `conversation_id is not null` as "the assistant booked this",
-- which was true only because the assistant was the only writer that set it. Booking from
-- a thread sets it too, and without this column every walk-in entered by the person on the
-- phone would be counted back to the owner as work the assistant did — a number in the
-- owner's own dashboard, quietly inflating itself.
--
-- Default 'person', because that is what a row nobody marked actually is: a block is made
-- by a person, a hand-entered booking is made by a person, and only `book_appointment`
-- knows otherwise. The backfill is exact rather than a guess: until this migration, a
-- conversation on an appointment could only have come from `book_appointment`.
alter table appointments
  add column source text not null default 'person'
  check (source in ('assistant', 'person'));

update appointments set source = 'assistant' where conversation_id is not null;

-- The assistant's own writer says so.
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
    org_id, conversation_id, starts_at, duration_minutes, customer_name, service, source
  )
  values (
    p_org_id, p_conversation_id, p_starts_at, slot_len,
    nullif(trim(p_name), ''), nullif(trim(p_service), ''), 'assistant'
  )
  on conflict do nothing
  returning id into new_id;

  return new_id;
end;
$$;

-- Moving a booking must not change who took it. Rescheduling the assistant's 10:30 into
-- Thursday is the same booking at a different hour, and a reschedule that flipped it to
-- 'person' would make the diary's count fall every time somebody moved an appointment.
create or replace function public.reschedule_appointment(
  p_org_id uuid,
  p_id uuid,
  p_starts_at timestamptz
) returns uuid
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
    org_id, conversation_id, starts_at, duration_minutes, customer_name, service, source
  )
  values (
    p_org_id, prev.conversation_id, p_starts_at, slot_len,
    prev.customer_name, prev.service, prev.source
  )
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

-- ---------------------------------------------------------------------------------------
-- 3. Hand entry that can name the thread it came from.
--
-- Dropped and recreated rather than given a defaulted sixth argument: two overloads that
-- both accept four named arguments are ambiguous to PostgREST, and the error it returns
-- says nothing useful about why.
--
-- The link is the point. A booking with a conversation is one `desk_queue` can put back on
-- the desk when it is marked a no-show, with a number to ring; a booking without one is
-- rescheduled in the diary or not at all. Somebody booked over WhatsApp by a human is in
-- the first category, and until now the only way to record them put them in the second.
drop function public.book_manual(uuid, timestamptz, text, text);

create function public.book_manual(
  p_org_id uuid,
  p_starts_at timestamptz,
  p_name text default null,
  p_service text default null,
  p_conversation_id uuid default null
) returns uuid
language plpgsql volatile security invoker set search_path = public
as $$
declare
  slot_len smallint := app.slot_length(p_org_id, p_starts_at);
  new_id uuid;
begin
  if slot_len is null then
    return null;
  end if;

  -- No membership check on the conversation, and none needed: the composite foreign key
  -- (conversation_id, org_id) refuses a thread belonging to another org, and the org id
  -- itself is already decided by `appointments`' with-check under RLS.
  insert into appointments (
    org_id, conversation_id, starts_at, duration_minutes, customer_name, service, source
  )
  values (
    p_org_id, p_conversation_id, p_starts_at, slot_len,
    nullif(trim(p_name), ''), nullif(trim(p_service), ''), 'person'
  )
  on conflict do nothing
  returning id into new_id;

  return new_id;
end;
$$;

revoke all on function public.book_manual(uuid, timestamptz, text, text, uuid) from public, anon;
grant execute on function public.book_manual(uuid, timestamptz, text, text, uuid) to authenticated;
