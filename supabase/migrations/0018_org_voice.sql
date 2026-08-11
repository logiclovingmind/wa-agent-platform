-- Per-org voice — docs/admin-panel.md §10.
--
-- `sector` is a list of legal guardrails, not a list of industries: each value exists
-- because a specific sentence is unlawful in that trade. A restaurant and a coaching
-- institute are both 'general' and always will be. What separates them is their KB —
-- and, from here on, their voice.
--
-- Until now tone was hardcoded in prompt.ts for every client at once ("under 60 words,
-- plain", English only), which is a salon confirming a booking. These three columns
-- move it to data so a coaching institute can have room to explain a syllabus without
-- anyone touching the repo. Client #21 stays an INSERT.
--
-- All three are nullable with NO database default, deliberately. Null means "the
-- platform default", and that default lives in prompt.ts alone rather than being
-- written down in two places that can drift. Every existing row is null, so this
-- migration changes no client's behaviour by itself.

alter table organizations
  -- An instruction, not reference data: it sits ABOVE the delimited block and the model
  -- is meant to obey it. It is written by us in the admin panel and must never become
  -- client-editable without the same containment the KB gets — a client who can write
  -- here can argue with the guardrails above it. Length capped because every word is
  -- charged on every single turn, forever.
  add column if not exists voice text,

  -- Bounded, not free: this multiplies into every reply's output tokens, and the 60-word
  -- ceiling is also what keeps a WhatsApp message readable on a phone.
  add column if not exists reply_max_words smallint,

  -- Comma-separated, read by the model rather than parsed by us. Null keeps today's
  -- behaviour, which is that the prompt says nothing about language at all.
  add column if not exists languages text;

alter table organizations
  add constraint organizations_voice_len_check
  check (voice is null or length(voice) <= 500);

alter table organizations
  add constraint organizations_reply_max_words_check
  check (reply_max_words is null or reply_max_words between 20 and 300);

alter table organizations
  add constraint organizations_languages_len_check
  check (languages is null or length(languages) <= 200);
