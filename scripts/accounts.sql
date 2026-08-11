-- The three logins the platform is meant to be looked at through, and the un-merge of
-- the single account that was previously doing all three jobs.
--
--   logiclovingmind@gmail.com  platform admin. No org, no membership, no inbox.
--   owner@demo.com             owner of the demo org.
--   staff@demo.com             staff of the demo org.
--
-- The separation is a database fact, not a UI one. `conversations`, `messages` and
-- `usage_events` are gated on `app.is_member(org_id)` with no platform-admin escape
-- (0001), so an admin holding no `org_members` row cannot read a client's messages even
-- with a valid token. Migration 0013 made such an account legal by dropping the NOT NULL
-- on `users.org_id`; this file is what creates one. Proven in
-- tests/db/platform-admin.test.ts.
--
-- Run by .github/workflows/migrate.yml with provision_accounts=true. It goes through the
-- runner rather than the GoTrue admin API because the service_role key exists only as a
-- write-only wrangler secret, while the runner already holds SUPABASE_DB_URL.
--
-- Passwords arrive as psql variables from GitHub secrets, so no password is ever written
-- into this repository:
--   psql -v admin_pw="$ADMIN_PASSWORD" -v demo_pw="$DEMO_PASSWORD" -f scripts/accounts.sql
--
-- Idempotent: re-running resets the three passwords to whatever those secrets currently
-- hold and re-asserts the memberships. Touches no other account.

\set ON_ERROR_STOP on

begin;

-- pgcrypto lives in `extensions` on Supabase and in `public` on a bare cluster, and
-- crypt()/gen_salt() below are unqualified so that either placement resolves. `auth` is
-- deliberately absent: with it on the path, an unqualified `users` would mean
-- auth.users rather than the application table.
set local search_path = public, extensions;

-- A null role means the platform admin: no org, no membership.
create temporary table provisioned (email text primary key, password text, role text)
on commit drop;

insert into provisioned values
  ('logiclovingmind@gmail.com', :'admin_pw', null),
  ('owner@demo.com',            :'demo_pw',  'owner'),
  ('staff@demo.com',            :'demo_pw',  'staff');

-- Update-then-insert rather than ON CONFLICT: GoTrue's uniqueness on email is a partial
-- index (`where is_sso_user = false`), which ON CONFLICT cannot infer a target from, so
-- the obvious upsert fails outright on the real schema.
update auth.users u
   set encrypted_password = crypt(p.password, gen_salt('bf')),
       -- The project has mailer_autoconfirm off and two of these addresses are demo
       -- domains that can never receive a link, so confirmation happens here.
       email_confirmed_at = coalesce(u.email_confirmed_at, now()),
       updated_at = now()
  from provisioned p
 where u.email = p.email;

-- Existing accounts keep their id above — the platform admin is almost certainly already
-- present as the account that used to be both things, and audit_log references that id.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  created_at, updated_at, raw_app_meta_data, raw_user_meta_data
)
select
  '00000000-0000-0000-0000-000000000000',
  gen_random_uuid(),
  'authenticated',
  'authenticated',
  p.email,
  crypt(p.password, gen_salt('bf')),
  now(),
  now(),
  now(),
  '{"provider":"email","providers":["email"]}'::jsonb,
  '{}'::jsonb
from provisioned p
where not exists (select 1 from auth.users u where u.email = p.email);

-- One identity per email account. Without it the account exists, looks correct in the
-- Supabase dashboard, and misbehaves on anything that resolves a user's identities.
insert into auth.identities (
  id, provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
select
  gen_random_uuid(),
  u.id::text,
  u.id,
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  'email',
  now(),
  now(),
  now()
from auth.users u
join provisioned p on p.email = u.email
where not exists (
  select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email'
);

-- The same org selector as scripts/demo-seed.sql: the org owning the oldest wa_account.
-- The two files have to agree, or the demo accounts get wired to one org and the demo
-- conversations to another.
create temporary table demo_org on commit drop as
  select org_id as id from wa_accounts order by created_at limit 1;

-- Without this the owner and staff rows below would be written with a null org and no
-- membership — two more accounts that can sign in and see nothing, which is the exact
-- confusion this file exists to end.
do $$
begin
  if not exists (select 1 from demo_org) then
    raise exception 'no wa_accounts: onboard the demo org before provisioning accounts';
  end if;
end;
$$;

update organizations set is_demo = true where id = (select id from demo_org);

-- org_id is null for the admin. Belonging to no org is the entire point of the account.
insert into public.users (id, org_id, email, is_platform_admin)
select
  u.id,
  case when p.role is null then null else (select id from demo_org) end,
  p.email,
  p.role is null
from auth.users u
join provisioned p on p.email = u.email
on conflict (id) do update
  set org_id = excluded.org_id,
      is_platform_admin = excluded.is_platform_admin;

-- This is the un-merge. The admin account held an owner membership of the demo org,
-- which is precisely what made the admin panel and the demo dashboard the same screen
-- behind the same password.
delete from org_members m
using public.users u, provisioned p
where m.user_id = u.id and u.email = p.email and p.role is null;

insert into org_members (org_id, user_id, role)
select (select id from demo_org), u.id, p.role::org_role
from auth.users u
join provisioned p on p.email = u.email
where p.role is not null
on conflict (user_id, org_id) do update set role = excluded.role;

commit;

select u.email,
       coalesce(m.role::text, 'platform admin (no org)') as access,
       pu.is_platform_admin
from public.users pu
join auth.users u on u.id = pu.id
left join org_members m on m.user_id = pu.id
where u.email in ('logiclovingmind@gmail.com', 'owner@demo.com', 'staff@demo.com')
order by u.email;
