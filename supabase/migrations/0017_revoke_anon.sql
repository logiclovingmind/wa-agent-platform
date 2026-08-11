-- Revoke the two functions 0015 and 0016 left callable by anon.
--
-- Neither leaks today: admin_flags() raises in its own guard before touching a row, and
-- org_month_spend() is security invoker, so usage_events' owner-only policy answers zero.
-- Both were verified against the deployed project with the anon key.
--
-- They are revoked anyway, because in both cases the guard is currently the *only* lock,
-- and 0014 already does this for admin_health(). The same omission has now been made in
-- 0007, 0010, 0012 and here: `revoke ... from public` reads like it covers everyone, and
-- on Supabase it does not — anon and authenticated hold EXECUTE by name, granted by the
-- project's default privileges, and a role-specific grant outlives a revoke from public.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.admin_flags() from anon';
    execute 'revoke all on function public.org_month_spend(uuid) from anon';
  end if;
end;
$$;
