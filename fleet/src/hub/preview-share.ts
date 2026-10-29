/**
 * A preview shared publicly, one preview per share, on the owner's say (`fleet preview share`). Everything private
 * stays on the tailnet; a share is served by a separate listener on loopback only (`SHARE_PORT`), which Tailscale
 * Funnel exposes, and which reaches nothing but the shared dev server: never `/f/…`'s routes, the private proxy,
 * another worker's preview, or the hub.
 *
 * A share is an unguessable link (`/<token>/`, 256 bits, kept only as its SHA-256, compared in constant time),
 * a password (kept only as its scrypt hash), and an expiry (24 h unless told otherwise). The link answers a password
 * form; the right password sets an HttpOnly, Secure, SameSite=Strict cookie scoped to the shared dev server's base
 * path, valid until the share ends, and moves the browser there. Tries are counted per share before any is checked
 * (so tries sent at once are as many tries): 5 wrong a minute, then refused until the minute is over; the form's body
 * is read up to 4 KiB, and the password is checked off the event loop, so a flood of tries never stalls the private
 * previews this process serves. Each share, unshare and public request is logged, never a password or token.
 *
 * The public origin is one for every share, so it is guarded as the hub's is: a dev server's headers that act on the
 * whole origin are dropped and a service worker past its path is the kill switch (`proxyHttp`), and the dev server's
 * own tools (`isTooling`) are not public. Writes to the app itself pass: a shared preview is there to be used.
 */
import { createHash, randomBytes, scrypt as scryptCallback, scryptSync, timingSafeEqual } from "node:crypto";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import * as Option from "effect/Option";

import { makePrivateDir, readText, writeAtomic } from "../files.ts";
import { asArray, asNumber, asObject, asString, dumps, parseObject } from "../json.ts";
import { readRecord } from "../preview/record.ts";
import { noteRequest, serverStanding } from "../preview/sleep.ts";
import { proxyHttp, proxySocket, startingPage, type Upgrade } from "./preview-proxy.ts";

/** The loopback port the public listener takes; Funnel forwards to it. */
export const SHARE_PORT = 7600;

/** The public https port Funnel serves shares on (Funnel allows 443, 8443 and 10000; 8443 is taken here). */
export const FUNNEL_PORT = 10000;

/** How long a share lasts unless told otherwise. */
export const SHARE_MS = 24 * 60 * 60 * 1000;

/** Wrong passwords allowed per share in a minute. */
const TRIES = 5;

const MINUTE = 60_000;

/** The most a password form's body is read. */
const FORM_BYTES = 4096;

/** Signed-in browsers kept per share; one more forgets the oldest. */
const SESSIONS = 32;

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** The sign-in's answers: the link is in their URL, so no page they lead to is told it. */
const SIGN_IN = { ...NO_STORE, "Referrer-Policy": "no-referrer" } as const;

/** Path segments of a dev server's tools that only a GET or HEAD reaches (Vite's client and modules, which HMR loads). */
const READ_ONLY = new Set(["@vite", "@fs", "@id", "node_modules"]);

/** One share, as `hub/shares.json` keeps it. */
export interface Share {
  readonly id: string;
  readonly fleet: string;
  readonly dir: string;
  /** The worker whose preview is shared; null for the combined one. */
  readonly worker: string | null;
  /** SHA-256 of the link's token, hex. */
  readonly token: string;
  /** scrypt salt and hash of the password, hex. */
  readonly salt: string;
  readonly hash: string;
  readonly created: number;
  readonly expires: number;
}

export function sharesPath(home: string): string {
  return join(home, "hub", "shares.json");
}

function sharesLog(home: string): string {
  return join(home, "hub", "shares.log");
}

const sha256 = (text: string): Buffer => createHash("sha256").update(text).digest();

const SCRYPT = { N: 16384, r: 8, p: 1 } as const;

const scrypt = (password: string, salt: Buffer): Buffer => scryptSync(password, salt, 32, SCRYPT);

/** {@link scrypt} off the event loop. */
const scryptAsync = (password: string, salt: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scryptCallback(password, salt, 32, SCRYPT, (error, key) => {
      if (error instanceof Error) reject(error);
      else resolve(key);
    });
  });

/** Whether `a` and `b` are the same bytes, in time that does not depend on where they differ. */
function same(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function readShares(home: string): Share[] {
  const raw = asArray(asObject(Option.getOrUndefined(parseObject(readText(sharesPath(home)) ?? "")))?.["shares"]) ?? [];

  return raw.flatMap((r) => {
    const o = asObject(r);
    const id = asString(o?.["id"]);
    const fleet = asString(o?.["fleet"]);
    const dir = asString(o?.["dir"]);
    const token = asString(o?.["token"]);
    const salt = asString(o?.["salt"]);
    const hash = asString(o?.["hash"]);
    const created = asNumber(o?.["created"]);
    const expires = asNumber(o?.["expires"]);

    if (id === undefined || fleet === undefined || dir === undefined || token === undefined || salt === undefined || hash === undefined || created === undefined || expires === undefined) return [];

    return [{ id, fleet, dir, worker: asString(o?.["worker"]) ?? null, token, salt, hash, created, expires }];
  });
}

function writeShares(home: string, shares: readonly Share[]): void {
  makePrivateDir(join(home, "hub"));
  writeAtomic(sharesPath(home), `${dumps({ shares: shares.map((s) => ({ ...s })) }, { indent: 2 })}\n`);
}

function logLine(home: string, line: string, now: number): void {
  makePrivateDir(join(home, "hub"));
  appendFileSync(sharesLog(home), `${new Date(now).toISOString()} ${line}\n`, { mode: 0o600 });
}

const subject = (s: Pick<Share, "fleet" | "worker">): string => `${s.fleet}${s.worker === null ? "" : `/${s.worker}`}`;

/** What a share is made of. */
export interface ShareAsked {
  readonly fleet: string;
  readonly dir: string;
  readonly worker: string | null;
  readonly ms: number;
  /** The owner's, from a file; else a new one is made. */
  readonly password: string | undefined;
  readonly now: number;
}

/** A share made: what is kept, and what is said once. */
export interface Made {
  readonly share: Share;
  readonly token: string;
  readonly password: string;
}

/** A new share: what is kept, and the link's token and the password, which are said once and never kept. */
export function createShare(home: string, given: ShareAsked): Made {
  const token = randomBytes(32).toString("base64url");
  const password = given.password ?? randomBytes(15).toString("base64url");
  const salt = randomBytes(16);

  const share: Share = {
    id: randomBytes(6).toString("hex"),
    fleet: given.fleet,
    dir: given.dir,
    worker: given.worker,
    token: sha256(token).toString("hex"),
    salt: salt.toString("hex"),
    hash: scrypt(password, salt).toString("hex"),
    created: given.now,
    expires: given.now + given.ms,
  };

  writeShares(home, [...readShares(home).filter((s) => s.expires > given.now), share]);
  logLine(home, `share ${share.id} ${subject(share)} until ${new Date(share.expires).toISOString()}`, given.now);

  return { share, token, password };
}

/** End the shares `which` picks; how many ended. */
export function removeShares(home: string, which: (s: Share) => boolean, now: number): number {
  const shares = readShares(home);
  const gone = shares.filter(which);
  writeShares(home, shares.filter((s) => !which(s)));

  for (const s of gone) logLine(home, `unshare ${s.id} ${subject(s)}`, now);

  return gone.length;
}

const notFound = (): Response => new Response("not found\n", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE } });

function form(status: number, note: string): Response {
  const body = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Shared preview</title>
<form method="post" style="font:16px system-ui;max-width:20rem;margin:20vh auto;display:grid;gap:.5rem">
<label for="p">Password</label><input id="p" name="password" type="password" autocomplete="current-password" autofocus required>
<button>Open</button>${note === "" ? "" : `<p role="alert">${note}</p>`}</form>`;

  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'", ...SIGN_IN } });
}

const notRunning = (): Response => new Response("The preview is not running\n", { status: 502, headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE } });

/** Whether `path` reaches the dev server's own tools rather than the app: a segment that starts with `__` (Vite's
 * `/__open-in-editor` and the like), or anything but a GET or HEAD to its modules (`READ_ONLY`). A path that does not
 * decode is refused too. */
export function isTooling(method: string, path: string): boolean {
  let segments: string[];

  try {
    segments = decodeURIComponent(path).toLowerCase().split(/[/\\]/u);
  } catch {
    return true;
  }

  return segments.some((s) => s.startsWith("__")) || (method !== "GET" && method !== "HEAD" && segments.some((s) => READ_ONLY.has(s)));
}

/** `req`'s body as text, unless it is longer than `limit` bytes: then undefined, the rest unread. */
async function bodyUpTo(req: Request, limit: number): Promise<string | undefined> {
  if (Number(req.headers.get("Content-Length") ?? "0") > limit) return undefined;
  const reader = req.body?.getReader();

  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  let next = await reader.read();

  while (!next.done) {
    size += next.value.byteLength;

    if (size > limit) {
      await reader.cancel();

      return undefined;
    }

    chunks.push(next.value);
    next = await reader.read();
  }

  return Buffer.concat(chunks).toString("utf8");
}

export interface PublicSharesOptions {
  readonly home: string;
  /** The public name the browser asked for (`<this machine>:FUNNEL_PORT`), which the dev server is told; the request's Host while there is none. */
  readonly host?: () => string | undefined;
  readonly now: () => number;
  readonly log: (line: string) => void;
}

/** The public side: the shares' links, their password forms, and the shared dev servers behind their cookies. */
export class PublicShares {
  private readonly options: PublicSharesOptions;
  /** Signed-in browsers, oldest first: SHA-256 of the cookie's value (hex) to the share it opens. */
  private readonly sessions = new Map<string, string>();
  /** Each share's tries in the last minute, oldest first: a try is counted when it comes, and given back if right. */
  private readonly failures = new Map<string, number[]>();
  private readonly counts = new Map<string, number>();

  constructor(options: PublicSharesOptions) {
    this.options = options;
  }

  private live(): Share[] {
    const now = this.options.now();

    return readShares(this.options.home).filter((s) => s.expires > now);
  }

  /** How many browsers are signed in, to shares that have not ended. */
  signedIn(): number {
    return this.sessions.size;
  }

  /** Forget what belongs to shares that ended: their browsers, tries and counts. */
  private forget(live: readonly Share[]): void {
    const ids = new Set(live.map((s) => s.id));

    for (const [key, id] of this.sessions) if (!ids.has(id)) this.sessions.delete(key);

    for (const map of [this.failures, this.counts]) for (const id of map.keys()) if (!ids.has(id)) map.delete(id);
  }

  async fetch(req: Request, upgrade: Upgrade | undefined): Promise<Response | undefined> {
    const url = new URL(req.url);
    const shares = this.live();
    this.forget(shares);
    const first = /^\/([A-Za-z0-9_-]{43})\/?$/.exec(url.pathname)?.[1];

    if (first !== undefined) {
      const hashed = sha256(first);
      const share = shares.find((s) => same(Buffer.from(s.token, "hex"), hashed));

      return share === undefined ? notFound() : this.signIn(req, share);
    }

    const cookies = cookiesOf(req.headers.get("Cookie") ?? "");

    const opened = shares
      .filter((s) => this.sessions.get(sha256(cookies.get(`fleet-share-${s.id}`) ?? "").toString("hex")) === s.id)
      .map((s) => ({ share: s, base: baseOf(s) }))
      .filter((o) => o.base !== undefined && url.pathname.startsWith(o.base))
      .sort((a, b) => (b.base?.length ?? 0) - (a.base?.length ?? 0))[0];

    if (opened === undefined) return notFound();

    return this.pass(req, opened.share, url, upgrade);
  }

  private async signIn(req: Request, share: Share): Promise<Response> {
    if (req.method !== "POST") return form(200, "");
    const now = this.options.now();
    const tries = this.failures.get(share.id) ?? [];
    this.failures.set(share.id, tries);

    while (tries.length > 0 && now - (tries[0] ?? now) >= MINUTE) tries.shift();

    if (tries.length >= TRIES) return new Response("too many wrong passwords: wait a minute\n", { status: 429, headers: { "Retry-After": String(Math.ceil((MINUTE - (now - (tries[0] ?? now))) / 1000)), ...SIGN_IN } });
    // Counted before anything is awaited, so that tries sent at once are as many tries.
    tries.push(now);
    const body = await bodyUpTo(req, FORM_BYTES);

    if (body === undefined) return new Response("too long\n", { status: 413, headers: SIGN_IN });
    const password = new URLSearchParams(body).get("password") ?? "";

    if (!same(await scryptAsync(password, Buffer.from(share.salt, "hex")), Buffer.from(share.hash, "hex"))) {
      this.options.log(`share ${share.id} ${subject(share)}: wrong password (${tries.length} in the last minute)`);

      return form(401, "Wrong password.");
    }

    const mine = tries.indexOf(now);

    if (mine >= 0) tries.splice(mine, 1);

    const base = baseOf(share);

    if (base === undefined) return notRunning();
    const session = randomBytes(32).toString("base64url");
    const own = [...this.sessions].filter(([, id]) => id === share.id);

    for (const [key] of own.slice(0, Math.max(0, own.length - SESSIONS + 1))) this.sessions.delete(key);
    this.sessions.set(sha256(session).toString("hex"), share.id);
    this.options.log(`share ${share.id} ${subject(share)}: signed in`);
    const age = Math.max(0, Math.floor((share.expires - now) / 1000));
    const cookie = `fleet-share-${share.id}=${session}; Path=${base}; Max-Age=${age}; HttpOnly; Secure; SameSite=Strict`;

    return new Response(null, { status: 303, headers: { Location: base, "Set-Cookie": cookie, ...SIGN_IN } });
  }

  private async pass(req: Request, share: Share, url: URL, upgrade: Upgrade | undefined): Promise<Response | undefined> {
    const record = readRecord(share.dir);
    const server = share.worker === null ? record?.server : record?.workers.find((w) => w.worker === share.worker);

    if (server === undefined || server === null) return notFound();

    if (isTooling(req.method, url.pathname)) return new Response("not shared: the dev server's own tools\n", { status: 403, headers: { "Content-Type": "text/plain; charset=utf-8", ...NO_STORE } });
    const count = (this.counts.get(share.id) ?? 0) + 1;
    this.counts.set(share.id, count);
    this.options.log(`share ${share.id} ${subject(share)}: public request ${count}`);
    const worker = share.worker ?? undefined;
    const now = serverStanding(server);

    if (now === "asleep" || now === "waking") {
      noteRequest(share.dir, worker);

      return startingPage(req);
    }

    if (now !== "running") return notRunning();
    noteRequest(share.dir, worker);
    // Every share is on the one public origin, as the previews are on the hub's: what acts on the whole origin is dropped.
    const target = { server, path: url.pathname, prefix: server.base, worker, onHubOrigin: true };
    // Where the browser asked, as `proxiedHost` says it, over https (Funnel's), whatever the client claimed.
    const host = this.options.host?.() ?? req.headers.get("Host") ?? url.host;
    const identity = new Headers({ "X-Forwarded-Host": host, "X-Forwarded-Proto": "https", Forwarded: `host="${host}";proto=https` });

    if ((req.headers.get("Upgrade") ?? "").toLowerCase() === "websocket") {
      return upgrade === undefined ? notFound() : proxySocket(req, target, url.search, upgrade, identity);
    }

    return proxyHttp(req, target, url.search, identity, notRunning);
  }
}

/** The base path of the shared dev server, under which its pages and its cookie live. */
function baseOf(share: Share): string | undefined {
  const record = readRecord(share.dir);
  const server = share.worker === null ? record?.server : record?.workers.find((w) => w.worker === share.worker);

  return server === undefined || server === null ? undefined : server.base;
}

function cookiesOf(header: string): Map<string, string> {
  return new Map(
    header.split(";").flatMap((part) => {
      const at = part.indexOf("=");

      return at < 0 ? [] : [[part.slice(0, at).trim(), part.slice(at + 1).trim()] as const];
    }),
  );
}
