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

-- Before the conversations, because the FK only nulls the link rather than following it.
-- A demo conversation's usage rows outlive it with `conversation_id` null, where nothing
-- names them and a re-run would count them twice. `pricing_category` is the only handle
-- left on them, which is why the demo replies carry one of their own.
delete from usage_events where pricing_category = 'demo_reply';

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

-- ---------------------------------------------------------------------------
-- The back catalogue — one month of ordinary traffic
-- ---------------------------------------------------------------------------
--
-- The nine conversations above each exist to show one feature, in one exchange each: the
-- message that provokes it and the single reply that is the feature. Nothing is
-- demonstrated twice, because a second example of a thing already on screen is storage
-- spent on nothing.
--
-- Nine conversations is also, unmistakably, a demo. These 990 are the other thing a
-- client needs to see: what the inbox looks like after a month of use — 1,000
-- conversations in all, about thirty-three a day. Nothing here gets clicked during a
-- walkthrough; they are the backdrop the interesting ones sit against.
--
-- Two messages each, and no more. A backdrop conversation is read from the list, where
-- only the last line shows, so a third message would cost storage and egress to say
-- something nobody opens the thread to see. The inbox reads 50 at a time
-- (`LIST_LIMIT`), so a thousand rows here is a list that scrolls, not a list that gets
-- downloaded.
--
-- The timestamps are the part that matters, because Pulse reads them rather than just
-- counting rows:
--
--   * the hour comes from a weighted list, not `random()`. A uniform spread puts as
--     many customers at 4am as at 7pm, which flattens the hour grid into noise and
--     quietly destroys the one number on that screen worth selling — how many people
--     were answered after closing.
--   * the gap between question and answer is seconds, not the two flat minutes this
--     block used to use. "Typical reply time" is a median over these gaps, and two
--     minutes is what a fast human does, not what this product does.
insert into conversations
  (org_id, wa_account_id, customer_wa_id, customer_name, handoff_state,
   last_message_at, window_expires_at)
select w.org_id, w.id,
       '91999002' || lpad(n.i::text, 4, '0'),
       -- Nineteen first names against eleven surnames, indexed so they turn at different
       -- rates. 209 combinations over 991 rows is about five of each, spread far enough
       -- apart that a page of 50 rarely shows the same name twice.
       (array['Deepa','Arjun','Fatima','Ravi','Nisha','Karthik','Sneha','Aditya','Lakshmi',
              'Farhan','Pooja','Manoj','Anil','Divya','Sagar','Tanvi','Vinod','Reshma',
              'Neha'])[1 + (n.i % 19)]
       || ' ' ||
       (array['Suresh','Pillai','Sheikh','Kumar','Ghosh','Raj','Patil','Nair','Desai',
              'Verma','Hegde'])[1 + ((n.i / 19) % 11)],
       -- 'returned' is what the DO alarm leaves behind after a human goes quiet for
       -- thirty minutes. It should be the commonest non-bot state in an old inbox, and
       -- nowhere else in this file produces one. It also decides, below, which
       -- conversations count as answered by a person rather than by the assistant.
       (case when n.i = 3 then 'human' when n.i % 7 = 0 then 'returned' else 'bot' end)::handoff_state,
       t.at, t.at + interval '23 hours 50 minutes'
from (select org_id, id from wa_accounts order by created_at limit 1) w
cross join generate_series(1, 990) as n(i)
cross join lateral (
  select (
    -- 7 and 30 are coprime, so the days fill evenly instead of clumping.
    ((now() at time zone 'Asia/Kolkata')::date - ((n.i * 7) % 30))
    -- Morning enquiries, a lunch dip, an evening peak, and a thin tail past closing.
    -- The late entries are the ones that make "answered out of hours" a real number.
    + (((array[7,8,8,9,9,9,10,10,10,11,11,11,12,12,13,13,14,14,15,15,
               16,16,17,17,18,18,18,19,19,19,20,20,20,21,21,22,22,23,0,1])
         [1 + ((n.i * 17) % 40)])::text || ' hours')::interval
    + (((n.i * 23) % 60)::text || ' minutes')::interval
  ) at time zone 'Asia/Kolkata' as at
) t;

insert into messages
  (org_id, conversation_id, wa_message_id, direction, body, type, safety_screened, status, created_at)
select c.org_id, c.id, 'demo-' || c.customer_wa_id || '-' || m.seq, m.dir::message_direction,
       case m.seq when 1 then qa.ask else qa.answer end,
       'text', true,
       case m.seq when 1 then null else 'read' end,
       -- The answer lands at `last_message_at`; the question is backdated by however
       -- long the reply took. Four of those seconds are the debounce window the DO
       -- waits out before it builds a prompt at all, and the rest is the model.
       --
       -- A conversation a person took over is minutes, not seconds, and that is the
       -- honest number: the assistant is fast, a human is not, and a demo that claims
       -- eight seconds on a thread a person answered is claiming the wrong thing.
       c.last_message_at - case
         when m.seq = 2 then interval '0'
         when c.handoff_state = 'bot'
           then ((5 + (right(c.customer_wa_id, 4)::int % 5))::text || ' seconds')::interval
         else ((8 + (right(c.customer_wa_id, 4)::int % 37))::text || ' minutes')::interval
       end
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
      'Are the classes online or in person?',
      'Is the fee refundable if I drop out?',
      'Do you help with placements?',
      'Can I move from the weekend batch to weekdays later?',
      'How many students are there in one batch?',
      'Do you teach digital marketing as well?',
      'Do you have an online-only option?',
      'Can I pay by UPI?',
      'When does the next batch start?',
      'Do you have anything early in the morning?',
      'What do I need to bring to enrol?',
      'Is attendance compulsory?',
      'How far is the centre from Domlur?',
      'My son is in first year BCom — can he join?',
      'Do you take classes on public holidays?',
      'What is the fee for Spoken English?',
      'Can I speak to someone before I decide?'
    ])[1 + (right(c.customer_wa_id, 4)::int % 24)] as ask,
    (array[
      'Yes — a twelve-week data science track, weekday evenings or weekend mornings. Which would suit you better?',
      'The weekend batch is ₹4,500 for eight sessions, material included. Shall I send you the schedule?',
      'Yes, our Indiranagar centre runs evening batches Monday to Thursday. Would you like the address?',
      'Yes — two instalments, half at enrolment and half after the fourth session.',
      'Yes, graduates are eligible for every track. Would you like me to note her details?',
      'Yes, a completion certificate once the final project is submitted and reviewed.',
      'The Saturday batch runs 10am to 1pm. Would you like me to hold a seat?',
      'Both — you can switch between the in-person class and the live online session in any week.',
      'Once a batch has begun the fee is not refundable, but you can move to the next batch up to the second session.',
      'We offer CV review and interview practice. We do not promise a job — that would not be honest of us.',
      'Yes — let us know a week ahead and we will move you to the weekday batch.',
      'Batches are capped at twenty, so there is time with the trainer for everyone.',
      'Yes — eight weeks, weekends 2pm to 5pm, ₹12,000.',
      'Yes, you can take the live online session instead of the class in any week.',
      'Yes — UPI, card and bank transfer are all fine.',
      'The next weekend batch begins on the 6th, and four seats are open at the moment.',
      'Spoken English runs 8am to 9am on weekdays. Data Science is evenings and weekends only.',
      'One photo ID at the first session, and the first instalment. That is all.',
      'The certificate needs 80% attendance, so most weeks do matter.',
      'About ten minutes — we are on 100 Feet Road, above the HDFC branch.',
      'Yes, students on any degree are welcome. Shall I send the weekend schedule?',
      'No, and the batch simply runs a week longer when one falls in the middle.',
      '₹6,000 for six weeks, weekday mornings 8am to 9am.',
      'Of course — someone from our team can call you. What time suits you?'
    ])[1 + (right(c.customer_wa_id, 4)::int % 24)] as answer
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
-- What each of those replies cost
-- ---------------------------------------------------------------------------
--
-- Derived from the messages rather than generated beside them, which is a change: this
-- block used to invent its own thirty days of spend on its own timeline. Two
-- independent random walks meant the busiest day on the cost chart was not the busiest
-- day in the inbox, and the "who answered" split could exceed the number of replies
-- that exist. One row per reply, at the moment of that reply, and every screen agrees
-- with every other by construction.
--
-- `handoff_state = 'bot'` is the test for "the assistant wrote this". A conversation a
-- person took over cost no model call, and Pulse counts the difference between replies
-- and usage rows as the work your team did — so an extra row here would quietly claim
-- credit for a human's answer.
--
-- Clients can no longer read `cost_micros` at all (migration 0019), but the all-clients
-- screen still shows it and it still has to be right.
--
-- `pricing_category = 'demo_reply'` rather than 'reply' is what makes these removable:
-- deleting the demo conversations leaves usage rows behind (the FK is `on delete set
-- null`, because a deleted conversation must not erase what it cost).
delete from usage_events where pricing_category = 'demo_reply';

insert into usage_events (org_id, conversation_id, pricing_category, cost_micros, currency, created_at)
select m.org_id, m.conversation_id, 'demo_reply',
  -- Micro-INR, priced off `costMicros()`: ₹14 per 1M prompt tokens, ₹57 per 1M
  -- completion. The system prompt is the whole KB (~1,300 chars) plus the rules block,
  -- so ~500 tokens before the customer has said anything, and up to ten turns of history
  -- on top — call it 550–850 in, 60–170 out. That is ₹0.011 to ₹0.022 a reply, and the
  -- prompt side is most of it, which is why the KB's size is shown in the console.
  11000 + (random() * 11000)::int,
  'INR',
  m.created_at
from messages m
join conversations c on c.id = m.conversation_id
where m.direction = 'outbound'
  and c.customer_wa_id like '9199900%'
  and c.handoff_state = 'bot';

-- ---------------------------------------------------------------------------
-- What the assistant learned about each customer
-- ---------------------------------------------------------------------------
--
-- No delete above this: `leads.conversation_id` cascades, so dropping the demo
-- conversations already took these with them. Unlike a usage event, a lead has nothing
-- to prove once the thread it came from is gone.
--
-- Keyed off the same `% 24` index as the question, so the row in the Leads tab says what
-- the thread in the inbox says. Most fields are blank on most rows, and that is the
-- honest shape: these are two-message conversations, and a customer who asked about fees
-- has not told anyone their budget. A row with nothing but a phone number still earns its
-- place — it means somebody asked and nobody called them back.
--
-- Every fourth conversation gets none at all. Nothing was extracted because nothing was
-- said, and a demo where the lead count equals the conversation count is selling a
-- promise the model cannot keep.
--
-- Flagged conversations are excluded by the same rule the cron enforces: a lead is only
-- ever written on a turn that was never flagged, and the retention sweep deletes any
-- that predate the signal. ...0004 (minor) and ...0009 (distress) must stay absent here,
-- or the seed contradicts safety.md.
insert into leads (org_id, conversation_id, intent, timeframe, budget, notes, created_at, updated_at)
select c.org_id, c.id, l.intent, l.timeframe, l.budget, l.notes,
       c.last_message_at, c.last_message_at
from conversations c
cross join lateral (
  select
    (array[
      'Data science course',      'Weekend batch — fees',   'Centre near Indiranagar',
      'Instalment payment',       'Course for her daughter', 'Certificate',
      'Saturday batch timing',    'Online or in person',    'Refund policy',
      'Placement help',           'Weekday batch later',    'Batch size',
      'Digital marketing',        'Online-only option',     'UPI payment',
      'Next batch start date',    'Early morning class',    'Enrolment documents',
      'Attendance rules',         'Distance from Domlur',   'Course for her son',
      'Public holiday schedule',  'Spoken English fees',    'Wants a call back'
    ]::text[])[1 + (right(c.customer_wa_id, 4)::int % 24)] as intent,
    (array[
      null, null, null, null, 'Next batch', null,
      'Saturdays', null, null, null, 'Later — after a few weeks', null,
      null, null, null, 'As soon as one opens', 'Mornings', null,
      null, null, null, null, null, 'This week'
    ]::text[])[1 + (right(c.customer_wa_id, 4)::int % 24)] as timeframe,
    -- Almost entirely blank, and it has to be: nobody states a budget in two messages.
    -- The two that are filled are how someone wants to pay, which is the only money
    -- anybody volunteers this early.
    (array[
      null, null, null, 'Wants to pay in instalments', null, null,
      null, null, null, null, null, null,
      null, null, 'Prefers UPI', null, null, null,
      null, null, null, null, null, null
    ]::text[])[1 + (right(c.customer_wa_id, 4)::int % 24)] as budget,
    (array[
      null, null, 'Indiranagar', null, 'Daughter finished her degree last year', null,
      null, null, null, null, null, null,
      null, 'Cannot attend in person', null, null, null, null,
      null, 'Travelling from Domlur', 'Son is in first year BCom', null, null, null
    ]::text[])[1 + (right(c.customer_wa_id, 4)::int % 24)] as notes
) l
where c.customer_wa_id like '91999002%'
  and right(c.customer_wa_id, 4)::int % 4 <> 0;

-- The nine feature conversations, by hand. ...0004 and ...0009 are flagged and get
-- nothing; the media threads went to a person before anyone said what they wanted.
-- ...0008 is the erase demo, and it needs a lead precisely so that erasing it can be
-- seen to take the lead with it — that path deletes leads explicitly, because a flagged
-- conversation keeps its row and the cascade never fires.
insert into leads (org_id, conversation_id, name, intent, timeframe, budget, notes, created_at, updated_at)
select c.org_id, c.id, l.name, l.intent, l.timeframe, l.budget, l.notes,
       c.last_message_at, c.last_message_at
from conversations c
join (values
  ('919990010001', null,     'Saturday batch — wants a seat held', 'Saturday',  null, 'Asked if seats are still open'),
  ('919990010002', null,     'Asked to be called back tomorrow',   'Tomorrow',  null, null),
  ('919990010003', null,     'Wants to speak to a person',         null,        null, null),
  ('919990010008', 'Sanjay', 'Asked for their details to be deleted', null,     null, null),
  ('919990030001', 'Harini', 'Data science — weekend batch',       'Batch starting on the 6th', '₹18,000 full course, or ₹4,500 a module', 'Works full time, no coding background. Seat held.')
) as l(wa_id, name, intent, timeframe, budget, notes) on l.wa_id = c.customer_wa_id;

-- Who has already been called back. "To call" is only a worklist if rows leave it, and
-- a demo where every lead is outstanding shows a filter nobody has ever used. The ones
-- marked are the older ones — which is also the true shape of the day: what came in this
-- morning is what is still owed.
update conversations c
set followed_up_at = c.last_message_at + interval '3 hours'
from leads l
where l.conversation_id = c.id
  and right(c.customer_wa_id, 4)::int % 3 = 1
  and c.last_message_at < now() - interval '1 day';

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

-- ---------------------------------------------------------------------------
-- The knowledge base, without which every answer is "I'll check with the team"
-- ---------------------------------------------------------------------------
--
-- This was missing, and it is the file the whole product turns on. The threads above are
-- hand-written, so the bot reads as knowledgeable in the inbox while actually knowing
-- nothing; the training console asks the real model and exposes that in one message.
-- Content matches the conversations above so the two cannot contradict each other.
--
-- Reference data, never instructions: `buildSystemPrompt()` wraps it in delimiters, and
-- the sector output check runs on the finished reply regardless of what is in here.
delete from kb_documents
where org_id = (select org_id from wa_accounts order by created_at limit 1)
  and title like 'Demo — %';

insert into kb_documents (org_id, title, raw)
select w.org_id, d.title, d.raw
from (select org_id from wa_accounts order by created_at limit 1) w
cross join (values
  ('Demo — courses and fees', $kb$
Data Science, 12 weeks. Weekend batch: Saturday and Sunday, 10am to 1pm. Weekday batch:
Monday to Thursday, 7pm to 9pm. Fees ₹18,000 for the full course, or ₹4,500 per module
taken one at a time. 10% off if the full amount is paid before the batch begins. No prior
coding needed — Python is taught from the first session, and basic spreadsheets are
enough to start.

Digital Marketing, 8 weeks. Weekends only, 2pm to 5pm. Fees ₹12,000.

Spoken English, 6 weeks. Weekday mornings, 8am to 9am. Fees ₹6,000.

Fees may be paid in two instalments on request, by UPI, card or bank transfer. No refunds
once a batch has begun; a transfer to the next batch is allowed up to the second session.
$kb$),
  ('Demo — timings, location and admissions', $kb$
Centre: Indiranagar, 100 Feet Road, above the HDFC branch, Bengaluru 560038. Office hours
9:30am to 7pm, Monday to Saturday. Closed Sunday except during class hours.

The next weekend Data Science batch begins on the 6th and four seats remain. Batch size
is capped at 20. Anyone may sit in on the first session before deciding to enrol.

To enrol: confirm the batch, pay the first instalment, and bring one photo ID to the
first session. A certificate is issued on 80% attendance.

Placement assistance is offered — CV review and interview practice. We do not guarantee a
job and do not quote salary figures.
$kb$)
) as d(title, raw);

-- §10's voice, on the one org that has a KB to talk about. Left null everywhere else on
-- purpose: null has to reproduce the old prompt byte for byte, and this is the place to
-- watch a tone sentence change the answer without a line of code changing.
update organizations
set voice = 'warm and unhurried; explains before it sells; mirrors the customer''s Hinglish',
    reply_max_words = 120,
    languages = 'English, Hindi, Kannada'
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
