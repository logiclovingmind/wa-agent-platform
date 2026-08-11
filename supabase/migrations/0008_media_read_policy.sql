-- Let the dashboard read its own org's attachments.
--
-- The bucket is private and had no policies at all, so the browser could not see media
-- even though it already reads `messages` directly under RLS. This closes that gap with
-- the same rule the rest of the schema uses, rather than routing bytes through the
-- Worker: an image is not a secret, and a Worker hop would spend the 100k/day request
-- budget on every thumbnail.
--
-- `mediaPath()` writes `<org_id>/<conversation_id>/<wa_message_id>`, so the first path
-- segment is the org, and `app.is_member` is the same check the table policies call.
--
-- Guarded on the storage schema existing: the local cluster is plain Postgres.

do $$
begin
  if to_regclass('storage.objects') is null then
    return;
  end if;

  execute 'drop policy if exists media_read_own_org on storage.objects';
  execute $p$
    create policy media_read_own_org on storage.objects
      for select to authenticated
      using (
        bucket_id = 'media'
        and app.is_member(((storage.foldername(name))[1])::uuid)
      )
  $p$;
end;
$$;
