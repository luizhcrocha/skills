#!/usr/bin/env node
// round-check.mjs: load each page of a prototype round in headless Chromium, at each width and color scheme,
// and write one summary line per load. Node 22+ and a Chromium; no packages (it speaks the DevTools protocol
// over Node's own WebSocket).
//
//   node round-check.mjs --out DIR --page URL [--page URL ...] [--scheme light[,dark]] [--width 1440[,390]]
//        [--wait SELECTOR] [--criteria SELECTOR] [--check JS ...] [--timeout S] [--jobs N] [--chromium PATH] [--plan]
//
// A load passes when the page answers below 400, the --wait selector shows up within --timeout, the page throws
// nothing, and every --check expression is truthy. --criteria reads the text of every element it matches into
// the line. The defaults (light, 1440) are the mid-round scoped check; the full matrix is
// `--scheme light,dark --width 1440,390`. --plan prints the loads as JSON and opens no browser.
// Output: DIR/summary.txt (one line per load: PASS|FAIL, path, scheme, width, errors, screenshot, reasons,
// criteria) and a PNG per load in DIR. Every DevTools call of a load ends within --timeout plus 5 s, so a server
// that never answers or a page that never yields fails its load instead of hanging the run.
// A browser that dies fails every load left. The browser is closed and its profile removed on every exit,
// SIGINT and SIGTERM included, also while Chromium starts. Under a $TMPDIR too deep for Chromium's socket path the
// profile goes under /tmp and is Chromium's $TMPDIR, removed with it. Exit 0 when every load passes, 1 when one fails or
// the run broke, 2 on bad arguments, 3 when no Chromium runs, 130 or 143 when stopped by SIGINT or SIGTERM.

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const USAGE =
  "usage: round-check.mjs --out DIR --page URL [--page URL ...] [--scheme light,dark] [--width 1440,390] " +
  "[--wait SELECTOR] [--criteria SELECTOR] [--check JS ...] [--timeout S] [--jobs N] [--chromium PATH] [--plan]";

const SCHEMES = new Set(["light", "dark"]);

function fail(message) {
  process.stderr.write(`round-check: ${message}\n${USAGE}\n`);
  process.exit(2);
}

function noChromium(message) {
  process.stderr.write(`round-check: ${message}\n`);
  process.exit(3);
}

/** The options from argv. A page is a whole URL, normalized as URL does it (a space or a quote is
 * percent-encoded); every `=` and `&` of its query is kept. */
function parseArgs(argv) {
  const o = { pages: [], schemes: ["light"], widths: [1440], wait: "body", criteria: null, checks: [], timeout: 30, jobs: 4, chromium: null, out: null, plan: false };
  const lists = (v) => v.split(",").map((s) => s.trim()).filter((s) => s !== "");

  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--plan") {
      o.plan = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) fail(`${flag} takes a value`);
    i += 1;
    if (flag === "--page") {
      let url;
      try {
        url = new URL(value);
      } catch {
        fail(`--page takes a full URL (scheme and host included), not ${JSON.stringify(value)}`);
      }
      o.pages.push(url.href);
    } else if (flag === "--scheme") {
      o.schemes = lists(value);
      for (const s of o.schemes) if (!SCHEMES.has(s)) fail(`--scheme is light, dark or both, not ${s}`);
    } else if (flag === "--width") {
      o.widths = lists(value).map(Number);
      for (const w of o.widths) if (!Number.isInteger(w) || w < 200) fail(`--width takes pixel widths such as 1440,390, not ${value}`);
    } else if (flag === "--wait") o.wait = value;
    else if (flag === "--criteria") o.criteria = value;
    else if (flag === "--check") o.checks.push(value);
    else if (flag === "--timeout") o.timeout = Number(value);
    else if (flag === "--jobs") o.jobs = Math.max(1, Number(value) || 1);
    else if (flag === "--chromium") o.chromium = value;
    else if (flag === "--out") o.out = value;
    else fail(`unknown argument ${flag}`);
  }
  if (o.pages.length === 0) fail("give at least one --page");
  if (o.out === null && !o.plan) fail("--out DIR is required (keep it in the scratchpad: screenshots may show client data)");
  if (!(o.timeout > 0)) fail("--timeout takes seconds");
  return o;
}

/** Every load: each page at each scheme and width, in that order. */
function plan(o) {
  return o.pages.flatMap((url) => o.schemes.flatMap((scheme) => o.widths.map((width) => ({ url, scheme, width }))));
}

const runs = (bin) => spawnSync(bin, ["--version"], { stdio: "ignore", timeout: 20_000 }).status === 0;

/** The Chromium to run: --chromium, else $CHROMIUM (either must run), else the first known one that runs. */
function findChromium(given) {
  for (const [name, from] of [[given, "--chromium"], [process.env.CHROMIUM, "$CHROMIUM"]]) {
    if (!name) continue;
    if (runs(name)) return name;
    noChromium(`${from} ${name} does not run (\`${name} --version\` failed)`);
  }
  const names = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  return names.find(runs) ?? null;
}

/** The longest Unix socket path: sun_path holds 108 bytes on Linux (104 on macOS), the closing NUL included. */
const SOCKET_PATH_MAX = process.platform === "linux" ? 107 : 103;

/** Chromium's singleton socket under `dir` as its $TMPDIR: dir/org.chromium.Chromium.XXXXXX/SingletonSocket. */
const socketFits = (dir) => Buffer.byteLength(join(dir, "org.chromium.Chromium.XXXXXX", "SingletonSocket")) <= SOCKET_PATH_MAX;

/** A headless Chromium, started at once, and its DevTools connection once `ready` resolves. `close` works from
 * the start, so a stop while Chromium starts leaves no browser and no profile either. */
function launch(bin) {
  const short = !socketFits(tmpdir());
  const profile = mkdtempSync(join(short ? "/tmp" : tmpdir(), "round-check-"));
  const env = short ? { ...process.env, TMPDIR: profile } : process.env;
  const proc = spawn(bin, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--no-sandbox", "--hide-scrollbars", "--mute-audio", "about:blank"], { stdio: ["ignore", "ignore", "pipe"], env });
  const exited = new Promise((resolve) => proc.once("exit", resolve));
  let ws = null;
  let open = false;
  let next = 0;
  let dead = null;
  const waiting = new Map();
  const listeners = new Set();
  const die = (why) => {
    dead ??= new Error(why);
    for (const { reject } of waiting.values()) reject(dead);
    waiting.clear();
  };
  proc.on("exit", (code, signal) => die(`Chromium exited (${signal ?? code})`));
  const send = (method, params = {}, sessionId = undefined) =>
    new Promise((resolve, reject) => {
      if (dead) return reject(dead);
      next += 1;
      waiting.set(next, { resolve, reject });
      ws.send(JSON.stringify({ id: next, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  let closing = null;
  /** Ask Chromium to close (Browser.close once connected, else SIGTERM), kill it if it has not exited in 5 s,
   * then remove its profile once it is gone. */
  const close = () =>
    (closing ??= (async () => {
      if (open && !dead) await within(send("Browser.close"), Date.now() + 5000, "Browser.close in 5 s").catch(() => {});
      else if (!dead) proc.kill("SIGTERM");
      if (!(await within(exited, Date.now() + 5000, "Chromium's exit in 5 s").then(() => true, () => false))) {
        proc.kill("SIGKILL");
        await exited;
      }
      rmSync(profile, { recursive: true, force: true });
    })());
  const ready = (async () => {
    const endpoint = await new Promise((resolve, reject) => {
      let seen = "";
      const timer = setTimeout(() => reject(new Error(`Chromium did not start in 20 s: ${seen.slice(-400)}`)), 20_000);
      proc.stderr.on("data", (chunk) => {
        seen += chunk;
        const m = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`Chromium exited (${code}): ${seen.slice(-400)}`));
      });
    });
    ws = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error(`no DevTools connection at ${endpoint}`));
    });
    open = true;
    ws.onclose = () => die("Chromium exited (its DevTools connection closed)");
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.id !== undefined && waiting.has(msg.id)) {
        const { resolve, reject } = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ""}`));
        else resolve(msg.result);
      } else if (msg.method) for (const l of listeners) l(msg);
    };
  })().catch(async (e) => {
    await close();
    throw e;
  });
  return { ready, send, listeners, close };
}

/** `promise`, or a rejection naming `what` once `deadline` (ms since the epoch) passes. */
function within(promise, deadline, what) {
  let timer;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer to ${what}`)), Math.max(0, deadline - Date.now()));
  });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(send, session, expression) {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, session);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description?.split("\n")[0] ?? r.exceptionDetails.text);
  return r.result.value;
}

function slug(load, index) {
  const u = new URL(load.url);
  const name = `${u.pathname}${u.search}`.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "root";
  return `${String(index + 1).padStart(2, "0")}-${name}-${load.scheme}-${load.width}.png`;
}

/** One load in a fresh tab: its line's fields. The waits for the page end at the load's deadline; every call to
 * the browser ends 5 s after it at the latest, so a load that reached its deadline still reads its page. */
async function check(browser, o, load, shot) {
  const deadline = Date.now() + o.timeout * 1000;
  const send = (method, params, session) => within(browser.send(method, params, session), deadline + 5000, `${method} in ${o.timeout} + 5 s`);
  const { listeners } = browser;
  const result = { path: "?", errors: [], reasons: [], criteria: null, shot };
  let targetId;
  let sessionId;
  try {
    ({ targetId } = await send("Target.createTarget", { url: "about:blank" }));
    ({ sessionId } = await send("Target.attachToTarget", { targetId, flatten: true }));
  } catch (e) {
    result.reasons.push(`error: ${e.message}`);
    if (targetId !== undefined) await within(browser.send("Target.closeTarget", { targetId }), Date.now() + 5000, "Target.closeTarget in 5 s").catch(() => {});
    return result;
  }
  const errors = result.errors;
  let loaded = false;
  const listen = (msg) => {
    if (msg.sessionId !== sessionId) return;
    if (msg.method === "Runtime.exceptionThrown") errors.push(msg.params.exceptionDetails.exception?.description?.split("\n")[0] ?? msg.params.exceptionDetails.text);
    if (msg.method === "Page.loadEventFired") loaded = true;
  };
  listeners.add(listen);
  try {
    await send("Page.enable", {}, sessionId);
    await send("Runtime.enable", {}, sessionId);
    await send("Emulation.setDeviceMetricsOverride", { width: load.width, height: load.width < 600 ? 844 : 900, deviceScaleFactor: 1, mobile: load.width < 600 }, sessionId);
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: load.scheme }] }, sessionId);
    const nav = await send("Page.navigate", { url: load.url }, sessionId);
    if (nav.errorText) {
      result.reasons.push(`not loaded: ${nav.errorText}`);
      return result;
    }
    while (!loaded && Date.now() < deadline) await sleep(100);
    if (!loaded) result.reasons.push("no load event");
    result.path = await evaluate(send, sessionId, "location.pathname + location.search");
    const status = await evaluate(send, sessionId, "performance.getEntriesByType('navigation')[0]?.responseStatus ?? 0");
    if (status >= 400) result.reasons.push(`HTTP ${status}`);
    const sel = JSON.stringify(o.wait);
    let found = false;
    while (Date.now() < deadline && !(found = await evaluate(send, sessionId, `!!document.querySelector(${sel})`))) await sleep(100);
    if (!found) result.reasons.push(`${o.wait} not found in ${o.timeout} s`);
    if (o.criteria !== null) result.criteria = await evaluate(send, sessionId, `Array.from(document.querySelectorAll(${JSON.stringify(o.criteria)}), (e) => e.textContent.trim().replace(/\\s+/g, " ")).join(" | ")`);
    for (const js of o.checks) {
      try {
        if (!(await evaluate(send, sessionId, js))) result.reasons.push(`check false: ${js}`);
      } catch (e) {
        result.reasons.push(`check threw: ${js}: ${e.message}`);
      }
    }
    const { data } = await send("Page.captureScreenshot", { format: "png" }, sessionId);
    writeFileSync(shot, Buffer.from(data, "base64"));
  } catch (e) {
    result.reasons.push(`error: ${e.message}`);
  } finally {
    listeners.delete(listen);
    await within(browser.send("Target.closeTarget", { targetId }), Date.now() + 5000, "Target.closeTarget in 5 s").catch(() => {});
  }
  return result;
}

function line(load, r) {
  const reasons = [...r.reasons, ...r.errors.map((e) => `page error: ${e}`)];
  const fields = [reasons.length === 0 ? "PASS" : "FAIL", r.path, load.scheme, load.width, `errors=${r.errors.length}`, `shot=${r.shot}`];
  if (reasons.length > 0) fields.push(`why=${JSON.stringify(reasons.join("; "))}`);
  if (r.criteria !== null) fields.push(`criteria=${JSON.stringify(r.criteria)}`);
  return fields.join(" ");
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const loads = plan(o);
  if (o.plan) {
    process.stdout.write(`${JSON.stringify(loads, null, 2)}\n`);
    return 0;
  }
  const bin = findChromium(o.chromium);
  if (bin === null) noChromium("no Chromium found: pass --chromium PATH or set $CHROMIUM");
  mkdirSync(o.out, { recursive: true });
  let browser = null;
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]]) {
    process.on(signal, () => {
      process.stderr.write(`round-check: stopped by ${signal}; closing Chromium\n`);
      (browser?.close() ?? Promise.resolve()).finally(() => process.exit(code));
    });
  }
  browser = launch(bin);
  await browser.ready;
  const lines = new Array(loads.length);
  try {
    let at = 0;
    const worker = async () => {
      while (at < loads.length) {
        const i = at;
        at += 1;
        const r = await check(browser, o, loads[i], join(o.out, slug(loads[i], i)));
        lines[i] = line(loads[i], r);
        process.stdout.write(`${lines[i]}\n`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(o.jobs, loads.length) }, worker));
  } finally {
    await browser.close();
  }
  const summary = join(o.out, "summary.txt");
  writeFileSync(summary, `${lines.join("\n")}\n`);
  const failed = lines.filter((l) => l.startsWith("FAIL")).length;
  process.stdout.write(`${loads.length - failed}/${loads.length} loads pass; summary: ${summary}\n`);
  return failed === 0 ? 0 : 1;
}

// A run whose event loop drains before main settles (a promise nothing will settle) fails, never passes.
process.exitCode = 1;
main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`round-check: ${e.message}\n`);
    process.exit(1);
  },
);
