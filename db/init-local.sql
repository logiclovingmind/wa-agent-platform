-- LOCAL ONLY. Supabase ships all of this; a bare Postgres cluster does not.
-- Nothing here may be duplicated into supabase/migrations, or db:push will fail
-- against the real project. Applied by scripts/db.ts on every db:up.

create extension if not exists pgcrypto;
create extension if not exists vector;

create schema if not exists auth;

do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

grant usage on schema public, auth to anon, authenticated, service_role;

-- Supabase's auth.users. Only the columns the app actually joins against.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz not null default now()
);

-- PostgREST sets request.jwt.claims per request. Tests set it with `set local`.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  );
$$;

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid;
$$;

create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'role', current_setting('role', true));
$$;

grant execute on function auth.jwt, auth.uid, auth.role to anon, authenticated, service_role;
grant select on auth.users to authenticated, service_role;
