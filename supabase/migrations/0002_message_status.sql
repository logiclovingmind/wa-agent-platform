-- Session 2. Additive only: new nullable columns and one with a default, so this
-- is the "expand" half and there is nothing to contract.

-- Meta sends sent/delivered/read/failed on a separate webhook keyed by the same
-- wa_message_id. Deliberately unconstrained text — Meta adds values, and a check
-- constraint here would mean a migration every time they do.
alter table messages add column status text;
alter table messages add column status_at timestamptz;

-- text | image | audio | … . v1 accepts media but does not interpret it, so the
-- type is what tells the dashboard to show an attachment instead of a body.
alter table messages add column type text not null default 'text';

-- Status webhooks arrive keyed only by wa_message_id, and there is already a
-- unique index on that column, so the update is a single-row lookup.
