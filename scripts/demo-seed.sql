-- Demo fixtures for clicking through dashboard features in a browser.
--
-- Not a migration and not test data: these rows live in the real database so the owner
-- can see each feature in its interesting state. Seeded customer numbers all start
-- 9199900, but the cleanup at the top is no longer scoped to them: a demo driven from a
-- real handset creates real threads that have to go too. It is scoped to the demo org
-- and guarded on `organizations.is_demo`, so re-running this file is the reset button
-- after a walk-in — it clears the prospect's KB, name, voice and conversations.
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

-- Stamped before the deletes below, which are guarded on it. This file has always written
-- into "oldest wa_account's org", so this only says out loud what that org already is —
-- and it is what keeps the blanket deletes off a real client if that ever stops holding.
update organizations set is_demo = true
where id = (select org_id from wa_accounts order by created_at limit 1);

-- Before the conversations, because the FK only nulls the link rather than following it.
-- A demo conversation's usage rows outlive it with `conversation_id` null, where nothing
-- names them and a re-run would count them twice. `pricing_category` is the only handle
-- left on them, which is why the demo replies carry one of their own.
delete from usage_events where pricing_category = 'demo_reply';

-- What a walk-in actually spent: `reply` rows from messaging the sandbox number and
-- `console` rows from the training tab. Same reason as above — they outlive their
-- conversation by design, so once the rows below are gone the org is all that names them.
delete from usage_events
where org_id = (select org_id from wa_accounts order by created_at limit 1)
  and org_id in (select id from organizations where is_demo);

-- `like '9199900%'` was the whole safety rail while every demo customer was seeded. A
-- demo driven from a real handset arrives with a real wa_id, so those threads outlived
-- the re-run and stacked up walk-in on walk-in. Scoped to the demo org instead, behind
-- two locks: oldest account *and* `is_demo`. An org missing either is untouched.
delete from conversations
where org_id = (select org_id from wa_accounts order by created_at limit 1)
  and org_id in (select id from organizations where is_demo);

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
  ('919990010009', 2, 'outbound', 'I hear you, and I don''t want to leave you with a bot right now. I''m bringing a person from our team into this conversation.', 'text', false, true, 'read', interval '4 minutes'),

  -- How each of those threads began. Every demo above used to open on its own punchline —
  -- nobody's first message to a business is "the fan is making this noise" — and a client
  -- reads that as the product having no memory of the conversation.
  --
  -- Numbered from 11, not renumbered from 1: `demo-<wa_id>-1` is the storage path the
  -- media objects were uploaded to (scripts/demo-media.ts), so seq 1 and 2 cannot move.
  -- Order on screen is by created_at, which these sit before, so the numbers never show.
  ('919990010001', 11, 'inbound',  'Hi, is this the Indiranagar centre?',                   'text', false, true, null,   interval '25 minutes'),
  ('919990010001', 12, 'outbound', 'It is — 100 Feet Road, above the HDFC branch.',         'text', false, true, 'read', interval '24 minutes'),
  ('919990010001', 13, 'inbound',  'I am looking at the weekend data science batch',        'text', false, true, null,   interval '12 minutes'),
  ('919990010001', 14, 'outbound', 'That one runs Saturdays and Sundays, 10am to 1pm, for twelve weeks.', 'text', false, true, 'read', interval '11 minutes'),
  ('919990010002', 11, 'inbound',  'hello, I filled the form on your website',              'text', false, true, null,   interval '185 minutes'),
  ('919990010002', 12, 'outbound', 'Thanks for getting in touch! Which course were you looking at?', 'text', false, true, 'read', interval '184 minutes'),
  ('919990010002', 13, 'inbound',  'data science, the weekend one',                         'text', false, true, null,   interval '150 minutes'),
  ('919990010002', 14, 'outbound', 'The next weekend batch begins on the 6th and four seats are open. Shall I tell you the fees?', 'text', false, true, 'read', interval '149 minutes'),
  ('919990010003', 11, 'inbound',  'is there an instalment option for the fees',            'text', false, true, null,   interval '33 minutes'),
  ('919990010003', 12, 'outbound', 'There is — the fee can be paid in two instalments, by UPI, card or bank transfer.', 'text', false, true, 'read', interval '32 minutes'),
  ('919990010003', 13, 'inbound',  'and if I need to change batch later?',                  'text', false, true, null,   interval '20 minutes'),
  ('919990010003', 14, 'outbound', 'A transfer to the next batch is allowed up to the second session.', 'text', false, true, 'read', interval '19 minutes'),
  ('919990010004', 11, 'inbound',  'hi is there a coding class',                            'text', false, true, null,   interval '14 minutes'),
  ('919990010004', 12, 'outbound', 'We teach Python as part of the Data Science course, from the first session.', 'text', false, true, 'read', interval '13 minutes'),
  ('919990010005', 11, 'inbound',  'hi, quick question about what you have available',      'text', false, true, null,   interval '22 minutes'),
  ('919990010005', 12, 'outbound', 'Of course — what are you looking for?',                 'text', false, true, 'read', interval '21 minutes'),
  ('919990010006', 11, 'inbound',  'hi, I need help with something at home',                'text', false, true, null,   interval '24 minutes'),
  ('919990010006', 12, 'outbound', 'Happy to help — what seems to be the trouble?',         'text', false, true, 'read', interval '23 minutes'),
  ('919990010007', 11, 'inbound',  'hi, can I send a voice note? typing is hard right now', 'text', false, true, null,   interval '20 minutes'),
  ('919990010007', 12, 'outbound', 'Please go ahead.',                                      'text', false, true, 'read', interval '19 minutes'),
  ('919990010008', 11, 'inbound',  'hi, I enquired last year about the evening batch',      'text', false, true, null,   interval '60 minutes'),
  ('919990010008', 12, 'outbound', 'I can see an enquiry from this number. Would you like the current timings?', 'text', false, true, 'read', interval '59 minutes'),
  ('919990010008', 13, 'inbound',  'no, I am not interested any more',                      'text', false, true, null,   interval '40 minutes'),
  ('919990010008', 14, 'outbound', 'Understood — I won''t follow up.',                      'text', false, true, 'read', interval '39 minutes'),
  -- Deliberately nothing a text prefilter could catch. The flag on this conversation has
  -- to have come from the picture alone, or the demo below it proves nothing.
  ('919990010009', 11, 'inbound',  'hi, are you open today?',                               'text', false, true, null,   interval '20 minutes'),
  ('919990010009', 12, 'outbound', 'We are — 9:30am to 7pm, Monday to Saturday.',           'text', false, true, 'read', interval '19 minutes')
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
) t0
-- The day offset reaches zero for every thirtieth row, and the hour picked for it is an
-- hour of today that may not have arrived. Those rows sorted above everything — the inbox
-- orders by last message, so the first thing a client saw was a dozen two-line stubs from
-- this evening, dated later than now, with a 24-hour window already counting down from
-- the future. Pushed a month back instead of forward: today keeps only the hours that
-- have actually happened, and the back catalogue is 31 days deep rather than 30.
cross join lateral (
  select case when t0.at > now() then t0.at - interval '30 days' else t0.at end as at
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
-- The top of the inbox — a dozen conversations run start to finish
-- ---------------------------------------------------------------------------
--
-- The nine above are one exchange each because each is there to show one control. The 990
-- below are two messages each because they are volume. Between them the inbox opened on a
-- wall of stubs, and a client scrolling it sees a product that answers once and stops.
--
-- These are what the assistant actually does on a normal day: somebody asks, it answers,
-- they push back on the price, it explains, and the thread lands somewhere — a seat held,
-- a call asked for, a person brought in. Everything said here matches the KB at the foot
-- of this file, so the training console cannot contradict the inbox.
--
-- Newest in the org, so they lead the list. The three that end unresolved carry a handoff
-- state, which puts them in "Needs you" above their own recency — a full thread that is
-- genuinely waiting is a better first row than a two-line one that is.
insert into conversations
  (org_id, wa_account_id, customer_wa_id, customer_name, handoff_state,
   last_message_at, window_expires_at)
select w.org_id, w.id, v.wa_id, v.name, v.state::handoff_state, now(), now()
from (select org_id, id from wa_accounts order by created_at limit 1) w
cross join (values
  ('919990040001', 'Deepak Shetty',   'bot'),
  ('919990040002', 'Latha Krishnan',  'bot'),
  ('919990040003', 'Arjun Pillai',    'requested'),
  ('919990040004', 'Nisha Bhat',      'bot'),
  ('919990040005', 'Farhan Qureshi',  'bot'),
  ('919990040006', 'Shruti Desai',    'bot'),
  ('919990040007', 'Gopal Menon',     'bot'),
  -- Taken over and answered by a person, so the last two turns are the owner's and no
  -- usage row is written for them.
  ('919990040008', 'Ritu Agarwal',    'human'),
  ('919990040009', 'Praveen Kumar',   'bot'),
  -- Unhappy, and the assistant stops rather than argues.
  ('919990040010', 'Anjali Verma',    'requested'),
  ('919990040011', 'Manoj Rathi',     'bot'),
  ('919990040012', 'Sneha Pai',       'bot')
) as v(wa_id, name, state);

-- Minutes ago rather than an interval per row: the gaps are the point. A customer answers
-- in seconds while they are at their phone and then goes quiet for an hour, and a thread
-- whose turns are evenly spaced reads as generated at a glance.
insert into messages
  (org_id, conversation_id, wa_message_id, direction, body, type, safety_screened, status, status_at, created_at)
select c.org_id, c.id, 'demo-' || c.customer_wa_id || '-' || t.seq, t.dir::message_direction,
       t.body, 'text', true,
       case when t.dir = 'outbound' then 'read' end,
       case when t.dir = 'outbound' then now() - make_interval(mins => t.mins) end,
       now() - make_interval(mins => t.mins)
from conversations c
join (values
  -- Fees, then the price objection, then how to pay it. The most common thread there is.
  ('919990040001', 1, 'inbound',  'Hi, do you have any weekend classes?', 47),
  ('919990040001', 2, 'outbound', 'We do — Data Science runs Saturdays and Sundays, 10am to 1pm, for twelve weeks.', 46),
  ('919990040001', 3, 'inbound',  'Sounds good. What is the total fee?', 41),
  ('919990040001', 4, 'outbound', '₹18,000 for the full course, or ₹4,500 per module if you would rather take them one at a time.', 40),
  ('919990040001', 5, 'inbound',  'that is a lot in one go', 33),
  ('919990040001', 6, 'outbound', 'It can be split into two instalments if that is easier — UPI, card or bank transfer, whichever suits you.', 32),
  ('919990040001', 7, 'inbound',  'two instalments works. UPI is fine for me', 12),
  ('919990040001', 8, 'outbound', 'Noted. I have put you down for the batch beginning on the 6th, and someone from our team will send the payment details.', 3),

  -- A parent asking on somebody else's behalf, which is why `leads.name` exists at all.
  ('919990040002', 1, 'inbound',  'my daughter finished her BSc last year, would this course be useful for her?', 182),
  ('919990040002', 2, 'outbound', 'It is a common starting point after a science degree — no coding background is needed, we teach Python from the first session.', 181),
  ('919990040002', 3, 'inbound',  'she has interviews going on, mornings are busy', 175),
  ('919990040002', 4, 'outbound', 'The weekday batch runs Monday to Thursday, 7pm to 9pm, which may suit her better.', 174),
  ('919990040002', 5, 'inbound',  'and the fee is the same?', 170),
  ('919990040002', 6, 'outbound', 'Yes — ₹18,000 for the twelve weeks, or ₹4,500 a module.', 169),
  ('919990040002', 7, 'inbound',  'can she attend one class first', 96),
  ('919990040002', 8, 'outbound', 'She is welcome to sit in on the first session before deciding.', 95),
  ('919990040002', 9, 'inbound',  'ok I will speak to her and let you know', 63),
  ('919990040002', 10, 'outbound', 'Please do. I have kept a note against your number, so you will not have to explain it again.', 62),

  -- Asked for a call. Ends in "Needs you" with the whole reason already on the screen.
  ('919990040003', 1, 'inbound',  'hello', 39),
  ('919990040003', 2, 'outbound', 'Hello! How can I help?', 38),
  ('919990040003', 3, 'inbound',  'I wanted to know about the digital marketing course', 36),
  ('919990040003', 4, 'outbound', 'Eight weeks, weekends only, 2pm to 5pm. Fees are ₹12,000.', 35),
  ('919990040003', 5, 'inbound',  'is it practical or mostly theory', 30),
  ('919990040003', 6, 'outbound', 'It is hands-on — you work on live campaigns through the course.', 29),
  ('919990040003', 7, 'inbound',  'can someone call me, I have a few more questions', 8),
  ('919990040003', 8, 'outbound', 'Of course — someone from our team will call you shortly.', 7),

  ('919990040004', 1, 'inbound',  'I enrolled for the batch on the 6th but I have to travel that week', 300),
  ('919990040004', 2, 'outbound', 'That is alright — a transfer to the next batch is allowed up to the second session.', 299),
  ('919990040004', 3, 'inbound',  'so I do not lose the fee?', 295),
  ('919990040004', 4, 'outbound', 'No, the fee moves with you. It is only a refund that is not possible once a batch has begun.', 294),
  ('919990040004', 5, 'inbound',  'ok please move me to the next one', 291),
  ('919990040004', 6, 'outbound', 'Noted — I have passed this on, and someone from our team will confirm the new batch date.', 290),

  -- A no, handled well. Not every thread should end in a sale.
  ('919990040005', 1, 'inbound',  'Do you run the data science course online?', 150),
  ('919990040005', 2, 'outbound', 'It runs in person at our Indiranagar centre — there is no online batch at the moment.', 149),
  ('919990040005', 3, 'inbound',  'I am in Mysuru so that is difficult', 145),
  ('919990040005', 4, 'outbound', 'Understood. I can note your number and let you know if an online batch opens.', 144),
  ('919990040005', 5, 'inbound',  'yes please do that', 140),
  ('919990040005', 6, 'outbound', 'Done — nothing else is needed from you for now.', 139),

  ('919990040006', 1, 'inbound',  'spoken english class timings?', 210),
  ('919990040006', 2, 'outbound', 'Weekday mornings, 8am to 9am, for six weeks. Fees are ₹6,000.', 209),
  ('919990040006', 3, 'inbound',  'where exactly is the centre, I am coming from Domlur', 205),
  ('919990040006', 4, 'outbound', 'Indiranagar, 100 Feet Road, above the HDFC branch — about fifteen minutes from Domlur.', 204),
  ('919990040006', 5, 'inbound',  'ok that works, when does it start', 200),
  ('919990040006', 6, 'outbound', 'A new batch opens most months. I have noted your interest and someone will confirm the next start date.', 199),

  -- The one where the assistant has to say no. Placement help is offered, a job is not
  -- promised and no salary is quoted — the sector output check would strip either.
  ('919990040007', 1, 'inbound',  'after this course will I get a job?', 120),
  ('919990040007', 2, 'outbound', 'We help with placement — CV review and interview practice — but I would not want to promise you a job, and I cannot quote salary figures.', 119),
  ('919990040007', 3, 'inbound',  'ok fair enough. what kind of help exactly', 116),
  ('919990040007', 4, 'outbound', 'CV review, mock interviews, and introductions where we have them. The rest depends on how the interviews go.', 115),
  ('919990040007', 5, 'inbound',  'and the certificate?', 112),
  ('919990040007', 6, 'outbound', 'A certificate is issued on 80% attendance.', 111),
  ('919990040007', 7, 'inbound',  'got it, I will think about it', 108),
  ('919990040007', 8, 'outbound', 'Take your time. I have made a note, so you will not have to start over when you come back.', 107),

  -- The handover, mid-thread and visible: the assistant stops, a person picks it up and
  -- signs their name, and the last two replies cost nothing.
  ('919990040008', 1, 'inbound',  'I paid the first instalment yesterday but have not received a receipt', 95),
  ('919990040008', 2, 'outbound', 'Let me look into that — one moment.', 94),
  ('919990040008', 3, 'inbound',  'sure', 90),
  ('919990040008', 4, 'outbound', 'I am bringing someone from our team in, they can check the payment properly.', 89),
  ('919990040008', 5, 'inbound',  'thank you', 60),
  ('919990040008', 6, 'outbound', 'Hi, this is Ananya from the office. I can see your payment against the weekend batch — the receipt went to the wrong email, I am resending it now.', 22),
  ('919990040008', 7, 'inbound',  'oh perfect, thank you', 18),
  ('919990040008', 8, 'outbound', 'Sent. Anything else, just message here.', 14),

  ('919990040009', 1, 'inbound',  'how many students in one batch?', 260),
  ('919990040009', 2, 'outbound', 'Batches are capped at twenty.', 259),
  ('919990040009', 3, 'inbound',  'and if I miss a class?', 256),
  ('919990040009', 4, 'outbound', 'Sessions are not repeated, but the material is shared and you can ask in the next class. A certificate needs 80% attendance.', 255),
  ('919990040009', 5, 'inbound',  'fine. I will come on the 6th', 250),
  ('919990040009', 6, 'outbound', 'Good — I have noted you for the batch beginning on the 6th.', 249),

  ('919990040010', 1, 'inbound',  'I want to cancel and get a refund', 45),
  ('919990040010', 2, 'outbound', 'I am sorry to hear that. Has your batch already begun?', 44),
  ('919990040010', 3, 'inbound',  'yes, two sessions so far', 43),
  ('919990040010', 4, 'outbound', 'Refunds are not possible once a batch has begun, though a transfer to the next batch is allowed up to the second session.', 42),
  ('919990040010', 5, 'inbound',  'that is not what I was told when I paid', 25),
  ('919990040010', 6, 'outbound', 'I would rather not settle that over a message — let me bring someone from our team in.', 24),
  ('919990040010', 7, 'inbound',  'please do', 21),
  ('919990040010', 8, 'outbound', 'Someone will reply here shortly.', 20),

  -- Hinglish in, Hinglish out. `organizations.voice` at the foot of this file says to
  -- mirror the customer, and this is the thread that shows it doing so.
  ('919990040011', 1, 'inbound',  'bhai weekend batch me abhi seat hai kya', 70),
  ('919990040011', 2, 'outbound', 'Haan, abhi chaar seat baaki hain — batch 6 tareekh se shuru ho raha hai.', 69),
  ('919990040011', 3, 'inbound',  'fees kitni hai', 66),
  ('919990040011', 4, 'outbound', '₹18,000 poore course ka, ya ₹4,500 per module agar ek ek karke lena ho.', 65),
  ('919990040011', 5, 'inbound',  'ek baar dekhne aa sakta hoon?', 58),
  ('919990040011', 6, 'outbound', 'Bilkul — pehli class attend karke decide kar sakte hain.', 57),
  ('919990040011', 7, 'inbound',  'theek hai, main Saturday aa jaunga', 52),
  ('919990040011', 8, 'outbound', 'Badhiya. Saturday 10 baje, Indiranagar, 100 Feet Road, HDFC branch ke upar.', 51),

  ('919990040012', 1, 'inbound',  'what do I need to bring on the first day?', 27),
  ('919990040012', 2, 'outbound', 'One photo ID, and the first instalment paid before the session.', 26),
  ('919990040012', 3, 'inbound',  'is aadhaar ok', 24),
  ('919990040012', 4, 'outbound', 'Aadhaar is fine.', 23),
  ('919990040012', 5, 'inbound',  'and can I pay by card at the centre', 18),
  ('919990040012', 6, 'outbound', 'Yes — UPI, card or bank transfer, whichever is easiest.', 17),
  ('919990040012', 7, 'inbound',  'perfect, see you on the 6th', 6),
  ('919990040012', 8, 'outbound', 'See you then. I have noted you for the weekend batch.', 5)
) as t(wa_id, seq, dir, body, mins) on t.wa_id = c.customer_wa_id;

-- Taken from the messages rather than written twice. The row above went in with
-- `now()` for both, which is only ever right for whichever thread happens to be newest;
-- the 24-hour window runs from the customer's last message, so it is derived here too.
update conversations c
set last_message_at = (select max(created_at) from messages where conversation_id = c.id),
    window_expires_at = (select max(created_at) from messages where conversation_id = c.id)
                        + interval '24 hours'
where c.customer_wa_id like '91999004%';

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

-- The twelve full threads, by hand, because the whole point of them is that what the
-- assistant took away is checkable against what was said. These are the rows an owner
-- exports and works from, so `intent` is the sentence they would have written themselves
-- — not a category, and never a guess the thread does not support.
--
-- ...0010 gets one despite ending badly. A refund argument is still somebody to call, and
-- a worklist that only holds happy customers is the wrong worklist.
insert into leads (org_id, conversation_id, name, intent, timeframe, budget, notes, created_at, updated_at)
select c.org_id, c.id, l.name, l.intent, l.timeframe, l.budget, l.notes,
       c.last_message_at, c.last_message_at
from conversations c
join (values
  ('919990040001', 'Deepak',  'Data science — weekend batch',        'Batch starting on the 6th', 'Two instalments, by UPI', 'Balked at the full fee; instalments settled it'),
  ('919990040002', 'Latha',   'Course for her daughter — weekday batch', 'After her daughter decides', null, 'Daughter finished a BSc last year, interviews ongoing. Sitting in on the first session.'),
  ('919990040003', 'Arjun',   'Digital marketing — asked for a call', 'Today',                null, 'Wants to speak to someone before enrolling'),
  ('919990040004', 'Nisha',   'Transfer to the next batch',          'Next batch',            null, 'Already enrolled; travelling the week of the 6th'),
  ('919990040005', 'Farhan',  'Online-only option',                  'Whenever one opens',    null, 'In Mysuru — cannot attend in person'),
  ('919990040006', 'Shruti',  'Spoken English — morning batch',      'Next batch',            null, 'Travelling from Domlur'),
  ('919990040007', 'Gopal',   'Placement help',                      'Undecided',             null, 'Asked whether a job is guaranteed. Told no, and stayed.'),
  ('919990040008', 'Ritu',    'Receipt for the first instalment',    null,   'First instalment paid', 'Receipt went to the wrong email; resent by the office'),
  ('919990040009', 'Praveen', 'Batch size and attendance',           'Batch starting on the 6th', null, null),
  ('919990040010', 'Anjali',  'Refund request',                      'Waiting on us',         null, 'Batch already begun. Says she was told something different when she paid.'),
  ('919990040011', 'Manoj',   'Weekend batch — coming to sit in',    'This Saturday',         null, 'Writes in Hinglish'),
  ('919990040012', 'Sneha',   'Enrolment documents',                 'Batch starting on the 6th', 'Paying by card at the centre', null)
) as l(wa_id, name, intent, timeframe, budget, notes) on l.wa_id = c.customer_wa_id;

-- The four that were dealt with, so "To call" starts as a list that is being worked
-- rather than a list nobody has touched. The three unresolved ones are excluded by hand:
-- ...0008 is answered, and the rest are old enough to have been picked up this morning.
update conversations
set followed_up_at = last_message_at + interval '40 minutes'
where customer_wa_id in ('919990040004', '919990040006', '919990040008', '919990040009');

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
--
-- Written to `app.demo_kb_seed` rather than straight into `kb_documents`: the restore at
-- the foot of this file is what puts them in the demo org, and it is also what the Reset
-- demo button calls. A demo has to delete these two — everything in the KB reaches the
-- prompt on every turn, so a dental prospect's bot would otherwise quote course fees —
-- and going through the snapshot is what lets the button put them back.
delete from app.demo_kb_seed;

insert into app.demo_kb_seed (title, raw)
select d.title, d.raw
from (values
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
--
-- This call is also what writes the two documents above into `kb_documents`, so it has to
-- stay after the snapshot and not before it.
--
-- `name` and `sector` are restored here too, because a walk-in demo edits both to the
-- prospect's business and nothing else would ever put them back. `general` is the column
-- default and the right answer for a coaching institute: a sector is a set of legal
-- guardrails, not an industry (docs/admin-panel.md §10).
select app.demo_restore_defaults();

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
