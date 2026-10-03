/**
 * What opens over the page: the finder (Ctrl/⌘K), the worker sheet (a worker's or a coordinator's detail,
 * opened from its name anywhere), and the toolbar a text selection offers (Copy, Reply, Side chat).
 */
import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { For, Match, Show, Switch, type JSX } from "@solidjs/web";

import { ChatIcon, CloseIcon, listen, Pill, usePage, tf } from "./bits.tsx";
import { copyText, selectAndCopy, type Copied } from "./clip.ts";
import { Core, type Agent, type Coordinator, type FindRow, type Json, type QuoteAt } from "./core.ts";
import { evidence } from "./DecisionPage.tsx";
import { parseEmbedMessage, parseEvidenceSelect, postSelect, type SelRect } from "./embed.ts";
import { GROUPS, groupOf, highlight, rangesIn, type Item } from "./find.ts";
import { fmtDur, fmtInt, spentWords } from "./format.ts";
import type { Model } from "./model.ts";
import { BriefAndReport } from "./Views.tsx";

/** A finder row's title, the letters the query matched marked. */
function Marked(props: { readonly title: string; readonly query: string }): JSX.Element {
  return (
    <For each={highlight(props.title, rangesIn(props.title, props.query))} keyed={false}>
      {(part) => (part().hit ? <mark>{part().text}</mark> : <>{part().text}</>)}
    </For>
  );
}

/** One line of the finder's list: a row, a "show more", a kind to narrow to. */
function FindItem(props: { readonly item: Item; readonly at: number }): JSX.Element {
  const { ui } = usePage();
  const selected = (): "true" | "false" => tf(ui.foundAt() === props.at);

  return (
    <Switch>
      <Match when={props.item.kind === "row" ? props.item : null}>
        {(it) => {
          const row = (): FindRow => ui.liveRows().get(it().row.key) ?? it().row;
          const pill = (): string => (it().recent ? row().pill || groupOf(row().group).one : row().pill);

          return (
            <div class="find-row" role="option" id={"find-" + String(props.at)} data-i={String(props.at)} data-key={it().key} aria-selected={selected()}>
              <span class="t">
                <Show when={row().ref}>
                  <span class="ref">{row().ref}</span>{" "}
                </Show>
                <span class="tt">
                  <Marked title={row().title} query={ui.findQuery()} />
                </span>
              </span>
              <span class="h">
                <Show when={pill()}>
                  <span class="pill">{pill()}</span>
                </Show>
                {row().hint}
              </span>
              <Show when={row().sub}>
                <span class="s">{row().sub}</span>
              </Show>
            </div>
          );
        }}
      </Match>
      <Match when={props.item.kind === "more" ? props.item : null}>
        {(it) => (
          <div class="find-more" role="option" id={"find-" + String(props.at)} data-i={String(props.at)} data-key={it().key} aria-selected={selected()}>
            Show {it().n} more
          </div>
        )}
      </Match>
      <Match when={props.item.kind === "hint" ? props.item : null}>
        {(it) => (
          <div class="find-row find-hint" role="option" id={"find-" + String(props.at)} data-i={String(props.at)} data-key={it().key} aria-selected={selected()}>
            <span class="t">
              <span class="tt">{it().heading}</span>
            </span>
            <span class="h">
              <span class="n">{it().n}</span> <kbd>{it().prefix + ":"}</kbd>
            </span>
          </div>
        )}
      </Match>
    </Switch>
  );
}

/**
 * One box to find anything the page holds and go there. The combobox pattern: the focus stays in the field,
 * the highlighted row is `aria-activedescendant`. Up and Down go round, Enter opens, Ctrl/⌘+Enter opens in a
 * new tab, Tab and Shift+Tab cycle the kinds, a prefix ("d:") selects one, Backspace in an empty field drops
 * it, Escape clears and then closes. On a phone it is a full-height sheet with a close button and no legend.
 */
export function Finder(): JSX.Element {
  const { ui } = usePage();

  /** Each section's first item's place in the list. */
  const firstOf = (): number[] => {
    let n = 0;

    return ui.findSections().map((s) => {
      const at = n;
      n += s.items.length;

      return at;
    });
  };

  /* The highlighted row stays in view, and the tab selected in its row of tabs (a phone's is narrower than the kinds). */
  createEffect(
    () => [ui.foundAt(), ui.findItems().length] as const,
    ([at]) => {
      document.getElementById("find-" + String(at))?.scrollIntoView({ block: "nearest" });
    },
  );
  createEffect(ui.findTab, () => {
    document.querySelector('#find-tabs [aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  return (
    <dialog
      class="sheet finder"
      id="finder"
      aria-label="Search"
      ref={(el) => (ui.refs.finder = el)}
      onClick={(e) => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      }}
      onClose={() => ui.setFinderOpen(false)}
    >
      <div class="finder-in">
        <div class="find-bar">
          <label class="vh" for="find-q">
            Search
          </label>
          <input
            id="find-q"
            type="search"
            placeholder="Search decisions, workers, the plan, the chat…"
            autocomplete="off"
            spellcheck={false}
            role="combobox"
            aria-controls="find-list"
            aria-expanded="true"
            aria-autocomplete="list"
            aria-activedescendant={ui.findItems().length ? "find-" + String(ui.foundAt()) : undefined}
            ref={(el) => (ui.refs.findQ = el)}
            onInput={(e) => ui.findTyped(e.currentTarget.value)}
            onKeyDown={(e) => {
              const mod = e.ctrlKey || e.metaKey;

              if (e.key === "ArrowDown" || e.key === "ArrowUp") ui.moveFound(e.key === "ArrowDown" ? 1 : -1);
              else if (e.key === "Enter") ui.choose(ui.findItems()[ui.foundAt()], mod);
              else if (e.key === "Tab" && !e.altKey && !mod) ui.cycleFindTab(e.shiftKey ? -1 : 1);
              else if (e.key === "Escape") ui.findEscape();
              else if (e.key === "Backspace" && e.currentTarget.value === "" && ui.findTab()) ui.setFindTab("");
              else return;
              e.preventDefault();
            }}
          />
          <button type="button" class="icon-btn find-x" aria-label="Close" title="Close" onClick={() => ui.refs.finder?.close()}>
            <CloseIcon />
          </button>
        </div>
        <div class="find-tabs" id="find-tabs" role="tablist" aria-label="Narrow to">
          <For each={ui.findTabs()} keyed={false}>
            {(t) => (
              <button
                type="button"
                role="tab"
                tabindex="-1"
                aria-selected={tf(ui.findTab() === t())}
                aria-controls="find-list"
                onClick={() => {
                  ui.setFindTab(t());
                  ui.refs.findQ?.focus();
                }}
              >
                {t() ? groupOf(t()).heading : "All"}
              </button>
            )}
          </For>
        </div>
        <div
          class="find-list"
          id="find-list"
          role="listbox"
          aria-label="Results"
          onClick={(e) => {
            const el = e.target instanceof Element ? e.target.closest<HTMLElement>("[role=option]") : null;

            if (el) ui.choose(ui.findItems()[Number(el.dataset["i"])], e.ctrlKey || e.metaKey);
          }}
        >
          <For each={ui.findSections()} keyed={false} fallback={<div class="find-empty">{ui.findQuery().trim() ? "Nothing matches." : "Nothing here yet."}</div>}>
            {(section, s) => (
              <div role="group" aria-labelledby={"find-h-" + section().id}>
                <div class="find-group" id={"find-h-" + section().id} role="presentation">
                  <span class="gh">{section().heading}</span>
                </div>
                <For each={section().items} keyed={false}>
                  {(item, i) => <FindItem item={item()} at={(firstOf()[s] ?? 0) + i} />}
                </For>
              </div>
            )}
          </For>
        </div>
        <p class="find-foot muted">
          <span class="find-keys">
            <span>
              <kbd>↑</kbd>
              <kbd>↓</kbd> move
            </span>
            <span>
              <kbd>↵</kbd> open
            </span>
            <span>
              <kbd>{MOD}</kbd>
              <kbd>↵</kbd> new tab
            </span>
            <span>
              <kbd>Tab</kbd> next kind
            </span>
            <span>
              <kbd>Esc</kbd> clear, then close
            </span>
          </span>
          <span class="find-prefixes">
            <For each={GROUPS.filter((g) => ui.findTabs().includes(g.key))} keyed={false}>
              {(g) => (
                <span>
                  <kbd>{g().prefix + ":"}</kbd> {g().heading.toLowerCase()}
                </span>
              )}
            </For>
          </span>
        </p>
      </div>
    </dialog>
  );
}

/** The modifier key of the platform: ⌘ on a Mac, else Ctrl. */
const MOD = /Mac|iPhone|iPad/u.test(globalThis.navigator?.platform ?? "") ? "⌘" : "Ctrl";

/** A fact of the sheet. */
function Fact(props: { readonly k: string; readonly children: JSX.Element }): JSX.Element {
  return (
    <div>
      <dt>{props.k}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

/** The sheet's close (x) button. */
function CloseX(): JSX.Element {
  return (
    <button type="button" class="icon-btn" data-close data-focus="x" aria-label="Close" title="Close">
      <CloseIcon />
    </button>
  );
}

/** A worker's detail. */
function AgentSheet(props: { readonly a: Agent }): JSX.Element {
  const { m } = usePage();
  const a = (): Agent => props.a;
  const ms = () => m.state.roadmap.find((x) => x.id === a().milestone);

  return (
    <>
      <div class="sheet-head" style={`--c:${m.colorOf(a().id)}`}>
        <span class="swatch" />
        <h2 id="worker-name">{a().name}</h2>
        <Pill s={a().status} />
        <CloseX />
      </div>
      <p>{a().task}</p>
      <dl class="facts">
        <Fact k="Skill">{a().skill || "none"}</Fact>
        <Fact k="Model">{a().model || "opus"}</Fact>
        <Fact k="Milestone">{ms()?.title ?? (a().milestone || "none")}</Fact>
        <Fact k="Tokens">
          <Show when={a().tokens} fallback="pending">
            <span class="num">{fmtInt(a().tokens)}</span>
          </Show>
        </Fact>
        <Fact k="Time">{fmtDur(a().duration_ms) || "none"}</Fact>
        <Show when={(a().rounds || 1) > 1}>
          <Fact k="Round">
            <span class="num">{String(a().rounds)}</span>
          </Fact>
        </Show>
        <Fact k="Updated">{m.ago(a().updated) || "unknown"}</Fact>
        <Show when={a().active}>
          <Show when={a().beat} fallback={<Fact k="Last activity">{m.ago(a().active)}</Fact>}>
            <Fact k="Last seen">{`${m.ago(a().active)}${a().beat?.tool ? ", " + String(a().beat?.tool) : ""}`}</Fact>
          </Show>
        </Show>
      </dl>
      <div>
        <h3>Lane</h3>
        <div class="lane">
          <Show when={a().lane.length} fallback="read-only">
            <For each={a().lane} keyed={false}>
              {(l) => <code>{l()}</code>}
            </For>
          </Show>
        </div>
      </div>
      <BriefAndReport agent={a()} heading="h3" />
      <WriteActions id={a().id} label={a().name} icon />
    </>
  );
}

/** The sheet's actions: write to it (when the chat is here), and close. */
function WriteActions(props: { readonly id: string; readonly label: string; readonly icon?: boolean; readonly page?: string }): JSX.Element {
  const { m } = usePage();

  return (
    <>
      <div class="sheet-actions">
        <Show when={m.chatAvailable()}>
          <button type="button" class="btn primary" data-write={props.id} data-focus="write" disabled={!m.write().ok} aria-describedby={m.write().ok ? undefined : "write-why"}>
            <Show when={props.icon}>
              <ChatIcon />
            </Show>
            Message {props.label}
          </button>
        </Show>
        <Show when={props.page}>
          <a class="btn" href={props.page} data-focus="page">
            Open its page
          </a>
        </Show>
        <button type="button" class="btn" data-close data-focus="close">
          Close
        </button>
      </div>
      <Show when={m.chatAvailable() && !m.write().ok}>
        <p class="muted" id="write-why">
          {m.write().reason}
        </p>
      </Show>
    </>
  );
}

/** A coordinator's detail, on a manager's page. */
function FleetSheet(props: { readonly c: Coordinator }): JSX.Element {
  const { m } = usePage();
  const c = (): Coordinator => props.c;

  return (
    <>
      <div class="sheet-head" style={`--c:${m.colorOf(c().id)}`}>
        <span class="swatch" />
        <h2 id="worker-name">{c().id}</h2>
        <Pill s={c().status} />
        <CloseX />
      </div>
      <p>{c().now || c().goal}</p>
      <dl class="facts">
        <Fact k="Project">{c().name}</Fact>
        <Fact k="Session">{c().session || "not named yet"}</Fact>
        <Fact k="Decisions open">{c().decisions.length}</Fact>
        <Fact k="Roadblocks">{c().roadblocks}</Fact>
        <Fact k="Workers' tokens">
          <Show when={c().tokens} fallback="none yet">
            <span class="num">{fmtInt(c().tokens)}</span>
          </Show>
        </Fact>
        <Fact k="Updated">{m.ago(c().updated) || "unknown"}</Fact>
      </dl>
      <Show when={c().spent}>
        {(s) => (
          <div>
            <h3>The coordinator itself</h3>
            <p>{spentWords(s())}</p>
          </div>
        )}
      </Show>
      <Show when={c().goal}>
        <div>
          <h3>Goal</h3>
          <p>{c().goal}</p>
        </div>
      </Show>
      <div>
        <h3>Lanes in flight</h3>
        <div class="lane">
          <Show when={c().lanes.length} fallback="none">
            <For each={c().lanes} keyed={false}>
              {(l) => <code>{l()}</code>}
            </For>
          </Show>
        </div>
      </div>
      <WriteActions id={c().id} label={c().id} {...(c().url ? { page: c().url } : {})} />
    </>
  );
}

/** The worker sheet: everything the page knows about one worker, and one tap to write to it. */
export function WorkerSheet(): JSX.Element {
  const { m, ui } = usePage();
  const p = createMemo(() => m.person(ui.sheetFor()));

  return (
    <dialog
      class="sheet"
      id="worker"
      aria-labelledby="worker-name"
      ref={(el) => (ui.refs.worker = el)}
      onClick={(e) => {
        const dialog = e.currentTarget;
        const t = e.target instanceof Element ? e.target : null;

        if (t === dialog || t?.closest("[data-close]")) {
          dialog.close();

          return;
        }

        const w = t?.closest<HTMLElement>("[data-write]");

        if (w) {
          dialog.close();
          ui.writeTo(w.dataset["write"] ?? "");
        }
      }}
    >
      <div class="sheet-in" id="worker-body">
        <Show when={p()}>
          {(x) => (
            <Show when={x().coordinator} fallback={<Show when={x().agent}>{(a) => <AgentSheet a={a()} />}</Show>}>
              {(c) => <FleetSheet c={c()} />}
            </Show>
          )}
        </Show>
      </div>
    </dialog>
  );
}

/** How long a selection must rest, after the pointer or key that made it is released, before the bar shows. */
const SETTLE_MS = 250;

/** The room the bar keeps from the selection, and on a touch screen the extra room the selection's handles take. */
const GAP = 8;

const HANDLES = 30;

/** A selection's place on screen: its first and its last line, and the box around it. */
interface SelBox {
  readonly first: { readonly top: number; readonly bottom: number };
  readonly last: { readonly top: number; readonly bottom: number };
  readonly left: number;
  readonly width: number;
}

/** Where the bar sits, in the viewport. */
interface ToolAt {
  readonly top: number;
  readonly left: number;
}

/**
 * Where the bar of height `h` and width `w` goes for a selection at `box`, in a viewport `vw` by `vh`:
 * never over the selection. With a mouse, above its first line, or below its last when there is no room
 * above; on a touch screen below its last line, clear of the handles and of the menu the phone shows above
 * it, or above when there is no room below. Always inside the viewport's width.
 */
export function toolPlace(box: SelBox, w: number, h: number, vw: number, vh: number, touch: boolean): ToolAt {
  const above = box.first.top - GAP - h;
  const below = box.last.bottom + (touch ? HANDLES : GAP);
  const fitsAbove = above >= GAP;
  const fitsBelow = below + h <= vh - GAP;
  const top = touch ? (fitsBelow || !fitsAbove ? below : above) : fitsAbove || !fitsBelow ? above : below;

  return { top: Math.min(Math.max(GAP, top), vh - h - GAP), left: Math.min(Math.max(GAP, box.left + box.width / 2 - w / 2), Math.max(GAP, vw - w - GAP)) };
}

/** The box of a range: its first line, its last line, and around it all. */
function boxOf(range: Range): SelBox {
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 || r.height > 0);
  const all = range.getBoundingClientRect();
  const first = rects[0] ?? all;
  const last = rects.at(-1) ?? all;

  return { first: { top: first.top, bottom: first.bottom }, last: { top: last.top, bottom: last.bottom }, left: all.left, width: all.width };
}

/** Where on the page `node` is, as a quote names it: the chat and its sender, the decision, a view. */
function whereOf(m: Model, node: Node | null): string {
  const el = node && (node instanceof Element ? node : node.parentElement);

  if (!el) return "";

  if (el.closest("#chat-log")) {
    const art = el.closest<HTMLElement>("article.msg");
    const msg = m.messageById(art ? Number(art.dataset["id"]) : NaN);

    if (!msg) return "the chat";

    return "the chat, " + (msg.from === "user" ? msg.author || "You" : msg.from === m.host() ? m.host() : m.nameOf(msg.from));
  }

  if (el.closest("#decision")) {
    const d = m.decisionById(m.viewing());

    return d ? d.title : "a decision";
  }

  const view = el.closest<HTMLElement>("section.view[data-view]");

  return view ? ({ decisions: "Decisions", plan: "the Plan", fleet: m.managed() ? "Fleets" : "the Fleet", links: "Links", log: "the Log" }[view.dataset["view"] ?? ""] ?? "") : "the page's head";
}

/** The location hash of what the page shows now: the address, or the view's when the address has none. */
function hereHash(m: Model): string {
  return location.hash.length > 1 ? location.hash : "#" + m.place().view;
}

/** The nearest element with an id around `el`, up to `box` and not `box` itself; "" when there is none. */
function anchorIn(box: Element, el: Element): string {
  for (let at: Element | null = el; at && at !== box; at = at.parentElement) if (at.id && !at.matches("input, textarea, select, button")) return at.id;

  return "";
}

/**
 * Where on the page `node` is, as a place a quote can be followed back to (`quote.at`): in the chat, the
 * message; on a decision's page, its address and the part of it; in a view, the view's address (or the
 * part's own, as a worker's row has) and the part.
 */
function placeOf(m: Model, node: Node | null): QuoteAt {
  const el = node && (node instanceof Element ? node : node.parentElement);
  const here = hereHash(m);

  if (!el) return { hash: here };

  if (el.closest("#chat-log")) {
    const id = el.closest<HTMLElement>("article.msg")?.dataset["id"];

    return id && /^[0-9]+$/u.test(id) ? { hash: here, message: id } : { hash: here };
  }

  const box = el.closest<HTMLElement>("#decision") ?? el.closest<HTMLElement>("section.view[data-view]");

  if (!box) return { hash: here };
  const viewing = m.viewing();
  const hash = box.id === "decision" ? (viewing ? Core.decisionHref(viewing) : here) : "#" + String(box.dataset["view"]);
  const anchor = anchorIn(box, el);

  if (!anchor) return { hash };

  return box.id !== "decision" && Core.viewOf("#" + anchor, m.managed()).anchor === anchor ? { hash: "#" + anchor, anchor } : { hash, anchor };
}

/** The place of a decision's evidence: its page, at the evidence. */
function evidencePlace(m: Model): QuoteAt {
  const viewing = m.viewing();

  return { hash: viewing ? Core.decisionHref(viewing) : hereHash(m), anchor: "dv-body" };
}

/** `r`, a place in `frame`'s viewport, in the viewport of the page that holds the frame. */
function within(frame: HTMLIFrameElement, r: SelRect | null): SelRect {
  const box = frame.getBoundingClientRect();

  return { top: box.top + (r?.top ?? 0), bottom: box.top + (r?.bottom ?? 0), left: box.left + (r?.left ?? 0), width: r?.width ?? 0 };
}

/**
 * A place on the page of the fleet whose decision `shown` is framed on the manager's (`at` as the frame
 * tells it), as the manager's own address: the decision `#decision/<fleet>/<id>`, the part of it kept.
 */
function fleetPlace(shown: { readonly fleet: string; readonly id: string }, at: QuoteAt | null): QuoteAt {
  const hash = Core.decisionHref(shown.fleet + "/" + (Core.viewOf(at?.hash).decision ?? shown.id));

  return at?.anchor ? { hash, anchor: at.anchor } : { hash };
}

/** How long the frame's selection rests before the manager is told of it, as the evidence frame's script waits. */
const FORWARD_MS = 180;

/**
 * Inside the manager's frame (`?embed=1`), where the page has no toolbar of its own: text selected on the
 * decision's page, and its evidence frame's, told to the manager, whose toolbar shows over the frame.
 */
export function forwardSelections(): void {
  const { m } = usePage();
  let settle: ReturnType<typeof setTimeout> | undefined;
  let told = false;
  let touch = false;

  const tell = (): void => {
    const sel = getSelection();
    const node = sel?.anchorNode ?? null;
    const el = node && (node instanceof Element ? node : node.parentElement);

    if (!sel || sel.isCollapsed || !sel.rangeCount || !el || el.closest("textarea, input, .composer") || !el.closest("#decision")) {
      /* Only a selection of this page's own is cleared: the evidence frame's is the frame's to clear. */
      if (told) postSelect("", null, "", false);
      told = false;

      return;
    }

    const r = sel.getRangeAt(0).getBoundingClientRect();
    postSelect(sel.toString(), { top: r.top, bottom: r.bottom, left: r.left, width: r.width }, whereOf(m, node), touch, placeOf(m, node));
    told = true;
  };

  listen(document, "pointerdown", (e) => {
    touch = e.pointerType === "touch" || e.pointerType === "pen";
  });
  listen(document, "selectionchange", () => {
    clearTimeout(settle);
    settle = setTimeout(tell, FORWARD_MS);
  });
  listen(window, "message", (e) => {
    const frame = evidence.frame;
    const said = frame && e.source === frame.contentWindow ? parseEvidenceSelect(e.data) : null;

    if (!frame || !said) return;
    const d = m.decisionById(m.viewing());
    postSelect(said.text, within(frame, said.rect), "the evidence" + (d ? " of " + d.title : ""), said.touch, evidencePlace(m));
  });
  onCleanup(() => clearTimeout(settle));
}

/**
 * Text selected anywhere on the page (or in a decision's evidence) offers Copy, and where the chat can be
 * written Reply (the text on the composer as a quote) and Side chat (a conversation of its own about it).
 * The bar never covers the selection and leaves the browser's own handling alone: it listens to no
 * `contextmenu` or `copy`, and prevents nothing in the text, so a right-click opens the browser's menu
 * with Copy. It shows once the selection rests (the pointer or key released, then SETTLE_MS), never during
 * a drag, and closes on a right-click, Escape, a scroll, or a press anywhere else. On a manager's page,
 * text selected in a fleet's decision (its page in a frame) shows the bar too, and its Reply and Side chat
 * write to that fleet's coordinator.
 */
export function SelTool(): JSX.Element {
  const { m, ui } = usePage();
  let tool: HTMLDivElement | undefined;
  /* Picked in a frame, not on the page: in a fleet's frame, the fleet a reply goes to. */
  let framePicked: { readonly fleet: string | null } | null = null;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let pressed = false;
  let touch = false;
  /* The text exactly as selected, for Copy; `picked` holds the excerpt a quote takes. */
  let raw = "";
  const [copied, setCopied] = createSignal<Copied | "">("");
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  const hide = (): void => {
    clearTimeout(settle);
    framePicked = null;
    raw = "";
    setCopied("");
    ui.setPicked(null);
    ui.setToolAt(null);
  };

  function show(text: string, from: string, at: QuoteAt, box: SelBox): void {
    if (!text.trim() || !tool) {
      hide();

      return;
    }

    raw = text;
    setCopied("");
    ui.setPicked({ text: Core.excerptOf(text), from, at });
    tool.hidden = false;
    ui.setToolAt(toolPlace(box, tool.offsetWidth, tool.offsetHeight, innerWidth, innerHeight, touch));
  }

  /* The page's own selection, once it rests. */
  const showSelection = (): void => {
    const sel = getSelection();

    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const node = sel.anchorNode;
    const el = node && (node instanceof Element ? node : node.parentElement);

    if (!el || el.closest("textarea, input, .composer, #seltool, .seltool") || !el.closest("#app, #decision, #chat-log")) return;
    show(sel.toString(), whereOf(m, node), placeOf(m, node), boxOf(sel.getRangeAt(0)));
  };

  const later = (): void => {
    clearTimeout(settle);
    settle = setTimeout(showSelection, SETTLE_MS);
  };

  const onSelection = (): void => {
    const sel = getSelection();

    if (!sel || sel.isCollapsed) {
      if (!framePicked) hide();

      return;
    }

    /* While the selection moves, the bar is away; a selection made without a pointer (the keyboard) shows once it rests. */
    if (ui.picked() && !framePicked) {
      ui.setPicked(null);
      ui.setToolAt(null);
    }

    if (!pressed) later();
    else clearTimeout(settle);
  };

  /* Passive: the page notes the press and its release, and prevents nothing. */
  const onDown = (e: PointerEvent): void => {
    touch = e.pointerType === "touch" || e.pointerType === "pen";

    if (tool?.contains(e.target instanceof Node ? e.target : null)) return;
    pressed = e.button === 0;
    hide();
  };

  const onUp = (e: PointerEvent): void => {
    if (e.button !== 0 || !pressed) return;
    pressed = false;
    later();
  };

  /* A long press on a phone hands the touch to the browser's selection: the press is over, and the selection shows the bar once it rests. */
  const onCancel = (): void => {
    pressed = false;
  };

  const onTouchEnd = (): void => {
    pressed = false;
    later();
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && (ui.picked() || framePicked)) hide();
  };

  /* Text selected in `frame`, at `r` in its viewport and `at` on the page, by a touch or not; empty once the frame's selection is cleared. */
  const pickIn = (frame: HTMLIFrameElement, text: string, r: SelRect | null, from: string, at: QuoteAt, fleet: string | null, byTouch: boolean): void => {
    if (!text) {
      if (framePicked) hide();

      return;
    }

    touch = byTouch;
    const { top, bottom, left, width } = within(frame, r);
    show(text, from, at, { first: { top, bottom }, last: { top, bottom }, left, width });
    framePicked = { fleet };
  };

  /* A selection inside the evidence frame, or a fleet's frame on the manager's page, arrives as a message. */
  const onMessage = (e: MessageEvent<Json>): void => {
    const fleetFrame = document.querySelector<HTMLIFrameElement>("#dv-embed");
    const shown = Core.parseFleetDecision(m.viewing());
    const fleet = shown?.fleet;

    if (fleetFrame && shown && fleet && e.source === fleetFrame.contentWindow) {
      const said = parseEmbedMessage(e.data);

      if (said?.kind === "select") pickIn(fleetFrame, said.text, said.rect, said.from ? said.from + ", in " + fleet : fleet, fleetPlace(shown, said.at), fleet, said.touch);

      return;
    }

    const frame = evidence.frame;
    const said = frame && e.source === frame.contentWindow ? parseEvidenceSelect(e.data) : null;

    if (!frame || !said) return;
    const d = m.decisionById(m.viewing());
    pickIn(frame, said.text, said.rect, "the evidence" + (d ? " of " + d.title : ""), evidencePlace(m), null, said.touch);
  };

  const onScroll = (): void => {
    if (ui.picked()) hide();
  };

  document.addEventListener("selectionchange", onSelection);
  document.addEventListener("pointerdown", onDown, { capture: true, passive: true });
  document.addEventListener("pointerup", onUp, { capture: true, passive: true });
  document.addEventListener("pointercancel", onCancel, { capture: true, passive: true });
  document.addEventListener("touchend", onTouchEnd, { capture: true, passive: true });
  document.addEventListener("keydown", onKey);
  addEventListener("message", onMessage);
  addEventListener("scroll", onScroll, { passive: true, capture: true });
  onCleanup(() => {
    clearTimeout(settle);
    clearTimeout(copiedTimer);
    document.removeEventListener("selectionchange", onSelection);
    document.removeEventListener("pointerdown", onDown, { capture: true });
    document.removeEventListener("pointerup", onUp, { capture: true });
    document.removeEventListener("pointercancel", onCancel, { capture: true });
    document.removeEventListener("touchend", onTouchEnd, { capture: true });
    document.removeEventListener("keydown", onKey);
    removeEventListener("message", onMessage);
    removeEventListener("scroll", onScroll, { capture: true });
  });

  const copy = (): void => {
    copyText(
      raw,
      () => selectAndCopy(null),
      (how) => {
        setCopied(how);
        clearTimeout(copiedTimer);
        copiedTimer = setTimeout(() => setCopied(""), 2000);
      },
    );
  };

  return (
    <div
      class="seltool"
      id="seltool"
      role="toolbar"
      aria-label="Selected text"
      hidden={!ui.picked()}
      style={ui.toolAt() ? `top:${ui.toolAt()?.top ?? 0}px;left:${ui.toolAt()?.left ?? 0}px` : undefined}
      ref={(el) => (tool = el)}
      /* A press on the bar keeps the selection (a press on the text is the browser's). */
      onPointerDown={(e) => e.preventDefault()}
      onClick={(e) => {
        const b = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-sel]") : null;
        const quote = ui.picked();
        const fleet = framePicked?.fleet;

        if (!b || !quote) return;

        if (b.dataset["sel"] === "copy") {
          copy();

          return;
        }

        hide();
        getSelection()?.removeAllRanges();
        m.setQuote(quote);
        m.setReply(null);
        m.setFocus(b.dataset["sel"] === "side" ? "new" : null);

        if (fleet) {
          ui.writeTo(fleet);

          return;
        }

        ui.openChat();
        ui.refs.say?.focus();
      }}
    >
      <button type="button" data-sel="copy">
        {copied() === "copied" ? "Copied" : copied() === "selected" ? "Press Ctrl+C" : "Copy"}
      </button>
      <Show when={m.chatWritable() && ui.picked()?.text}>
        <button type="button" data-sel="reply">
          Reply
        </button>
        <button type="button" data-sel="side">
          Side chat
        </button>
      </Show>
    </div>
  );
}
