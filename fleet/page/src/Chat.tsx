/**
 * The chat: docked beside the page on a wide screen, a full-height view over it elsewhere. Its head says
 * the connection and holds the switch for decision activity; the conversation is `ChatLog.tsx`'s. The
 * composer keeps its draft, lists people after "@" and skills after a "/" that starts a word, and says who
 * the text would reach.
 */
import { createEffect, createMemo, createSignal, untrack } from "solid-js";
import { Show, type JSX } from "@solidjs/web";

import { CloseIcon, usePage, tf } from "./bits.tsx";
import { CaretList } from "./CaretList.tsx";
import { Log, useSender } from "./ChatLog.tsx";
import { decisionTrail } from "./chatlog.ts";
import { SideList, useAbout } from "./SideList.tsx";
import type { Message } from "./core.ts";

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
    <div class="composer" id="composer" hidden={ui.sideList()}>
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

          if (!say || e.target === say || say.disabled || (e.target instanceof Element && e.target.closest("button, a"))) return;
          e.preventDefault();
          say.focus();
        }}
      >
        <div class="reply quote-chip" id="quote" hidden={!m.quote()}>
          <Show when={m.quote()}>
            {(q) => (
              <span class="reply-text" id="quote-text">
                {m.focus() === "new" ? "Side chat on" : "Quoting"}
                <Show when={q().from}>
                  {" "}
                  <Show when={q().at} fallback={q().from}>
                    {(at) => (
                      <a
                        class="quote-from"
                        href={(at().page ?? "") + at().hash}
                        title="Go to where it was quoted"
                        onClick={(e) => {
                          if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
                          e.preventDefault();
                          ui.goQuote(q());
                        }}
                      >
                        {q().from}
                      </a>
                    )}
                  </Show>
                </Show>
                {": " + q().text.replace(/\s+/gu, " ").slice(0, 160)}
              </span>
            )}
          </Show>
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

  /* A live message is read out, unless it is decision activity the chat does not show. */
  m.onMessage((msg, live) => {
    if (live && msg.from !== "user" && (m.decisionActivity() || !decisionTrail([...m.messages(), msg]).has(msg.id))) setAnnounce(`${sender(msg).label}: ${msg.text}`);
  });

  /** How many messages of the conversation shown are decision activity: left out, or shown as markers. */
  /** The side chat shown, and the answers unread in the others and in it. */
  const here = createMemo(() => {
    const f = m.focus();

    return f === null || f === "new" ? undefined : ui.sides().find((x) => x.id === f);
  });

  const sideUnread = createMemo(() => ui.sides().reduce((n, x) => n + (ui.isArchived(x) ? 0 : x.unread), 0));
  const about = useAbout();

  const activity = createMemo(() => {
    const trail = decisionTrail(m.messages());
    const focus = m.focus();

    return m.messages().filter((x) => trail.has(x.id) && (focus == null ? x.side == null : x.side === focus)).length;
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
      <div class="chat-tools" id="chat-tools">
        <span class="hidden-note" id="chat-decisions-note" hidden={m.decisionActivity() || !activity()}>
          {activity()} decision message{activity() === 1 ? "" : "s"} hidden
        </span>
        <button
          type="button"
          class="btn small side-list-btn"
          id="side-list-btn"
          hidden={!ui.sides().length}
          aria-pressed={tf(ui.sideList())}
          aria-label={"Side chats" + (sideUnread() ? `, ${sideUnread()} unread` : "")}
          onClick={() => {
            const f = m.focus();

            if (ui.sideList()) ui.openSide(f === "new" ? null : f);
            else ui.openSideList();
          }}
        >
          Side chats
          <Show when={sideUnread()}>
            <span class="count">{sideUnread()}</span>
          </Show>
        </button>
        <button type="button" class="switch" id="chat-decisions" role="switch" aria-checked={tf(m.decisionActivity())} onClick={() => m.setDecisionActivity(!m.decisionActivity())}>
          <span class="switch-track" aria-hidden="true" />
          Decision activity
        </button>
      </div>
      <div class="side-head" id="side-head" hidden={m.focus() == null || ui.sideList()}>
        <button type="button" class="btn small" id="side-back" onClick={() => ui.openSide(null)}>
          Back to the chat
        </button>
        <span class="side-name">
          <span class="side-title">Side chat</span>
          <Show when={here()}>{(s) => <span class="side-about">{about(s()).label}</span>}</Show>
        </span>
        <Show when={here()}>
          {(s) => (
            <button type="button" class="btn small" id="side-archive" aria-pressed={tf(ui.isArchived(s()))} onClick={() => ui.setArchive(s().id, !ui.isArchived(s()))}>
              {ui.isArchived(s()) ? "Unarchive" : "Archive"}
            </button>
          )}
        </Show>
        <button type="button" class="btn small" id="side-all" onClick={() => ui.openSideList()}>
          All side chats
        </button>
      </div>
      <SideList />
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

