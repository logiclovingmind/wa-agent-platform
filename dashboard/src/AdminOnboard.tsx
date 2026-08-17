import { useEffect, useState } from "react";
import {
  exportOrg,
  offboardOrg,
  onboard,
  testMessage,
  type Onboarded,
  type Onboarding,
} from "./lib/api";

/**
 * Onboarding and offboarding (admin-panel.md §4) — the riskiest screen in the panel, and
 * the one that decides whether "client #21 is an INSERT, not a deploy" stays true.
 *
 * The Meta token and app secret are typed into this form and go straight to the Worker,
 * which seals them under `MASTER_KEY_V*` and stores ciphertext. They are never read back:
 * `wa_accounts` denies select to every browser login, including this one. If a token has
 * to change, it is typed again.
 */
const BLANK: Onboarding = {
  name: "",
  sector: "general",
  phone_number_id: "",
  waba_id: "",
  display_phone_number: "",
  token: "",
  app_secret: "",
  owner_email: "",
};

const SECTORS: Array<[string, string]> = [
  ["general", "General"],
  ["real_estate", "Real estate"],
  ["healthcare", "Healthcare"],
  ["pharmacy", "Pharmacy / ayurveda"],
];

export function OnboardClient({
  onChanged,
  orgIds,
}: {
  onChanged: () => void;
  /** The clients currently on the table, so a result panel cannot outlive the client it describes. */
  orgIds: string[];
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<Onboarding>(BLANK);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Onboarded | null>(null);
  const [listed, setListed] = useState(false);
  const [testTo, setTestTo] = useState("");
  const [testResult, setTestResult] = useState<string | null>(null);

  const set = (k: keyof Onboarding) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const ready = Object.values(form).every((v) => v.trim() !== "");

  /**
   * The result panel holds the webhook slug and a live one-time sign-in link — the two
   * things this screen promises are shown once. Nothing used to clear them: Close left
   * `done` set, so reopening showed the previous client's secrets instead of a form, and
   * they stayed on screen after that client had been offboarded entirely.
   */
  function reset() {
    setDone(null);
    setListed(false);
    setError(null);
    setTestTo("");
    setTestResult(null);
  }

  function dismiss() {
    reset();
    setOpen(false);
  }

  // Drop the panel when its client stops existing. `listed` is what keeps this from
  // firing on the way in: `onChanged` reloads the table asynchronously, so for a moment
  // after a successful onboard the new client is genuinely absent from `orgIds`, and
  // without the guard the panel would erase itself the instant it appeared.
  useEffect(() => {
    if (!done) return;
    if (orgIds.includes(done.org_id)) setListed(true);
    else if (listed) dismiss();
  }, [orgIds, done, listed]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await onboard(form);
      // Cleared the moment the Worker has them. The token and app secret have no reason
      // to sit in a tab's memory after this.
      setForm(BLANK);
      setDone(result);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not onboard");
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    if (!done) return;
    setBusy(true);
    const result = await testMessage(done.org_id, testTo).catch(() => ({
      ok: false,
      meta: "the Worker did not answer",
    }));
    setTestResult(result.ok ? "Sent. Check the phone." : JSON.stringify(result.meta));
    setBusy(false);
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-8 rounded bg-foreground px-3 py-1.5 text-xs font-medium text-background"
      >
        Onboard a client
      </button>
    );
  }

  return (
    <section className="mb-8 rounded border border-border p-4">
      <div className="mb-3 flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">
          Onboard a client
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="rounded border border-border px-2 py-1 text-xs"
        >
          Close
        </button>
      </div>

      {done ? (
        <div className="space-y-3 text-xs">
          <p className="font-medium">{done.subscribed ? "Onboarded." : "Onboarded, with a fault."}</p>

          <div>
            <div className="text-muted-foreground">Webhook URL — paste this into Meta</div>
            <p className="break-all font-mono">{done.webhook_url}</p>
            <p className="mt-1 text-muted-foreground">
              This URL is the client's only per-client secret. Anyone who has it can post
              to their webhook, so it goes into Meta and nowhere else.
            </p>
          </div>

          {!done.subscribed && (
            <p className="text-destructive">
              Meta did not accept the app subscription. Nothing will arrive until it does —
              subscribe by hand in the Meta app dashboard, then re-check the client's row.
            </p>
          )}

          {done.invite_link && (
            <div>
              <div className="text-muted-foreground">Owner's one-time sign-in link</div>
              <p className="break-all font-mono">{done.invite_link}</p>
              <p className="mt-1 text-muted-foreground">
                Shown once. No email was sent — pass it on yourself.
              </p>
            </div>
          )}
          {done.invite_error && (
            <p className="text-destructive">
              The client exists but the owner login was not created: {done.invite_error}.
              Add it from the client's row.
            </p>
          )}

          <div className="rounded border border-border p-3">
            <div className="mb-2 text-muted-foreground">
              Send a test message before handing this over
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="919876543210"
                className="min-w-48 flex-1 rounded border border-border bg-transparent px-2 py-1"
              />
              <button
                type="button"
                disabled={busy || !testTo.trim()}
                onClick={() => void sendTest()}
                className="rounded bg-foreground px-3 py-1.5 font-medium text-background disabled:opacity-50"
              >
                Send
              </button>
            </div>
            <p className="mt-1 text-muted-foreground">
              Sends Meta's `hello_world` template. A number that has never messaged this
              client has no open 24-hour window, so free text would fail for a reason that
              has nothing to do with the setup.
            </p>
            {testResult && <p className="mt-2 break-all font-mono">{testResult}</p>}
          </div>

          <button
            type="button"
            onClick={reset}
            className="rounded border border-border px-2 py-1"
          >
            Onboard another
          </button>
        </div>
      ) : (
        <>
          <div className="grid gap-3 text-xs sm:grid-cols-2">
            <Text label="Business name" value={form.name} onChange={set("name")} />
            <label className="space-y-1">
              <span className="text-muted-foreground">Sector</span>
              <select
                value={form.sector}
                onChange={(e) => set("sector")(e.target.value)}
                className="w-full rounded border border-border bg-transparent px-2 py-1"
              >
                {SECTORS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <span className="block text-muted-foreground">
                Decides the guardrails enforced in code before every send.
              </span>
            </label>

            <Text
              label="Phone number ID"
              value={form.phone_number_id}
              onChange={set("phone_number_id")}
            />
            <Text label="WABA ID" value={form.waba_id} onChange={set("waba_id")} />
            <Text
              label="Display number"
              value={form.display_phone_number}
              onChange={set("display_phone_number")}
            />
            <Text
              label="Owner's email"
              value={form.owner_email}
              onChange={set("owner_email")}
            />

            <Text label="Meta access token" value={form.token} onChange={set("token")} secret />
            <Text
              label="Meta app secret"
              value={form.app_secret}
              onChange={set("app_secret")}
              secret
            />
          </div>

          <div className="mt-3 flex items-center gap-3">
            <button
              type="button"
              disabled={busy || !ready}
              onClick={() => void submit()}
              className="rounded bg-foreground px-3 py-1.5 text-xs font-medium text-background disabled:opacity-50"
            >
              Create client
            </button>
            {error && <span className="text-xs text-destructive">{error}</span>}
          </div>

          <p className="mt-3 text-xs text-muted-foreground">
            The token and the app secret are encrypted by the Worker and stored as
            ciphertext. They cannot be read back from any screen — if one changes, type it
            again here.
          </p>
        </>
      )}
    </section>
  );
}

function Text({
  label,
  value,
  onChange,
  secret = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  secret?: boolean;
}) {
  return (
    <label className="space-y-1">
      <span className="text-muted-foreground">{label}</span>
      <input
        type={secret ? "password" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        // Nothing about a Meta token should end up in a browser's saved form data.
        autoComplete={secret ? "new-password" : "off"}
        className="w-full rounded border border-border bg-transparent px-2 py-1"
      />
    </label>
  );
}

/**
 * Offboarding, in the order §4 requires: export, then delete. The Worker enforces it —
 * the delete refuses until an export has been recorded against this client.
 */
export function Offboard({
  orgId,
  name,
  onChanged,
}: {
  orgId: string;
  name: string;
  onChanged: () => void;
}) {
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState(false);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const data = await exportOrg(orgId);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `${name.replace(/\W+/g, "-").toLowerCase()}-export.json`;
      a.click();
      URL.revokeObjectURL(url);
      setExported(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not export");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await offboardOrg(orgId, confirm);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not delete");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-destructive/40 bg-background p-4">
      <div className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
        Offboarding
      </div>
      <p className="mb-3 text-xs text-muted-foreground">
        Export first, then delete. Deleting removes every conversation, message and stored
        file, and the logins that could read them. There is no undo and no backup of a
        deliberate deletion.
      </p>

      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          disabled={busy}
          onClick={() => void download()}
          className="rounded border border-border px-3 py-1.5 disabled:opacity-50"
        >
          {exported ? "Export again" : "Export everything"}
        </button>
        <input
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder={`type "${name}" to delete`}
          className="min-w-48 flex-1 rounded border border-border bg-transparent px-2 py-1"
        />
        <button
          type="button"
          disabled={busy || confirm !== name}
          onClick={() => void remove()}
          className="rounded bg-destructive px-3 py-1.5 font-medium text-destructive-foreground disabled:opacity-50"
        >
          Delete this client
        </button>
      </div>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}
