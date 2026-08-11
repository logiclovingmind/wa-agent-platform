-- Demo fixtures for clicking through dashboard features in a browser.
--
-- Not a migration and not test data: these rows live in the real database so the owner
-- can see each feature in its interesting state. Every demo customer number starts
-- 9990, which is what makes the cleanup at the bottom safe to run.
--
-- Re-runnable. The 02:30 IST retention cron scrubs message content for any conversation
-- carrying a safety flag, so the flagged demo below loses its bodies overnight and needs
-- this file run again.
--
-- The attachment demos need bytes in the `media` bucket as well as rows here, so their
-- conversation ids are fixed rather than generated: re-running this file then rebuilds
-- the rows at the same storage path and the uploaded objects stay valid. Upload them
-- with `scripts/demo-media.ts`, once per install.

begin;

delete from conversations where customer_wa_id like '9990%';

insert into conversations
  (id, org_id, wa_account_id, customer_wa_id, handoff_state, last_message_at, window_expires_at)
select coalesce(v.id::uuid, gen_random_uuid()), w.org_id, w.id, v.wa_id, v.state::handoff_state,
       now() - v.age, now() + v.win
-- One account, not every account. `demo-<wa_id>-<seq>` is the wa_message_id below, so
-- seeding a second org would collide on the unique index and abort the whole file.
from (select org_id, id from wa_accounts order by id limit 1) w
cross join (values
  -- Countdown goes red under 2h; this one sits inside that band.
  ('999001', null, 'bot',       interval '6 minutes', interval '47 minutes'),
  -- Expired: composer disabled, "needs a template" explanation.
  ('999002', null, 'bot',       interval '2 hours',   interval '-1 hour'),
  -- Customer asked for a human: shows in "Needs you" above ordinary conversations.
  ('999003', null, 'requested', interval '3 minutes', interval '20 hours'),
  -- Safety flag, added below. Outranks everything else in the list.
  ('999004', null, 'bot',       interval '1 minute',  interval '23 hours'),
  -- Photo: the model never sees the bytes, so the turn goes to a person.
  ('999005', 'aaaa0000-0000-4000-8000-000000000005', 'requested', interval '5 minutes', interval '22 hours'),
  -- Video: never fetched and never stored. Asks for a photo instead.
  ('999006', null, 'requested', interval '9 minutes', interval '21 hours'),
  -- Voice note: stored and playable, but still a handoff — nothing transcribes it.
  ('999007', 'aaaa0000-0000-4000-8000-000000000007', 'requested', interval '12 minutes', interval '19 hours'),
  -- Exists to be destroyed. Erase on an unflagged conversation deletes the row itself,
  -- so pointing the demo at any of the above would cost that demo; re-run this file to
  -- get it back. Erase on 999004 is the other half — flagged, so it scrubs and stays.
  ('999008', null, 'bot',       interval '30 minutes', interval '18 hours')
) as v(wa_id, id, state, age, win);

-- `type` is what makes a row render as an attachment. media_key is the path the Worker
-- would have written (mediaPath: org/conversation/wa_message_id), set only where an
-- object actually exists — a null key is the honest "bytes are gone" state the video
-- and retention cases both rely on.
insert into messages (org_id, conversation_id, wa_message_id, direction, body, type, media_key, status, created_at)
select c.org_id, c.id, 'demo-' || c.customer_wa_id || '-' || m.seq, m.dir::message_direction,
       m.body, m.type,
       case
         when m.stored then c.org_id || '/' || c.id || '/demo-' || c.customer_wa_id || '-' || m.seq
       end,
       m.status, now() - m.age
from conversations c
join (values
  ('999001', 1, 'inbound',  'Is the Saturday batch still open?',                     'text',  false, null,   interval '8 minutes'),
  ('999001', 2, 'outbound', 'Yes, a few seats are left. Shall I hold one for you?',  'text',  false, 'read', interval '6 minutes'),
  ('999002', 1, 'inbound',  'Sorry, I got busy — can we talk tomorrow?',             'text',  false, null,   interval '2 hours'),
  ('999003', 1, 'inbound',  'I would rather speak to someone, please.',              'text',  false, null,   interval '4 minutes'),
  ('999003', 2, 'outbound', 'Of course — someone from our team will reply shortly.', 'text',  false, 'read', interval '3 minutes'),
  ('999004', 1, 'inbound',  'hi i am 14, can i join the coding class?',              'text',  false, null,   interval '2 minutes'),
  ('999004', 2, 'outbound', 'I''ll need to speak with a parent or guardian.',        'text',  false, 'read', interval '1 minute'),
  -- The caption is the only text an attachment carries, and answering from it alone
  -- would be a guess. Every reply below is a constant, not model output.
  ('999005', 1, 'inbound',  'is this the model you have in stock?',                  'image', true,  null,   interval '6 minutes'),
  ('999005', 2, 'outbound', 'Thanks — I''ve passed this on to someone from our team, and they''ll reply here shortly.', 'text', false, 'read', interval '5 minutes'),
  -- No stored object: the bytes were never fetched, so the bubble shows why.
  ('999006', 1, 'inbound',  'the fan is making this noise',                          'video', false, null,   interval '10 minutes'),
  ('999006', 2, 'outbound', 'I can''t open videos here. Please send a photo or describe it in a message, and someone from our team will help.', 'text', false, 'read', interval '9 minutes'),
  -- A voice note has no caption at all, so the bubble is the player and nothing else.
  ('999007', 1, 'inbound',  null,                                                    'audio', true,  null,   interval '13 minutes'),
  ('999007', 2, 'outbound', 'Thanks — I''ve passed this on to someone from our team, and they''ll reply here shortly.', 'text', false, 'read', interval '12 minutes'),
  ('999008', 1, 'inbound',  'Please delete my details from your system.',            'text',  false, null,   interval '31 minutes'),
  ('999008', 2, 'outbound', 'Of course — I''ll pass that on and it will be taken care of.', 'text', false, 'read', interval '30 minutes')
) as m(wa_id, seq, dir, body, type, stored, status, age) on m.wa_id = c.customer_wa_id;

insert into safety_flags (org_id, conversation_id, message_id, kind)
select c.org_id, c.id, m.id, 'minor'
from conversations c
join messages m on m.conversation_id = c.id and m.wa_message_id = 'demo-999004-1'
where c.customer_wa_id = '999004';

commit;

-- Cleanup, once the walkthrough is done:
--   delete from conversations where customer_wa_id like '9990%';
-- and the demo objects, which no cascade reaches:
--   pnpm tsx scripts/demo-media.ts --remove
