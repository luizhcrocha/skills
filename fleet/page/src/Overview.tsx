/**
 * The Decisions view, the page's first: the card that asks to unlock 1Password while it is locked, what
 * waits on the viewer said in a sentence (with what is stuck,
 * the goal, the Now line and the glance under it), the decisions in three lists, what was done under the
 * viewer's standing approvals and the approvals, the fleet's totals, and on
 * a manager's page the plan's usage.
 */
import { createMemo, createSignal, flush } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { Approvals } from "./Approvals.tsx";
import { Pill, PillAs, RefTag, usePage, When, Who, tf } from "./bits.tsx";
import { Core, type Deaf, type Decision, type Json, type Lookup, type Message } from "./core.ts";
import { Refs, RefsBeside } from "./DecisionRef.tsx";
import { CodeBlock } from "./Rich.tsx";
import { clock, dayTime, fmtDur, fmtInt, fmtShort, spentWords } from "./format.ts";
import { keyed } from "./model.ts";
import { ALL, held, narrow, scopes, type Scope } from "./scope.ts";

/** What each kind of decision asks for. */
export const KIND_WORDS: Lookup = { decision: "a choice", input: "your input", secret: "a secret", action: "something to do", grill: "a grilling", permission: "a permission", notice: "done under your approval" };

/** A decision's state as a pill (or two). */
export function StatePill(props: { readonly d: Decision; readonly pending: ReturnType<typeof Core.pendingAnswer> }): JSX.Element {
  const { m } = usePage();
  const grill = createMemo(() => (props.d.kind === "grill" ? Core.grillState(props.d, m.messages()) : null));

  return (
    <>
      {(() => {
        const d = props.d;
        const pending = props.pending;

        if (d.status !== "open") return <Pill s={d.status} />;
        const failed = d.kind === "action" && pending && Core.failedAnswer(d, [pending.answer]);

        if (failed) return <PillAs cls="blocking" text={"failed: " + Core.failureWords(failed)} />;

        if (Core.isHeld(d)) return <PillAs cls="held" text="with the fleet" />;
        const g = grill();

        if (g) return g.toAnswer ? <PillAs cls="open" text={`${g.toAnswer} to answer`} /> : <PillAs cls="held" text={g.answered ? "answered, waiting to be recorded" : "answers sent"} />;

        if (pending) {
          return (
            <PillAs
              cls={pending.replies.length ? "open" : "held"}
              text={pending.replies.length ? "the " + m.host() + " replied" : Core.unreadBy(m.state.hearing, pending.answer) ? "answered, not read yet" : "answered, waiting on the " + m.host()}
            />
          );
        }

        if (d.asks === "manager") {
          return (
            <>
              <PillAs cls="" text="with the manager" />
              {d.blocking ? <PillAs cls="blocking" text="blocks work" /> : null}
            </>
          );
        }

        return d.blocking ? <PillAs cls="blocking" text="blocks work" /> : <PillAs cls="open" text="open" />;
      })()}
    </>
  );
}

/** Where a decision came from, in words: its step and the worker it is for. */
export function originText(m: ReturnType<typeof usePage>["m"], d: Decision): string {
  return [d.step || "", d.agent && m.person(d.agent) ? (m.person(d.agent)?.name ?? "") : ""].filter(Boolean).join(", ");
}

/** The card as the lead counts it: one action of the user's that blocks work. */
const UNLOCK = { status: "open", asks: "user", blocking: true, kind: "action" } as const;

/**
 * While 1Password is locked on the machine: the card that asks the user to unlock it, the same on every
 * page, above everything else that waits. It reads as an action of the user's, though no decision holds it:
 * it shows from the machine's state, and it goes when that state does. The user clears the lock by running
 * `fleet secrets unlocked` in his own terminal, which tells each held fleet; no page answers for him. Cleared
 * and then seen locked again, it is the same card, asked since the same moment, marked "still locked".
 */
function Unlock(): JSX.Element {
  const { m } = usePage();

  return (
    <Show when={m.state.onepw}>
      {(o) => (
        <div class="part" id="onepw">
          <div class="card">
            <div class="ask open blocking">
              <span class="ask-head">
                <b>Unlock 1Password</b>
                <PillAs cls="blocking" text="blocks work" />
                <Show when={o().again}>
                  <PillAs cls="warning" text="still locked" />
                </Show>
                <PillAs cls="plain" text={KIND_WORDS["action"] ?? ""} />
              </span>
              <span class="detail">1Password, here or on the machine you are connected from, is refusing commands: {o().why}. Unlock the app, then run the command below in your terminal, outside Claude Code: it tells each fleet that waits.</span>
              <Show when={o().again}>{(again) => <span class="detail onepw-again">It was cleared and a command failed again {m.ago(again())}.</span>}</Show>
              <For each={o().waiting} keyed={(w) => w.who}>
                {(w) => (
                  <span class="detail onepw-waits">
                    Waiting: <b>{w().who}</b>, for {w().what}.
                  </span>
                )}
              </For>
              <span class="meta">Asked {m.ago(o().since)}. Every fleet holds its commands that need 1Password until then, and goes on with the rest.</span>
              <div id="onepw-run">
                <CodeBlock lang="nu" text="fleet secrets unlocked" />
              </div>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

/**
 * A fleet whose host does not listen while the user's messages wait, in the stuck band: since when, how many
 * wait, when the hub woke its session and how that ended, in the hub's facts and the page's words
 * (`Core.deafWords`). "Wake now" asks the hub for one wake at once; `fleet` names the fleet on a manager's
 * page and is empty on the fleet's own. A session that is gone has nothing to wake, so no button; while the
 * hub holds the button (`Core.wakeButton`), it is disabled and says how long is left.
 */
function DeafRow(props: { readonly fleet: string; readonly deaf: Deaf }): JSX.Element {
  const { m } = usePage();
  const [said, setSaid] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const denied = (): string => (m.chatWritable() ? "" : m.chatAvailable() ? m.write().reason || "Read-only here." : "This copy of the page has no server to send this to.");
  const stands = createMemo(() => Core.wakeButton(props.deaf, m.tick()));

  async function wake(): Promise<void> {
    if (!m.chatWritable() || busy() || stands().disabled) return;
    setBusy(true);
    setSaid("");

    try {
      const res = await fetch("wake", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(props.fleet ? { fleet: props.fleet } : {}) });
      // SAFETY: the page's server answers {woken, fleet, at} or {error} (with `again` when it holds the wake); anything else shows as its status.
      const body = (await res.json().catch(() => ({}))) as { readonly error?: string };

      setSaid(res.ok ? "Woken now." : (body.error ?? `the page's server answered ${String(res.status)}`));
    } catch {
      setSaid("the page's server did not answer");
    }

    setBusy(false);
  }

  return (
    <li class="deaf-row" data-deaf={props.fleet || "here"}>
      <Show when={props.fleet}>
        <a href={m.fleetPage(props.fleet)}>{props.fleet}</a>:{" "}
      </Show>
      <span class="deaf-words">{Core.deafWords(props.deaf, clock)}</span>{" "}
      <Show when={props.deaf.end !== "gone"}>
        <button type="button" class="btn wake-now" disabled={!m.chatWritable() || busy() || stands().disabled} title={denied() || stands().title || undefined} onClick={() => void wake()}>
          {busy() ? "Waking…" : stands().label}
        </button>
      </Show>
      <Show when={said()}>
        {" "}
        <span class="meta wake-said" role="status">
          {said()}
        </span>
      </Show>
    </li>
  );
}

/** The sentence the page opens with, and what is stuck above it. */
function Lead(): JSX.Element {
  const { m } = usePage();

  const lead = createMemo(() => {
    const msgs: readonly Message[] = m.messages();
    const every = m.everyDecision();
    const waits = every.filter((d) => Core.awaiting(d, msgs));
    // The card that asks to unlock 1Password is one more action that waits, and it blocks work.
    const l = Core.leadOf(m.state.onepw ? [UNLOCK, ...waits] : waits);
    const away = every.filter((d) => d.status === "open" && d.asks !== "manager" && !Core.isNotice(d) && !Core.awaiting(d, msgs));
    const held = away.filter((d) => Core.isHeld(d));
    const sent = away.length - held.length;

    const detail = [
      sent ? `${sent === 1 ? "Your answer waits" : String(sent) + " answers wait"} to be recorded.` : "",
      held.length ? `${Core.kindCount(held, ["is", "are"])} with the fleet, back to you when it is ready.` : "",
    ]
      .filter(Boolean)
      .join(" ");

    return detail && l.tone === "clear" ? { ...l, detail } : l;
  });

  const stuck = createMemo(() => Core.stuckOf(m.state, m.state.coordinators, m.messages(), m.tick()));
  /* A Now line nobody said again stays on the page greyed, and what the log says last comes under it. */
  const nowStale = createMemo(() => Core.staleNow(m.state.now_at, m.tick()));
  const latest = createMemo(() => (nowStale() ? m.state.events.filter((e) => e.kind !== "spawned").slice(-2).reverse() : []));

  const closed = createMemo(() =>
    Core.closedInNow(
      m.state.now,
      m.state.decisions,
      Object.fromEntries(m.state.coordinators.map((c) => [c.id, c.index.filter((x) => x["group"] === "decisions").map((x) => ({ ref: String(x["ref"] ?? ""), title: String(x["title"] ?? ""), status: String(x["hint"] ?? "") }))])),
    ),
  );

  const glance = createMemo(() => Core.glanceOf(m.state));
  const more = (x: { readonly more: number }): string => (x.more ? `, and ${x.more} more` : "");

  return (
    <div class={"lead " + lead().tone} id="lead">
      <Show when={stuck().length}>
        <div class="stuck" role="status">
          <h3>Stuck</h3>
          <ul>
            <For each={keyed(stuck(), (r) => `${r.fleet}|${r.what}|${r.ref}|${r.id ?? ""}|${r.title}`)} keyed={(x) => x.key}>
              {(x) => {
                const r = () => x().row;

                const href = (): string => {
                  const row = r();

                  return row.agent ? "#agent-" + encodeURIComponent(row.agent) : row.id ? m.cardHref(row.fleet ? row.fleet + "/" + row.id : row.id) : row.fleet ? m.fleetPage(row.fleet) : "";
                };

                const name = (): JSX.Element => (
                  <>
                    {r().fleet ? r().fleet + " " : ""}
                    <Show when={r().ref}>
                      <span class="ref">{r().ref}</span>{" "}
                    </Show>
                    {r().title}
                  </>
                );

                const who = (): string => (r().fleet ? "coordinator" : m.host());

                const why = (): string =>
                  r().what === "worker silent"
                    ? `The ledger says it runs, but it has written nothing. The ${who()} should ask it where it stands.`
                    : r().what === "chat not read"
                      ? `The ${who()} is not reading; tell it in its session.`
                      : `The ${who()} has it and has not acted; tell it in its session if it stays.`;

                // What the hub says whole: a change of host.
                const told = (): string => {
                  const row = r();

                  return row.takeover ? Core.takeoverWords(row.takeover, clock) : "";
                };

                return (
                  <Show
                    when={r().deaf}
                    fallback={
                      <Show
                        when={told()}
                        fallback={
                          <li>
                            <Show when={href()} fallback={name()}>
                              <a href={href()}>{name()}</a>
                            </Show>
                            : {r().what === "answer not recorded" ? `${Core.kindWord(r().kind)} answered, not recorded` : r().what}, {m.ago(r().since)}. {why()}
                          </li>
                        }
                      >
                        <li class="hub-told" data-told="takeover" data-fleet={r().fleet || "here"}>
                          <Show when={r().fleet}>
                            <a href={m.fleetPage(r().fleet)}>{r().fleet}</a>:{" "}
                          </Show>
                          {told()}
                        </li>
                      </Show>
                    }
                  >
                    {(deaf) => <DeafRow fleet={r().fleet} deaf={deaf()} />}
                  </Show>
                );
              }}
            </For>
          </ul>
        </div>
      </Show>
      <h2 class="lead-line">{lead().headline}</h2>
      <Show when={lead().detail}>
        <p class="lead-detail">{lead().detail}</p>
      </Show>
      <p class="goal">
        <Refs text={m.state.goal} />
      </p>
      <p class={"now" + (nowStale() ? " stale" : "")}>
        <b>Now</b>
        <Refs text={m.state.now} />{" "}
        <span class="said">{nowStale() ? `not updated for ${m.ago(m.state.now_at || m.state.started).replace(/ ago$/u, "")}` : `said ${m.ago(m.state.now_at)}`}</span>
      </p>
      <Show when={closed().length}>
        <p class="now-wrong" role="status">
          The Now line names{" "}
          <For each={closed()} keyed={false}>
            {(c, i) => (
              <>
                {i ? "; " : ""}
                {c().fleet ? c().fleet + " " : ""}
                <span class="ref">{c().ref}</span> ({c().title}), {c().status}
              </>
            )}
          </For>
          : it no longer waits on anyone.
        </p>
      </Show>
      <Show when={glance().running.shown.length || glance().current.shown.length || glance().next.shown.length}>
        <ul class="glance">
          <Show when={glance().running.shown.length}>
            <li>
              <b>Running</b>{" "}
              <For each={glance().running.shown} keyed={(a) => a.id}>
                {(a, i) => (
                  <>
                    {i() ? ", " : ""}
                    <Who id={a().id} />
                    {a().blocked ? " (blocked)" : ""}
                  </>
                )}
              </For>
              {more(glance().running)}
            </li>
          </Show>
          <Show when={glance().current.shown.length}>
            <li>
              <b>Current</b> <Refs text={glance().current.shown.map((st) => `${st.id} ${st.title ?? ""}`).join("; ")} />
              {more(glance().current)}
            </li>
          </Show>
          <Show when={glance().next.shown.length}>
            <li>
              <b>Next</b> <Refs text={glance().next.shown.map((st) => `${st.id} ${st.title ?? ""}`).join("; ")} />
              {more(glance().next)}
            </li>
          </Show>
        </ul>
      </Show>
      <Show when={nowStale() && latest().length}>
        <div class="latest">
          <b>Latest from the log</b>
          <ul>
            <For each={keyed(latest(), (e) => `${e.at}|${e.kind}|${e.text}`)} keyed={(x) => x.key}>
              {(x) => (
                <li>
                  <When at={x().row.at} relative /> {x().row.agent ? m.nameOf(x().row.agent ?? "") + ": " : ""}
                  <Refs text={String(x().row.text).slice(0, 220)} />
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
      <p class="meta">
        Started {m.ago(m.state.started)}, updated {m.ago(m.state.updated)}.
      </p>
    </div>
  );
}

/**
 * On a manager's page, a chip per agent with an open decision: one pressed at a time narrows the lists and
 * their counts. Kept per browser; a scope with nothing open left is all again, and stays so if it returns.
 */
function useScope() {
  const { m } = usePage();
  const list = createMemo(() => (m.managed() ? scopes(m.everyDecision()) : []));
  const [chosen, setChosen] = createSignal<Json>(m.prefs.get<Json>("d-scope", ALL));
  const scope = createMemo(() => held(list(), chosen()));
  const [cursor, setCursor] = createSignal<string | null>(null);
  let bar: HTMLDivElement | undefined;

  const choose = (key: string): void => {
    setChosen(key);
    m.prefs.set("d-scope", key);
  };

  const settle = (): void => {
    if (chosen() !== scope()) choose(scope());
  };

  settle();
  m.onState(settle);

  const keys = (): string[] => [ALL, ...list().map((s) => s.key)];
  const tabStop = (): string => (keys().includes(cursor() ?? "\0") ? (cursor() ?? ALL) : scope());
  const label = (s: Scope): string => (s.agent === null ? "no agent" : s.fleet ? s.agent : m.nameOf(s.agent));

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && scope() !== ALL) {
      e.preventDefault();
      choose(ALL);

      return;
    }

    const all = keys();
    const at = all.indexOf(tabStop());
    const to = { ArrowRight: at + 1, ArrowDown: at + 1, ArrowLeft: at - 1, ArrowUp: at - 1, Home: 0, End: all.length - 1 }[e.key];

    if (to === undefined) return;
    e.preventDefault();
    const i = (to + all.length) % all.length;
    setCursor(all[i] ?? ALL);
    flush();
    bar?.querySelectorAll("button")[i]?.focus();
  };

  const chip = (key: string, name: string, count: number): JSX.Element => (
    <button type="button" tabindex={tabStop() === key ? 0 : -1} aria-pressed={tf(scope() === key)} onFocus={() => setCursor(key)} onClick={() => choose(scope() === key ? ALL : key)}>
      {name} <span class="n">{String(count)}</span>
    </button>
  );

  return {
    scope,
    bar: () => (
      <Show when={list().length}>
        <div class="seg small scopes" id="decision-scope" role="toolbar" aria-label="Decisions for" ref={(el) => (bar = el)} onKeyDown={onKeyDown}>
          {chip(
            ALL,
            "All",
            list().reduce((n, s) => n + s.count, 0),
          )}
          <For each={list()} keyed={(s) => s.key}>
            {(s) => chip(s().key, label(s()), s().count)}
          </For>
        </div>
      </Show>
    ),
  };
}

/** The decisions, in three lists: each row opens its page from anywhere on it (its head is the link, stretched
 * over the row), and a reference in its words (refs.ts) is a link of its own above that. */
function DecisionList(): JSX.Element {
  const { m, ui } = usePage();
  const { scope, bar } = useScope();
  const all = createMemo(() => Core.decisionRows(narrow(m.everyDecision(), scope()), ui.seen()).map((r) => ({ ...r, bucket: Core.bucketOf(r.item, m.messages()) })));
  const rows = createMemo(() => all().filter((r) => r.bucket === ui.bucket()));
  const empty = (): string => ({ active: "Nothing waits on you.", waiting: "Nothing is waiting on the fleet.", done: "Nothing decided yet." })[ui.bucket()] ?? "";

  return (
    <div class="part">
      <h2 id="h-decisions" class="vh">
        Decisions
      </h2>
      <div class="seg" id="decision-seg" role="group" aria-label="Show decisions">
        <For each={Core.BUCKETS} keyed={(b) => b[0]}>
          {(b) => (
            <button type="button" data-bucket={b()[0]} aria-pressed={tf(ui.bucket() === b()[0])} onClick={() => ui.setBucket(b()[0])}>
              {b()[1]} <span class="n">{String(all().filter((r) => r.bucket === b()[0]).length)}</span>
            </button>
          )}
        </For>
      </div>
      {bar()}
      <div class="card" id="decision-list">
        <For each={rows()} keyed={(r) => r.item.id} fallback={<p class="empty">{empty()}</p>}>
          {(r) => {
            const d = (): Decision => r().item;
            const open = (): boolean => d().status === "open";
            const waits = (): boolean => r().bucket === "active";

            /* What the row says under its head, in the fleet's words: the question, or where it stands. */
            const detail = (): string => (open() ? (Core.isHeld(d()) ? `With the fleet: ${String(d().held)}` : d().question) : d().status === "decided" ? `Decided: ${d().answer || ""}` : `Withdrawn: ${d().resolution || ""}`);

            const meta = (): string =>
              open()
                ? `${originText(m, d()) ? "From " + originText(m, d()) + ". " : ""}${d().why ? (d().blocking ? "Blocks: " : "Meanwhile: ") + String(d().why) + ". " : ""}Asked ${m.ago(d().opened)}${d().revised ? ", changed " + m.ago(d().revised) : ""}`
                : `${d().status === "decided" && d().resolution ? String(d().resolution) + ". " : ""}Closed ${m.ago(d().closed)}`;

            return (
              <div class={"ask " + (waits() ? "open" : open() ? "held" : "closed") + (waits() && d().blocking ? " blocking" : "")}>
                <a class="ask-head" href={m.cardHref(d())}>
                  <b>
                    <RefTag of={d()} />
                    {d().title}
                  </b>
                  <StatePill d={d()} pending={open() ? Core.pendingAnswer(d(), m.messages()) : null} />
                  <Show when={r().mark && waits()}>
                    <Pill s={r().mark} />
                  </Show>
                  <PillAs cls="plain" text={KIND_WORDS[d().kind] || d().kind} />
                  <Show when={d().fleet}>
                    <PillAs cls="plain" text={"in " + String(d().fleet)} />
                  </Show>
                </a>
                <RefsBeside text={d().title} fleet={d().fleet} />
                <span class="detail">
                  <Refs text={detail()} fleet={d().fleet} />
                </span>
                <span class="meta">
                  <Refs text={meta()} fleet={d().fleet} />
                </span>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

/** One figure of the totals. */
function Total(props: { readonly label: string; readonly value: string | number; readonly cls?: string; readonly title?: string }): JSX.Element {
  return (
    <div class={props.cls || ""} title={props.title}>
      <dd>{props.value}</dd>
      <dt>{props.label}</dt>
    </div>
  );
}

/** The fleet's totals. */
function Tiles(): JSX.Element {
  const { m } = usePage();
  const byStatus = (s: string): number => m.state.agents.filter((a) => a.status === s).length;
  const totalTokens = (): number => m.state.agents.reduce((n, a) => n + a.tokens, 0);
  const openBlocks = (): number => m.state.roadblocks.filter((r) => !r.resolved).length;
  const steps = () => m.state.roadmap.flatMap((x) => x.steps);
  const across = (status: string): number => m.state.coordinators.reduce((n, c) => n + (Number(c.workers[status]) || 0), 0);
  const fleetTokens = (): number => m.state.coordinators.reduce((n, c) => n + c.tokens, totalTokens());
  const theirs = () => m.state.coordinators.filter((c) => c.spent);
  const elapsed = (): string => fmtDur(m.tick() - Date.parse(m.state.started)) || "0 s";

  const own = (): JSX.Element => (
    <Show when={m.state.spent}>{(s) => <Total label={`written by the ${m.host()}`} value={fmtShort(s().output)} title={`The ${m.host()} itself: ${spentWords(s())}`} />}</Show>
  );

  return (
    <dl class="totals" id="tiles">
      <Show
        when={m.managed()}
        fallback={
          <>
            <Total label="running" value={byStatus("running")} />
            <Show when={byStatus("queued")}>
              <Total label="queued" value={byStatus("queued")} />
            </Show>
            <Total label="done" value={byStatus("done")} />
            <Total label="blocked" value={byStatus("blocked")} cls={openBlocks() ? "alert" : ""} title={`${openBlocks()} open roadblock${openBlocks() === 1 ? "" : "s"}`} />
            <Show when={byStatus("failed") + byStatus("stopped")}>
              <Total label="failed or stopped" value={byStatus("failed") + byStatus("stopped")} cls="alert" />
            </Show>
            <Total label="steps done" value={`${steps().filter((s) => s.status === "done").length} of ${steps().length}`} />
            <Total label="workers' tokens" value={fmtShort(totalTokens())} title={fmtInt(totalTokens()) + " across " + String(m.state.agents.length) + " workers, as they reported"} />
            {own()}
            <Total label="elapsed" value={elapsed()} />
          </>
        }
      >
        <Total label="fleets" value={m.state.coordinators.length} />
        <Total label="workers running" value={across("running") + byStatus("running")} />
        <Total label="workers blocked" value={across("blocked") + byStatus("blocked")} cls={across("blocked") ? "alert" : ""} />
        <Total label="roadblocks" value={m.state.coordinators.reduce((n, c) => n + c.roadblocks, openBlocks())} title="open, across the fleets" />
        <Total label="workers' tokens" value={fmtShort(fleetTokens())} title={fmtInt(fleetTokens()) + " across the fleets, as the workers reported"} />
        <Show when={theirs().length}>
          <Total label="written by coordinators" value={fmtShort(theirs().reduce((n, c) => n + (c.spent?.output ?? 0), 0))} title="What the coordinators themselves wrote, from their transcripts" />
        </Show>
        {own()}
        <Total label="elapsed" value={elapsed()} />
      </Show>
    </dl>
  );
}

/**
 * A manager's page shows the plan's usage, as the status line of whichever session worked last saw it,
 * named by that session's account; below it, a line for each other account still inside a window.
 */
function Usage(): JSX.Element {
  const { m } = usePage();
  const rows = createMemo(() => Core.usageOf(m.state.usage, m.now()));
  const others = createMemo(() => Core.usageOthersOf(m.state.usage, m.now()));
  const account = (): string => Core.usageAccountOf(m.state.usage) ?? "Account not recorded";

  const until = (r: ReturnType<typeof Core.usageOf>[number]): string =>
    r.reset ? "has reset since this reading" : r.resetsAt - m.now() < 86400e3 ? "resets in " + fmtDur(r.resetsAt - m.now()) : "resets " + dayTime(r.resetsAt);

  const read = (): number => Math.max(0, ...rows().map((r) => r.readAt));

  return (
    <div class="part" id="usage" hidden={!m.managed()}>
      <h2>Plan usage</h2>
      <div class="card usage" id="usage-list">
        <Show
          when={rows().length}
          fallback={
            <p class="usage-note">
              No reading yet. It appears once a session's status line runs through <code>fleet usage capture</code>.
            </p>
          }
        >
          <p class="usage-account">{account()}</p>
          <For each={rows()} keyed={(r) => r.key}>
            {(r) => (
              <div class={"usage-row " + r().tone}>
                <b>{r().label}</b>
                <span class="figure">{r().percent}% used</span>
                <div class="meter" role="meter" aria-label={r().label} aria-valuemin="0" aria-valuemax="100" aria-valuenow={String(r().percent)}>
                  <span style={`width:${r().percent}%`} />
                </div>
                <span class="meta">{until(r())}</span>
              </div>
            )}
          </For>
          <Show when={read()}>
            <p class="usage-note">Read {m.ago(new Date(read()).toISOString())}, from the status line of the session that worked last.</p>
          </Show>
          <For each={others()} keyed={(o) => o.account ?? ""}>
            {(o) => (
              <p class="usage-other">
                {o().account ?? "Account not recorded"}: {o().rows.map((r) => `${r.short} ${r.percent}%`).join(", ")}
              </p>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}

/** The Decisions view. */
export function Overview(): JSX.Element {
  const { m } = usePage();

  return (
    <section class="view" id="decisions" data-view="decisions" aria-labelledby="h-decisions" hidden={m.place().view !== "decisions"}>
      <Unlock />
      <Lead />
      <DecisionList />
      <Approvals />
      <div class="part">
        <h2 id="h-totals">{m.managed() ? "The fleets" : "The fleet"}</h2>
        <Tiles />
      </div>
      <Usage />
    </section>
  );
}
