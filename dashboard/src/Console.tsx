import { useEffect, useState } from "react";
import { supabase, type AdminOrg } from "./lib/supabase";
import { consoleRun, setControls, type ConsoleRun, type ConsoleTurn } from "./lib/api";
import { inr } from "./lib/utils";

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
            <button
              type="button"
              onClick={reset}
              className="rounded border border-border px-3 py-1 text-xs"
            >
              Reset
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

      <aside className="w-80 shrink-0 overflow-y-auto border-l border-border p-4">
        <Voice orgId={orgId} run={last} />

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
 * §10's three columns, edited here because this is the only screen where a change to
 * them can be judged: edit the tone, send the same question again, read the difference.
 *
 * Admin-only by construction — the route behind `setControls` is platform-admin. `voice`
 * is an instruction sitting above the reference block, so a client able to type into it
 * could argue with the safety rules. The sector output check would still refuse the
 * result, but the argument should not be possible in the first place.
 */
function Voice({ orgId, run }: { orgId: string; run: ConsoleRun | null }) {
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

  // The console answer is the only reader of these columns the browser has — `admin_orgs`
  // does not return them — so the form fills from the first run and then leaves itself
  // alone, or a later run would overwrite what is being typed.
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
      await setControls(orgId, {
        voice: voice.trim() || null,
        reply_max_words: words.trim() === "" ? null : Number(words),
        languages: languages.trim() || null,
      });
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
        Tone, length and language for this client. Empty means the platform default: under
        60 words, plain, English.
      </p>

      <label className="block space-y-1">
        <span className="text-muted-foreground">Tone</span>
        <textarea
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          rows={3}
          placeholder="warm and unhurried, explains before it sells"
          className="w-full rounded border border-border bg-transparent px-2 py-1"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-muted-foreground">Reply length (words)</span>
        <input
          value={words}
          onChange={(e) => setWords(e.target.value)}
          inputMode="numeric"
          placeholder="60 — platform default"
          className="w-full rounded border border-border bg-transparent px-2 py-1"
        />
      </label>

      <label className="block space-y-1">
        <span className="text-muted-foreground">Languages</span>
        <input
          value={languages}
          onChange={(e) => setLanguages(e.target.value)}
          placeholder="English"
          className="w-full rounded border border-border bg-transparent px-2 py-1"
        />
      </label>

      <button
        type="button"
        disabled={busy || !orgId}
        onClick={() => void save()}
        className="rounded bg-foreground px-3 py-1.5 font-medium text-background disabled:opacity-50"
      >
        Save voice
      </button>
      {saved && <p className="text-muted-foreground">{saved}</p>}

      <p className="pt-2 text-muted-foreground">
        The knowledge base is not editable here yet — it is what makes one client's answers
        different from another's, and it needs its own write path.
      </p>
    </div>
  );
}
