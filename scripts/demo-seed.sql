-- Demo fixtures for clicking through dashboard features in a browser.
--
-- Not a migration and not test data: these rows live in the real database so the owner
-- can see each feature in its interesting state. Every demo customer number starts
-- 9199900, which is what makes the cleanup at the bottom safe to run.
--
-- Numbers are full E.164 digits with the country code, exactly as Meta sends wa_id — no
-- `+` and no spacing. Names are the WhatsApp profile name the webhook carries, which is
-- what the inbox shows; one demo deliberately has none, so the fallback to the number
-- is visible rather than assumed.
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

delete from conversations where customer_wa_id like '9199900%';

insert into conversations
  (id, org_id, wa_account_id, customer_wa_id, customer_name, handoff_state,
   last_message_at, window_expires_at)
select coalesce(v.id::uuid, gen_random_uuid()), w.org_id, w.id, v.wa_id, v.name,
       v.state::handoff_state, now() - v.age, now() + v.win
-- One account, not every account. `demo-<wa_id>-<seq>` is the wa_message_id below, so
-- spreading these over every org would collide on the unique index and abort the file.
-- Oldest by created_at is the first-installed account; the demo org added at the bottom
-- is newer, so it can never steal these rows.
from (select org_id, id from wa_accounts order by created_at limit 1) w
cross join (values
  -- Countdown goes red under 2h; this one sits inside that band.
  ('919990010001', 'Ananya Rao',    null, 'bot',       interval '6 minutes', interval '47 minutes'),
  -- Expired: composer disabled, "needs a template" explanation. No profile name either,
  -- so this is also the one that shows what the inbox does without one.
  ('919990010002', null,            null, 'bot',       interval '2 hours',   interval '-1 hour'),
  -- Customer asked for a human: shows in "Needs you" above ordinary conversations.
  ('919990010003', 'Vikram Nair',   null, 'requested', interval '3 minutes', interval '20 hours'),
  -- Safety flag, added below. Outranks everything else in the list.
  ('919990010004', 'Rohit',         null, 'bot',       interval '1 minute',  interval '23 hours'),
  -- Photo: the model never sees the bytes, so the turn goes to a person.
  ('919990010005', 'Priya Menon',   'aaaa0000-0000-4000-8000-000000000005', 'requested', interval '5 minutes', interval '22 hours'),
  -- Video: never fetched and never stored. Asks for a photo instead.
  ('919990010006', 'Imran Shaikh',  null, 'requested', interval '9 minutes', interval '21 hours'),
  -- Voice note: stored and playable, but still a handoff — nothing transcribes it.
  ('919990010007', 'Meera Joshi',   'aaaa0000-0000-4000-8000-000000000007', 'requested', interval '12 minutes', interval '19 hours'),
  -- Exists to be destroyed. Erase on an unflagged conversation deletes the row itself,
  -- so pointing the demo at any of the above would cost that demo; re-run this file to
  -- get it back. Erase on ...0004 is the other half — flagged, so it scrubs and stays.
  ('919990010008', 'Sanjay Kulkarni', null, 'bot',     interval '30 minutes', interval '18 hours'),
  -- The image classifier's whole reason to exist: an inbound photo with no caption at
  -- all, so the text prefilter has nothing to read, and a flag raised anyway.
  ('919990010009', 'Kavya Iyer',    null, 'bot',       interval '4 minutes', interval '23 hours')
) as v(wa_id, name, id, state, age, win);

-- `type` is what makes a row render as an attachment. media_key is the path the Worker
-- would have written (mediaPath: org/conversation/wa_message_id), set only where an
-- object actually exists — a null key is the honest "bytes are gone" state the video
-- and retention cases both rely on.
--
-- `screened` is the amber "Not screened — read it yourself" badge, inverted: it says a
-- detector actually looked, and it is stored rather than inferred because an image whose
-- classification failed is exactly as unscreened as a voice note. Text is always
-- screened by the regex prefilter; audio never is; images are, unless the call failed.
insert into messages (org_id, conversation_id, wa_message_id, direction, body, type, media_key, safety_screened, status, status_at, created_at)
select c.org_id, c.id, 'demo-' || c.customer_wa_id || '-' || m.seq, m.dir::message_direction,
       m.body, m.type,
       case
         when m.stored then c.org_id || '/' || c.id || '/demo-' || c.customer_wa_id || '-' || m.seq
       end,
       m.screened, m.status,
       -- The status webhook writes both columns together (webhook.ts), and the admin
       -- panel reads the timestamp, not the word: a client whose sends started failing
       -- an hour ago looks perfectly healthy by every other measure on that screen.
       case when m.status is not null then now() - m.age end,
       now() - m.age
from conversations c
join (values
  ('919990010001', 1, 'inbound',  'Is the Saturday batch still open?',                     'text',  false, true,  null,   interval '8 minutes'),
  ('919990010001', 2, 'outbound', 'Yes, a few seats are left. Shall I hold one for you?',  'text',  false, true,  'read', interval '6 minutes'),
  ('919990010002', 1, 'inbound',  'Sorry, I got busy — can we talk tomorrow?',             'text',  false, true,  null,   interval '2 hours'),
  -- The one send Meta refused. Nothing else on the admin screen can show this: the reply
  -- exists, the conversation looks answered, and the customer received nothing.
  ('919990010002', 2, 'outbound', 'No problem at all — shall I check back with you tomorrow morning?', 'text', false, true, 'failed', interval '119 minutes'),
  ('919990010003', 1, 'inbound',  'I would rather speak to someone, please.',              'text',  false, true,  null,   interval '4 minutes'),
  ('919990010003', 2, 'outbound', 'Of course — someone from our team will reply shortly.', 'text',  false, true,  'read', interval '3 minutes'),
  ('919990010004', 1, 'inbound',  'hi i am 14, can i join the coding class?',              'text',  false, true,  null,   interval '2 minutes'),
  ('919990010004', 2, 'outbound', 'I''ll need to speak with a parent or guardian.',        'text',  false, true,  'read', interval '1 minute'),
  -- Screened and clean: the classifier saw it, said nothing, and the turn still went to
  -- a person. Booleans back are never an answer to the customer.
  ('919990010005', 1, 'inbound',  'is this the model you have in stock?',                  'image', true,  true,  null,   interval '6 minutes'),
  ('919990010005', 2, 'outbound', 'Thanks — I''ve passed this on to someone from our team, and they''ll reply here shortly.', 'text', false, true, 'read', interval '5 minutes'),
  -- Never fetched, so never screened either — the badge and the missing bytes are the
  -- same fact told twice.
  ('919990010006', 1, 'inbound',  'the fan is making this noise',                          'video', false, false, null,   interval '10 minutes'),
  ('919990010006', 2, 'outbound', 'I can''t open videos here. Please send a photo or describe it in a message, and someone from our team will help.', 'text', false, true, 'read', interval '9 minutes'),
  -- A voice note has no caption at all, so the bubble is the player and nothing else —
  -- and nothing transcribes it, so this is the badge's permanent home.
  ('919990010007', 1, 'inbound',  null,                                                    'audio', true,  false, null,   interval '13 minutes'),
  ('919990010007', 2, 'outbound', 'Thanks — I''ve passed this on to someone from our team, and they''ll reply here shortly.', 'text', false, true, 'read', interval '12 minutes'),
  ('919990010008', 1, 'inbound',  'Please delete my details from your system.',            'text',  false, true,  null,   interval '31 minutes'),
  ('919990010008', 2, 'outbound', 'Of course — I''ll pass that on and it will be taken care of.', 'text', false, true, 'read', interval '30 minutes'),
  -- No caption, no stored bytes. A flagged conversation has its content dropped within
  -- 24 hours, so this is what the demo looks like the morning after anyway — and it is
  -- the only place the flag can have come from the picture and nothing else.
  ('919990010009', 1, 'inbound',  null,                                                    'image', false, true,  null,   interval '5 minutes'),
  ('919990010009', 2, 'outbound', 'I hear you, and I don''t want to leave you with a bot right now. I''m bringing a person from our team into this conversation.', 'text', false, true, 'read', interval '4 minutes')
) as m(wa_id, seq, dir, body, type, stored, screened, status, age) on m.wa_id = c.customer_wa_id;

insert into safety_flags (org_id, conversation_id, message_id, kind)
select c.org_id, c.id, m.id, f.kind::safety_kind
from conversations c
join (values
  ('919990010004', 'demo-919990010004-1', 'minor'),
  -- Raised by the image classifier, not the prefilter. The inbound row it points at has
  -- no body at all, which is the whole demonstration.
  ('919990010009', 'demo-919990010009-1', 'distress')
) as f(wa_id, msg_id, kind) on f.wa_id = c.customer_wa_id
join messages m on m.conversation_id = c.id and m.wa_message_id = f.msg_id;

-- Spend history for the Usage screen. A screen whose only honest state is "₹0.00" is
-- indistinguishable from one that is broken, and the interesting part — a month total, a
-- per-reply average, a shape over 30 days — needs history no live demo can produce.
--
-- Five and a half months of it, not thirty days. The screen only reads 62 (`DAYS` in
-- Usage.tsx) and charts 30, but a client being walked through this is being shown a
-- business that has run on the system since spring, and a database that agrees with
-- that story costs nothing extra to hold — `usage_daily` aggregates in Postgres, so the
-- browser downloads the same sixty-odd rows either way.
--
-- `pricing_category = 'demo_reply'` rather than 'reply' is what makes these removable:
-- deleting the demo conversations leaves usage rows behind (the FK is `on delete set
-- null`, because a deleted conversation must not erase what it cost).
delete from usage_events where pricing_category = 'demo_reply';

insert into usage_events (org_id, conversation_id, pricing_category, cost_micros, currency, created_at)
select
  w.org_id,
  null,
  'demo_reply',
  -- Micro-INR, in the range a real gpt-4o-mini reply lands in: ₹0.002–₹0.005 for a
  -- prompt of history plus a short answer.
  2000 + (random() * 3000)::int,
  'INR',
  -- IST calendar days, matching how usage_daily buckets them, spread across working
  -- hours so the timestamps read like traffic rather than a batch job.
  (((now() at time zone 'Asia/Kolkata')::date - d.day) + interval '9 hours' + random() * interval '11 hours')
    at time zone 'Asia/Kolkata'
from (select org_id from wa_accounts order by created_at limit 1) w
cross join generate_series(0, 164) as d(day)
-- Volume wobbles day to day and thins out on Sundays, so the chart has a shape to read
-- instead of a flat wall. It also grows: a business that started six months ago handled
-- fewer conversations then than it does now, and a flat five months would read as
-- generated data even to someone not looking for it.
cross join lateral generate_series(
  1,
  case when extract(dow from (now() at time zone 'Asia/Kolkata')::date - d.day) = 0
       then 3
       else greatest(4, 13 - d.day / 20) + ((d.day * 7) % 9) end
) as r(n);

-- ---------------------------------------------------------------------------
-- The back catalogue
-- ---------------------------------------------------------------------------
--
-- The nine conversations above each exist to show one feature. Nine conversations is
-- also, unmistakably, a demo. These sixteen are the other thing a client needs to see:
-- an inbox that has been running for months, with ordinary finished traffic in it.
-- Nothing here gets clicked during a walkthrough — they are the backdrop the
-- interesting ones sit against.
--
-- Spacing is quadratic, so the list is dense over the last few days and thins into the
-- past, which is the shape a real inbox has. Most of these windows are long shut. That
-- is correct and worth showing: a closed window is the normal state of a conversation
-- nobody has touched since last month.
insert into conversations
  (org_id, wa_account_id, customer_wa_id, customer_name, handoff_state,
   last_message_at, window_expires_at)
select w.org_id, w.id,
       '91999002' || lpad(n.i::text, 4, '0'),
       (array['Deepa Suresh','Arjun Pillai','Fatima Sheikh','Ravi Kumar','Nisha Ghosh',
              'Karthik Raj','Sneha Patil','Aditya Bose','Lakshmi Nair','Farhan Ali',
              'Pooja Desai','Manoj Verma'])[1 + (n.i % 12)],
       -- 'returned' is what the DO alarm leaves behind after a human goes quiet for
       -- thirty minutes. It should be the commonest non-bot state in an old inbox, and
       -- nowhere else in this file produces one.
       (case when n.i = 3 then 'human' when n.i % 5 = 0 then 'returned' else 'bot' end)::handoff_state,
       now() - (n.i * n.i * interval '5 hours'),
       now() - (n.i * n.i * interval '5 hours') + interval '23 hours 50 minutes'
from (select org_id, id from wa_accounts order by created_at limit 1) w
cross join generate_series(1, 16) as n(i);

insert into messages
  (org_id, conversation_id, wa_message_id, direction, body, type, safety_screened, status, created_at)
select c.org_id, c.id, 'demo-' || c.customer_wa_id || '-' || m.seq, m.dir::message_direction,
       case m.seq when 1 then qa.ask else qa.answer end,
       'text', true,
       case m.seq when 1 then null else 'read' end,
       c.last_message_at - case m.seq when 1 then interval '2 minutes' else interval '0' end
from conversations c
cross join lateral (
  select
    (array[
      'Do you have a data science course?',
      'What are the fees for the weekend batch?',
      'Is there a centre near Indiranagar?',
      'Can I pay in instalments?',
      'My daughter finished her degree last year — is she eligible?',
      'Do you give a certificate at the end?',
      'What time does the Saturday batch start?',
      'Are the classes online or in person?'
    ])[1 + (right(c.customer_wa_id, 4)::int % 8)] as ask,
    (array[
      'Yes — a twelve-week data science track, weekday evenings or weekend mornings. Which would suit you better?',
      'The weekend batch is ₹4,500 for eight sessions, material included. Shall I send you the schedule?',
      'Yes, our Indiranagar centre runs evening batches Monday to Thursday. Would you like the address?',
      'Yes — two instalments, half at enrolment and half after the fourth session.',
      'Yes, graduates are eligible for every track. Would you like me to note her details?',
      'Yes, a completion certificate once the final project is submitted and reviewed.',
      'The Saturday batch runs 10am to 1pm. Would you like me to hold a seat?',
      'Both — you can switch between the in-person class and the live online session in any week.'
    ])[1 + (right(c.customer_wa_id, 4)::int % 8)] as answer
) qa
cross join (values (1, 'inbound'), (2, 'outbound')) as m(seq, dir)
where c.customer_wa_id like '91999002%';

-- One conversation long enough to page. `PAGE` in Thread.tsx is 20 (invariant 7), so a
-- thread has to carry more than that before "Load older" appears at all — and a client
-- told the system keeps full history reasonably wants to watch it being kept.
insert into conversations
  (org_id, wa_account_id, customer_wa_id, customer_name, handoff_state,
   last_message_at, window_expires_at)
select w.org_id, w.id, '919990030001', 'Harini Balaji', 'bot',
       now() - interval '24 minutes', now() + interval '23 hours 26 minutes'
from (select org_id, id from wa_accounts order by created_at limit 1) w;

insert into messages
  (org_id, conversation_id, wa_message_id, direction, body, type, safety_screened, status, created_at)
select c.org_id, c.id, 'demo-919990030001-' || t.seq,
       (case when t.seq % 2 = 1 then 'inbound' else 'outbound' end)::message_direction,
       t.body, 'text', true,
       case when t.seq % 2 = 1 then null else 'read' end,
       now() - interval '4 hours' + (t.seq * interval '9 minutes')
from conversations c
cross join (values
  (1,  'Hi, I saw your ad for the data science course'),
  (2,  'Hello! Happy to help. Is this for yourself, or for someone else?'),
  (3,  'For myself. I work full time though'),
  (4,  'Understood — most of our working professionals take the weekend batch. Would that suit you?'),
  (5,  'Yes, weekends work. What is the schedule?'),
  (6,  'Saturdays and Sundays, 10am to 1pm, for twelve weeks.'),
  (7,  'And the fees?'),
  (8,  '₹18,000 for the full twelve weeks, or ₹4,500 per module if you would rather take them one at a time.'),
  (9,  'Is there a discount if I pay early?'),
  (10, 'There is — 10% off if the full amount is paid before the batch begins.'),
  (11, 'What do I need to know before starting?'),
  (12, 'Basic spreadsheets are enough. We cover Python from the first session.'),
  (13, 'I have never coded before. Is that a problem?'),
  (14, 'Not at all — about half of each batch starts from zero.'),
  (15, 'Where is the centre?'),
  (16, 'Indiranagar, 100 Feet Road, above the HDFC branch. I can send a map link if that helps.'),
  (17, 'Yes please, send it'),
  (18, 'Here you go: https://maps.example.com/indiranagar-centre'),
  (19, 'When does the next batch start?'),
  (20, 'The next weekend batch begins on the 6th. Four seats are open at the moment.'),
  (21, 'Can I sit in before I enrol?'),
  (22, 'Of course — you are welcome to attend the first session before deciding.'),
  (23, 'Great, please hold a seat for me'),
  (24, 'Done — a seat is held for you for the batch starting on the 6th. Someone from our team will confirm by tomorrow.')
) as t(seq, body)
where c.customer_wa_id = '919990030001';

-- ---------------------------------------------------------------------------
-- Runtime controls, in their resting state
-- ---------------------------------------------------------------------------
--
-- Business hours only. `out_of_hours = 'reply'` means the hours change nothing yet, so
-- these two fields are the safe half of the controls panel: they render populated
-- instead of blank, and the AI keeps answering at 2am the way it does today.
--
-- The other three are deliberately left at the platform default. `ai_paused = true`
-- would silence every demo conversation above, a `cap_micros` under the month's spend
-- would do the same, and a retention override would pull this org out of the single
-- cross-org sweep for no reason. All three are one click in the panel when you want to
-- show them:
--
--   Pause/Resume       — flips ai_paused, red badge on the row, AI hands off instantly
--   Cap below spend    — the row goes red: "monthly spend cap reached"
--   Out of hours       — set to 'handoff' with hours that exclude now
--
-- Each of those writes an audit_log row, which is the point of the demo as much as the
-- behaviour is.
update organizations
set hours_open_ist = '09:30',
    hours_close_ist = '19:00',
    out_of_hours = 'reply'
where id = (select org_id from wa_accounts order by created_at limit 1);

commit;

-- The live database still holds the earlier six-digit demo rows (999001…999008), which
-- the delete above no longer matches. Clear them by hand, once, on the next push:
--   delete from conversations where customer_wa_id like '9990%';
--
-- The all-clients tab renders only for a platform admin, and that flag is deliberately
-- not seeded here: this file picks its org by "oldest account", so a line granting it
-- would hand the platform-admin flag to client 1's owner the day they onboard. Grant it
-- to yourself once, by name:
--   update users set is_platform_admin = true where email = 'you@example.com';
--
-- Cleanup, once the walkthrough is done:
--   delete from conversations where customer_wa_id like '9199900%';
--   delete from usage_events where pricing_category = 'demo_reply';
-- and the demo objects, which no cascade reaches:
--   pnpm tsx scripts/demo-media.ts --remove
