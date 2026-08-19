/**
 * Screenshots of the client screens, for the partner brief in
 * `dashboard/public/portfolio/`.
 *
 * Chrome is driven over the DevTools protocol rather than through Playwright or
 * Puppeteer: node 24 has a global WebSocket, so this needs no dependency and no browser
 * download on a machine that already has Chrome.
 *
 * The passwords stay in the environment of whoever runs this. Nothing here prints them.
 *
 *   pnpm dev:dashboard                # in another terminal
 *   DEMO_PASSWORD=... node scripts/shots.mjs
 *
 * The brief shows only the three screens a client actually logs into, so the demo owner
 * account is the only login needed here.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const APP = process.env.APP_URL ?? "http://localhost:5173";
// fileURLToPath, not `.pathname`: the repo lives under a directory with a space in its
// name, and the raw pathname keeps it percent-encoded.
const OUT = fileURLToPath(new URL("../dashboard/public/portfolio/shots/", import.meta.url));
const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;

// A conversation row is a button whose first line is the customer's name, so opening a
// thread is the same click as switching screens. Harini Balaji is the one seeded
// conversation that runs start to finish — 24 turns, ending on a held seat — which is the
// only one worth photographing as a chat.
const OPEN_THREAD = `[...document.querySelectorAll("button")]
  .find((b) => b.textContent.trim().startsWith("Harini Balaji"))?.click() ?? true`;
const OPEN_MENU = `document.querySelector('button[aria-label="More"]')?.click() ?? true`;

const PASSES = [
  {
    email: process.env.DEMO_EMAIL ?? "owner@demo.com",
    password: process.env.DEMO_PASSWORD,
    // Crops are in CSS pixels against the fixed viewport below. They exist because the
    // brief is read on a phone: a whole screen shrunk to the width of a column is
    // unreadable, while the part of it that carries the point stays legible.
    shots: [
      ["Flowin", "flowin"],
      ["Flowin", "flowin-headline", { x: 240, y: 130, width: 740, height: 260 }],
      ["Desk", "desk"],
      // 13px of air around the "Waiting on you" label (top 237) and the Distress badge
      // (bottom 431). Any taller and the next conversation is sliced in half, which reads
      // as a broken image rather than a crop; x clears the column rule at 241.
      ["Desk", "desk-flags", { x: 245, y: 224, width: 315, height: 220 }],
      // 20px of air around the block itself: heading top 558, button bottom 682, text
      // 617 to 1209. Starting any higher catches the divider rule above, and the old
      // bottom edge sliced 8px off the button, which reads as a broken image.
      ["Desk", "desk-pause", { x: 597, y: 538, width: 632, height: 164 }],
      // The chat itself. Taken after the three Desk shots above, because opening a
      // conversation replaces the right-hand panel they are cropped out of.
      ["Desk", "thread", null, OPEN_THREAD, `/Four seats are open/.test(document.body.innerText)`],
      // The conversation header and the open menu together, which is every control there
      // is on a chat. Generously bounded rather than measured: the menu's height depends
      // on which items the signed-in role may see, and a crop that fits the owner exactly
      // would slice the last item off for staff.
      [
        "Desk",
        "thread-options",
        { x: 580, y: 0, width: 700, height: 330 },
        OPEN_MENU,
        `/Erase permanently/.test(document.body.innerText)`,
      ],
      ["Diary", "diary"],
      ["Diary", "diary-today", { x: 590, y: 56, width: 655, height: 292 }],
    ],
  },
];

// None of these screens has a loading flag: before the first Supabase read returns they
// render a complete, and completely stable, zeroed empty state. So the wait cannot key off
// the text settling — it has to name something only real data can produce.
//
// Every one of these must be a *positive* assertion. "The empty-state sentence is absent"
// is also true of a panel that has not mounted yet, so a negative test passes instantly on
// the screen before this one and the shot is taken while the RPCs are still in flight.
// That is exactly how an empty Flowin got into the brief twice.
const READY = {
  Flowin: `/replies went out without anyone/.test(document.body.innerText)`,
  Desk: `/\\d[\\d,]*\\s*enquiries answered/.test(document.body.innerText)`,
  Diary: `/\\d+\\s*booked/.test(document.body.innerText)`,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chrome() {
  const profile = mkdtempSync(join(tmpdir(), "shots-"));
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      "--hide-scrollbars",
      "--disable-gpu",
      "--no-first-run",
      "--window-size=1280,730",
    ],
    { stdio: "ignore" },
  );
  return proc;
}

async function attach() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      const page = list.find((t) => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not listening yet */
    }
    await sleep(250);
  }
  throw new Error("Chrome never opened a debugging port");
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let id = 0;

  const open = new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message));
    else waiter.resolve(msg.result);
  });

  const send = (method, params = {}) =>
    open.then(
      () =>
        new Promise((resolve, reject) => {
          const n = ++id;
          pending.set(n, { resolve, reject });
          ws.send(JSON.stringify({ id: n, method, params }));
        }),
    );

  return { send, close: () => ws.close() };
}

async function evaluate(cdp, expression) {
  const { result } = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  return result.value;
}

async function waitFor(cdp, expression, what, timeout = 25000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await evaluate(cdp, expression)) return true;
    await sleep(300);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** React listens for the input event and reads the value off the native setter. */
const type = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`;

const clickButton = (label) => `(() => {
  const hit = [...document.querySelectorAll("button")].find(
    (b) => b.textContent.trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())}),
  );
  if (!hit) return false;
  hit.click();
  return true;
})()`;

async function run(pass, cdp) {
  await cdp.send("Page.navigate", { url: APP });
  await waitFor(cdp, `!!document.querySelector('input[type="password"]')`, "the sign-in form");

  await evaluate(cdp, type('input[type="email"]', pass.email));
  await evaluate(cdp, type('input[type="password"]', pass.password));
  await evaluate(cdp, clickButton("sign in"));

  try {
    await waitFor(
      cdp,
      `!document.querySelector('input[type="password"]') &&
       [...document.querySelectorAll("button")].some((b) => /flowin|all clients/i.test(b.textContent))`,
      "the dashboard",
      30000,
    );
  } catch {
    const stuck = await evaluate(cdp, "document.body.innerText.slice(0, 160)");
    throw new Error(`${pass.email} did not reach the dashboard. Screen said: ${stuck}`);
  }

  let current = null;
  for (const [label, name, clip, before, ready] of pass.shots) {
    if (label !== current) {
      if (!(await evaluate(cdp, clickButton(label)))) {
        console.log(`  skipped ${name}: no "${label}" button on this account`);
        continue;
      }
      if (READY[label]) await waitFor(cdp, READY[label], `${label} to load its data`);
      await sleep(600); // The number counts up and the chart draws.
      current = label;
    }
    if (before) {
      await evaluate(cdp, before);
      // Same rule as READY above: name something only the loaded state can produce. A
      // thread renders its header before its messages, so waiting on the name would
      // photograph an empty chat.
      if (ready) await waitFor(cdp, ready, `${name} to be ready`);
      await sleep(400);
    }
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      ...(clip ? { clip: { ...clip, scale: 1 } } : {}),
    });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
    console.log(`  wrote ${name}.png`);
  }

  await evaluate(cdp, clickButton("sign out"));
  await sleep(1500);
}

const proc = chrome();
try {
  mkdirSync(OUT, { recursive: true });
  const cdp = connect(await attach());
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    // Wide enough for the desktop three-column layout, short enough that the Diary and
    // Flowin do not end in a band of empty white.
    width: 1280,
    height: 730,
    deviceScaleFactor: 2,
    mobile: false,
  });

  for (const pass of PASSES) {
    if (!pass.password) {
      console.log(`skipping ${pass.email}: no password in the environment`);
      continue;
    }
    console.log(`signing in as ${pass.email}`);
    await run(pass, cdp);
  }
  cdp.close();
} finally {
  proc.kill();
}
