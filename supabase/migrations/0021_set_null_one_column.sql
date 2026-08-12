-- Two foreign keys promised to survive their parent and could not keep the promise.
--
-- `usage_events (conversation_id, org_id)` and `safety_flags (message_id, org_id)` are
-- both composite and both `on delete set null`. Plain `set null` nulls *every* column in
-- the key, so deleting the parent tried to null `org_id` too — which is `not null` on
-- both children. The delete did not orphan the row, it raised:
--
--   null value in column "org_id" of relation "usage_events" violates not-null constraint
--
-- and took its transaction with it. `on delete set null (column)` — Postgres 15 — nulls
-- only the column named, which is what both were always meant to say. The composite
-- reference stays, so a child still cannot point at another org's parent.
--
-- Neither has fired in production yet, and both were going to:
--   * retention (`cron.ts`, `0 21 * * *`) hard-deletes messages at 12 months, and
--     safety_flags outlive them deliberately — "delete the payload, keep the proof".
--     The first flagged message to turn 12 months old would have failed the whole sweep,
--     for every client at once, with no retry.
--   * erase (`conversation.ts`) only survives because it deletes usage_events first,
--     which is the opposite of what that FK was written to guarantee.

alter table usage_events
  drop constraint usage_events_conversation_id_org_id_fkey,
  add constraint usage_events_conversation_id_org_id_fkey
    foreign key (conversation_id, org_id) references conversations (id, org_id)
    on delete set null (conversation_id);

alter table safety_flags
  drop constraint safety_flags_message_id_org_id_fkey,
  add constraint safety_flags_message_id_org_id_fkey
    foreign key (message_id, org_id) references messages (id, org_id)
    on delete set null (message_id);
