-- Outside the 24h window Meta rejects free-form messages, so a burst answered late
-- had nowhere to go but a handoff. A pre-approved template is the only thing that may
-- legally be sent, and it re-opens the window when the customer replies.
--
-- Config, not code: client #21 is an INSERT. Templates are approved per WABA, so the
-- name and language live on wa_accounts rather than on the org.
--
-- Nullable with no default on purpose. An account with no template configured keeps
-- the old behaviour and hands off, which is the safe direction: sending an
-- unapproved template name just earns a Meta rejection.
alter table wa_accounts
  add column reengagement_template_name text,
  add column reengagement_template_lang text;

-- Half a config is worse than none: a name with no language is rejected by Meta at
-- send time, which is the one moment there is no way to tell anyone.
alter table wa_accounts
  add constraint wa_accounts_reengagement_template_complete
  check (
    (reengagement_template_name is null and reengagement_template_lang is null)
    or (reengagement_template_name is not null and reengagement_template_lang is not null)
  );
