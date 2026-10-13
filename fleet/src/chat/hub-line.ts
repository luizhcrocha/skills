/**
 * One line of the hub's for a fleet's host, sent by a command as it happens (a refusal draft the plugin's
 * hook recorded: ledger/refusal-draft.ts). It goes the way the hub's 1Password notice goes (onepw.ts
 * `settle`, SPEC.md "Who is told, and how"): into the fleet's chat while the host's watch runs, where a
 * `--once` watch wakes on it; into the host's session when no watch runs (wake.ts `deliverTo`, the one
 * verified way to a session's socket), since a chat nobody watches wakes nobody; and into the chat when the
 * session does not take it, where the next watch armed prints it first.
 */
import { stampOf } from "../clock.ts";
import { strerror } from "../files.ts";
import { PROBE, type Probe } from "../host.ts";
import { HUB_NAME } from "../registry.ts";
import { deliver, deliverTo, socksDir, type Delivered, type Send } from "../wake.ts";
import type { Machine } from "../world.ts";
import { hostOf, watchLive } from "./chat.ts";
import { appendLocked } from "./store.ts";

/** Where a line went: the chat (as message `id`) or the host's session; or why neither took it. */
export type ToldHost = { readonly via: "chat"; readonly to: string; readonly id: number } | { readonly via: "session"; readonly to: string } | { readonly via: "nowhere"; readonly to: string; readonly why: string };

/** How a session's socket is reached: the machine's own unless a test says. */
export interface HostReach {
  readonly send?: Send;
  readonly probe?: Probe;
}

function post(machine: Machine, root: string, to: string, text: string): ToldHost {
  try {
    const stored = appendLocked(root, (_known, nextId) => ({ id: nextId, at: stampOf(machine.now()), from: HUB_NAME, to: [to], text, re: null, parts: [{ text }] }));

    return stored instanceof Error ? { via: "nowhere", to, why: stored.message } : { via: "chat", to, id: stored.id };
  } catch (cause: unknown) {
    return { via: "nowhere", to, why: strerror(cause) };
  }
}

/** A line that reached nobody because the way to the host failed: it is said so, never thrown. */
function unreached(root: string, cause: unknown): ToldHost {
  let to = "host";

  try {
    to = hostOf(root);
  } catch {
    // The ledger cannot be read either: the host goes unnamed.
  }

  return { via: "nowhere", to, why: strerror(cause) };
}

/**
 * Tell the host of the fleet at `root` the line `text`. A fleet the registry does not serve, or whose host's
 * watch runs, is told in its chat, at once (no promise); any other in its session, and in its chat when the
 * session did not take the line. It never throws and never rejects: a registry, a chat or a session that
 * fails is `nowhere` with why, so the caller never says the host was told when it was not.
 */
export function tellHost(machine: Machine, root: string, text: string, reach: HostReach = {}): ToldHost | Promise<ToldHost> {
  try {
    const told = reachHost(machine, root, text, reach);

    return told instanceof Promise ? told.catch((cause: unknown) => unreached(root, cause)) : told;
  } catch (cause: unknown) {
    return unreached(root, cause);
  }
}

function reachHost(machine: Machine, root: string, text: string, reach: HostReach): ToldHost | Promise<ToldHost> {
  const to = hostOf(root);
  const entry = machine.registry.find(root);
  const watched = entry !== undefined && watchLive(machine, root);

  if (entry === undefined || watched) {
    const stored = post(machine, root, to, text);

    if (stored.via !== "nowhere" || entry === undefined) return stored;
  }

  return deliverTo(entry, socksDir(machine.env), text, reach.send ?? deliver, reach.probe ?? PROBE)
    .catch((cause: unknown): Delivered => ({ written: false, unknown: false, why: strerror(cause) }))
    .then((sent): ToldHost => {
      if (sent.written) return { via: "session", to };

      // The chat was tried first while its watch ran, and refused: nothing is left to try.
      if (watched) return { via: "nowhere", to, why: `its chat could not be written, and ${sent.why}` };
      const stored = post(machine, root, to, text);

      return stored.via === "nowhere" ? { via: "nowhere", to, why: `${sent.why}; its chat: ${stored.why}` } : stored;
    });
}

/** What a command prints of a line it sent. */
export function toldWords(told: ToldHost): string {
  if (told.via === "chat") return `told the ${told.to} in its chat (#${String(told.id)})`;

  if (told.via === "session") return `told the ${told.to} in its session (its chat watch is not running)`;

  return `could not tell the ${told.to}: ${told.why}`;
}
