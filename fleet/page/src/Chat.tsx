/**
 * The chat: docked beside the page on a wide screen, a full-height view over it elsewhere. The conversation
 * is threads in the order of their latest message, replies under what they answer, side chats as links;
 * each message's node is made once and only its changed parts are touched, so focus, a selection and
 * scroll survive every update. The composer keeps its draft, lists people after "@" and skills after a
 * leading "/", and says who the text would reach.
 */
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { CloseIcon, Pill, usePage, When, Who, tf } from "./bits.tsx";
import { CaretList } from "./CaretList.tsx";
import { Core, type Entry, type Message, type Side, type Thread } from "./core.ts";

/** Who sent a message, as the chat shows it. */
function useSender(): (msg: Message) => { label: string; colour: string; status: string } {
  const { m } = usePage();

  return (msg) => {
    if (msg.from === "user") return { label: msg.author || "You", colour: "var(--accent)", status: "" };

    if (msg.from === m.host()) return { label: m.host(), colour: "var(--accent)", status: m.state.status };
    const p = m.person(msg.from);

    return { label: p ? p.name : msg.from, colour: m.colourOfId(msg.from), status: p ? p.status : "" };
  };
}

/** One message, its parts kept apart so an update touches only what changed. */
function MessageView(props: { readonly entry: Entry; readonly rootId: number }): JSX.Element {
  const { m } = usePage();
  const sender = useSender();
  const msg = (): Message => props.entry.message;
  const s = createMemo(() => sender(msg()));
  const fromFleet = (): boolean => msg().from !== "user";
  const canReply = (): boolean => fromFleet() && m.chatWritable();
  const parent = (): Message | undefined => (msg().re != null && msg().re !== props.rootId ? m.messageById(msg().re) : undefined);
  const about = () => (msg().decision ? m.decisionById(msg().decision) : undefined);

  return (
    <article class={`msg from-${fromFleet() ? "fleet" : "user"}${canReply() ? " can-reply" : ""}${m.reply() === msg().id ? " replying" : ""}`} data-id={String(msg().id)} style={`--c:${s().colour}`}>
      <div class="msg-head">
        <Show when={m.person(msg().from)} fallback={<b>{s().label}</b>}>
          <Who id={msg().from} />
        </Show>
        <Show when={s().status && msg().from !== m.host()}>
          <Pill s={s().status} />
        </Show>
        <When at={msg().at} relative />
      </div>
      <Show when={canReply()}>
        <button type="button" class="reply-btn" data-reply={String(msg().id)} aria-label={`Reply to ${s().label}`}>
          Reply
        </button>
      </Show>
      <Show when={parent()}>{(p) => <p class="msg-re">Answering {sender(p()).label}</p>}</Show>
      <Show when={msg().decision}>
        <p class="msg-re">
          About{" "}
          <Show when={about()} fallback={msg().decision}>
            {(d) => (
              <a href={"#decision/" + msg().decision}>
                <Show when={d().ref}>
                  <span class="ref">{d().ref}</span>{" "}
                </Show>
                {d().title}
              </a>
            )}
          </Show>
        </p>
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
      <p class="msg-text">
        <For each={msg().parts} keyed={false}>
          {(p) => (
            <Show when={p().mention} fallback={p().text}>
              {(id) => (
                <span class="mention" style={`--c:${m.colourOfId(id())}`} title={p().text}>
                  @{m.nameOf(id())}
                </span>
              )}
            </Show>
          )}
        </For>
      </p>
      <Show when={msg().from === "user"}>
        <Show
          when={!(Core.unreadBy(m.state.hearing, msg()) && props.entry.waiting.length)}
          fallback={<p class="wait unread">Not read yet</p>}
        >
          <Show when={props.entry.waiting.length} fallback={<p class="wait done">Answered</p>}>
            <p class="wait">
              Waiting on{" "}
              <For each={props.entry.waiting} keyed={(r) => r}>
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
      </Show>
    </article>
  );
}

/** A row of the conversation: a thread, or the way into a side chat. */
type Row = { readonly kind: "thread"; readonly key: string; readonly last: number; readonly thread: Thread } | { readonly kind: "side"; readonly key: string; readonly last: number; readonly side: Side };

/** The thread a row holds, or null for a side chat. */
const threadOf = (row: Row): Thread | null => (row.kind === "thread" ? row.thread : null);

/** The side chat a row holds, or null for a thread. */
const sideOf = (row: Row): Side | null => (row.kind === "side" ? row.side : null);

/** What a side chat's row shows of it: the text it quotes, else its first message. */
const sideText = (side: Side): string => (side.quote ? side.quote.text : side.first).replace(/\s+/gu, " ").slice(0, 120);

/** The conversation. */
function Log(): JSX.Element {
  const { m, ui } = usePage();

  const rows = createMemo((): Row[] => {
    const all = m.messages();
    const focus = m.focus();
    const threads = (list: readonly Message[]): Row[] => Core.fold(list).map((t) => ({ kind: "thread", key: "t:" + String(t.root.message.id), last: t.last, thread: t }));

    if (focus != null) return threads(all.filter((x) => x.side === focus));

    return [...threads(all.filter((x) => x.side == null)), ...Core.sidesOf(all).map((side): Row => ({ kind: "side", key: "side:" + String(side.id), last: side.last, side }))].sort((a, b) => a.last - b.last);
  });

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
            when={threadOf(row())}
            fallback={
              <Show when={sideOf(row())}>
                {(side) => (
                  <li class="side-link">
                    <button type="button" data-side={String(side().id)}>
                      <b>Side chat</b>{" "}
                      <span class="from">
                        {side().count} message{side().count === 1 ? "" : "s"}
                      </span>
                      <br />
                      {sideText(side())}
                    </button>
                  </li>
                )}
              </Show>
            }
          >
            {(t) => (
              <li class="thread">
                <MessageView entry={t().root} rootId={t().root.message.id} />
                <Show when={t().replies.length}>
                  <ol class="replies">
                    <For each={t().replies} keyed={(r) => r.message.id}>
                      {(r) => (
                        <li>
                          <MessageView entry={r()} rootId={t().root.message.id} />
                        </li>
                      )}
                    </For>
                  </ol>
                </Show>
              </li>
            )}
          </Show>
        )}
      </For>
    </ol>
  );
}

/** The composer. */
function Composer(): JSX.Element {
  const { m, ui } = usePage();
  const sender = useSender();
  const replyMsg = (): Message | undefined => m.messageById(m.reply());

  const replyLine = (): string => {
    const r = replyMsg();

    return r ? `Replying to ${sender(r).label}: ${String(r.text).replace(/\s+/gu, " ").slice(0, 80)}` : "";
  };

  const replyPlaceholder = (): string => {
    const r = replyMsg();

    return r ? `Reply to ${sender(r).label}` : "Message the fleet, or type @ or /";
  };

  const readOnly = (): boolean => m.chatAvailable() && !m.write().ok;
  const deaf = (): boolean => m.state.hearing !== null && !m.state.hearing.on && m.chatAvailable();

  const toShown = (): string => {
    const to = ui.to();
    const wanted = m.chatWritable() && (m.draft().trim() !== "" || m.reply() != null);

    if (!wanted || !to || !to.length) return "";
    const n = to.map((id) => m.nameOf(id));

    return "To " + (n.length > 1 ? n.slice(0, -1).join(", ") + " and " + String(n[n.length - 1]) : String(n[0]));
  };

  /* A reply, a quote or a draft changed elsewhere: the "To" line is asked again. */
  createEffect(
    () => [m.chatWritable(), m.reply()] as const,
    () => ui.askPreview(true),
    { defer: true },
  );

  return (
    <div class="composer" id="composer">
      <CaretList caret={ui.composer} ref={(el) => (ui.refs.mentions = el)} />
      <p class="chat-error" id="chat-error" role="alert" hidden={!ui.error() || readOnly()}>
        {ui.error()}
      </p>
      <p class="deaf" id="deaf" role="status" hidden={!deaf()}>
        {`The ${m.host()} has not read the chat for over ten minutes. What you send is kept` + (m.state.manager ? ", and the manager is told if it waits." : "; tell it in its session if it stays unread.")}
      </p>
      <div
        class="box"
        id="box"
        hidden={readOnly()}
        onPointerDown={(e) => {
          const say = ui.refs.say;

          if (!say || e.target === say || say.disabled || (e.target instanceof Element && e.target.closest("button"))) return;
          e.preventDefault();
          say.focus();
        }}
      >
        <div class="reply quote-chip" id="quote" hidden={!m.quote()}>
          <span class="reply-text" id="quote-text">
            {m.quote() ? `${m.focus() === "new" ? "Side chat on" : "Quoting"}${m.quote()?.from ? " " + String(m.quote()?.from) : ""}: ${String(m.quote()?.text).replace(/\s+/gu, " ").slice(0, 160)}` : ""}
          </span>
          <button
            type="button"
            class="icon-btn"
            id="quote-x"
            aria-label="Remove the quote"
            title="Remove the quote"
            onClick={() => {
              m.setQuote(null);

              if (m.focus() === "new") m.setFocus(null);
            }}
          >
            <CloseIcon small />
          </button>
        </div>
        <div class="reply" id="reply" hidden={!replyMsg()}>
          <span class="reply-text" id="reply-text">
            {replyLine()}
          </span>
          <button
            type="button"
            class="icon-btn"
            id="reply-x"
            aria-label="Stop replying"
            title="Stop replying"
            onClick={() => {
              ui.clearReply();
              ui.refs.say?.focus();
            }}
          >
            <CloseIcon small />
          </button>
        </div>
        <label class="vh" for="say">
          Message
        </label>
        <textarea
          id="say"
          rows="1"
          placeholder={replyPlaceholder()}
          autocomplete="off"
          autocorrect="on"
          autocapitalize="sentences"
          spellcheck={true}
          data-1p-ignore
          data-lpignore="true"
          role="combobox"
          aria-autocomplete="list"
          aria-controls="mentions"
          aria-expanded={tf(Boolean(ui.list()))}
          aria-activedescendant={ui.list() ? ui.composer.optionId(ui.listIndex()) : undefined}
          disabled={!m.chatWritable()}
          ref={(el) => {
            ui.refs.say = el;
            el.value = untrack(m.draft);
            queueMicrotask(() => ui.fit());
          }}
          onKeyDown={(e) => ui.onKey(e)}
          onInput={() => ui.afterEdit()}
          onClick={() => ui.updateList()}
          onKeyUp={(e) => {
            if (/^(Arrow(Left|Right)|Home|End)$/u.test(e.key)) ui.updateList();
          }}
          onBlur={() => ui.closeList()}
          onFocus={() => {
            if (!m.docked() && m.phone()) setTimeout(() => ui.toBottom(), 250);
          }}
        />
        <button type="button" class="send" id="send" aria-label="Send" title="Send" disabled={!m.draft().trim() || m.sending() || !m.chatWritable()} onClick={() => void ui.send()}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
          </svg>
        </button>
      </div>
      <p class="to" id="to" hidden={!toShown()}>
        {toShown()}
      </p>
      <p class="readonly" id="readonly" role="status" hidden={!readOnly()}>
        {m.write().reason || "This address can read the chat but not write to it."}
      </p>
    </div>
  );
}

const CONN_WORDS = { off: "Unavailable", unavailable: "Unavailable", connecting: "Connecting", live: "Live", reconnecting: "Reconnecting" } as const;

/** The chat. */
export function Chat(): JSX.Element {
  const { m, ui } = usePage();
  const modal = (): boolean => !m.docked() && m.chatOpen();
  const [announce, setAnnounce] = createSignal("");
  const sender = useSender();

  m.onMessage((msg, live) => {
    if (live && msg.from !== "user") setAnnounce(`${sender(msg).label}: ${msg.text}`);
  });

  return (
    <aside
      class={"chat" + (m.chatAvailable() ? " available" : "") + (!m.docked() && m.chatOpen() ? " open" : "")}
      id="chat"
      aria-labelledby="chat-title"
      role={modal() ? "dialog" : undefined}
      aria-modal={modal() ? "true" : undefined}
      ref={(el) => (ui.refs.chat = el)}
      onKeyDown={(e) => {
        const chat = ui.refs.chat;

        if (e.key === "Escape" && e.target !== ui.refs.say && modal()) {
          ui.closeChat();

          return;
        }

        /* Tab stays inside the overlay. */
        if (e.key !== "Tab" || e.defaultPrevented || !modal() || !chat) return;
        const f = [...chat.querySelectorAll<HTMLElement>("button, textarea, a[href]")].filter((x) => !("disabled" in x && x.disabled) && x.getClientRects().length);
        const first = f[0];
        const last = f[f.length - 1];
        const at = document.activeElement;

        if (!first || !last) return;

        if (e.shiftKey && (at === first || at === ui.refs.chatTitle)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && at === last) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      <header class="chat-head">
        <h2 id="chat-title" tabindex="-1" ref={(el) => (ui.refs.chatTitle = el)}>
          Chat
        </h2>
        <span class="you" id="chat-you" hidden={!m.you()} title={m.you() ? "Writing as " + m.you() : ""}>
          {m.you() ? "as " + m.you() : ""}
        </span>
        <span class="conn" id="conn" data-conn={m.conn()} role="status">
          {CONN_WORDS[m.conn()]}
        </span>
        <button type="button" class="icon-btn" id="chat-close" aria-label={m.docked() ? "Hide chat" : "Close chat"} title={m.docked() ? "Hide chat" : "Close chat"} onClick={() => ui.closeChat()}>
          <CloseIcon />
        </button>
      </header>
      <div class="side-head" id="side-head" hidden={m.focus() == null}>
        <button
          type="button"
          class="btn small"
          id="side-back"
          onClick={() => {
            m.setFocus(null);
            m.setQuote(null);
            ui.toBottom();
          }}
        >
          Back to the chat
        </button>
        <span class="side-title">Side chat</span>
      </div>
      <p class="chat-note" id="chat-note" hidden={m.conn() !== "unavailable"}>
        Chat is unavailable here. It runs on the dashboard's own server, at the address the coordinator gave you; this copy shows the fleet only.
      </p>
      <Log />
      <div class="vh" id="chat-announce" aria-live="polite">
        {announce()}
      </div>
      <Composer />
    </aside>
  );
}

