-- The regex prefilter is text-only, so until now an attachment arrived completely
-- unscreened. Every media turn hands off to a person, so nothing unsafe was *sent* —
-- but nothing was *detected* either, which is what retention and the owner's view both
-- run on.
--
-- Images are now shown to a classifier (flags only, never a reply). Voice notes,
-- documents and stickers have no detector and are not going to get one: transcribing
-- them means a second model and every voice note crossing to the provider.
--
-- So the inbox has to be able to say which it is, and it cannot infer that from
-- `type`: an image whose classification timed out is exactly as unscreened as a voice
-- note, and a badge that guesses from the type would call it screened. Hence a column
-- that records what was actually looked at.
--
-- Default false, not null: every existing row predates the classifier and none of them
-- were screened, which is the truth. Nullable would invite "unknown" to render as
-- "fine".
alter table messages
  add column if not exists safety_screened boolean not null default false;

comment on column messages.safety_screened is
  'True only when a detector actually examined this message. Text is screened by the regex prefilter; images by the vision classifier; audio/document/sticker never are.';

-- Backfill for text: the prefilter has run on every inbound text message since day one
-- and on every outbound reply's output check, so calling those unscreened would be the
-- other kind of lie. Bounded to what is provably true — media rows stay false.
update messages
   set safety_screened = true
 where type = 'text'
   and safety_screened = false;

-- The inbox lists a conversation's recent messages and the badge is read per row, so
-- there is no new index here: `safety_screened` is never a search predicate, only a
-- column that comes back with rows already being fetched by conversation_id.
