/**
 * A launcher in memory, for `fleet team`'s tests: sessions with tabs and agents, every call recorded. A tab that
 * starts an agent sees it working, or asking when it blocks at its start; `settle` lets it finish (ready). Each session instance has its own handle, so a
 * session seeded again (after a reboot) is not the one `open` started. Sessions not this fake's own are given with
 * {@link FakeLauncher.seed}.
 */
import type { Why } from "../src/team/agents.ts";
import type { Blocked, Handle, Launch, Launcher, Look, Opened, Seen, Tab } from "../src/team/launcher.ts";

interface Held {
  tabs: Tab[];
  agents: Seen[];
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
  /** The agents whose start blocks on a prompt in their tab (a new folder's trust question) until {@link answer}. */
  readonly blockAtStart = new Set<string>();
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

  sessions(): readonly string[] {
    return [...this.held.keys()];
  }

  open(name: string, cwd: string): Opened {
    this.calls.push(`open ${name} ${cwd}`);

    if (this.held.has(name)) return { started: undefined };
    const instance = this.instance(name);
    this.held.set(name, { tabs: [], agents: [], instance });

    return { started: instance };
  }

  owns(name: string, handle: Handle): boolean {
    return this.held.get(name)?.instance === handle;
  }

  tab(session: string, launch: Launch): Tab | Blocked | Why {
    const held = this.held.get(session);

    if (held === undefined) return { why: `no session ${session}` };
    const n = this.next++;
    const tab = { handle: `w1:t${String(n)}`, label: launch.label };
    this.calls.push(`tab ${session} ${launch.label}`);
    held.tabs.push(tab);
    this.launches.set(tab.handle, launch);
    const blocked = this.blockAtStart.has(launch.agent.name);
    held.agents.push({ name: launch.agent.name, tab: tab.handle, status: blocked ? "asking" : "working" });

    return blocked ? { blocked: tab } : tab;
  }

  /** The user answers the prompt agent `agent` blocked on in `session`: it is ready. */
  answer(session: string, agent: string): void {
    const held = this.held.get(session);

    if (held !== undefined) held.agents = held.agents.map((a) => (a.name === agent ? { ...a, status: "ready" } : a));
  }

  prompt(session: string, agent: string, text: string): Why | undefined {
    this.calls.push(`prompt ${session} ${agent}`);
    this.prompts.push(`${agent}: ${text}`);

    return undefined;
  }

  look(session: string): Look | Why {
    const held = this.held.get(session);

    return held === undefined ? { why: `no session ${session}` } : { tabs: [...held.tabs], agents: [...held.agents] };
  }

  settle(session: string, agent: string): Why | undefined {
    this.calls.push(`settle ${session} ${agent}`);
    const held = this.held.get(session);

    if (held !== undefined) held.agents = held.agents.map((a) => (a.name === agent ? { ...a, status: "ready" } : a));

    return undefined;
  }

  close(session: string, tab: Handle): Why | undefined {
    this.calls.push(`close ${session} ${tab}`);
    const held = this.held.get(session);

    if (held === undefined) return { why: `no session ${session}` };
    held.tabs = held.tabs.filter((t) => t.handle !== tab);
    held.agents = held.agents.filter((a) => a.tab !== tab);

    return undefined;
  }

  end(name: string, handle: Handle): Why | undefined {
    this.calls.push(`end ${name}`);

    if (!this.owns(name, handle)) return { why: `session ${name} is not the instance fleet team started` };
    this.held.delete(name);

    return undefined;
  }

  attach(name: string): number {
    this.calls.push(`attach ${name}`);

    return 0;
  }
}
