-- The KB half of the demo reset.
--
-- `demo_reset()` only ever deleted, and a demo has to delete: every document is
-- concatenated into the prompt on every turn, so leaving the two seeded coaching-institute
-- docs in place while a dental prospect's KB sits beside them produces a bot that quotes
-- course fees to a dentist. Deleting them was therefore step one of a demo — and nothing
-- put them back, so the second demo began with an empty KB and a bot that could only offer
-- to check with the team.
--
-- The bodies stay in `scripts/demo-seed.sql`, which is the only place they are written.
-- The seed leaves a copy here on its way past, and the restore replays it. That keeps one
-- source of truth for the text and still lets the reset be a button rather than a
-- workflow run.
create table if not exists app.demo_kb_seed (
  title text primary key,
  raw   text not null
);

-- No policy, deliberately: the only readers are the `security definer` functions below,
-- which run as the owner and are not subject to it. The table is in `app`, which PostgREST
-- does not expose, so this is the second lock rather than the first.
alter table app.demo_kb_seed enable row level security;

comment on table app.demo_kb_seed is
  'What demo-seed.sql last wrote into the demo org''s KB. Replayed by app.demo_restore_defaults().';

-- Both locks — oldest `wa_accounts` row *and* `organizations.is_demo` — in one place.
-- They were written out three times across 0026 and the seed, and the one copy that
-- dropped the `is_demo` join renamed a paying client's org in the test suite before the
-- test caught it. A statement that overwrites or deletes an org's rows should not be
-- restating this.
create or replace function app.demo_org()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select w.org_id
  from wa_accounts w
  join organizations o on o.id = w.org_id and o.is_demo
  order by w.created_at
  limit 1;
$$;

comment on function app.demo_org() is
  'The demo org: oldest wa_account, and is_demo. Null when there is no demo org.';

-- plpgsql now rather than sql: the org is resolved once and three statements share it.
create or replace function app.demo_restore_defaults()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  demo_org uuid := app.demo_org();
begin
  -- Without this the update below would match `where id = null` and the two writes after
  -- it would delete and insert against a null org — harmless by luck, not by design.
  if demo_org is null then
    return;
  end if;

  update organizations
  set name = 'Demo Institute',
      sector = 'general',
      voice = 'warm and unhurried; explains before it sells; mirrors the customer''s Hinglish',
      reply_max_words = 120,
      languages = 'English, Hindi, Kannada'
  where id = demo_org;

  -- Delete-then-insert rather than an upsert on title: a demo may have edited a seeded
  -- document in place instead of deleting it, and there is no unique index on
  -- (org_id, title) to conflict against anyway.
  delete from kb_documents where org_id = demo_org;

  insert into kb_documents (org_id, title, raw)
  select demo_org, s.title, s.raw from app.demo_kb_seed s;
end;
$$;

comment on function app.demo_restore_defaults() is
  'Restores the demo org to its seeded identity and KB. Called by demo_reset() and by demo-seed.sql.';

-- Unchanged except for the two locks moving into app.demo_org() and the KB predicate
-- becoming "not something the seed wrote" rather than a title prefix — a prospect whose
-- own KB happens to be titled `Demo — ...` was otherwise left behind.
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
  if not app.is_platform_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  demo_org := app.demo_org();

  if demo_org is null then
    return query select 0::bigint, 0::bigint, 0::bigint;
    return;
  end if;

  delete from conversations
  where org_id = demo_org
    and customer_wa_id not like '9199900%';
  get diagnostics conversations_removed = row_count;

  -- Counted before the restore replaces the whole KB, because this number is what the
  -- panel shows the operator: documents the walk-in left behind, not rows touched.
  delete from kb_documents
  where org_id = demo_org
    and title not in (select title from app.demo_kb_seed);
  get diagnostics kb_documents_removed = row_count;

  delete from usage_events
  where org_id = demo_org
    and pricing_category <> 'demo_reply';
  get diagnostics usage_events_removed = row_count;

  perform app.demo_restore_defaults();

  return next;
end;
$$;

revoke all on function public.demo_reset() from public, anon;
grant execute on function public.demo_reset() to authenticated;
