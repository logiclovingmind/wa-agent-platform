-- Meta sends the customer's WhatsApp profile name on every inbound webhook, in
-- `contacts[].profile.name`. We were throwing it away and showing the raw wa_id, so the
-- inbox read as a list of phone numbers — the one thing an owner does not recognise.
--
-- Nullable with no backfill on purpose: the name is not ours to invent, and a customer
-- who has set no profile name genuinely has none. Reads fall back to the number.
alter table conversations add column if not exists customer_name text;
