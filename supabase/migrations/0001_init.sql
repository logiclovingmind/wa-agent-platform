-- Session 1: schema + RLS.
-- Invariant 1: org_id on every table, RLS on every table.
-- Invariant 2: service_role bypasses RLS. These policies are the SECOND lock.
--              The Worker still filters by org_id in code. See packages/shared/src/db.ts.

create extension if not exists pgcrypto;
create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

create type org_role as enum ('owner', 'staff');
create type handoff_state as enum ('bot', 'requested', 'human', 'returned');
create type message_direction as enum ('inbound', 'outbound');
create type safety_kind as enum ('distress', 'self_harm', 'abuse', 'minor');

create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  -- RAG retrieval is OFF by design. See .claude/rules/data-model.md.
  rag_enabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table users (
  id uuid primary key references auth.users (id) on delete cascade,
  org_id uuid not null references organizations (id) on delete cascade,
  email text not null unique,
  -- Deliberately NOT a value of org_role: no bug in role logic can promote a client.
  is_platform_admin boolean not null default false,
  created_at timestamptz not null default now()
);
create index users_org_idx on users (org_id);

create table org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role org_role not null,
  created_at timestamptz not null default now(),
  unique (user_id, org_id)
);
create index org_members_org_idx on org_members (org_id);

create table wa_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  phone_number_id text not null unique,
  waba_id text not null,
  display_phone_number text not null,
  webhook_slug text not null unique,
  -- AES-GCM under one master key held as a Wrangler secret. key_version lets the
  -- master key rotate with no schema change. A dump leaks nothing.
  -- base64 text rather than bytea: PostgREST renders bytea as a `\x…` hex escape,
  -- which every reader would then have to decode by hand. The bytes are ciphertext
  -- either way.
  token_ciphertext text not null,
  token_iv text not null,
  token_key_version integer not null default 1,
  app_secret_ciphertext text not null,
  app_secret_iv text not null,
  app_secret_key_version integer not null default 1,
  created_at timestamptz not null default now(),
  -- Redundant against the PK, but it is what lets children point at this row
  -- *and* its org in a single constraint. See conversations below.
  unique (id, org_id)
);
create index wa_accounts_org_idx on wa_accounts (org_id);

create table conversations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  wa_account_id uuid not null,
  customer_wa_id text not null,
  handoff_state handoff_state not null default 'bot',
  window_expires_at timestamptz,
  last_message_at timestamptz,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (org_id, wa_account_id, customer_wa_id),
  unique (id, org_id),
  -- Composite on purpose: a plain FK on wa_account_id alone would happily let an
  -- org A conversation hang off an org B phone number. The database refuses
  -- cross-org parentage so a Worker bug cannot create it.
  foreign key (wa_account_id, org_id) references wa_accounts (id, org_id) on delete cascade
);
create index conversations_inbox_idx on conversations (org_id, updated_at desc);

-- NOT partitioned. Deliberate: a unique index on a partitioned table must contain
-- every partition key column, so UNIQUE (wa_message_id) is rejected and the
-- "fix" UNIQUE (wa_message_id, created_at) silently stops deduping.
-- See .claude/rules/data-model.md before revisiting.
create table messages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  conversation_id uuid not null,
  wa_message_id text not null unique,
  direction message_direction not null,
  body text,
  media_r2_key text,
  created_at timestamptz not null default now(),
  unique (id, org_id),
  foreign key (conversation_id, org_id) references conversations (id, org_id) on delete cascade
);
create index messages_page_idx on messages (org_id, conversation_id, created_at desc);
create index messages_archive_idx on messages (created_at);

create table inbound_dedupe (
  wa_message_id text primary key,
  org_id uuid not null references organizations (id) on delete cascade,
  seen_at timestamptz not null default now()
);
create index inbound_dedupe_sweep_idx on inbound_dedupe (seen_at);

create table kb_documents (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  title text not null,
  raw text not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (id, org_id)
);
create index kb_documents_org_idx on kb_documents (org_id);

-- Dormant. The column exists from day one because adding a vector column to a live
-- multi-tenant table later is painful. No ivfflat/hnsw index: an unused index only
-- costs write time. Add one when organizations.rag_enabled is first switched on.
create table kb_chunks (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  document_id uuid not null,
  content text not null,
  embedding vector(1536),
  created_at timestamptz not null default now(),
  foreign key (document_id, org_id) references kb_documents (id, org_id) on delete cascade
);
create index kb_chunks_org_idx on kb_chunks (org_id);

create table usage_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  conversation_id uuid,
  foreign key (conversation_id, org_id) references conversations (id, org_id) on delete set null,
  pricing_category text not null,
  cost_micros bigint not null,
  currency text not null default 'INR',
  created_at timestamptz not null default now()
);
create index usage_events_org_time_idx on usage_events (org_id, created_at desc);

create table audit_log (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  actor_user_id uuid references users (id) on delete set null,
  action text not null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_org_time_idx on audit_log (org_id, created_at desc);

create table safety_flags (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  conversation_id uuid not null,
  message_id uuid,
  kind safety_kind not null,
  detected_at timestamptz not null default now(),
  resolved_at timestamptz,
  foreign key (conversation_id, org_id) references conversations (id, org_id) on delete cascade,
  foreign key (message_id, org_id) references messages (id, org_id) on delete set null
);
create index safety_flags_open_idx on safety_flags (org_id, detected_at desc)
  where resolved_at is null;

-- ---------------------------------------------------------------------------
-- Policy helpers
--
-- SECURITY DEFINER so they read membership without tripping the RLS policy that
-- is calling them. A plain function here recurses forever on org_members.
-- Defined after the tables because a `language sql` body is parsed at creation.
-- ---------------------------------------------------------------------------

create or replace function app.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select u.is_platform_admin from users u where u.id = auth.uid()), false);
$$;

create or replace function app.is_member(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from org_members m
    where m.org_id = target_org and m.user_id = auth.uid()
  );
$$;

create or replace function app.is_owner(target_org uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from org_members m
    where m.org_id = target_org and m.user_id = auth.uid() and m.role = 'owner'
  );
$$;

-- Inbox ordering depends on this being right every time, so it is not left to
-- the caller.
create or replace function app.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger conversations_touch_updated_at
  before update on conversations
  for each row execute function app.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Grants: start from zero, hand back only what the browser may touch.
-- Anything not granted below is unreachable from the dashboard regardless of RLS.
-- ---------------------------------------------------------------------------

revoke all on all tables in schema public from anon, authenticated;

-- The Worker. BYPASSRLS alone is not access — it still needs the grant. Supabase
-- hands this out by default; stating it keeps local and remote identical.
grant all on all tables in schema public to service_role;

grant select on organizations, users, org_members, conversations, messages,
                kb_documents, kb_chunks, usage_events, audit_log, safety_flags
  to authenticated;

grant insert, update, delete on org_members, kb_documents to authenticated;
grant update on safety_flags to authenticated;
grant update on organizations to authenticated;

-- Column-level: an owner may rename their org but never flip rag_enabled, and may
-- never move a user between orgs or mint a platform admin. RLS cannot express this;
-- grants can.
revoke update on organizations from authenticated;
grant update (name) on organizations to authenticated;
grant update (email) on users to authenticated;

-- wa_accounts is never reachable from the browser, by anyone, at any role.
revoke all on wa_accounts from anon, authenticated;
revoke all on inbound_dedupe from anon, authenticated;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------

alter table organizations  enable row level security;
alter table users          enable row level security;
alter table org_members    enable row level security;
alter table wa_accounts    enable row level security;
alter table conversations  enable row level security;
alter table messages       enable row level security;
alter table inbound_dedupe enable row level security;
alter table kb_documents   enable row level security;
alter table kb_chunks      enable row level security;
alter table usage_events   enable row level security;
alter table audit_log      enable row level security;
alter table safety_flags   enable row level security;

-- Belt and braces: even the table owner obeys these.
alter table organizations  force row level security;
alter table users          force row level security;
alter table org_members    force row level security;
alter table wa_accounts    force row level security;
alter table conversations  force row level security;
alter table messages       force row level security;
alter table inbound_dedupe force row level security;
alter table kb_documents   force row level security;
alter table kb_chunks      force row level security;
alter table usage_events   force row level security;
alter table audit_log      force row level security;
alter table safety_flags   force row level security;

create policy org_read on organizations
  for select to authenticated
  using (app.is_member(id) or app.is_platform_admin());

create policy org_rename on organizations
  for update to authenticated
  using (app.is_owner(id)) with check (app.is_owner(id));

create policy users_read_same_org on users
  for select to authenticated
  using (id = auth.uid() or app.is_member(org_id) or app.is_platform_admin());

create policy users_update_self on users
  for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy members_read on org_members
  for select to authenticated
  using (app.is_member(org_id) or app.is_platform_admin());

create policy members_write on org_members
  for all to authenticated
  using (app.is_owner(org_id)) with check (app.is_owner(org_id));

-- wa_accounts: no policy is defined on purpose. RLS enabled with zero policies
-- denies every row to every non-bypassing role. Do not add a policy here.

-- inbound_dedupe: Worker-only, same reasoning. No policy on purpose.

create policy conversations_read on conversations
  for select to authenticated
  using (app.is_member(org_id));

-- Sending touches Meta, so it goes through the Worker (invariant 6). The browser
-- reads messages and never writes them.
create policy messages_read on messages
  for select to authenticated
  using (app.is_member(org_id));

create policy kb_docs_read on kb_documents
  for select to authenticated
  using (app.is_member(org_id));

create policy kb_docs_write on kb_documents
  for all to authenticated
  using (app.is_owner(org_id)) with check (app.is_owner(org_id));

create policy kb_chunks_read on kb_chunks
  for select to authenticated
  using (app.is_member(org_id));

-- Billing is owner-only; staff never see cost.
create policy usage_read on usage_events
  for select to authenticated
  using (app.is_owner(org_id));

create policy audit_read on audit_log
  for select to authenticated
  using (app.is_platform_admin());

create policy safety_read on safety_flags
  for select to authenticated
  using (app.is_member(org_id));

create policy safety_resolve on safety_flags
  for update to authenticated
  using (app.is_member(org_id)) with check (app.is_member(org_id));

-- ---------------------------------------------------------------------------
-- The one safe window onto wa_accounts.
-- Not security_invoker, so it runs as owner and the base-table denial does not
-- apply. The membership check therefore lives in the view body.
-- ---------------------------------------------------------------------------

create view wa_accounts_public
with (security_barrier = true)
as
  select id, org_id, display_phone_number, created_at
  from wa_accounts
  where app.is_member(org_id);

grant select on wa_accounts_public to authenticated;
