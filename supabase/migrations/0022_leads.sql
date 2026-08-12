-- What the assistant learned about a customer, so the owner does not have to read the
-- thread to find out. One row per conversation, not per message: a lead accretes — the
-- name arrives in the first turn and the budget in the fifth — so this is a row that
-- gets updated, never a log that gets appended to.
--
-- Fixed columns, the same for every client. A per-client field builder would make
-- onboarding a schema change, and client #21 is an INSERT.
--
-- Every column is nullable including the interesting ones. A lead with nothing but a
-- phone number is still the thing the owner wants to see: it means somebody asked and
-- nobody has called them back.

create table leads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations (id) on delete cascade,
  conversation_id uuid not null,
  -- The customer's own name as they gave it in conversation, which is not always the
  -- WhatsApp profile name on `conversations` and is the one they expect to be called.
  name text,
  -- What they asked for, condensed: "2BHK in Whitefield", "bridal package".
  intent text,
  -- When they want it. Free text on purpose — "next Saturday" is a real answer, and
  -- parsing it into a date would invent a precision the customer never gave.
  timeframe text,
  budget text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One lead per conversation, which is what makes the upsert below a merge.
  unique (conversation_id),
  -- Composite for the same tenant guarantee as everywhere else, and cascade because a
  -- lead is payload: unlike a usage event it has nothing to prove once the thread is gone.
  foreign key (conversation_id, org_id) references conversations (id, org_id) on delete cascade
);
create index leads_org_time_idx on leads (org_id, updated_at desc);

alter table leads enable row level security;
alter table leads force row level security;

-- Staff read leads too. The people answering the inbox are the people who call them back,
-- and a lead carries no cost figure, so there is nothing here that billing gates.
create policy leads_read on leads
  for select to authenticated
  using (app.is_member(org_id));

-- Written only by the Worker, from the model's own reply. The browser reads and exports.
grant select on leads to authenticated;
revoke all on leads from anon;

-- Merge, not replace. The model sees the last ten turns, so a later reply that never
-- mentions the budget must not erase the budget: coalesce keeps the older value and a new
-- non-null one wins. Read-modify-write in the Worker would cost a second round trip and
-- lose a race with a second burst on the same conversation.
--
-- nullif(trim(...), '') because a model asked for JSON answers "" far more often than it
-- omits a key, and an empty string would otherwise overwrite a real name.
create function public.record_lead(
  p_org_id uuid,
  p_conversation_id uuid,
  p_name text default null,
  p_intent text default null,
  p_timeframe text default null,
  p_budget text default null,
  p_notes text default null
) returns void
language sql volatile security definer set search_path = public
as $$
  insert into leads (org_id, conversation_id, name, intent, timeframe, budget, notes)
  values (
    p_org_id, p_conversation_id,
    nullif(trim(p_name), ''), nullif(trim(p_intent), ''), nullif(trim(p_timeframe), ''),
    nullif(trim(p_budget), ''), nullif(trim(p_notes), '')
  )
  on conflict (conversation_id) do update set
    name      = coalesce(nullif(trim(excluded.name), ''),      leads.name),
    intent    = coalesce(nullif(trim(excluded.intent), ''),    leads.intent),
    timeframe = coalesce(nullif(trim(excluded.timeframe), ''), leads.timeframe),
    budget    = coalesce(nullif(trim(excluded.budget), ''),    leads.budget),
    notes     = coalesce(nullif(trim(excluded.notes), ''),     leads.notes),
    updated_at = now();
$$;

-- Definer and cross-org by signature, so it must never be reachable from a browser. The
-- Worker calls it as service_role. Fourth time this project has needed the anon revoke
-- spelled out: Supabase's default privileges grant EXECUTE on new public functions to
-- anon and authenticated regardless of the revoke from `public`.
revoke all on function public.record_lead(uuid, uuid, text, text, text, text, text)
  from public, anon, authenticated;
