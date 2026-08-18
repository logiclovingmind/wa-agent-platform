-- The same foreign key mistake 0021 fixed, reintroduced by 0029.
--
-- `appointments (conversation_id, org_id)` is composite and `on delete set null`. Plain
-- `set null` nulls *every* column in the key, so deleting a conversation that has a
-- booking against it tried to null `org_id` too, which is `not null`:
--
--   null value in column "org_id" of relation "appointments" violates not-null constraint
--
-- `on delete set null (conversation_id)` nulls only the column named. The composite
-- reference stays, so a booking still cannot point at another org's conversation.
--
-- This one had already fired. `scripts/demo-seed.sql` clears the demo org's
-- conversations before reseeding, and every run since 0029 has aborted there — which is
-- why the demo Desk still read zero after the nightly roll and could not be reset.
-- `erase` in `conversation.ts` deletes a single thread on request and would have failed
-- the same way for a real client the moment that thread carried a booking.
--
-- The column was always meant to go null on its own: 0029 says a booking keeps "the
-- thread it was agreed in", and null is what a hand-entered booking or a block already
-- stores there.

alter table appointments
  drop constraint appointments_conversation_id_org_id_fkey,
  add constraint appointments_conversation_id_org_id_fkey
    foreign key (conversation_id, org_id) references conversations (id, org_id)
    on delete set null (conversation_id);
