-- The desk list is live now, so `conversations` has to be published as well as `messages`.
--
-- 0004 published `messages` only, and said a second subscription would "spend the
-- 200-connection free tier on a sidebar". That reasoning was wrong: supabase-js
-- multiplexes every channel over a single WebSocket, so a second channel in the same tab
-- costs no extra connection at all. It costs messages against the 2M/month budget, and one
-- event per conversation row change is nowhere near it.
--
-- Polling was the alternative and it is the expensive one: re-reading the desk every 20
-- seconds is roughly 2.6GB/month per open tab against a 5GB egress cap, which one owner
-- leaving two tabs open would exhaust on its own.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversations'
  ) then
    alter publication supabase_realtime add table conversations;
  end if;
end $$;

-- Realtime re-checks RLS per subscriber, and it needs the row's identity to do it. Without
-- this the channel joins and no event ever arrives — the same silent failure as being
-- absent from the publication.
alter table conversations replica identity full;
