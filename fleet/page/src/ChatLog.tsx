/**
 * The conversation, laid out as a messenger: the viewer's messages on the right in the accent's tint, the
 * fleet's on the left under the sender's name in its colour, runs of one sender under one name and time,
 * a separator per day, a reply quoting what it answers on one line (a tap goes there), side chats as links.
 * Decision activity is left out unless the viewer turns it on, and then each is a one-line marker that
 * leads to the decision (`chatlog.ts` says what counts). Each row's node is made once, by its key, and only
 * its changed parts are touched, so focus, a selection and the scroll survive every update.
 */
import { createMemo } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { Pill, usePage, Who } from "./bits.tsx";
import { chatRows, dayWords, type Item, type Row } from "./chatlog.ts";
import { Core, type Message, type Side } from "./core.ts";
import { clock, fullTime } from "./format.ts";
import { Rich } from "./Rich.tsx";

/** Who sent a message, as the chat shows it. */
export function useSender(): (msg: Message) => { label: string; colour: string; status: string } {
  const { m } = usePage();

  return (msg) => {
    if (msg.from === "user") return { label: msg.author || "You", colour: "var(--accent)", status: "" };

    if (msg.from === m.host()) return { label: m.host(), colour: "var(--accent)", status: m.state.status };
    const p = m.person(msg.from);

    return { label: p ? p.name : msg.from, colour: m.colourOfId(msg.from), status: p ? p.status : "" };
  };
}

const HM = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });

/** A message's time of day (the day is its separator's), or with `dated` its day too when not today; the full moment on hover. */
function Clock(props: { readonly at: string; readonly dated?: boolean }): JSX.Element {
  const valid = (): boolean => !isNaN(Date.parse(props.at));

  return (
    <Show when={valid()}>
      <time datetime={props.at} title={fullTime(props.at)}>
        {props.dated ? clock(props.at) : HM.format(new Date(props.at))}
      </time>
    </Show>
  );
}

/** The first line of a text, its blank space made one, cut to `n` characters. */
export const firstLine = (text: string, n = 90): string => {
  const line = (text.trim().split("\n")[0] ?? "").replace(/\s+/gu, " ");

  return line.length > n ? line.slice(0, n - 1).trimEnd() + "…" : line;
};

/** A message's words in the page's text format, its mentions as chips in the colour of who they name. */
function Words(props: { readonly msg: Message }): JSX.Element {
  const { m } = usePage();

  return (
    <Rich
      class="msg-text"
      text={props.msg.text}
      parts={props.msg.parts}
      mention={(p) =>
        p.mention ? (
          <span class="mention" style={`--c:${m.colourOfId(p.mention)}`} title={p.text}>
            @{m.nameOf(p.mention)}
          </span>
        ) : (
          p.text
        )
      }
    />
  );
}

/** Under one of the viewer's messages: not read yet, who it still waits on, or answered. */
function Waiting(props: { readonly item: Item }): JSX.Element {
  const { m } = usePage();

  return (
    <Show when={!(Core.unreadBy(m.state.hearing, props.item.message) && props.item.waiting.length)} fallback={<p class="wait unread">Not read yet</p>}>
      <Show when={props.item.waiting.length} fallback={<p class="wait done">Answered</p>}>
        <p class="wait">
          Waiting on{" "}
          <For each={props.item.waiting} keyed={(r) => r}>
            {(r) => (
              <Show
                when={m.person(r())}
                fallback={
                  <span class="chip">
                    <span class="swatch" style={`--c:${m.colourOfId(r())}`} />
                    {m.nameOf(r())}
                  </span>
                }
              >
                <Who id={r()} />
              </Show>
            )}
          </For>
        </p>
      </Show>
    </Show>
  );
}

/**
 * One message: its sender's name and time when it starts a run, the bubble, a reply button beside a fleet
 * message, and under the viewer's own who it waits on. The chat and a decision's thread (`dated`, as it has
 * no day separators) both show these.
 */
export function Turn(props: { readonly item: Item; readonly replyable: boolean; readonly dated?: boolean }): JSX.Element {
  const { m } = usePage();
  const sender = useSender();
  const msg = (): Message => props.item.message;
  const s = createMemo(() => sender(msg()));
  const fromFleet = (): boolean => msg().from !== "user";
  const canReply = (): boolean => props.replyable && fromFleet() && m.chatWritable();
  const quoted = (): Message | undefined => (props.item.quote == null ? undefined : m.messageById(props.item.quote));
  const someoneElse = (): string => (msg().author && msg().author !== m.you() ? msg().author : "");

  return (
    <li class={`turn from-${fromFleet() ? "fleet" : "user"}${props.item.head ? " head" : ""}${props.item.tail ? " tail" : ""}`} style={`--c:${s().colour}`}>
      <Show when={props.item.head}>
        <div class="turn-head">
          <Show
            when={fromFleet()}
            fallback={
              <Show when={someoneElse()}>
                <b class="name">{someoneElse()}</b>
              </Show>
            }
          >
            <Show when={m.person(msg().from)} fallback={<b class="name">{s().label}</b>}>
              <Who id={msg().from} />
            </Show>
            <Show when={s().status && msg().from !== m.host()}>
              <Pill s={s().status} />
            </Show>
          </Show>
          <Clock at={msg().at} dated={props.dated ?? false} />
        </div>
      </Show>
      <div class="turn-row">
        <article class={`msg${canReply() ? " can-reply" : ""}${m.reply() === msg().id ? " replying" : ""}`} data-id={String(msg().id)}>
          <Show when={quoted()}>
            {(q) => (
              <button type="button" class="re-line" data-goto={String(q().id)} style={`--c:${sender(q()).colour}`} aria-label={`Answers ${sender(q()).label}: ${firstLine(q().text)}. Show it`}>
                <b>{sender(q()).label}</b>
                <span>{firstLine(q().text)}</span>
              </button>
            )}
          </Show>
          <Show when={msg().quote}>
            {(q) => (
              <blockquote class="msg-quote">
                <Show when={q().from}>
                  <span class="from">From {q().from}</span>
                </Show>
                {q().text}
              </blockquote>
            )}
          </Show>
          <Words msg={msg()} />
        </article>
        <Show when={canReply()}>
          <button type="button" class="reply-btn" data-reply={String(msg().id)} aria-label={`Reply to ${s().label}`} title="Reply">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M9.5 7 4.5 12l5 5M5 12h9.5a5 5 0 0 1 5 5v1" />
            </svg>
          </button>
        </Show>
      </div>
      <Show when={!fromFleet()}>
        <Waiting item={props.item} />
      </Show>
    </li>
  );
}

/** Decision activity in the chat, when shown: one line that leads to the decision. */
function Marker(props: { readonly message: Message; readonly decision: string }): JSX.Element {
  const { m } = usePage();
  const d = () => m.decisionById(props.decision);
  const ref = (): string => d()?.ref || props.decision;
  const mine = (): boolean => props.message.from === "user";

  return (
    <li class={`dmark from-${mine() ? "user" : "fleet"}`} data-id={String(props.message.id)}>
      <a href={d()?.href || "#decision/" + encodeURIComponent(props.decision)} title={d()?.title ?? ""}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3.5 20.5 12 12 20.5 3.5 12z" />
        </svg>
        <span class="dmark-line">
          <span class="dmark-who">{mine() ? (props.message.decision ? "You answered" : "You on") : m.nameOf(props.message.from) + " on"}</span> <span class="ref">{ref()}</span>
          {mine() && props.message.decision ? " · " : ": "}
          {firstLine(props.message.text, 140)}
        </span>
        <Clock at={props.message.at} />
      </a>
    </li>
  );
}

/** The way into a side chat: how many messages, and what it quotes or says first. */
function SideLink(props: { readonly side: Side }): JSX.Element {
  return (
    <li class="side-link">
      <button type="button" data-side={String(props.side.id)}>
        <span class="side-kicker">
          Side chat · {props.side.count} message{props.side.count === 1 ? "" : "s"}
        </span>
        <span class="side-text">{firstLine(props.side.quote ? props.side.quote.text : props.side.first, 120)}</span>
      </button>
    </li>
  );
}

/** A row as each kind, or null. */
const asMsg = (r: Row): Item | null => (r.kind === "msg" ? r.item : null);

const asMark = (r: Row): { message: Message; decision: string } | null => (r.kind === "mark" ? { message: r.message, decision: r.decision } : null);

const asSide = (r: Row): Side | null => (r.kind === "side" ? r.side : null);

const asDay = (r: Row): string | null => (r.kind === "day" ? r.day : null);

/** Scroll `container` to message `id` and mark it for a moment. */
export function showMessage(container: Element | null | undefined, id: string | undefined): void {
  const el = id ? container?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`) : null;

  if (!el) return;
  el.scrollIntoView({ block: "center" });
  el.classList.add("found");
  setTimeout(() => el.classList.remove("found"), 1600);
}

/** The conversation. */
export function Log(): JSX.Element {
  const { m, ui } = usePage();
  const rows = createMemo((): Row[] => chatRows(m.messages(), m.focus(), m.decisionActivity()));

  const empty = (): string =>
    m.focus() != null
      ? `A side chat, apart from the main one. Ask about the quote, and the ${m.host()} answers here.`
      : m.chatAvailable()
        ? m.chatWritable()
          ? m.managed()
            ? "No messages yet. Write to the manager, or type @ to reach a coordinator."
            : "No messages yet. Write to the coordinator, or type @ to reach a worker."
          : "No messages yet."
        : "";

  return (
    <ol
      class="chat-log"
      id="chat-log"
      ref={(el) => (ui.refs.chatLog = el)}
      onClick={(e) => {
        const t = e.target instanceof Element ? e.target : null;
        const side = t?.closest<HTMLElement>("[data-side]");

        if (side) {
          m.setFocus(Number(side.dataset["side"]));
          m.setQuote(null);
          m.setReply(null);
          ui.toBottom();

          return;
        }

        const goto = t?.closest<HTMLElement>("[data-goto]");

        if (goto) {
          showMessage(ui.refs.chatLog, goto.dataset["goto"]);

          return;
        }

        const r = t?.closest<HTMLElement>("[data-reply]");

        if (r) {
          ui.replyTo(Number(r.dataset["reply"]));

          return;
        }

        if (t?.closest("button, a") || String(getSelection() ?? "")) return;
        const art = t?.closest<HTMLElement>(".msg.can-reply");

        if (art) ui.replyTo(Number(art.dataset["id"]));
      }}
    >
      <For each={rows()} keyed={(r) => r.key} fallback={<Show when={empty()}>{<li class="chat-empty">{empty()}</li>}</Show>}>
        {(row) => (
          <Show
            when={asMsg(row())}
            fallback={
              <Show
                when={asMark(row())}
                fallback={
                  <Show when={asSide(row())} fallback={<li class="day">{dayWords(asDay(row()) ?? "", m.tick())}</li>}>
                    {(side) => <SideLink side={side()} />}
                  </Show>
                }
              >
                {(mark) => <Marker message={mark().message} decision={mark().decision} />}
              </Show>
            }
          >
            {(it) => <Turn item={it()} replyable />}
          </Show>
        )}
      </For>
    </ol>
  );
}
