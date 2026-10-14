/**
 * The seam `fleet team` starts agents through: a place that runs sessions, each holding agents, one per tab. It
 * takes an agent's definition and decides itself how to run it; `fleet team` never sees a command line. herdr
 * (herdr.ts) is the one real adapter; the tests' fake is the other. Rex and Managed Agents would be adapters here
 * too, one file each; none is built. Every method answers or says why it could not, in one sentence.
 */
import type { Agent, Why } from "./agents.ts";

/** An agent's states, in `fleet team`'s words: ready for a prompt, in a turn, waiting on a person, or not known. */
export const STATUSES = ["ready", "working", "asking", "unknown"] as const;

/** One agent's state. */
export type Status = (typeof STATUSES)[number];

/** The adapter's name for a tab or a running session: opaque to `fleet team`, which stores and compares it, and
 * shown to people as it is. */
export type Handle = string;

/** One tab of a session. */
export interface Tab {
  readonly handle: Handle;
  readonly label: string;
}

/** One agent the launcher recognises, by the name it was started with, in tab `tab`. */
export interface Seen {
  readonly name: string;
  readonly tab: Handle;
  readonly status: Status;
}

/** What a session holds now. */
export interface Look {
  readonly tabs: readonly Tab[];
  readonly agents: readonly Seen[];
}

/** What a tab runs: `agent`, in `cwd`, the tab labelled `label`. */
export interface Launch {
  readonly cwd: string;
  readonly label: string;
  readonly agent: Agent;
}

/** A tab whose agent blocked at its start on a prompt in it (in a folder Claude Code has not trusted yet, its trust
 * question): the tab is kept, for the user to answer the prompt; no one answers it for them. */
export interface Blocked {
  readonly blocked: Tab;
}

/** What opening a session did: the handle of the session when this call started it, else undefined (it ran). */
export interface Opened {
  readonly started: Handle | undefined;
}

/** A place that runs agents, as `fleet team` uses one. */
export interface Launcher {
  /** The sessions running now, by name. */
  sessions(): readonly string[] | Why;
  /** Session `name` running, started (in `cwd`) when it was not. */
  open(name: string, cwd: string): Opened | Why;
  /** Whether `handle`, from {@link Launcher.open}, still names the instance of session `name` that runs now. */
  owns(name: string, handle: Handle): boolean;
  /** A new tab in `session` running `launch.agent`, named after it; returns once it is ready for its first prompt,
   * or, its tab kept, once its start blocks on a prompt in it. Any other failure closes the tab. */
  tab(session: string, launch: Launch): Tab | Blocked | Why;
  /** Submit `text` to agent `agent` without waiting for its turn to end. */
  prompt(session: string, agent: string, text: string): Why | undefined;
  /** The tabs and agents of `session`. */
  look(session: string): Look | Why;
  /** Wait, for a bounded time, until agent `agent` is ready; the Why says when it gave up. */
  settle(session: string, agent: string): Why | undefined;
  /** Close tab `tab` of `session`, and what runs in it. */
  close(session: string, tab: Handle): Why | undefined;
  /** Stop session `name`, only while `handle` (from {@link Launcher.open}) still names it; else refuse. */
  end(name: string, handle: Handle): Why | undefined;
  /** Attach this terminal to session `name`; the exit code once it detaches. */
  attach(name: string): number;
}
