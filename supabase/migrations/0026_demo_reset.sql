-- One-click undo for a walk-in demo.
--
-- A demo overlays a prospect's business onto the demo org: their KB pasted into the
-- console, their voice, and whatever threads arrive from messaging the sandbox number.
-- This deletes exactly that and nothing else, so the seeded backdrop never has to be
-- rebuilt — which is what makes it a button rather than a two-minute workflow run.
--
-- Two locks on every delete, the same pair `scripts/demo-seed.sql` uses: the org must be
-- the oldest `wa_accounts` row *and* carry `organizations.is_demo`. Neither alone is
-- allowed to authorise a delete.

-- The restore half, in `app` rather than `public` because PostgREST exposes only
-- `public`: nothing here is reachable over the API, so it needs no guard of its own and
-- the seed can call it directly as the migration runner. That is the whole point of
-- splitting it out — the defaults are defined once, and `demo_reset()`'s guard stays
-- narrow instead of being widened to admit a superuser.
--
-- Volatile (the default), not `stable`: a non-volatile function cannot execute an UPDATE.
create or replace function app.demo_restore_defaults()
returns void
language sql
security definer
set search_path = public
as $$
  update organizations
  set name = 'Demo Institute',
      sector = 'general',
      voice = 'warm and unhurried; explains before it sells; mirrors the customer''s Hinglish',
      reply_max_words = 120,
      languages = 'English, Hindi, Kannada'
  where id = (
    -- Both locks here too, not just on the deletes. `order by created_at limit 1` alone
    -- is not deterministic when two accounts share a timestamp, and this statement
    -- overwrites an org's identity — it must never be able to land on a paying client.
    select w.org_id
    from wa_accounts w
    join organizations o on o.id = w.org_id and o.is_demo
    order by w.created_at
    limit 1
  );
$$;

comment on function app.demo_restore_defaults() is
  'Restores the demo org to its seeded identity. Called by demo_reset() and by demo-seed.sql.';

create or replace function public.demo_reset()
returns table (
  conversations_removed bigint,
  kb_documents_removed bigint,
  usage_events_removed bigint
)
language plpgsql
security definer
set search_path = public
as $$
declare
  demo_org uuid;
begin
  -- First statement in the body, as in admin_orgs(). The `revoke ... from anon` at the
  -- foot of this file is the other lock; this guard is not meant to be the only one.
  if not app.is_platform_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  select w.org_id into demo_org
  from wa_accounts w
  join organizations o on o.id = w.org_id and o.is_demo
  order by w.created_at
  limit 1;

  -- No demo org means nothing to reset. The bare `return` matters: without it execution
  -- falls through to the deletes below, which is precisely the case the join above exists
  -- to prevent.
  if demo_org is null then
    return query select 0::bigint, 0::bigint, 0::bigint;
    return;
  end if;

  -- Seeded customers are all `9199900%`; a thread created by messaging the sandbox number
  -- from a real handset is anything else.
  delete from conversations
  where org_id = demo_org
    and customer_wa_id not like '9199900%';
  -- ROW_COUNT, not `returning 1 into`: that form assigns from the first returned row, so
  -- it reports 1 for any non-empty delete and null for an empty one.
  get diagnostics conversations_removed = row_count;

  delete from kb_documents
  where org_id = demo_org
    and title not like 'Demo — %';
  get diagnostics kb_documents_removed = row_count;

  -- `demo_reply` is the seeded spend history. What a walk-in really cost arrives as
  -- `reply` (the sandbox thread) and `console` (the training tab).
  delete from usage_events
  where org_id = demo_org
    and pricing_category <> 'demo_reply';
  get diagnostics usage_events_removed = row_count;

  perform app.demo_restore_defaults();

  return next;
end;
$$;

comment on function public.demo_reset() is
  'Deletes walk-in demo data from the demo org and restores its seeded identity. Platform admin only.';

-- Supabase grants EXECUTE on every new `public` function to `anon` and `authenticated`
-- by name, so `revoke ... from public` alone leaves this callable by anyone holding the
-- publishable key — which is compiled into the dashboard bundle. Missed four times in
-- this repo already (0006/0007, 0015, 0016, 0017). `ship.sh` curls it to prove otherwise.
revoke all on function public.demo_reset() from public, anon;
grant execute on function public.demo_reset() to authenticated;
