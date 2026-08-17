# Running a walk-in demo

A demo overlays a prospect's business onto the demo org: their name, their knowledge
base, their tone. The bot then answers as them, over real WhatsApp, on the seeded
backdrop of 1,000 conversations and a month of spend. Afterwards one button puts it
back.

No code, no deploy, no laptop. Everything below is doable from a phone browser.

---

## One-time, before the first demo

1. **Your handset is on Meta's allow-list.** The sandbox test number replies only to
   numbers added in Meta → WhatsApp → API Setup, and it holds **five**. Add your own.
   The prospect's number is not worth a slot — you drive the demo from your phone.
2. **Two-factor is on.** `app.logiclovingmind.com` → Security → Set up → scan → type the
   code. Do this at a desk, not five minutes before someone arrives.
3. Know the sandbox number by heart: **+1 555-669-6700**.
4. **Check `owner@demo.com` still signs in.** That is the login a prospect is actually
   buying — the inbox, the takeover, their own usage — and the admin panel is not it.
   The password is the `DEMO_PASSWORD` GitHub secret; nothing in the repo holds the
   value. To change it: set the secret, then run `migrate.yml` with
   `provision_accounts=true`, which resets all three logins to their current secrets.

## Prep, about three minutes

Sign in at `app.logiclovingmind.com` as the platform admin.

1. **Training console** → the dropdown → **Demo Institute (demo)**.
2. **Business name** → theirs. It is the first line of the prompt — the bot introduces
   itself as their business, so this is not decoration.
3. **Tone** → one line in their register. `crisp and clinical, never chatty` reads very
   differently from the seeded `warm and unhurried`, and that contrast is the point.
   **Languages** → what their customers actually write in.
4. **Save**.
5. **Knowledge base** → open each `Demo — …` document and **Delete** it. Every document
   is concatenated into the prompt on every turn, so leaving the coaching-institute
   files in place has a dental bot quoting course fees.
6. **Add** → title it after their business, paste their services, prices, timings,
   location, policies. Plain sentences. It does not need formatting.

   Ceilings are five documents and 10,000 characters each, but aim for **2,000–4,000
   characters in total**. Retrieval is off, so every document goes into the prompt whole
   on every turn — one file and two of the same length cost exactly the same. At 1,300
   characters a reply costs about ₹0.005; filled to the ceiling it is about ₹0.18. Split
   by topic if it reads better on screen, never to make it smaller.
7. Type a question in the left panel and **Send**. You see the answer, the prompt that
   produced it, and what the reply cost in ₹. Nothing is sent to anyone and nothing is
   written to an inbox.

Read the answer before they arrive. If it says it will check with the team, something
they will ask about is missing from the KB.

## Running it

Message **+1 555-669-6700** from your allow-listed handset and hand them the phone.

Three things worth showing, in this order:

- **It answers as them.** Their prices, their hours, their tone. Ask something the KB
  does not cover and let them watch it decline to invent an answer — that is the feature,
  not a gap.
- **It books.** Ask for an appointment. It offers real free times from the **Diary** panel
  beside the KB — 9:30 to 7, Monday to Saturday, in half hours — takes the one they pick,
  and the booking appears under **Booked** while you are both looking at it. Worth saying
  out loud: it can only offer times that are actually free, and it cannot invent one.
- **They can see the diary.** Sign in as the demo org's own owner and open the **Diary**
  tab: **Today** is the booking you just made alongside the rest of the day, and **Month**
  is the same week as a calendar to find a date on. This is the answer to "so where do the
  appointments actually go?", and it is the one screen on the tour that is theirs rather
  than ours — **Flowin** carries the next few under **Coming up** as well.
- **And they can close the loop.** Earlier today there are two appointments already
  settled: one **Came**, one **No show**. Press **Rebook** on the no-show to give them
  another time — any day, off the same half-hour grid the bot offers — then open the
  **Desk**: that customer is on it under *did not turn up*, and stays there until somebody
  marks the callback done. Say this part out loud, because a prospect will assume
  otherwise: moving a booking writes to the diary and messages nobody.
- **A human can cut in.** Open the Inbox on your laptop, take over the conversation, type
  a reply as yourself. The bot stops; it resumes on its own after thirty minutes idle.
- **What it costs and what it catches.** The training console shows ₹ per reply. **All
  clients** shows spend and open safety flags per org.

## Afterwards, five seconds

**After a demo** → **Reset demo** → **Confirm reset**. It is at the bottom of the training
console's sidebar whenever the demo org is selected, so you never leave the screen you ran
the demo on — and the same panel is still on the demo org's row in **All clients**.

Not the **Clear chat** button at the top of the console — that only empties the transcript
on screen. If the business name still reads like the prospect's, the reset has not run.

It reports what it removed, and it always restores the same thing: **Demo Institute**,
sector `general`, the seeded tone and languages, the two `Demo — …` documents, the seeded
week of hours, a week of upcoming bookings, one blocked-out stretch, and the two settled
appointments earlier today. Never the previous prospect's values.

The bookings are re-dated on every reset, taken by position from the free list rather than
written as fixed times — so they are always this week, always inside opening hours, and
always on the half-hour grid the bot itself offers. The settled pair are counted backwards
from now for the same reason; reset before opening time and there are no past slots that
day, so those two are simply absent until the morning is under way.

One thing the reset cannot put back: the no-show's link to a WhatsApp thread. The reset
deletes every conversation, so it restores that appointment as a walk-in and the **Desk**
beat above has nothing to name. Re-run `scripts/demo-seed.sql` before the next demo — the
same file that seeds the inbox — and the link comes back with the threads.

| Gone | Kept |
|---|---|
| Their KB documents | The two seeded `Demo — …` documents, put back |
| Threads from your handset, with their messages, leads and flags | The 1,000 seeded conversations |
| What the demo cost — the sandbox replies and console runs | The seeded month of spend |
| Their name, tone, languages, reply length | — |
| Every appointment booked during the demo | The seeded week of hours and four bookings, re-dated |

Two things it does not reach: **images** the prospect sent are still in Storage
(`pnpm tsx scripts/demo-media.ts --remove` clears demo objects), and `audit_log` keeps
its record of what you changed. Neither is visible in the dashboard.

If you skip the reset, the next demo starts wearing the last prospect's business. The
button is the whole reason a demo is a three-minute setup instead of a rebuild.

---

## Do

- **Delete the seeded KB documents before pasting theirs.** They share one prompt.
- **Save before you test.** The console reads the saved row, not the form.
- **Let it fail once, deliberately.** A question outside the KB shows the containment
  that keeps it from inventing a price. Owners recognise the value immediately.
- **Reset before you close the laptop**, not next morning.
- **Re-seed after `pnpm test`** if you have been in the code — the test run truncates the
  local database. `ship.sh` does it for you.

## Don't

- **Don't demo on any org but the demo org.** The console dropdown lists every client and
  **Save** writes to whichever one is selected — picking wrong edits a paying client's
  live tone. The Reset button only ever renders on the demo org, so it will not save you.
- **Don't open All clients in front of a prospect once real clients exist.** It shows
  their names, their spend and their flags. Today it is only test data.
- **Don't promise sector guardrails you have not switched on.** The demo org stays
  `general`. The healthcare and real-estate rules are real and enforced in code, but they
  are set at onboarding, not from this screen — describe them, do not claim the demo is
  running them.
- **Don't paste anything into the KB you would not want in a prompt sent to the model.**
  No customer lists, no patient names, no card details. Services and prices only.
- **Don't let the prospect message the number themselves.** Five allow-list slots, and a
  new one costs a verification code and a minute of silence in the room.
- **Don't demo a reply after 24 hours of quiet.** WhatsApp closes the free-form window at
  that point and only a template can reopen it. Send a fresh message first.
- **Don't hand-edit the demo org in SQL.** The reset restores what the seed defines; a
  change made anywhere else survives the button and quietly becomes permanent.
