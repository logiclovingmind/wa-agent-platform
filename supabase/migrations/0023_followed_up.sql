-- "I have called this person back."
--
-- On conversations rather than on leads, deliberately. A lead is what the assistant
-- heard; whether anyone acted on it is a fact about the customer, and a conversation is
-- a customer. Putting it on leads would create a second lifecycle running alongside
-- handoff_state, and the two would eventually disagree about whether somebody had been
-- dealt with — which is the only question this column exists to answer.
--
-- Nullable with no default: null means "not yet", which is also the honest state of
-- every row that existed before this migration. Nothing needs backfilling.
alter table conversations add column followed_up_at timestamptz;

-- The one thing the browser may write on this table. Sending touches Meta and money, so
-- it goes through the Worker (invariant 6) — this touches neither. It is a note the
-- owner makes to themselves, and routing it through a Worker endpoint would buy nothing
-- but a round trip. The column grant is the lock: an update policy alone would let a
-- member rewrite handoff_state or window_expires_at from the browser and desynchronise
-- the DO.
grant update (followed_up_at) on conversations to authenticated;

create policy conversations_follow_up on conversations
  for update to authenticated
  using (app.is_member(org_id))
  with check (app.is_member(org_id));

-- Partial: the list only ever asks for the ones still owed a call, and they are the
-- minority the moment a client actually works the list.
create index conversations_to_call_idx on conversations (org_id, last_message_at desc)
  where followed_up_at is null;
