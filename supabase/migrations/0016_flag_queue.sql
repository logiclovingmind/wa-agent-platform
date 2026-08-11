-- The cross-org safety-flag queue (docs/admin-panel.md §5).
--
-- `safety_flags` is gated on `app.is_member(org_id)` with no platform-admin escape, so
-- the admin — who is a member of nothing — reads exactly zero rows through PostgREST.
-- That is deliberate and stays. What the admin needs is the queue itself: which client,
-- which kind, how long it has been open. Never a word of the conversation.
--
-- `audit_log` needs no equivalent: its policy has been `app.is_platform_admin()` since
-- 0001, so the viewer in §5 reads it straight from the browser.

-- Resolving a flag is an act by a named person with a reason, and today the table can
-- only record that it happened. `resolved_at` alone is an anonymous state change, which
-- is not much use in the one situation these rows exist for.
alter table safety_flags
  add column if not exists resolved_by uuid references users (id) on delete set null,
  add column if not exists resolution_note text;

-- ---------------------------------------------------------------------------
-- public.admin_flags()
-- ---------------------------------------------------------------------------
--
-- Open flags across every client, newest first. Six columns, and the absence of a
-- seventh is the point: no body, no snippet, no customer name. §5 — the moment an admin
-- can read a customer's words, "we cannot read your customers' conversations" stops
-- being true, and that claim is worth more than the convenience.
--
-- `conversation_id` is here because a real incident has to be *findable* by the client's
-- own owner, who can open it under their own login. It is an identifier, not content.
--
-- Capped at 200. A queue longer than that is not a queue, and an unbounded cross-org
-- select is exactly the shape that spends the 5GB egress budget.
create or replace function public.admin_flags()
returns table (
  id uuid,
  org_id uuid,
  org_name text,
  conversation_id uuid,
  kind safety_kind,
  detected_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- `users.id`, not `id`: this function returns a column called `id`, and in plpgsql a
  -- RETURNS TABLE name is a variable that an unqualified column reference collides with.
  if not exists (
    select 1 from users
     where users.id = auth.uid()
       and users.is_platform_admin
  ) then
    raise exception 'admin only' using errcode = '42501';
  end if;

  return query
  select sf.id, sf.org_id, o.name, sf.conversation_id, sf.kind, sf.detected_at
  from safety_flags sf
  join organizations o on o.id = sf.org_id
  where sf.resolved_at is null
  order by sf.detected_at
  limit 200;
end;
$$;

-- Supabase grants EXECUTE on a new public function to anon and authenticated by name, so
-- `revoke from public` alone leaves it callable. The guard above would still refuse, but
-- an unauthorised caller should not reach the function body at all. Same block as 0012.
revoke all on function public.admin_flags() from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant execute on function public.admin_flags() to authenticated';
  end if;
end;
$$;
