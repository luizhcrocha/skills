/**
 * A launcher in memory, for `fleet team`'s tests: sessions with tabs and agents, every call recorded. A tab that
 * starts an agent sees it working; one that blocks at its start stays silent, as Claude Code does before its
 * prompt is up, and is read through rex's rule (rex.ts's statusOf) until answered. An agent's program may end,
 * its tab kept ({@link FakeLauncher.exit}). `settle` lets a working agent finish (ready), says when its program
 * ended, and gives up on a silent one. Each session instance has its own handle, so a session seeded again
 * (after a reboot) is not the one `open` started. Sessions not this fake's own are given with
 * {@link FakeLauncher.seed}. An ending read is a call too. A call named in {@link FakeLauncher.failing} answers as rex does when it cannot say.
 */
import type { Why } from "../src/team/agents.ts";
import type { Blocked, Handle, Launch, Launcher, Look, Opened, Seen, Settled, Shell, ShellTab, Status, Tab } from "../src/team/launcher.ts";
import { statusOf } from "../src/team/rex.ts";

/** What a read says when the launcher cannot say. */
const FAILED: Why = { why: "rex ls: connection reset" };

/** An agent as the fake holds it: its status, or silent while it runs having reported nothing. */
interface Running {
  readonly name: string;
  readonly tab: Handle;
  readonly status: Status | "silent";
}

interface Held {
  tabs: Tab[];
  agents: Running[];
  readonly instance: Handle;
}

/** {@link Launcher} in memory. */
export class FakeLauncher implements Launcher {
  /** Every call, as `<method> <args>`. */
  readonly calls: string[] = [];
  /** The prompts sent, as `<agent>: <text>`. */
  readonly prompts: string[] = [];
  /** The tabs' launches, by tab handle. */
  readonly launches = new Map<string, Launch>();
  /** The cmd tabs opened, as `<session> <label> in <cwd> after <tab>`. */
  readonly shells: string[] = [];
  /** Why a new agent tab cannot be opened, when it cannot. */
  tabFails: string | undefined;
  /** The tabs that cannot be closed, by handle. */
  readonly closeFails = new Set<Handle>();
  /** Why a cmd tab cannot be moved beside its agent's tab, when it cannot: it is left last. */
  moveFails: string | undefined;
  /** The agents whose start blocks on a prompt in their tab (a new folder's trust question) until {@link answer}. */
  readonly blockAtStart = new Set<string>();
  /** The agents whose program ends while a settle waits on them. */
  readonly endWhileSettling = new Set<string>();
  /** The agents whose opening is not sent: their prompt fails, saying so. */
  readonly promptFails = new Set<string>();
  /** How the agents' programs ended, as a look says it. */
  readonly endings = new Map<string, string>();
  /** The reads that cannot answer, by the launcher's method. */
  readonly failing = new Set<"sessions" | "owns" | "look">();
  private readonly held = new Map<string, Held>();
  private next = 1;
  private instances = 0;

  /** Session `name` running with these tabs and agents, as another tool (or a restore) left it. */
  seed(name: string, tabs: readonly Tab[] = [], agents: readonly Seen[] = []): this {
    this.held.set(name, { tabs: [...tabs], agents: [...agents], instance: this.instance(name) });

    return this;
  }

  private instance(name: string): Handle {
    this.instances += 1;

    return `fake:${name}:${String(this.instances)}:${String(Math.random()).slice(2, 8)}`;
  }

  sessions(): readonly string[] | Why {
    return this.failing.has("sessions") ? FAILED : [...this.held.keys()];
  }

  open(name: string): Opened {
    this.calls.push(`open ${name}`);

    if (this.held.has(name)) return { started: undefined };
    const instance = this.instance(name);
    this.held.set(name, { tabs: [], agents: [], instance });

    return { started: instance };
  }

  owns(name: string, handle: Handle): boolean | Why {
    return this.failing.has("owns") ? FAILED : this.held.get(name)?.instance === handle;
  }

  tab(session: string, launch: Launch): Tab | Blocked | Why {
    const held = this.held.get(session);

    if (held === undefined) return { why: `no session ${session}` };

    if (this.tabFails !== undefined) return { why: this.tabFails };
    const n = this.next++;
    const tab = { handle: `w1:t${String(n)}`, label: launch.label };
    this.calls.push(`tab ${session} ${launch.label}`);
    held.tabs.push(tab);
    this.launches.set(tab.handle, launch);
    const blocked = this.blockAtStart.has(launch.agent.name);
    held.agents.push({ name: launch.agent.name, tab: tab.handle, status: blocked ? "silent" : "working" });

    return blocked ? { blocked: tab } : tab;
  }

  shell(session: string, shell: Shell): ShellTab | Why {
    const held = this.held.get(session);

    if (held === undefined) return { why: `no session ${session}` };
    const tab = { handle: `w1:c${String(this.shells.length + 1)}`, label: shell.label };
    this.shells.push(`${session} ${shell.label} in ${shell.cwd} after ${shell.beside}`);
    const at = this.moveFails === undefined ? held.tabs.findIndex((t) => t.handle === shell.beside) : -1;
    held.tabs.splice(at === -1 ? held.tabs.length : at + 1, 0, tab);

    return this.moveFails === undefined ? tab : { ...tab, apart: this.moveFails };
  }

  /** The user answers the prompt agent `agent` blocked on in `session`: it is ready. */
  answer(session: string, agent: string): void {
    this.become(session, agent, "ready");
  }

  /** Agent `agent`'s program in `session` ends, its tab kept. */
  exit(session: string, agent: string): void {
    this.become(session, agent, "ended");
  }

  private become(session: string, agent: string, status: Status): void {
    const held = this.held.get(session);

    if (held !== undefined) held.agents = held.agents.map((a) => (a.name === agent ? { ...a, status } : a));
  }

  prompt(session: string, agent: string, text: string): Why | undefined {
    this.calls.push(`prompt ${session} ${agent}`);
    this.prompts.push(`${agent}: ${text}`);

    return this.promptFails.has(agent) ? { why: "Enter, pressed twice, did not start it: its opening still sits in its input" } : undefined;
  }

  look(session: string): Look | Why {
    if (this.failing.has("look")) return FAILED;
    const held = this.held.get(session);

    if (held === undefined) return { why: `no session ${session}` };

    return { tabs: [...held.tabs], agents: held.agents.map((a): Seen => this.seen(a)) };
  }

  private seen(agent: Running): Seen {
    const seen: Seen = { ...agent, status: agent.status === "silent" ? statusOf(undefined) : agent.status };
    const ending = this.endings.get(agent.name);

    if (agent.status !== "ended" || ending === undefined) return seen;

    return {
      ...seen,
      ended: () => {
        this.calls.push(`ending ${agent.name}`);

        return ending;
      },
    };
  }

  settle(session: string, agent: string): Settled | Why {
    this.calls.push(`settle ${session} ${agent}`);
    const status = this.held.get(session)?.agents.find((a) => a.name === agent)?.status;

    if (status === "silent") return { why: "it was not ready within 10 min" };
    const settled: Settled = status === "ended" || this.endWhileSettling.has(agent) ? "ended" : "ready";
    this.become(session, agent, settled);

    return settled;
  }

  close(session: string, tab: Handle): Why | undefined {
    this.calls.push(`close ${session} ${tab}`);
    const held = this.held.get(session);

    if (held === undefined) return { why: `no session ${session}` };

    if (this.closeFails.has(tab)) return { why: `rex window close ${tab}: busy` };
    held.tabs = held.tabs.filter((t) => t.handle !== tab);
    held.agents = held.agents.filter((a) => a.tab !== tab);

    return undefined;
  }

  end(name: string, handle: Handle): Why | undefined {
    this.calls.push(`end ${name}`);

    const owned = this.owns(name, handle);

    if (owned !== true) return owned === false ? { why: `session ${name} is not the instance fleet team started` } : owned;
    this.held.delete(name);

    return undefined;
  }

  attach(name: string): number {
    this.calls.push(`attach ${name}`);

    return 0;
  }
}
