-- 0006 revoked EXECUTE from PUBLIC. On Supabase that is not enough: default privileges
-- on schema `public` grant EXECUTE to `anon` and `authenticated` explicitly, and an
-- explicit grant survives a revoke from PUBLIC. The function is security definer and
-- sums every org's storage, so anyone holding the anon key could read it.
--
-- Guarded by role existence: a plain local cluster has neither role.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.media_bytes() from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on function public.media_bytes() from authenticated';
  end if;
end;
$$;
