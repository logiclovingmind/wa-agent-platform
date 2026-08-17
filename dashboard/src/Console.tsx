import { useEffect, useState } from "react";
import { supabase, type AdminOrg } from "./lib/supabase";
import {
  cancelAppointment,
  consoleRun,
  diary,
  kbCreate,
  kbDelete,
  kbList,
  kbUpdate,
  setControls,
  setHours,
  type Appointment,
  type ConsoleRun,
  type ConsoleTurn,
  type HoursRow,
  type KbDocument,
  type KbList,
  type OrgControls,
} from "./lib/api";
import { inr, ist } from "./lib/utils";

/**
 * The training console — docs/admin-panel.md §11.
 *
 * Types a message at a client and shows what that client's bot would have answered. It
 * calls `decideReply()` on the Worker, which is the same function the Durable Object
 * calls, so this is the reply path with the sending taken out rather than a model of it.
 *
 * Nothing here is a customer. History lives in this component's state and travels with
 * each request; no `messages` row is read or written, so §1's rule that we never read a
 * client's customer content is untouched.
 */
export default function Console() {
  const [orgs, setOrgs] = useState<AdminOrg[]>([]);
  const [orgId, setOrgId] = useState("");
  const [turns, setTurns] = useState<Array<ConsoleTurn & { run?: ConsoleRun }>>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [override, setOverride] = useState(false);
  const [last, setLast] = useState<ConsoleRun | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    void supabase.rpc("admin_orgs").then(({ data }) => {
      const list = (data ?? []) as AdminOrg[];
      setOrgs(list);
      setOrgId((id) => id || (list[0]?.org_id ?? ""));
    });
  }, []);

  // A rename has to come back through `admin_orgs`, or the dropdown keeps showing the
  // old name for the rest of the session.
  async function refreshOrgs() {
    const { data } = await supabase.rpc("admin_orgs");
    setOrgs((data ?? []) as AdminOrg[]);
  }

  // A conversation carried across a switch would be answered from the wrong client's KB
  // and read as that client's behaviour.
  function pick(next: string) {
    setOrgId(next);
    reset();
  }

  function reset() {
    setTurns([]);
    setLast(null);
    setError(null);
    setOverride(false);
  }

  async function send() {
    const typed = text.trim();
    if (!typed || !orgId || busy) return;

    setBusy(true);
    setError(null);
    // Sent before the answer arrives, so the run is priced against the history the model
    // actually saw and not against a pane that already includes this turn.
    const history = turns.map(({ direction, body }) => ({ direction, body }));

    try {
      const run = await consoleRun(orgId, typed, history, override);
      setTurns((t) => [
        ...t,
        { direction: "inbound", body: typed },
        { direction: "outbound", body: run.text ?? "(nothing would be sent)", run },
      ]);
      setLast(run);
      setText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  const spent = turns.reduce((n, t) => n + (t.run?.costMicros ?? 0), 0);

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="border-b border-border px-6 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-lg font-semibold">Training console</h1>
            <select
              value={orgId}
              onChange={(e) => pick(e.target.value)}
              className="rounded border border-border bg-transparent px-2 py-1 text-sm"
            >
              {orgs.map((o) => (
                <option key={o.org_id} value={o.org_id}>
                  {o.name}
                  {o.is_demo ? " (demo)" : ""}
                </option>
              ))}
            </select>
            <span className="flex-1" />
            <span className="text-xs text-muted-foreground">
              {inr(spent)} this session
            </span>
            {/* Not "Reset": the button that undoes a demo lives in All clients and is
                called Reset demo. Two buttons with one name had an operator clear the
                transcript and believe the prospect's name and KB had been rolled back. */}
            <button
              type="button"
              onClick={reset}
              className="rounded border border-border px-3 py-1 text-xs"
            >
              Clear chat
            </button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            The same code that answers a real customer, with the sending removed. Nobody is
            messaged and nothing is written to the client's inbox.
          </p>
        </header>

        {last?.hold && (
          <div className="border-b border-amber-500/40 bg-amber-500/10 px-6 py-3 text-xs">
            <strong className="font-medium">
              This client is {HOLD_LABEL[last.hold] ?? last.hold}.
            </strong>{" "}
            A real customer gets a holding line and a person, not a model reply.
            <label className="ml-3 inline-flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={override}
                onChange={(e) => setOverride(e.target.checked)}
              />
              Answer anyway, to test the prompt underneath
            </label>
          </div>
        )}

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
          {turns.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Type what a customer would type. The reply comes back with the step that
              decided it.
            </p>
          )}

          {turns.map((t, i) => (
            <div
              key={i}
              className={t.direction === "inbound" ? "flex justify-end" : "flex justify-start"}
            >
              <div className="max-w-[36rem]">
                <div
                  className={`whitespace-pre-wrap rounded px-3 py-2 text-sm ${
                    t.direction === "inbound"
                      ? "bg-foreground text-background"
                      : "border border-border"
                  }`}
                >
                  {t.body}
                </div>
                {t.run && <Verdict run={t.run} />}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t border-border px-6 py-3">
          {error && <p className="mb-2 text-xs text-destructive">{error}</p>}
          <div className="flex gap-2">
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="are you open on Sunday?"
              className="flex-1 rounded border border-border bg-transparent px-3 py-2 text-sm"
            />
            <button
              type="button"
              disabled={busy || !text.trim()}
              onClick={() => void send()}
              className="rounded bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
            >
              {busy ? "Thinking…" : "Send"}
            </button>
          </div>
        </div>
      </div>

      <aside className="w-96 shrink-0 overflow-y-auto border-l border-border p-4">
        <Voice
          orgId={orgId}
          run={last}
          name={orgs.find((o) => o.org_id === orgId)?.name ?? ""}
          onRenamed={() => void refreshOrgs()}
        />
        <Kb orgId={orgId} />
        <Diary orgId={orgId} />

        {last && (
          <div className="mt-6 space-y-2 text-xs">
            <div className="uppercase tracking-wide text-muted-foreground">Last run</div>
            <Field label="Sector" value={last.sector} />
            <Field
              label="Knowledge base"
              value={
                last.kbBytes === 0
                  ? "empty — the bot can only say it will check with the team"
                  : `${last.kbBytes.toLocaleString("en-IN")} characters`
              }
            />
            <Field
              label="Times offered"
              value={
                last.slotsOffered === 0
                  ? "none — no hours set, so it cannot book"
                  : `${last.slotsOffered} free slots`
              }
            />
            <Field
              label="Tokens"
              value={
                last.usage
                  ? `${last.usage.promptTokens} in, ${last.usage.completionTokens} out`
                  : "none — nothing reached the model"
              }
            />
            <Field label="Cost" value={inr(last.costMicros)} />

            {last.systemPrompt && (
              <>
                <button
                  type="button"
                  onClick={() => setShowPrompt((v) => !v)}
                  className="mt-2 rounded border border-border px-2 py-1"
                >
                  {showPrompt ? "Hide" : "Show"} the exact prompt
                </button>
                {showPrompt && (
                  <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[11px] leading-relaxed">
                    {last.systemPrompt}
                  </pre>
                )}
              </>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

const HOLD_LABEL: Record<string, string> = {
  paused: "paused",
  closed: "outside its business hours",
  capped: "over its monthly spend cap",
};

/**
 * Which step settled the turn. This is the question a console exists to answer: a reply
 * that looks wrong is a different problem depending on whether the regex prefilter, the
 * model's own flags, or the sector output check produced it.
 */
const STAGE_LABEL: Record<string, string> = {
  no_context: "no client context — nothing to answer from",
  prefilter: "stopped by the safety prefilter, before the model",
  video: "video — always a person",
  media_flag: "flagged by the image check",
  media: "attachment — always a person",
  hold: "held by a runtime control, the model was not asked",
  llm_error: "the model did not answer — hardcoded fallback",
  model_flag: "flagged by the model, its reply was discarded",
  multi_reply: "the model wrote more than one message — blocked",
  sector_check: "the reply broke a sector rule — blocked in code",
  sent: "sent as written",
};

function Verdict({ run }: { run: ConsoleRun }) {
  const blocked = run.action !== "send";
  return (
    <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
      <span
        className={`rounded border px-1.5 py-0.5 ${
          blocked ? "border-amber-500/50 text-amber-600" : "border-border"
        }`}
      >
        {STAGE_LABEL[run.stage] ?? run.stage}
      </span>
      {run.kind && <span>flag: {run.kind}</span>}
      {run.overrodeHold && <span>hold overridden</span>}
      {/* A real customer's slot is taken here. The console has no conversation to book
          against and writes no appointment, so the reply says confirmed while the diary
          beside it does not move — said out loud, because that gap looks like a bug. */}
      {run.booking && <span className="text-amber-600">would book {run.booking} — not taken</span>}
      <span>{inr(run.costMicros)}</span>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-muted-foreground">{label}</div>
      <div>{value}</div>
    </div>
  );
}

/**
 * §10's three columns plus the business name, edited here because this is the only
 * screen where a change to them can be judged: edit the tone, send the same question
 * again, read the difference.
 *
 * Admin-only by construction — the route behind `setControls` is platform-admin. `voice`
 * is an instruction sitting above the reference block, so a client able to type into it
 * could argue with the safety rules. The sector output check would still refuse the
 * result, but the argument should not be possible in the first place.
 */
function Voice({
  orgId,
  run,
  name,
  onRenamed,
}: {
  orgId: string;
  run: ConsoleRun | null;
  name: string;
  onRenamed: () => void;
}) {
  const [orgName, setOrgName] = useState(name);
  const [voice, setVoice] = useState("");
  const [words, setWords] = useState("");
  const [languages, setLanguages] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [filled, setFilled] = useState(false);

  useEffect(() => {
    setVoice("");
    setWords("");
    setLanguages("");
    setSaved(null);
    setFilled(false);
  }, [orgId]);

  // Its own effect, not folded into the reset above: saving refreshes `name`, and a
  // shared effect would clear the tone textarea every time the name came back.
  useEffect(() => {
    setOrgName(name);
  }, [orgId, name]);

  // The console answer is the only reader of these columns the browser has — `admin_orgs`
  // does not return them — so the form fills from the first run and then leaves itself
  // alone, or a later run would overwrite what is being typed. `filled` is also what
  // `save()` reads to tell "empty because unknown" from "empty on purpose".
  useEffect(() => {
    if (!run || filled) return;
    setVoice(run.voice ?? "");
    setWords(run.replyMaxWords === null ? "" : String(run.replyMaxWords));
    setLanguages(run.languages ?? "");
    setFilled(true);
  }, [run, filled]);

  async function save() {
    setBusy(true);
    setSaved(null);
    try {
      // Only the fields this panel has actually shown. `name` arrives with the org list,
      // the other three only after a console run — so before a run they are empty because
      // they are unknown, not because they are blank, and sending them would null a saved
      // tone the operator never saw. The route leaves out fields alone.
      const patch: Partial<OrgControls> = { name: orgName.trim() };
      if (filled) {
        patch.voice = voice.trim() || null;
        patch.reply_max_words = words.trim() === "" ? null : Number(words);
        patch.languages = languages.trim() || null;
      }
      await setControls(orgId, patch);
      onRenamed();
      setSaved("Saved. Send the same question again to hear the difference.");
    } catch (e) {
      setSaved(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 text-xs">
      <div className="uppercase tracking-wide text-muted-foreground">Voice</div>
      <p className="text-muted-foreground">
        The name opens the prompt — the assistant introduces itself as theirs. Tone, length
        and language left empty mean the platform default: under 60 words, plain, English.
      </p>

      <label className="block space-y-1">
        <span className="text-muted-foreground">Business name</span>
        <input
          value={orgName}
          onChange={(e) => setOrgName(e.target.value)}
          maxLength={120}
          placeholder="Sharma Dental"
          className="w-full rounded border border-border bg-transparent px-2 py-1"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-muted-foreground">Tone</span>
        <textarea
          value={voice}
          onChange={(e) => {
            setVoice(e.target.value);
            setFilled(true);
          }}
          rows={3}
          placeholder="warm and unhurried, explains before it sells"
          className="w-full rounded border border-border bg-transparent px-2 py-1"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-muted-foreground">Reply length (words)</span>
        <input
          value={words}
          onChange={(e) => {
            setWords(e.target.value);
            setFilled(true);
          }}
          inputMode="numeric"
          placeholder="60 — platform default"
          className="w-full rounded border border-border bg-transparent px-2 py-1"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-muted-foreground">Languages</span>
        <input
          value={languages}
          onChange={(e) => {
            setLanguages(e.target.value);
            setFilled(true);
          }}
          placeholder="English"
          className="w-full rounded border border-border bg-transparent px-2 py-1"
        />
      </label>

      <button
        type="button"
        disabled={busy || !orgId || orgName.trim() === ""}
        onClick={() => void save()}
        className="rounded bg-foreground px-3 py-1.5 font-medium text-background disabled:opacity-50"
      >
        Save
      </button>
      {saved && <p className="text-muted-foreground">{saved}</p>}
    </div>
  );
}

/**
 * The client's knowledge base, edited beside the console so a fact can be added and the
 * question that missed it asked again in the same breath.
 *
 * Retrieval is off (`.claude/rules/data-model.md`) — the documents go into the system
 * prompt whole, oldest first, and only the first `maxDocuments` of them. Anything past
 * that is shown as ignored rather than listed as if the bot had read it.
 */
function Kb({ orgId }: { orgId: string }) {
  const [list, setList] = useState<KbList | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setList(null);
    setOpenId(null);
    setError(null);
    if (!orgId) return;

    let live = true;
    void kbList(orgId)
      .then((l) => live && setList(l))
      .catch((e) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [orgId]);

  async function reload() {
    setList(await kbList(orgId));
  }

  function open(doc: KbDocument) {
    setOpenId(doc.id);
    setTitle(doc.title);
    setRaw(doc.raw);
    setError(null);
  }

  function add() {
    setOpenId("new");
    setTitle("");
    setRaw("");
    setError(null);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (openId === "new") await kbCreate(orgId, title, raw);
      else if (openId) await kbUpdate(orgId, openId, { title, raw });
      await reload();
      setOpenId(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      await kbDelete(orgId, id);
      await reload();
      setOpenId(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const read = list?.documents.slice(0, list.maxDocuments) ?? [];
  const ignored = list?.documents.slice(list.maxDocuments) ?? [];
  const chars = read.reduce((n, d) => n + d.raw.length, 0);

  return (
    <div className="mt-6 space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="uppercase tracking-wide text-muted-foreground">Knowledge base</span>
        <span className="flex-1" />
        {list && list.documents.length < list.maxDocuments && (
          <button type="button" onClick={add} className="rounded border border-border px-2 py-0.5">
            Add
          </button>
        )}
      </div>

      <p className="text-muted-foreground">
        {list === null
          ? "Loading…"
          : list.documents.length === 0
            ? "Empty. The bot can only offer to check with the team."
            : `${chars.toLocaleString("en-IN")} characters reach the prompt on every turn, so this is what each reply costs before anyone types.`}
      </p>

      {read.map((d) => (
        <div key={d.id} className="rounded border border-border">
          <button
            type="button"
            onClick={() => (openId === d.id ? setOpenId(null) : open(d))}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left"
          >
            <span className="flex-1 truncate">{d.title}</span>
            <span className="text-muted-foreground">{d.raw.length.toLocaleString("en-IN")}</span>
          </button>
          {openId === d.id && (
            <Editor
              title={title}
              raw={raw}
              busy={busy}
              maxChars={list?.maxChars ?? 0}
              onTitle={setTitle}
              onRaw={setRaw}
              onSave={() => void save()}
              onCancel={() => setOpenId(null)}
              onDelete={() => void remove(d.id)}
            />
          )}
        </div>
      ))}

      {openId === "new" && (
        <div className="rounded border border-border">
          <Editor
            title={title}
            raw={raw}
            busy={busy}
            maxChars={list?.maxChars ?? 0}
            onTitle={setTitle}
            onRaw={setRaw}
            onSave={() => void save()}
            onCancel={() => setOpenId(null)}
          />
        </div>
      )}

      {ignored.length > 0 && (
        <div className="space-y-1 rounded border border-amber-500/40 bg-amber-500/10 p-2">
          <p>
            Past the first {list?.maxDocuments}, so the bot never reads {ignored.length === 1 ? "it" : "them"}:
          </p>
          {ignored.map((d) => (
            <div key={d.id} className="flex items-center gap-2">
              <span className="flex-1 truncate">{d.title}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void remove(d.id)}
                className="text-destructive"
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}

/**
 * The diary, beside the console so a week can be opened and "can I come Tuesday?" asked
 * in the same breath — the same reason the KB is edited here.
 *
 * This panel is the whole reason the bot can book at all: with no row here `free_slots`
 * returns nothing, the prompt says nothing about appointments, and the model is not
 * allowed to invent a time. Hours in, offers out.
 *
 * Monday leads because a week does, not because the numbers do — `weekday` is Postgres's
 * `dow`, where 0 is Sunday.
 */
const WEEK: Array<{ day: number; label: string }> = [
  { day: 1, label: "Mon" },
  { day: 2, label: "Tue" },
  { day: 3, label: "Wed" },
  { day: 4, label: "Thu" },
  { day: 5, label: "Fri" },
  { day: 6, label: "Sat" },
  { day: 0, label: "Sun" },
];

const DEFAULT_OPEN = "09:00";
const DEFAULT_CLOSE = "18:00";
const DEFAULT_SLOT = 30;

type Week = Record<number, { opens_at: string; closes_at: string } | undefined>;

function Diary({ orgId }: { orgId: string }) {
  const [week, setWeek] = useState<Week>({});
  const [slot, setSlot] = useState(DEFAULT_SLOT);
  const [booked, setBooked] = useState<Appointment[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setBooked(null);
    setWeek({});
    setDirty(false);
    setError(null);
    if (!orgId) return;

    let live = true;
    void diary(orgId)
      .then((d) => live && fill(d))
      .catch((e) => live && setError(message(e)));
    return () => {
      live = false;
    };
  }, [orgId]);

  function fill(d: { hours: HoursRow[]; appointments: Appointment[] }) {
    const next: Week = {};
    for (const h of d.hours) {
      // `HH:MM:SS` off Postgres, and `<input type="time">` wants `HH:MM`.
      next[h.weekday] = { opens_at: h.opens_at.slice(0, 5), closes_at: h.closes_at.slice(0, 5) };
    }
    setWeek(next);
    // The table stores a slot length per day; this form writes one for the week, because
    // no client has yet wanted a different appointment length on a Tuesday.
    setSlot(d.hours[0]?.slot_minutes ?? DEFAULT_SLOT);
    setBooked(d.appointments);
    setDirty(false);
  }

  function toggle(day: number) {
    setWeek((w) => ({
      ...w,
      [day]: w[day] ? undefined : { opens_at: DEFAULT_OPEN, closes_at: DEFAULT_CLOSE },
    }));
    setDirty(true);
  }

  function edit(day: number, field: "opens_at" | "closes_at", value: string) {
    setWeek((w) => {
      const row = w[day];
      return row ? { ...w, [day]: { ...row, [field]: value } } : w;
    });
    setDirty(true);
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const hours = WEEK.flatMap(({ day }) => {
        const row = week[day];
        return row ? [{ weekday: day, ...row, slot_minutes: slot }] : [];
      });
      await setHours(orgId, hours);
      fill(await diary(orgId));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    setBusy(true);
    setError(null);
    try {
      await cancelAppointment(orgId, id);
      setBooked(await diary(orgId).then((d) => d.appointments));
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const open = WEEK.filter(({ day }) => week[day]);
  const broken = open.some(({ day }) => week[day]!.closes_at <= week[day]!.opens_at);

  return (
    <div className="mt-6 space-y-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="uppercase tracking-wide text-muted-foreground">Diary</span>
        <span className="flex-1" />
        <select
          value={slot}
          onChange={(e) => {
            setSlot(Number(e.target.value));
            setDirty(true);
          }}
          className="rounded border border-border bg-transparent px-1 py-0.5"
        >
          {[15, 20, 30, 45, 60].map((m) => (
            <option key={m} value={m}>
              {m} min
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || !dirty || broken}
          onClick={() => void save()}
          className="rounded bg-foreground px-2 py-0.5 font-medium text-background disabled:opacity-50"
        >
          Save
        </button>
      </div>

      <p className="text-muted-foreground">
        {open.length === 0
          ? "No hours set, so the bot never offers a time and cannot book. It answers questions only."
          : `The bot offers free ${slot}-minute slots inside these hours, up to a week ahead, and books the one the customer picks.`}
      </p>

      {WEEK.map(({ day, label }) => {
        const row = week[day];
        return (
          <div key={day} className="flex items-center gap-2">
            <label className="flex w-16 items-center gap-1.5">
              <input type="checkbox" checked={!!row} onChange={() => toggle(day)} />
              {label}
            </label>
            {row ? (
              <>
                <input
                  type="time"
                  value={row.opens_at}
                  onChange={(e) => edit(day, "opens_at", e.target.value)}
                  className="rounded border border-border bg-transparent px-1 py-0.5"
                />
                <span className="text-muted-foreground">–</span>
                <input
                  type="time"
                  value={row.closes_at}
                  onChange={(e) => edit(day, "closes_at", e.target.value)}
                  className={`rounded border bg-transparent px-1 py-0.5 ${
                    row.closes_at <= row.opens_at ? "border-destructive" : "border-border"
                  }`}
                />
              </>
            ) : (
              <span className="text-muted-foreground">closed</span>
            )}
          </div>
        );
      })}

      {broken && <p className="text-destructive">A day has to close after it opens.</p>}

      {booked && booked.length > 0 && (
        <div className="space-y-1 pt-2">
          <div className="uppercase tracking-wide text-muted-foreground">Booked</div>
          {booked.map((a) => (
            <div key={a.id} className="flex items-center gap-2">
              <span className="flex-1 truncate">
                {ist(a.starts_at)}
                {" — "}
                {a.kind === "block"
                  ? "blocked out"
                  : [a.customer_name, a.service].filter(Boolean).join(", ") || "no name given"}
              </span>
              {/* Cancelled, never deleted: the row is the only proof this customer was
                  ever told they had this time, and `free_slots` offers it again either way. */}
              <button
                type="button"
                disabled={busy}
                onClick={() => void cancel(a.id)}
                className="text-destructive"
              >
                Cancel
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <p className="text-destructive">{error}</p>}
    </div>
  );
}

function Editor({
  title,
  raw,
  busy,
  maxChars,
  onTitle,
  onRaw,
  onSave,
  onCancel,
  onDelete,
}: {
  title: string;
  raw: string;
  busy: boolean;
  maxChars: number;
  onTitle: (v: string) => void;
  onRaw: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const over = raw.length > maxChars;
  return (
    <div className="space-y-2 border-t border-border p-2">
      <input
        value={title}
        onChange={(e) => onTitle(e.target.value)}
        placeholder="Timings and location"
        className="w-full rounded border border-border bg-transparent px-2 py-1"
      />
      <textarea
        value={raw}
        onChange={(e) => onRaw(e.target.value)}
        rows={10}
        placeholder="Open 9am to 8pm, closed Tuesdays. Haircut ₹400."
        className="w-full rounded border border-border bg-transparent px-2 py-1 font-mono text-[11px] leading-relaxed"
      />
      <div className="flex items-center gap-2">
        <span className={over ? "text-destructive" : "text-muted-foreground"}>
          {raw.length.toLocaleString("en-IN")} / {maxChars.toLocaleString("en-IN")}
        </span>
        <span className="flex-1" />
        {onDelete && (
          <button type="button" disabled={busy} onClick={onDelete} className="text-destructive">
            Delete
          </button>
        )}
        <button type="button" onClick={onCancel} className="rounded border border-border px-2 py-1">
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || over || !title.trim() || !raw.trim()}
          onClick={onSave}
          className="rounded bg-foreground px-3 py-1 font-medium text-background disabled:opacity-50"
        >
          Save
        </button>
      </div>
    </div>
  );
}

const message = (e: unknown) => (e instanceof Error ? e.message : "failed");
