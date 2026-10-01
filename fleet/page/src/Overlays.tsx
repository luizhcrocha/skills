/**
 * What opens over the page: the finder (Ctrl/⌘K), the worker sheet (a worker's or a coordinator's detail,
 * opened from its name anywhere), and the toolbar a text selection offers (Reply, Side chat).
 */
import { createEffect, createMemo, onCleanup } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { ChatIcon, CloseIcon, Pill, usePage, tf } from "./bits.tsx";
import { Core, type Agent, type Coordinator } from "./core.ts";
import { evidence } from "./DecisionPage.tsx";
import { fmtDur, fmtInt, spentWords } from "./format.ts";
import { BriefAndReport } from "./Views.tsx";

/** One box to find anything the page holds and go there. */
export function Finder(): JSX.Element {
  const { ui } = usePage();
  const groupTitle = (g: string): string => Core.FIND_GROUPS.find(([k]) => k === g)?.[1] ?? g;

  /* The highlighted row stays in view. */
  createEffect(
    () => [ui.foundAt(), ui.found().length] as const,
    ([at]) => {
      document.getElementById("find-" + String(at))?.scrollIntoView({ block: "nearest" });
    },
  );

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
        <label class="vh" for="find-q">
          Search
        </label>
        <input
          id="find-q"
          type="search"
          placeholder="Search: D3, a title, a worker… (d, l, p, w, c narrow it)"
          autocomplete="off"
          spellcheck={false}
          role="combobox"
          aria-controls="find-list"
          aria-expanded="true"
          aria-activedescendant={"find-" + String(ui.foundAt())}
          ref={(el) => (ui.refs.findQ = el)}
          onInput={(e) => {
            ui.setFoundAt(0);
            ui.setFindQuery(e.currentTarget.value);
          }}
          onKeyDown={(e) => {
            const found = ui.found();
            const r = found[ui.foundAt()];

            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              ui.setFoundAt((ui.foundAt() + (e.key === "ArrowDown" ? 1 : -1) + found.length) % Math.max(1, found.length));
            } else if (e.key === "Enter" && r) {
              e.preventDefault();
              ui.go(r, e.ctrlKey || e.metaKey);
            }
          }}
        />
        <ul
          class="find-list"
          id="find-list"
          role="listbox"
          aria-label="Results"
          onClick={(e) => {
            const row = e.target instanceof Element ? e.target.closest<HTMLElement>(".find-row") : null;
            const r = row ? ui.found()[Number(row.dataset["i"])] : undefined;

            if (r) ui.go(r, e.ctrlKey || e.metaKey);
          }}
        >
          <For each={ui.found()} keyed={false} fallback={<li class="find-empty">{ui.findQuery().trim() ? "Nothing matches." : "Nothing here yet."}</li>}>
            {(r, i) => (
              <>
                <Show when={i === 0 || ui.found()[i - 1]?.group !== r().group}>
                  <li class="find-group" role="presentation">
                    {groupTitle(r().group)}
                  </li>
                </Show>
                <li class="find-row" role="option" id={"find-" + String(i)} data-i={String(i)} aria-selected={tf(i === ui.foundAt())}>
                  <span class="t">
                    <Show when={r().ref}>
                      <span class="ref">{r().ref}</span>{" "}
                    </Show>
                    {r().title}
                  </span>
                  <span class="h">{r().hint}</span>
                  <span class="s">{r().sub}</span>
                </li>
              </>
            )}
          </For>
        </ul>
        <p class="find-foot muted">
          <kbd>↑</kbd>
          <kbd>↓</kbd> move <kbd>↵</kbd> open <kbd>Ctrl</kbd>+<kbd>↵</kbd> new tab <kbd>Esc</kbd> close
        </p>
      </div>
    </dialog>
  );
}

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

/**
 * Text selected anywhere on the page (or in a decision's evidence) offers two things: Reply puts it on the
 * composer as a quote, Side chat opens a conversation of its own about it. The bar sits under the
 * selection, clear of the menu phones show above it.
 */
export function SelTool(): JSX.Element {
  const { m, ui } = usePage();
  let tool: HTMLDivElement | undefined;
  let framePicked = false;
  let selTimer: ReturnType<typeof setTimeout> | undefined;

  const sender = (id: number): string => {
    const msg = m.messageById(id);

    if (!msg) return "";

    return msg.from === "user" ? msg.author || "You" : msg.from === m.host() ? m.host() : m.nameOf(msg.from);
  };

  const whereOf = (node: Node | null): string => {
    const el = node && (node instanceof Element ? node : node.parentElement);

    if (!el) return "";

    if (el.closest("#chat-log")) {
      const art = el.closest<HTMLElement>("article.msg");
      const id = art ? Number(art.dataset["id"]) : NaN;

      return m.messageById(id) ? "the chat, " + sender(id) : "the chat";
    }

    if (el.closest("#decision")) {
      const d = m.decisionById(m.viewing());

      return d ? d.title : "a decision";
    }

    const view = el.closest<HTMLElement>("section.view[data-view]");

    return view ? ({ decisions: "Decisions", plan: "the Plan", fleet: m.managed() ? "Fleets" : "the Fleet", links: "Links", log: "the Log" }[view.dataset["view"] ?? ""] ?? "") : "the page's head";
  };

  const hide = (): void => {
    ui.setPicked(null);
    ui.setToolAt(null);
  };

  function show(text: string, from: string, rect: { top: number; bottom: number; left: number; width: number }): void {
    const excerpt = Core.excerptOf(text);

    if (!excerpt || !m.chatWritable() || !tool) {
      hide();

      return;
    }

    ui.setPicked({ text: excerpt, from });
    tool.hidden = false;
    const w = tool.offsetWidth;
    const h = tool.offsetHeight;
    const pad = 8;
    let top = rect.bottom + pad;

    if (top + h > innerHeight - pad) top = Math.max(pad, rect.top - h - pad);
    ui.setToolAt({ top, left: Math.min(Math.max(pad, rect.left + rect.width / 2 - w / 2), innerWidth - w - pad) });
  }

  const onSelection = (): void => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      const sel = getSelection();

      if (!sel || sel.isCollapsed || !sel.rangeCount) {
        if (!framePicked) hide();

        return;
      }

      const node = sel.anchorNode;
      const el = node && (node instanceof Element ? node : node.parentElement);

      if (!el || el.closest("textarea, input, .composer, #seltool, .seltool") || !el.closest("#app, #decision, #chat-log")) {
        hide();

        return;
      }

      framePicked = false;
      show(sel.toString(), whereOf(node), sel.getRangeAt(0).getBoundingClientRect());
    }, 180);
  };

  /* A selection inside the evidence frame arrives as a message: its text and where it sits in the frame. */
  const onMessage = (e: MessageEvent<{ readonly fleetSelect?: boolean; readonly text?: string; readonly rect?: { top?: number; bottom?: number; left?: number; width?: number } | null } | null>): void => {
    const frame = evidence.frame;

    if (!frame || e.source !== frame.contentWindow || !e.data || e.data.fleetSelect !== true) return;
    const box = frame.getBoundingClientRect();
    const r = e.data.rect ?? {};

    if (!e.data.text) {
      if (framePicked) {
        framePicked = false;
        hide();
      }

      return;
    }

    framePicked = true;
    const d = m.decisionById(m.viewing());
    show(String(e.data.text), "the evidence" + (d ? " of " + d.title : ""), { top: box.top + (r.top || 0), bottom: box.top + (r.bottom || 0), left: box.left + (r.left || 0), width: r.width || 0 });
  };

  /* A scroll moves the selection: the bar follows it while it lasts. */
  const onScroll = (): void => {
    if (!ui.picked() || framePicked) return;
    const sel = getSelection();

    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      hide();

      return;
    }

    show(sel.toString(), ui.picked()?.from ?? "", sel.getRangeAt(0).getBoundingClientRect());
  };

  document.addEventListener("selectionchange", onSelection);
  addEventListener("message", onMessage);
  addEventListener("scroll", onScroll, { passive: true, capture: true });
  onCleanup(() => {
    document.removeEventListener("selectionchange", onSelection);
    removeEventListener("message", onMessage);
    removeEventListener("scroll", onScroll, { capture: true });
  });

  return (
    <div
      class="seltool"
      id="seltool"
      role="toolbar"
      aria-label="Selected text"
      hidden={!ui.picked()}
      style={ui.toolAt() ? `top:${ui.toolAt()?.top ?? 0}px;left:${ui.toolAt()?.left ?? 0}px` : undefined}
      ref={(el) => (tool = el)}
      onPointerDown={(e) => e.preventDefault()}
      onClick={(e) => {
        const b = e.target instanceof Element ? e.target.closest<HTMLElement>("[data-sel]") : null;
        const quote = ui.picked();

        if (!b || !quote) return;
        hide();
        getSelection()?.removeAllRanges();
        m.setQuote(quote);
        m.setReply(null);
        m.setFocus(b.dataset["sel"] === "side" ? "new" : null);
        ui.openChat();
        ui.refs.say?.focus();
      }}
    >
      <button type="button" data-sel="reply">
        Reply
      </button>
      <button type="button" data-sel="side">
        Side chat
      </button>
    </div>
  );
}
