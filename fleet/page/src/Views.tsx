/**
 * The views under the masthead, one at a time: Plan (roadmap, roadblocks, held for later), Fleet (a
 * manager's coordinators, the live preview, the workers with their filters, tokens by worker), Links (the
 * preview, pages, dev servers, what else the machine serves) and Log.
 */
import { createEffect, createMemo, createSignal } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { Pill, PillAs, RefTag, usePage, When, Who, tf } from "./bits.tsx";
import { Core, type Agent, type Coordinator, type Decision, type Link, type Preview, type PreviewServer } from "./core.ts";
import { clock, fmtDur, fmtInt, fmtShort, plural, spentWords } from "./format.ts";
import { keyed } from "./model.ts";
import { Rich } from "./Rich.tsx";
import { FILTERS, type Filter } from "./ui.ts";

/** The decisions tied to a step, or to a milestone and no one step, as chips that open them. */
function DecisionChips(props: { readonly list: readonly Decision[] }): JSX.Element {
  const { m } = usePage();

  return (
    <For each={props.list} keyed={(d) => d.id}>
      {(d) => (
        <a class={"dchip " + (Core.awaiting(d(), m.messages()) ? "open" : d().status === "open" ? "held" : "closed")} href={Core.decisionHref(d().id)} title={d().title}>
          {d().ref || d().id}
        </a>
      )}
    </For>
  );
}

/** The roadmap: a step with a worker is a control that opens that worker. */
function Roadmap(): JSX.Element {
  const { m } = usePage();

  return (
    <div class="part" id="roadmap">
      <h2>Roadmap</h2>
      <div class="card" id="roadmap-list">
        <For each={m.state.roadmap} keyed={(x) => x.id} fallback={<p class="empty">No roadmap yet.</p>}>
          {(ms) => (
            <div class="milestone">
              <div class="milestone-head">
                <h3>{ms().title}</h3>
                <DecisionChips list={m.state.decisions.filter((d) => d.milestone === ms().id && !d.step)} />
                <span class="num faint">
                  {ms().steps.filter((s) => s.status === "done").length}/{ms().steps.length}
                </span>
              </div>
              <ol class="steps">
                <For each={ms().steps} keyed={(s) => s.id}>
                  {(s) => {
                    const a = () => m.person(s().agent);
                    const chips = () => m.state.decisions.filter((d) => d.step === s().id);

                    const inner = (): JSX.Element => (
                      <>
                        <span class="dot" />
                        <span class="title">{s().title}</span>
                        <span class="by">{a()?.name ?? ""}</span>
                      </>
                    );

                    return (
                      <li class={chips().length ? "with-chips" : ""}>
                        <Show when={chips().length}>
                          <span class="step-chips">
                            <DecisionChips list={chips()} />
                          </span>
                        </Show>
                        <Show
                          when={a()}
                          fallback={
                            <div class={"step " + String(s().status ?? "")} title={String(s().status ?? "")}>
                              {inner()}
                            </div>
                          }
                        >
                          {(p) => (
                            <button type="button" class={"step " + String(s().status ?? "")} data-agent={s().agent} title={`${String(s().status ?? "")}, open ${p().name}`}>
                              {inner()}
                            </button>
                          )}
                        </Show>
                      </li>
                    );
                  }}
                </For>
              </ol>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

/** The roadblocks: one with a worker opens that worker from anywhere on its card. */
function Roadblocks(): JSX.Element {
  const { m } = usePage();
  const blocks = createMemo(() => [...m.state.roadblocks].sort((a, b) => Number(a.resolved) - Number(b.resolved) || Core.stamp(b.since) - Core.stamp(a.since)));

  return (
    <div class="part" id="roadblocks">
      <h2>Roadblocks</h2>
      <div class="card" id="roadblock-list">
        <For each={blocks()} keyed={(r) => r.id} fallback={<p class="empty">No roadblocks.</p>}>
          {(r) => {
            const ask = () => (!r().resolved && r().decision ? m.decisionById(r().decision) : undefined);

            return (
              <div class={"block " + (r().resolved ? "resolved" : String(r().severity ?? ""))}>
                <div class="block-head">
                  <RefTag of={r()} />
                  <Show when={m.person(r().agent)} fallback={<b>{r().title}</b>}>
                    <button type="button" class="block-title" data-agent={r().agent}>
                      {r().title}
                    </button>
                  </Show>
                  <Pill s={r().resolved ? "done" : r().severity} />
                </div>
                <Rich class="detail" text={r().detail ?? ""} />
                <p class="needs muted">
                  <Show when={!r().resolved} fallback="Resolved">
                    Needs <b>{r().needs}</b>
                  </Show>
                  , {r().agent ? m.nameOf(r().agent ?? "") : m.host()}, since {clock(r().since)}
                </p>
                <Show when={ask()}>
                  {(d) => (
                    <a class="block-link" href={Core.decisionHref(d().id)}>
                      Decide: {d().title}
                    </a>
                  )}
                </Show>
              </div>
            );
          }}
        </For>
      </div>
    </div>
  );
}

/** The Plan view. */
export function PlanView(): JSX.Element {
  const { m } = usePage();

  return (
    <section class="view" id="plan" data-view="plan" aria-label="Plan" hidden={m.place().view !== "plan"}>
      <div class="cols">
        <Roadmap />
        <Roadblocks />
        <div class="part" id="kept" hidden={!m.state.kept.length}>
          <h2>Held for later</h2>
          <div class="card" id="kept-list">
            <For each={m.state.kept} keyed={(k) => k.id}>
              {(k) => (
                <div class="block">
                  <div class="block-head">
                    <b>{k().id}</b>
                  </div>
                  <p class="detail">{k().text}</p>
                  <p class="needs muted">Kept {m.ago(k().at)}</p>
                </div>
              )}
            </For>
          </div>
        </div>
      </div>
    </section>
  );
}

/** A manager's fleets in words: who works, what waits, what it spent. */
function fleetFacts(c: Coordinator): string {
  const yours = c.decisions.filter((d) => d.asks !== "manager");
  const held = c.decisions.length - yours.length;
  const waiting = yours.filter((d) => Core.awaiting(d, []));
  const fleets = yours.filter((d) => Core.isHeld(d));

  const workers = Object.entries(c.workers)
    .filter(([, n]) => Number(n) > 0)
    .map(([status, n]) => `${String(n)} ${status}`)
    .join(", ");

  return (
    [
      workers ? "Workers: " + workers : "No workers yet",
      waiting.length ? `${Core.kindCount(waiting)} on you` : "",
      fleets.length ? `${Core.kindCount(fleets, ["is", "are"])} with the fleet` : "",
      held ? `${held} with the manager` : "",
      c.roadblocks ? plural(c.roadblocks, "open roadblock") : "",
      c.tokens ? "Its workers: " + fmtShort(c.tokens) + " tokens" : "",
      c.spent ? "The coordinator itself: " + spentWords(c.spent) : "",
    ]
      .filter(Boolean)
      .join(". ") + "."
  );
}

/** A manager's fleets: who coordinates what, what each is doing now, what waits in it, and the way to its page. */
function Coordinators(): JSX.Element {
  const { m } = usePage();

  return (
    <div class="part" id="coordinators" hidden={!m.managed()}>
      <h2>Coordinators</h2>
      <p class="meta" id="gate-line">
        {m.state.gate ? `The gate is held by ${m.state.gate.fleet} since ${clock(m.state.gate.since)}: ${m.state.gate.what}.` : "The gate is free: no heavy check is running."}
      </p>
      <div class="card" id="coordinator-list">
        <For each={m.state.coordinators} keyed={(c) => c.id} fallback={<p class="empty">No coordinator is being served on this machine. One appears here when it starts its dashboard.</p>}>
          {(c) => (
            <div class="strip" style={`--c:${m.colorOf(c().id)}`}>
              <div class="strip-head">
                <Who id={c().id} />
                <Pill s={c().status} />
                <Show when={c().name !== c().id}>
                  <span class="muted">{c().name}</span>
                </Show>
              </div>
              <Show when={c().now}>
                <p class="detail">{c().now}</p>
              </Show>
              <p class="meta">{fleetFacts(c())}</p>
              <Show when={c().active}>
                <p class={"meta" + (Core.staleNow(c().active, m.now()) ? " deaf-line" : "")}>Session last active {m.ago(c().active)}</p>
              </Show>
              <Show when={c().hearing && !c().hearing?.on}>
                <p class="meta deaf-line">
                  Not reading its chat
                  {c().hearing?.unread ? `: ${plural(c().hearing?.unread ?? 0, "message")} from you unread since ${clock(c().hearing?.since)}` : ""}
                </p>
              </Show>
              <Show when={c().lanes.length}>
                <p class="meta lane">{c().lanes.join(", ")}</p>
              </Show>
              <Show when={c().url}>
                <a class="block-link" href={c().url}>
                  Open its page
                </a>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

/** A worker filter's choice: a select whose options follow the workers, and whose value the viewer keeps. */
function FilterSelect(props: { readonly id: Filter; readonly label: string; readonly options: readonly (readonly [string, string])[] }): JSX.Element {
  const { ui } = usePage();
  const [el, setEl] = createSignal<HTMLSelectElement>();

  /* After the options change the viewer's choice stands, or "all" when its option is gone. */
  createEffect(
    () => [el(), props.options.map((o) => o[0]).join("\u0000"), ui.filters()[props.id]] as const,
    ([select, , value]) => {
      if (select && select.value !== value) select.value = value;
    },
  );

  return (
    <label>
      {props.label}{" "}
      <select id={props.id} ref={setEl} onInput={(e) => ui.setFilter(props.id, e.currentTarget.value)}>
        <option value="">all</option>
        <For each={props.options} keyed={(o) => o[0]}>
          {(o) => <option value={o()[0]}>{o()[1]}</option>}
        </For>
      </select>
    </label>
  );
}

/** The workers: filters, a table where there is room and a strip per worker where there is not, and the token chart. */
function Workers(props: { readonly rows: () => readonly Agent[] }): JSX.Element {
  const { m, ui } = usePage();
  const uniq = (xs: readonly (string | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => Boolean(x)))];
  const statusOptions = createMemo(() => ["running", "queued", "blocked", "done", "failed", "stopped"].flatMap((s) => (m.state.agents.some((a) => a.status === s) ? [[s, s] as const] : [])));
  const milestoneOptions = createMemo(() => m.state.roadmap.map((x) => [x.id, x.title] as const));
  const skillOptions = createMemo(() => uniq(m.state.agents.map((a) => a.skill)).map((s) => [s, s] as const));
  const modelOptions = createMemo(() => uniq(m.state.agents.map((a) => a.model)).map((s) => [s, s] as const));
  const [open, setOpen] = createSignal(false);
  const active = (): number => FILTERS.filter((id) => id !== "f-q" && ui.filters()[id]).length;

  return (
    <div class="part" id="workers" hidden={m.managed() && !m.state.agents.length}>
      <h2>Workers</h2>
      <div class={"filters" + (open() ? " open" : "")} id="filters">
        <input type="search" id="f-q" placeholder="Search task, lane, report" aria-label="Search workers" autocomplete="off" value={ui.filters()["f-q"]} onInput={(e) => ui.setFilter("f-q", e.currentTarget.value)} />
        <button type="button" class="f-toggle" id="f-toggle" aria-expanded={tf(open())} aria-controls="f-more" onClick={() => setOpen(!open())}>
          Filters{" "}
          <span class="f-on" id="f-on" hidden={!active()}>
            {String(active())}
          </span>
        </button>
        <div class="f-more" id="f-more">
          <FilterSelect id="f-status" label="Status" options={statusOptions()} />
          <FilterSelect id="f-milestone" label="Milestone" options={milestoneOptions()} />
          <FilterSelect id="f-skill" label="Skill" options={skillOptions()} />
          <FilterSelect id="f-model" label="Model" options={modelOptions()} />
          <button
            class="reset"
            id="f-reset"
            type="button"
            onClick={() => {
              for (const id of FILTERS) ui.setFilter(id, "");
            }}
          >
            Clear filters
          </button>
        </div>
        <span class="count" id="f-count">
          {props.rows().length === m.state.agents.length ? `${props.rows().length} workers` : `${props.rows().length} of ${m.state.agents.length} workers`}
        </span>
      </div>
      <div class="card fleet-card">
        <table id="fleet-table">
          <Show
            when={props.rows().length}
            fallback={
              <tbody>
                <tr>
                  <td class="empty">No workers match these filters.</td>
                </tr>
              </tbody>
            }
          >
            <thead>
              <tr>
                <th>Worker</th>
                <th>Task</th>
                <th>Skill</th>
                <th>Model</th>
                <th>Status</th>
                <th>Lane</th>
                <th class="right">Tokens</th>
                <th class="right">Time</th>
                <th>Updated</th>
                <th>
                  <span class="vh">Brief and report</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <For each={props.rows()} keyed={(a) => a.id}>
                {(a) => {
                  const opened = (): boolean => ui.expanded().has(a().id);
                  const model = (): string => a().model || "opus";
                  const running = (): boolean => a().status === "running" || a().status === "blocked";

                  return (
                    <>
                      <tr class="row" id={"agent-" + a().id}>
                        <td class="c-name">
                          <Who id={a().id} extra="agent-name" />
                        </td>
                        <td class="c-task task">{a().task}</td>
                        <td class="c-skill" data-label="Skill">
                          {a().skill || "none"}
                        </td>
                        <td class="c-model" data-label="Model">
                          {model()}
                          <Show when={!["opus", "sonnet", "fable"].includes(model())}>
                            {" "}
                            <span class="pill warning" title="Outside the model policy (Opus, Sonnet, Fable): yours to approve">
                              needs your OK
                            </span>
                          </Show>
                        </td>
                        <td class="c-status">
                          <Pill s={a().status} />
                        </td>
                        <td class="c-lane lane">
                          <Show when={a().lane.length} fallback={<span class="faint">read-only</span>}>
                            <For each={a().lane} keyed={false}>
                              {(l) => <code>{l()}</code>}
                            </For>
                          </Show>
                        </td>
                        <td class="c-tokens right num" data-label="Tokens">
                          <Show when={a().tokens} fallback={<span class="faint">pending</span>}>
                            {fmtInt(a().tokens)}
                          </Show>
                        </td>
                        <td class="c-time right num" data-label="Time">
                          <Show when={fmtDur(a().duration_ms)} fallback={<span class="faint">none</span>}>
                            {fmtDur(a().duration_ms)}
                          </Show>
                        </td>
                        <td
                          class={"c-upd " + (Core.silentWorker(a(), m.tick()) ? "silent" : "muted")}
                          title={a().active ? (a().beat ? `last ${a().beat?.tool || a().beat?.event || "heartbeat"} at ` : "last wrote ") + String(a().active) : String(a().updated ?? "")}
                        >
                          {a().active && running() ? (a().beat ? "seen " : "active ") + m.ago(a().active) : m.ago(a().updated)}
                        </td>
                        <td class="c-act">
                          <button class="expand" type="button" data-id={a().id} aria-expanded={tf(opened())} onClick={() => ui.toggleExpanded(a().id)}>
                            {opened() ? "Hide brief" : "Brief and report"}
                          </button>
                        </td>
                      </tr>
                      <Show when={opened()}>
                        <tr class="detail">
                          <td colspan="10">
                            <BriefAndReport agent={a()} heading="h4" />
                          </td>
                        </tr>
                      </Show>
                    </>
                  );
                }}
              </For>
            </tbody>
          </Show>
        </table>
      </div>
    </div>
  );
}

/** A worker's brief and its latest report, side by side. */
export function BriefAndReport(props: { readonly agent: Agent; readonly heading: "h3" | "h4" }): JSX.Element {
  return (
    <div class="detail-grid">
      <div>
        <Show when={props.heading === "h4"} fallback={<h3>Brief and completion criterion</h3>}>
          <h4>Brief and completion criterion</h4>
        </Show>
        <p>{props.agent.brief || "No brief recorded."}</p>
      </div>
      <div>
        <Show when={props.heading === "h4"} fallback={<h3>Latest report</h3>}>
          <h4>Latest report</h4>
        </Show>
        <p>{props.agent.report || "No report yet."}</p>
      </div>
    </div>
  );
}

/** One bar per worker, coloured by spawn order, the figures on hover or focus. The table above stays the accessible alternative. */
function Chart(props: { readonly rows: () => readonly Agent[] }): JSX.Element {
  const { m } = usePage();
  const sorted = createMemo(() => [...props.rows()].sort((a, b) => (b.tokens || 0) - (a.tokens || 0)));
  const total = (): number => sorted().reduce((n, a) => n + (a.tokens || 0), 0);

  const nice = (): number => {
    const max = Math.max(1, ...sorted().map((a) => a.tokens || 0));
    const mag = Math.pow(10, Math.floor(Math.log10(max)));

    return mag * ([1, 2, 5, 10].find((k) => k * mag >= max) ?? 10);
  };

  const pct = (a: Agent): number => (total() ? Math.round((100 * (a.tokens || 0)) / total()) : 0);
  const [tip, setTip] = createSignal<{ agent: Agent; left: number; top: number } | null>(null);
  let card: HTMLDivElement | undefined;

  return (
    <div class="part" id="tokens" hidden={m.managed() && !m.state.agents.length}>
      <h2>Tokens by worker</h2>
      <div class="card chart-card" id="chart" ref={(el) => (card = el)}>
        <Show when={sorted().length} fallback={<p class="empty">No workers to chart.</p>}>
          <div class="chart-head">
            <span class="muted">Total tokens per worker, from task notifications. Running workers show their last reported figure.</span>
            <span class="num muted">{fmtInt(total())} total</span>
          </div>
          <ul
            class="bars"
            aria-label="Tokens by worker"
            onMouseMove={(e) => {
              const row = e.target instanceof Element ? e.target.closest<HTMLElement>(".bar-row") : null;
              const a = row ? sorted().find((x) => x.id === row.dataset["id"]) : undefined;

              if (!a || !card) {
                setTip(null);

                return;
              }

              const box = card.getBoundingClientRect();
              setTip({ agent: a, left: Math.min(Math.max(e.clientX - box.left, 90), box.width - 90), top: e.clientY - box.top });
            }}
            onMouseLeave={() => setTip(null)}
          >
            <For each={sorted()} keyed={(a) => a.id}>
              {(a, i) => (
                <li class="bar-row" data-i={String(i())} data-id={a().id} style={`--c:${m.colorOf(a().id)}`}>
                  <Who id={a().id} />
                  <span class="track">
                    <span class="bar" style={`width:${((100 * (a().tokens || 0)) / nice()).toFixed(2)}%`} />
                  </span>
                  <span class="bar-val">{a().tokens ? `${fmtShort(a().tokens)}, ${pct(a())}%` : "pending"}</span>
                </li>
              )}
            </For>
          </ul>
          <div class="bar-axis" aria-hidden="true">
            <span />
            <span class="ticks">
              <For each={[0, 0.25, 0.5, 0.75, 1]} keyed={false}>
                {(f) => <span style={`left:${f() * 100}%`}>{fmtShort(f() * nice())}</span>}
              </For>
            </span>
            <span />
          </div>
          <div class="tip" id="tip" hidden={!tip()} style={tip() ? `left:${tip()?.left ?? 0}px;top:${tip()?.top ?? 0}px` : undefined}>
            <Show when={tip()}>
              {(t) => (
                <>
                  <b>{t().agent.name}</b>, {t().agent.status}
                  <br />
                  <span class="num">{fmtInt(t().agent.tokens)}</span> tokens{t().agent.duration_ms ? ", " + fmtDur(t().agent.duration_ms) : ""}
                  {total() ? ", " + String(pct(t().agent)) + "%" : ""}
                </>
              )}
            </Show>
          </div>
        </Show>
      </div>
    </div>
  );
}

/** A root-mode preview's own origin: this host at its public port, plain http (the hub serves it there). */
function rootAddress(port: number): string {
  return `http://${location.hostname}:${String(port)}/`;
}

/** A root-mode preview's link to its own origin, and why the hub cannot listen there when it cannot. */
function RootLink(props: { readonly server: PreviewServer; readonly id?: string }): JSX.Element {
  return (
    <Show when={props.server.public}>
      {(port) => (
        <>
          <p class="meta">
            At its own address:{" "}
            <a
              class="preview-root-link"
              id={props.id}
              href={rootAddress(port())}
              target="_blank"
              rel="noopener"
              title="Served at the root, in plain http: no secure context there, so copying to the clipboard does not work"
            >
              {rootAddress(port())}
            </a>
          </p>
          <Show when={props.server.publicError}>
            <p class="meta deaf-line">
              The hub cannot listen on port {String(port())}: {props.server.publicError}
            </p>
          </Show>
        </>
      )}
    </Show>
  );
}

/** A preview's dev server in words: up, starting, stopped. */
function serverPill(s: PreviewServer): { readonly cls: string; readonly text: string } {
  return s.running ? (s.up ? { cls: "running", text: "up" } : { cls: "open", text: "starting" }) : { cls: "stopped", text: "stopped" };
}

/**
 * The live preview (`fleet preview`): its address, the workers its merge takes (a checkbox each, which
 * takes a worker in or out through the hub, for whoever may write the chat), the files where workers'
 * edits conflict and who made them, and the dev server's last build error.
 */
function PreviewPart(props: { readonly preview: Preview }): JSX.Element {
  const { m } = usePage();
  const p = (): Preview => props.preview;
  const [problem, setProblem] = createSignal("");

  /** Ask the hub to take `worker` in or out; the box goes back when the hub refuses. The state that follows
   * (over the stream) says what the merge takes. */
  async function choose(box: HTMLInputElement, worker: string, include: boolean): Promise<void> {
    setProblem("");
    let refused = "";

    try {
      const res = await fetch("preview-workers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ worker, include }) });

      if (!res.ok) {
        // SAFETY: the hub answers a refusal with {error}; anything else shows as its status.
        const body = (await res.json().catch(() => ({}))) as { readonly error?: string };
        refused = body.error ?? `the hub answered ${String(res.status)}`;
      }
    } catch {
      refused = "the hub did not answer";
    }

    if (refused) {
      box.checked = !include;
      setProblem(refused);
    }
  }

  return (
    <div class="part" id="preview">
      <h2>Preview</h2>
      <div class="card preview-card">
        <Show when={p().url}>
          <div class="block">
            <div class="block-head">
              <a class="link-title" id="preview-link" href={p().url} target="_blank" rel="noopener">
                Open the preview
              </a>
              <PillAs cls={serverPill(p()).cls} text={serverPill(p()).text} />
              <Show when={!p().updater}>
                <PillAs cls="warning" text="not updating" />
              </Show>
            </div>
            <Show when={p().address}>
              <p class="meta lane">{p().address}</p>
            </Show>
            <RootLink server={p()} id="preview-root-link" />
            <p class="meta">
              Every worker's edits as they are now, merged on the stack and served live; looked at every {String(p().every)} s
              {p().updated ? ", last changed " + m.ago(p().updated) : ""}.
            </p>
            <ul class="preview-workers" id="preview-workers">
              <For each={p().workers} keyed={(w) => w.id} fallback={<li class="muted">No worker has a workspace yet: the preview shows the stack.</li>}>
                {(w) => (
                  <li>
                    <label>
                      <input
                        type="checkbox"
                        data-worker={w().id}
                        checked={w().included}
                        disabled={!m.chatWritable()}
                        title={m.chatWritable() ? (w().included ? "Take out of the preview" : "Take into the preview") : m.write().reason || "Read-only here"}
                        onChange={(e) => void choose(e.currentTarget, w().id, e.currentTarget.checked)}
                      />
                      <span>{w().name}</span>
                    </label>
                    <span class="muted"> {w().status || "no row"}</span>
                    <Show when={w().included && w().change}>
                      {" "}
                      <code class="faint">{w().change}</code>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
            <Show when={problem()}>
              <p class="meta deaf-line">{problem()}</p>
            </Show>
          </div>
        </Show>
        <Show when={p().conflicts.length}>
          <div class="block warning" id="preview-conflicts">
            <div class="block-head">
              <b>Conflicts</b>
              <PillAs cls="warning" text={String(p().conflicts.length)} />
            </div>
            <ul class="preview-list">
              <For each={p().conflicts} keyed={(c) => c.path}>
                {(c) => (
                  <li>
                    <code>{c().path}</code> <span class="muted">{c().workers.length ? c().workers.map((id) => m.nameOf(id)).join(", ") : "the stack and a worker"}</span>
                  </li>
                )}
              </For>
            </ul>
            <p class="meta">jj keeps the merge with conflict markers in these files, which may break the build. Take a worker out, or settle it between the workers.</p>
          </div>
        </Show>
        <Show when={p().log}>
          <div class="block critical" id="preview-log">
            <div class="block-head">
              <b>Build error</b>
            </div>
            <pre class="preview-pre">{p().log}</pre>
          </div>
        </Show>
        <Show when={p().error}>
          <div class="block serious" id="preview-error">
            <p class="meta">The updater: {p().error}</p>
          </div>
        </Show>
        <For each={p().own} keyed={(o) => o.worker}>
          {(o) => (
            <div class="block">
              <div class="block-head">
                <a class="link-title" href={o().url} target="_blank" rel="noopener">
                  {m.nameOf(o().worker)} alone
                </a>
                <PillAs cls={serverPill(o()).cls} text={serverPill(o()).text} />
              </div>
              <Show when={o().address}>
                <p class="meta lane">{o().address}</p>
              </Show>
              <RootLink server={o()} />
              <Show when={o().log}>
                <pre class="preview-pre">{o().log}</pre>
              </Show>
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

/** The workers the filters let through. */
export function useVisibleAgents(): () => readonly Agent[] {
  const { m, ui } = usePage();

  /** A filter's value, or none when no option holds it any more. */
  const effective = (id: Filter, values: readonly (string | undefined)[]): string => {
    const v = ui.filters()[id];

    return v && values.includes(v) ? v : "";
  };

  return createMemo(() => {
    const f = ui.filters();
    const q = f["f-q"].trim().toLowerCase();
    const status = effective("f-status", m.state.agents.map((a) => a.status));
    const milestone = effective("f-milestone", m.state.roadmap.map((x) => x.id));
    const skill = effective("f-skill", m.state.agents.map((a) => a.skill));
    const model = effective("f-model", m.state.agents.map((a) => a.model));

    return m.state.agents.filter(
      (a) =>
        (!status || a.status === status) &&
        (!milestone || a.milestone === milestone) &&
        (!skill || a.skill === skill) &&
        (!model || a.model === model) &&
        (!q ||
          [a.name, a.task, a.report, a.brief, ...a.lane]
            .join(" ")
            .toLowerCase()
            .includes(q)),
    );
  });
}

/** The Fleet view. */
export function FleetView(props: { readonly rows: () => readonly Agent[] }): JSX.Element {
  const { m } = usePage();

  return (
    <section class="view" id="fleet" data-view="fleet" aria-label="Fleet" hidden={m.place().view !== "fleet"}>
      <Coordinators />
      <Show when={m.state.preview}>{(p) => <PreviewPart preview={p()} />}</Show>
      <Workers rows={props.rows} />
      <Chart rows={props.rows} />
    </section>
  );
}

/** A link the fleet named, up or down. */
function LinkRow(props: { readonly link: Link }): JSX.Element {
  const { m } = usePage();
  const l = (): Link => props.link;

  return (
    <div class={"block link-row " + (l().up ? "" : "down")}>
      <div class="block-head">
        <RefTag of={l()} />
        <a class="link-title" href={l().url} target="_blank" rel="noopener">
          {l().title}
        </a>
        <PillAs cls={l().up ? "running" : "stopped"} text={l().up ? "up" : "down"} />
        <Show when={m.managed() && l().fleet}>
          <PillAs cls="plain" text={l().fleet} />
        </Show>
      </div>
      <p class="meta lane">{l().url}</p>
      <Show when={l().note}>
        <p class="detail">{l().note}</p>
      </Show>
      <Show when={l().decision ? m.decisionById(l().decision) : undefined}>
        {(d) => (
          <a class="block-link" href={Core.decisionHref(l().decision)}>
            For: {d().title}
          </a>
        )}
      </Show>
    </div>
  );
}

/** The places the user opens: the pages and dev servers the fleet named, then what the machine serves that nobody named. */
export function LinksView(): JSX.Element {
  const { m } = usePage();
  const pages = createMemo(() => m.state.links.filter((l) => l.kind === "page"));
  const devs = createMemo(() => m.state.links.filter((l) => l.kind === "dev"));

  return (
    <section class="view" id="links-view" data-view="links" aria-label="Links" hidden={m.place().view !== "links"}>
      <Show when={m.state.preview}>
        {(p) => (
          <div class="part" id="preview-links">
            <h2>Preview</h2>
            <p class="muted part-note">The workers' edits before they are integrated, served live (the Fleet view says who is in it).</p>
            <div class="card">
              <Show when={p().url}>
                <div class={"block link-row " + (p().up ? "" : "down")}>
                  <div class="block-head">
                    <a class="link-title" href={p().url} target="_blank" rel="noopener">
                      Preview: every worker
                    </a>
                    <PillAs cls={serverPill(p()).cls} text={serverPill(p()).text} />
                  </div>
                  <p class="meta lane">{p().address || p().url}</p>
                </div>
              </Show>
              <For each={p().own} keyed={(o) => o.worker}>
                {(o) => (
                  <div class={"block link-row " + (o().up ? "" : "down")}>
                    <div class="block-head">
                      <a class="link-title" href={o().url} target="_blank" rel="noopener">
                        Preview: {m.nameOf(o().worker)} alone
                      </a>
                      <PillAs cls={serverPill(o()).cls} text={serverPill(o()).text} />
                    </div>
                    <p class="meta lane">{o().address || o().url}</p>
                  </div>
                )}
              </For>
            </div>
          </div>
        )}
      </Show>
      <div class="part">
        <h2>Pages</h2>
        <p class="muted part-note">Pages made for one purpose: a review, a lab, a report.</p>
        <div class="card" id="page-list">
          <For each={pages()} keyed={(l) => l.id} fallback={<p class="empty">No page yet. The {m.host()} lists one here when a worker builds it.</p>}>
            {(l) => <LinkRow link={l()} />}
          </For>
        </div>
      </div>
      <div class="part">
        <h2>Dev servers</h2>
        <div class="card" id="dev-list">
          <For each={devs()} keyed={(l) => l.id} fallback={<p class="empty">No dev server recorded.</p>}>
            {(l) => <LinkRow link={l()} />}
          </For>
        </div>
      </div>
      <div class="part" id="found-part" hidden={!m.state.found.length}>
        <h2>Also served on this machine</h2>
        <p class="muted part-note">Found by looking at what the machine serves; no fleet has said what they are.</p>
        <div class="card" id="found-list">
          <For each={m.state.found} keyed={(f) => f.url}>
            {(f) => (
              <div class={"block link-row " + (f().up ? "" : "down")}>
                <div class="block-head">
                  <a class="link-title" href={f().url} target="_blank" rel="noopener">
                    Port {String(f().port)}
                  </a>
                  <PillAs cls={f().up ? "running" : "stopped"} text={f().up ? "up" : "nothing answers"} />
                  <Show when={f().fleet}>
                    <PillAs cls="plain" text={f().fleet} />
                  </Show>
                </div>
                <Show when={f().cwd}>
                  <p class="meta lane">{f().cwd}</p>
                </Show>
                <Show when={f().command}>
                  <p class="meta lane">{f().command}</p>
                </Show>
              </div>
            )}
          </For>
        </div>
      </div>
    </section>
  );
}

/** The log: a time, what happened, who, and the words; the workers' filters narrow it too. */
export function LogView(props: { readonly rows: () => readonly Agent[] }): JSX.Element {
  const { m, ui } = usePage();

  const openForYou = (id: string): boolean => {
    const d = m.decisionById(id);

    return Boolean(d) && d?.status === "open" && d.asks !== "manager";
  };

  const events = createMemo(() => {
    const ids = new Set(props.rows().map((a) => a.id));
    const filtering = props.rows().length !== m.state.agents.length;
    const q = ui.filters()["f-q"].trim().toLowerCase();

    return keyed(
      [...m.state.events].reverse().filter((e) => (!filtering || (e.agent ? ids.has(e.agent) : !q)) && (!q || e.text.toLowerCase().includes(q) || (e.agent !== undefined && ids.has(e.agent)))),
      (e) => `${e.at}|${e.kind}|${e.text}`,
    );
  });

  return (
    <section class="view" id="log-view" data-view="log" aria-label="Log" hidden={m.place().view !== "log"}>
      <div class="part" id="activity">
        <h2>Activity</h2>
        <div class="card">
          <ul class="log" id="log">
            <For
              each={events()}
              keyed={(x) => x.key}
              fallback={
                <li>
                  <span />
                  <span class="muted">Nothing logged yet.</span>
                </li>
              }
            >
              {(x) => {
                const e = () => x().row;
                const about = () => (e().decision ? m.decisionById(e().decision) : undefined);

                return (
                  <li>
                    <When at={e().at} />
                    <span>
                      <span class="log-meta">
                        <span class={"kind " + e().kind}>
                          {e().kind}
                          {Core.noticeOf(e(), openForYou).important ? ", needs you" : ""}
                        </span>
                        <Show when={e().agent} fallback={<span class="by">{m.host()}</span>}>
                          <Who id={e().agent} />
                        </Show>
                      </span>{" "}
                      {e().text}
                      <Show when={about()}>
                        {(d) => (
                          <>
                            {" "}
                            <a href={Core.decisionHref(d().id)}>Open {d().ref || ""}</a>
                          </>
                        )}
                      </Show>
                    </span>
                  </li>
                );
              }}
            </For>
          </ul>
        </div>
      </div>
    </section>
  );
}

