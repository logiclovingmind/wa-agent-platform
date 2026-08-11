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

-- Supabase's auth.users. The columns the app joins against, plus the ones GoTrue itself
-- requires — scripts/accounts.sql writes accounts directly here on live, and rehearsing
-- that against a three-column stub proves nothing.
--
-- The email index is partial, copying GoTrue exactly, because that detail has teeth: a
-- partial unique index cannot be inferred by ON CONFLICT, so an upsert that passes
-- against a plain `unique` constraint fails on the real database.
create table if not exists auth.users (
  instance_id uuid default '00000000-0000-0000-0000-000000000000',
  id uuid primary key default gen_random_uuid(),
  aud text,
  role text,
  email text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_sso_user boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz
);
create unique index if not exists users_email_partial_key
  on auth.users (email) where is_sso_user = false;

create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  provider_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  identity_data jsonb not null,
  provider text not null,
  last_sign_in_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  unique (provider_id, provider)
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
