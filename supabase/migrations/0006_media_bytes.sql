-- How full the media bucket is, for the free-tier alarm in the daily usage cron.
--
-- Storage is 1GB shared by every client, and nothing we already hold reports it:
-- `storage` is not an exposed PostgREST schema, the bucket API returns no total, and
-- the Management API needs a PAT this account does not have. A security-definer
-- function in `public` is the road left.
--
-- Sums the size Storage recorded at upload time, so this reads metadata and never the
-- objects — it costs no egress, which matters for a job that exists to protect egress.

create or replace function public.media_bytes()
returns bigint
language plpgsql
stable
security definer
set search_path = storage, public
as $$
declare
  total bigint;
begin
  -- `storage.objects` is Supabase's, and the local cluster is plain Postgres. A plain
  -- `language sql` body is validated at creation time and would fail `pnpm db:migrate`
  -- outright, so the reference is deferred and missing means zero rather than an error.
  if to_regclass('storage.objects') is null then
    return 0;
  end if;

  execute $q$
    select coalesce(sum((metadata->>'size')::bigint), 0)
    from storage.objects
    where bucket_id = 'media'
  $q$ into total;

  return total;
end;
$$;

-- Security definer reads across every org, so the browser roles must never reach it.
-- The Worker calls this with service_role.
revoke all on function public.media_bytes() from public;
grant execute on function public.media_bytes() to service_role;
