-- Keep what a walk-in demo built, so the reset stops being a one-way door.
--
-- `demo_reset()` deletes the prospect's KB and overwrites the org's identity, which is
-- correct — the next walk-in must not be answered with the last one's fees. But it was
-- the *only* exit from a demo, so twenty minutes of pasting a prospect's business into
-- the training console died the moment the operator wanted the room back. Coming back to
-- the same prospect a week later meant typing all of it again.
--
-- A setup is the whole overlay: the org's identity (name, sector, voice, word cap,
-- languages) plus every KB document, captured as one row. Restoring one is the reset
-- run backwards.

create table demo_setups (
  id uuid primary key default gen_random_uuid(),
  -- Invariant 1, even though every row here belongs to the demo org by construction. The
  -- cascade is the point: if the demo org is ever deleted, its saved overlays go with it.
  org_id uuid not null references organizations (id) on delete cascade,
  label text not null,
  name text not null,
  sector text not null,
  voice text,
  reply_max_words smallint,
  languages text,
  -- `[{"title": ..., "raw": ...}, ...]`. One row per setup rather than a child table:
  -- a setup is only ever written and read whole, and a KB with a foreign key back to a
  -- snapshot is a second thing to keep consistent for no read this app performs.
  kb jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
create index demo_setups_org_idx on demo_setups (org_id, created_at desc);

alter table demo_setups enable row level security;
alter table demo_setups force row level security;

-- Platform admin only, for both halves. A client has no demo org and no business seeing
-- another prospect's pasted KB — and the panel that lists these is already admin-only.
create policy demo_setups_read on demo_setups
  for select to authenticated
  using (app.is_platform_admin());

-- Deleting a stale setup is a plain DELETE from the panel rather than another RPC. The
-- policy is the guard, and there is nothing to compute.
create policy demo_setups_delete on demo_setups
  for delete to authenticated
  using (app.is_platform_admin());

-- Writes go through the `security definer` functions below, never straight from the
-- browser: a setup has to be captured from the org's live state, not posted by a client.
grant select, delete on demo_setups to authenticated;
revoke all on demo_setups from anon;

comment on table demo_setups is
  'Saved walk-in demo overlays: the demo org''s identity and KB, captured whole.';

-- ---------------------------------------------------------------------------

/*
 * Capture the demo org as it stands. Returns the new row's id, or null when there was
 * nothing a walk-in put there.
 *
 * "Nothing to keep" is defined as "the KB holds no document the seed did not write" —
 * the same predicate `demo_reset()` deletes on. Deliberately not also comparing the org's
 * identity against the seeded defaults: those defaults live in
 * `app.demo_restore_defaults()`, and 0027 exists because this repo had already written
 * the demo org's identifying details out in three places and one copy drifted. A demo
 * that only renamed the org and pasted no KB is not worth a row; `demo_setup_save()` is
 * there for the operator who disagrees.
 */
create or replace function app.demo_setup_snapshot(p_label text default null)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  demo_org uuid := app.demo_org();
  setup_id uuid;
  captured jsonb;
begin
  if demo_org is null then
    return null;
  end if;

  -- Ordered so a restored setup rebuilds the KB in the order it was pasted, and so two
  -- snapshots of the same state compare equal.
  select coalesce(jsonb_agg(jsonb_build_object('title', d.title, 'raw', d.raw)
                            order by d.created_at, d.title), '[]'::jsonb)
    into captured
    from kb_documents d
   where d.org_id = demo_org;

  if p_label is null
     and not exists (
       select 1 from kb_documents d
        where d.org_id = demo_org
          and d.title not in (select title from app.demo_kb_seed)
     )
  then
    return null;
  end if;

  insert into demo_setups (org_id, label, name, sector, voice, reply_max_words, languages, kb)
  select demo_org,
         -- Invariant 12: stored UTC everywhere, but a label is display text and the
         -- operator reading this list is in IST.
         coalesce(p_label, o.name || ' — ' ||
                  to_char(now() at time zone 'Asia/Kolkata', 'DD Mon YYYY, HH12:MI am')),
         o.name, o.sector, o.voice, o.reply_max_words, o.languages, captured
    from organizations o
   where o.id = demo_org
  returning id into setup_id;

  return setup_id;
end;
$$;

comment on function app.demo_setup_snapshot(text) is
  'Captures the demo org''s identity and KB as a demo_setups row. Null label means '
  'auto-name and skip when the walk-in added no KB.';

-- ---------------------------------------------------------------------------

/** Save the current overlay under a name the operator chose, mid-demo. */
create or replace function public.demo_setup_save(p_label text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  clean text := nullif(btrim(p_label), '');
begin
  if not app.is_platform_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  -- A null label would fall through to the auto-name-and-skip path, which is not what a
  -- button called "Save setup" promises.
  if clean is null then
    raise exception 'a setup needs a name' using errcode = '22023';
  end if;

  return app.demo_setup_snapshot(left(clean, 120));
end;
$$;

comment on function public.demo_setup_save(text) is
  'Saves the demo org''s current identity and KB as a named setup. Platform admin only.';

revoke all on function public.demo_setup_save(text) from public, anon;
grant execute on function public.demo_setup_save(text) to authenticated;

-- ---------------------------------------------------------------------------

/**
 * Put a saved overlay back. The reset run backwards, and the same shape as
 * `app.demo_restore_defaults()`: overwrite the identity, then replace the KB whole.
 */
create or replace function public.demo_setup_load(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  demo_org uuid;
  setup demo_setups;
begin
  if not app.is_platform_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  demo_org := app.demo_org();
  if demo_org is null then
    raise exception 'no demo org' using errcode = 'P0002';
  end if;

  -- Matched on org as well as id. A setup belongs to the org it was taken from, and this
  -- function writes an org's identity — it must not be able to paste one org's overlay
  -- onto another because an id was guessed.
  select * into setup from demo_setups where id = p_id and org_id = demo_org;
  if not found then
    raise exception 'no such setup' using errcode = 'P0002';
  end if;

  update organizations
     set name = setup.name,
         sector = setup.sector,
         voice = setup.voice,
         reply_max_words = setup.reply_max_words,
         languages = setup.languages
   where id = demo_org;

  -- Delete-then-insert, as in app.demo_restore_defaults(): there is no unique index on
  -- (org_id, title) to upsert against, and a half-replaced KB is a bot quoting two
  -- businesses' prices in one reply.
  delete from kb_documents where org_id = demo_org;

  insert into kb_documents (org_id, title, raw)
  select demo_org, x.title, x.raw
    from jsonb_to_recordset(setup.kb) as x(title text, raw text)
   where x.title is not null and x.raw is not null;
end;
$$;

comment on function public.demo_setup_load(uuid) is
  'Restores a saved demo setup onto the demo org, replacing its identity and KB. '
  'Platform admin only.';

revoke all on function public.demo_setup_load(uuid) from public, anon;
grant execute on function public.demo_setup_load(uuid) to authenticated;

-- ---------------------------------------------------------------------------

-- Dropped rather than replaced: the return type gains a column, and `create or replace`
-- cannot change a function's result type. The added column is last, so a dashboard build
-- that predates this migration keeps reading the three counts it knows about.
drop function public.demo_reset();

create function public.demo_reset()
returns table (
  conversations_removed bigint,
  kb_documents_removed bigint,
  usage_events_removed bigint,
  setup_saved text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  demo_org uuid;
  saved uuid;
begin
  if not app.is_platform_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;

  demo_org := app.demo_org();

  if demo_org is null then
    return query select 0::bigint, 0::bigint, 0::bigint, null::text;
    return;
  end if;

  -- Before the deletes, which is the whole reason this call is here. Auto-labelled and
  -- skipped when the walk-in pasted no KB, so pressing reset on an untouched demo does
  -- not accumulate rows.
  saved := app.demo_setup_snapshot();

  delete from conversations
  where org_id = demo_org
    and customer_wa_id not like '9199900%';
  get diagnostics conversations_removed = row_count;

  delete from kb_documents
  where org_id = demo_org
    and title not in (select title from app.demo_kb_seed);
  get diagnostics kb_documents_removed = row_count;

  delete from usage_events
  where org_id = demo_org
    and pricing_category <> 'demo_reply';
  get diagnostics usage_events_removed = row_count;

  perform app.demo_restore_defaults();

  select s.label into setup_saved from demo_setups s where s.id = saved;

  return next;
end;
$$;

comment on function public.demo_reset() is
  'Saves the walk-in overlay as a demo_setups row, then deletes it from the demo org and '
  'restores the seeded identity. Platform admin only.';

revoke all on function public.demo_reset() from public, anon;
grant execute on function public.demo_reset() to authenticated;
