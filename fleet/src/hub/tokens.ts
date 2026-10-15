/**
 * The hub's page token (a grant's, `grantRefusal`) and Stop token (the manager's page's, `stopRefusal`), kept in one
 * file in the hub's state dir, `REGISTRY/hub/tokens.json`, so a page opened before a restart (a landing restarts the
 * hub) still answers after it. The file is made on the first start and reused after; one the hub cannot trust (a
 * symlink, not a regular file, a mode other than 0600, another owner, unreadable, malformed, a token of the wrong
 * length) is replaced with new tokens. It is written 0600 through a temp file and a rename, and never served nor
 * logged: what the log says of it names the file and why, never a token.
 *
 * A token older than {@link TOKEN_ROTATE_MS} is replaced when the hub starts, when a page is served and when an answer
 * is checked; the one it replaced is still accepted for {@link TOKEN_GRACE_MS} from when it was due (so never past
 * 48 h after it was made, however long the hub was idle), a page open at the rotation still answers, and new pages
 * always get the current one. A clock set back never rotates a token: its age counts from 0. A token made more than
 * 24 h ahead of the clock is replaced, as a due one is, with its grace from now.
 */
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import * as Option from "effect/Option";

import { makePrivateDir, strerror } from "../files.ts";
import { asNumber, asObject, asString, dumps, parseObject, type JsonObject } from "../json.ts";

/** How old a token gets before it is replaced: 24 h. */
export const TOKEN_ROTATE_MS = 24 * 3_600_000;

/** How long a replaced token is still accepted: 24 h. */
export const TOKEN_GRACE_MS = 24 * 3_600_000;

/** The two tokens: a fleet's page's (a grant) and the manager's page's Stop. */
export type TokenKind = "page" | "stop";

const KINDS: readonly TokenKind[] = ["page", "stop"];

/** 24 random bytes in base64url. */
const TOKEN_TEXT = /^[A-Za-z0-9_-]{32}$/u;

type Held = {
  readonly token: string;
  /** When it was made, in ms since the epoch. */
  readonly created: number;
  /** The token it replaced, and when, while that one is in its grace. */
  readonly previous?: { readonly token: string; readonly retired: number };
};

type Tokens = Readonly<Record<TokenKind, Held>>;

/** `REGISTRY/hub/tokens.json`. */
export function tokensPath(home: string): string {
  return join(home, "hub", "tokens.json");
}

function fresh(now: number): Held {
  return { token: randomBytes(24).toString("base64url"), created: now };
}

function heldOf(value: JsonObject | undefined): Held | undefined {
  const token = asString(value?.["token"]);
  const created = asNumber(value?.["created"]);

  if (token === undefined || !TOKEN_TEXT.test(token) || created === undefined || !Number.isFinite(created)) return undefined;
  const raw = value?.["previous"];

  if (raw === undefined || raw === null) return { token, created };
  const previous = asObject(raw);
  const old = asString(previous?.["token"]);
  const retired = asNumber(previous?.["retired"]);

  if (old === undefined || !TOKEN_TEXT.test(old) || retired === undefined || !Number.isFinite(retired)) return undefined;

  return { token, created, previous: { token: old, retired } };
}

/** The tokens `text` holds, or undefined when it is not the file the hub writes. */
function parseTokens(text: string): Tokens | undefined {
  const file = Option.getOrUndefined(parseObject(text));
  const page = heldOf(asObject(file?.["page"]));
  const stop = heldOf(asObject(file?.["stop"]));

  return page === undefined || stop === undefined ? undefined : { page, stop };
}

/** The file's tokens, or why the hub does not trust it. Opened without following a symlink, and checked on the
 * descriptor it is read from, so what is checked is what is read. */
function readTrusted(path: string, uid: number | undefined): Tokens | { readonly why: string } {
  let fd: number | undefined;

  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (cause: unknown) {
    const code = cause instanceof Error && "code" in cause ? String(cause.code) : "";

    return { why: code === "ELOOP" ? "a symlink" : code === "ENOENT" ? "missing" : `unreadable: ${strerror(cause)}` };
  }

  try {
    const st = fstatSync(fd);

    if (!st.isFile()) return { why: "not a regular file" };

    if ((st.mode & 0o777) !== 0o600) return { why: `mode 0${(st.mode & 0o777).toString(8).padStart(3, "0")}, not 0600` };

    if (uid !== undefined && st.uid !== uid) return { why: `owned by uid ${String(st.uid)}, not ${String(uid)}` };
    const tokens = parseTokens(readFileSync(fd, "utf8"));

    return tokens ?? { why: "malformed" };
  } catch (cause: unknown) {
    return { why: `unreadable: ${strerror(cause)}` };
  } finally {
    closeSync(fd);
  }
}

/** Write `text` to `path`, 0600, through a temp file of its own beside it and a rename: a reader sees the old file or
 * the new one, and a symlink at `path` is replaced, never written through. */
function writePrivate(path: string, text: string): void {
  makePrivateDir(dirname(path));
  const scratch = `${path}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(scratch, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);

  try {
    try {
      fchmodSync(fd, 0o600);
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    renameSync(scratch, path);
  } catch (cause: unknown) {
    try {
      unlinkSync(scratch);
    } catch {
      // already gone
    }

    throw cause;
  }
}

/** The tokens of one hub process. */
export class HubTokens {
  private tokens: Tokens;
  private readonly path: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  private constructor(path: string, now: () => number, log: (line: string) => void, tokens: Tokens) {
    this.path = path;
    this.now = now;
    this.log = log;
    this.tokens = tokens;
  }

  /** The tokens at `path` (`tokensPath`), made or replaced when the hub cannot trust them, then rotated when due.
   * `uid` is the owner the file must have (this process's, by default); `log` hears why a file was replaced or could
   * not be written, never a token. A file that cannot be written leaves the tokens in memory, for this process. */
  static open(path: string, now: () => number, options: { readonly uid?: number | undefined; readonly log?: ((line: string) => void) | undefined } = {}): HubTokens {
    const log = options.log ?? (() => {});
    const read = readTrusted(path, options.uid ?? process.getuid?.());

    if ("why" in read) {
      const made: Tokens = { page: fresh(now()), stop: fresh(now()) };
      const store = new HubTokens(path, now, log, made);

      if (read.why !== "missing") log(`hub: ${path} is not trusted (${read.why}): new page and Stop tokens; pages open before are told to reload`);
      store.save();

      return store;
    }

    const store = new HubTokens(path, now, log, read);
    store.rotate();

    return store;
  }

  /** The token a page served now gets. */
  current(kind: TokenKind): string {
    this.rotate();

    return this.tokens[kind].token;
  }

  /** The tokens an answer may carry now: the current one, then the one it replaced while that is in its grace. */
  accepted(kind: TokenKind): readonly string[] {
    this.rotate();
    const held = this.tokens[kind];
    const previous = held.previous;

    return previous !== undefined && this.now() - previous.retired < TOKEN_GRACE_MS ? [held.token, previous.token] : [held.token];
  }

  /** Each token older than {@link TOKEN_ROTATE_MS} replaced, the old one kept for its grace, which runs from when it
   * was due (`created` + {@link TOKEN_ROTATE_MS}), not from when it was checked; and the file written when one was. A
   * token made later than now (a clock set back) is 0 old: a step back never rotates, unless the token was made more
   * than {@link TOKEN_ROTATE_MS} ahead of now, which would otherwise hold it for as long as the clock takes to catch up;
   * that one is replaced, and kept {@link TOKEN_GRACE_MS} from now. */
  private rotate(): void {
    const at = this.now();
    let changed = false;
    const next: Record<TokenKind, Held> = { ...this.tokens };

    for (const kind of KINDS) {
      const held = this.tokens[kind];

      if (Math.max(0, at - held.created) > TOKEN_ROTATE_MS || held.created - at > TOKEN_ROTATE_MS) {
        const retired = Math.min(at, held.created + TOKEN_ROTATE_MS);

        next[kind] = at - retired < TOKEN_GRACE_MS ? { ...fresh(at), previous: { token: held.token, retired } } : fresh(at);
        changed = true;
      } else if (held.previous !== undefined && at - held.previous.retired >= TOKEN_GRACE_MS) {
        next[kind] = { token: held.token, created: held.created };
        changed = true;
      }
    }

    if (!changed) return;
    this.tokens = next;
    this.save();
  }

  private save(): void {
    try {
      writePrivate(this.path, `${dumps(this.tokens, { indent: 2 })}\n`);
    } catch (cause: unknown) {
      this.log(`hub: cannot write ${this.path} (${strerror(cause)}): the page and Stop tokens hold only until the hub restarts`);
    }
  }
}
