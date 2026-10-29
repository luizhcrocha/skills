/**
 * A line written to a Claude Code session through the socket its cross-session messaging listens on: the
 * one way the fleet reaches a session that is not reading its chat (onepw.ts, chat/hub-line.ts).
 *
 * Whom it writes to is checked before every write ({@link deliverTo}, host.ts `reach`): the registry entry's
 * process runs, is Claude Code, started when the entry says, and holds the socket named after it. A live pid
 * and a socket file are not that.
 *
 * {@link wakeText} is the line the office host writes to a session whose chat watch is not running (fleet-ship
 * apps/host/src/session-wake.ts keeps a copy, and the Stop guard in hooks/tstack-hook.py names its command).
 *
 * Measured on Linux with Claude Code 2.1.296 (2026-10-12): the socket is
 * `$XDG_RUNTIME_DIR/cc-socks/<pid>.sock`, `<pid>` the session's `claude` process, the pid a registry entry
 * records; one line of JSON and a close start a turn in an idle session within 2 s, with no token asked of
 * the sender; a line written while a turn runs is queued and runs as a turn of its own; the socket answers
 * nothing, so a connect and a write that succeed are all the sender knows; the session reads the line as
 * `Another Claude session sent a message: ...`, never as its user. Read in the binary and its docs, not
 * measured: the Mac's directory (`/private/tmp/cc-socks-<uid>`, else `/private/tmp/cc-socks`), an inbox of at
 * most 50 lines that rate-limits repeats, a receiver in a bypass-permissions mode holding a peer's message
 * for approval, no socket for a `--bare` session. The line's format is the binary's debug hint, not its
 * documented interface: a release may change it.
 */
import { createConnection } from "node:net";
import { join } from "node:path";

import { exists, FLEET_BIN } from "./files.ts";
import { PROBE, reach, recordedHost, type Presence, type Probe } from "./host.ts";
import type { Entry } from "./registry.ts";

/** How long a session's socket may take to accept the line. */
const DELIVER_MS = 2000;

/** What a fleet's id and its DIR may hold to be written in the wake: letters, digits, `.`, `_`, `/` and `-`.
 * Nothing that reads as markup, a mention, a label (`SYSTEM:`), a list or a second command. */
const PLAIN = /^[A-Za-z0-9._/-]+$/u;

/**
 * The wake's text: a fixed template, with the fleet's id, its DIR, how many of the user's
 * messages wait and since which, and the command that arms the watch, the one the Stop guard names
 * (`watch_command` and `DEAF` in hooks/tstack-hook.py: keep the two the same). No word of anyone's message, no
 * mention, nothing to do but arm the watch. An Error when the id or the DIR cannot be written plainly.
 */
export function wakeText(fleet: string, dir: string, role: string, unread: number, seen: number): string | Error {
  if (!PLAIN.test(fleet) || !PLAIN.test(dir)) return new Error("the fleet's id or its folder cannot be written in a plain command");

  return (
    `[hub] ${fleet} (${dir}): the chat watch is not running and ${String(unread)} message(s) from the user wait unread since #${String(seen)}. ` +
    `Arm it as a background command (run_in_background: true, timeout: 3300000): \`${FLEET_BIN} chat ${dir} watch --as ${role} --all --resume --once\`; it prints them first.`
  );
}

/** The one line a session's socket takes for `text`. */
export function lineOf(text: string): string {
  return `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`;
}

/** The folder of the sessions' sockets: `FLEET_CC_SOCKS` when set (the tests'), else Claude Code's own:
 * `$XDG_RUNTIME_DIR/cc-socks` (`/run/user/<uid>/cc-socks`); on the Mac `/private/tmp/cc-socks-<uid>`, else
 * `/private/tmp/cc-socks` (the Mac's is read in the binary, not measured). */
export function socksDir(env: (name: string) => string | undefined): string {
  const given = env("FLEET_CC_SOCKS");

  if (given !== undefined && given !== "") return given;
  const uid = String(process.getuid?.() ?? "");

  if (process.platform === "darwin") return exists(`/private/tmp/cc-socks-${uid}`) ? `/private/tmp/cc-socks-${uid}` : "/private/tmp/cc-socks";
  const runtime = env("XDG_RUNTIME_DIR");

  return join(runtime !== undefined && runtime !== "" ? runtime : `/run/user/${uid}`, "cc-socks");
}

/** The socket of the session process `pid` in `socks`. */
export function socketOf(socks: string, pid: number): string {
  return join(socks, `${String(pid)}.sock`);
}

/** Why a connection failed, in words. */
function reasonOf(cause: Error & { readonly code?: string }): string {
  if (cause.code === "ENOENT") return "the session has no socket";

  if (cause.code === "ECONNREFUSED") return "the session's socket refused the connection";

  return `the session's socket failed (${cause.code ?? cause.message})`;
}

/**
 * Write `text` to the session socket at `path`: connect, one line of JSON ({@link lineOf}), close. Undefined
 * when the line was written; else why not, in words. The socket answers nothing, so a written line is all
 * that is known: whether a turn began is seen later, when the watch runs again or it does not.
 */
export function deliver(path: string, text: string, timeoutMs: number = DELIVER_MS): Promise<string | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ path });

    const finish = (why: string | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(why);
    };

    const timer = setTimeout(() => finish("the session's socket did not take the line in time"), timeoutMs);
    socket.once("error", (cause) => finish(reasonOf(cause)));
    socket.once("connect", () => socket.end(lineOf(text), () => finish(undefined)));
  });
}

/** How a wake is written: {@link deliver}, or a test's own. */
export type Send = (path: string, text: string) => Promise<string | undefined>;

/** Whether the session hosting `entry`'s fleet can be written to in `socks` (host.ts `reach`). */
function reachOf(entry: Entry, socks: string, probe: Probe): Presence {
  const host = recordedHost(entry);

  return reach(host, host === undefined ? undefined : socketOf(socks, host.pid), probe);
}

/** What a verified write did: the line was written; or it was not, and why; or the machine did not say
 * whether the session is there (`unknown`), and nothing was tried. */
export type Delivered = { readonly written: true } | { readonly written: false; readonly unknown: boolean; readonly why: string };

/**
 * Write `text` to the socket of the session that hosts `entry`'s fleet, when that session is there: its
 * process is the Claude Code session the entry names and the socket is its own (host.ts `reach`, asked here,
 * at the write).
 */
export async function deliverTo(entry: Entry, socks: string, text: string, send: Send = deliver, probe: Probe = PROBE): Promise<Delivered> {
  const host = recordedHost(entry);
  const there = reachOf(entry, socks, probe);

  if (there.is !== "there" || host === undefined) return { written: false, unknown: there.is === "unknown", why: there.is === "there" ? "the registry names no process for it" : `the session is ${there.is === "gone" ? "gone" : "not known to be there"}: ${there.why}` };
  const failed = await send(socketOf(socks, host.pid), text);

  return failed === undefined ? { written: true } : { written: false, unknown: false, why: failed };
}

