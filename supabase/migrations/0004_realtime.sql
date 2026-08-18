-- Invariant 8 does not work without this: Supabase Realtime only publishes tables that
-- are in the `supabase_realtime` publication. Subscribing to a table that is not in it
-- fails silently — the channel joins and no event ever arrives.
--
-- `messages` only here. `conversations` was added later, in 0038 — see that file for why
-- the "a second subscription costs a second connection" reasoning below was wrong.
--
-- The publication is created by the Supabase platform, not by plain Postgres, so local
-- runs have to make it themselves.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table messages;
  end if;
end $$;

-- Realtime re-checks RLS per subscriber, and it needs the row's identity to do it.
alter table messages replica identity full;
