/**
 * The masthead that stays: the fleet's mark, name and status, the switcher between the manager and the
 * fleets, the way up to the manager, search and the bell; under it the views as tabs (a dock at the bottom
 * on a phone), and the notifications panel the bell opens.
 */
import { createEffect, createMemo } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { ChatIcon, Mark, Pill, usePage, When, tf } from "./bits.tsx";
import { unreadInChat } from "./chatlog.ts";
import { Core, type NoticePrefs } from "./core.ts";
import { faviconOf } from "./mark.ts";

/** The switcher: the manager and every fleet, this page's own selected. */
function Switcher(): JSX.Element {
  const { m } = usePage();

  const here = createMemo((): string =>
    m.state.role === "manager" ? "" : m.underHub ? decodeURIComponent(location.pathname.split("/")[2] ?? "") : String(m.state.fleet || ""),
  );

  const ids = createMemo((): string[] => {
    const list = m.state.role === "manager" ? m.state.coordinators.map((c) => c.id) : [...(m.state.fleets ?? [])];
    const own = here();

    /* This page's own fleet is always listed: missing from the list, the browser would select the first entry and the page would read as the manager's. */
    if (own && !list.includes(own)) list.push(own);

    return list;
  });

  return (
    <label class="switch" id="switch" hidden={!m.hubRoot() || !ids().length}>
      <span class="vh">Go to</span>
      <select
        aria-label="Go to the manager or a fleet"
        onChange={(e) => {
          if (e.currentTarget.value) location.href = e.currentTarget.value;
        }}
      >
        <option value={m.managerPage() || String(m.hubRoot())} selected={m.state.role === "manager"}>
          Manager
        </option>
        <For each={ids()} keyed={(id) => id}>
          {(id) => (
            <option value={m.fleetPage(id())} selected={id() === here()}>
              {id()}
            </option>
          )}
        </For>
        <Show when={m.state.role !== "manager" && !here()}>
          <option value="" selected>
            {m.state.project}
          </option>
        </Show>
      </select>
    </label>
  );
}

/** A setting as segments: off, important, all (or the two of "Notify about"). */
function Segments(props: { readonly name: keyof NoticePrefs; readonly label: string; readonly options: readonly (readonly [string, string])[]; readonly disabled?: boolean }): JSX.Element {
  const { ui } = usePage();

  return (
    <div class="seg small" role="radiogroup" aria-label={props.label}>
      <For each={props.options} keyed={(o) => o[0]}>
        {(o) => (
          <button type="button" role="radio" aria-checked={tf(ui.notify.prefs()[props.name] === o()[0])} aria-pressed={tf(ui.notify.prefs()[props.name] === o()[0])} disabled={props.disabled === true} onClick={() => ui.notify.setPref(props.name, o()[0])}>
            {o()[1]}
          </button>
        )}
      </For>
    </div>
  );
}

const LEVELS = [
  ["off", "off"],
  ["important", "important"],
  ["all", "all"],
] as const;

/** The notifications panel: the list first; the settings behind the gear, one compact row each. */
function Panel(): JSX.Element {
  const { m, ui } = usePage();
  const n = ui.notify;

  const aboutLink = (decision: string | undefined): JSX.Element => {
    const d = m.decisionById(decision);

    return d ? (
      <>
        {" "}
        <a href={"#decision/" + d.id}>Open {d.ref || ""}</a>
      </>
    ) : null;
  };

  return (
    <div class="panel" id="panel" hidden={!ui.panelOpen()} role="dialog" aria-label="Notifications" ref={(el) => (ui.refs.panel = el)}>
      <div class="panel-head">
        <h2 id="panel-title">Notifications</h2>
        <div class="actions">
          <button type="button" id="n-read" onClick={() => n.markRead()}>
            Mark all read
          </button>
          <button type="button" id="n-clear" onClick={() => n.clear()}>
            Clear
          </button>
          <button type="button" class="gear" id="n-gear" aria-expanded={tf(ui.settingsOpen())} aria-controls="n-prefs" aria-label="Notification settings" title="Notification settings" onClick={() => ui.setSettingsOpen(!ui.settingsOpen())}>
            <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
          </button>
        </div>
      </div>
      <Show
        when={ui.settingsOpen()}
        fallback={
          <button type="button" class="panel-summary" id="n-summary" aria-expanded="false" aria-controls="n-prefs" onClick={() => ui.setSettingsOpen(true)}>
            {Core.prefsLine(n.prefs())}
          </button>
        }
      >
        <div class="panel-prefs" id="n-prefs">
          <div class="pref">
            <span class="pref-name">Notify about</span>
            <Segments
              name="about"
              label="Notify about"
              options={[
                ["mine", "to me"],
                ["all", "everything"],
              ]}
            />
          </div>
          <div class="pref">
            <span class="pref-name">Sound</span>
            <Segments name="sound" label="Sound" options={LEVELS} />
            <button type="button" class="icon-btn test" id="n-test" aria-label="Test sound" title="Test sound" onClick={() => n.testSound()}>
              <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
                <path d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" />
              </svg>
            </button>
          </div>
          <div class="pref">
            <span class="pref-name">Toasts</span>
            <Segments name="toasts" label="Toasts" options={LEVELS} />
          </div>
          <div class="pref">
            <span class="pref-name">Browser alerts</span>
            <Segments name="browser" label="Browser alerts" options={LEVELS} disabled={n.browserNote().unsupported} />
          </div>
          <Show when={n.audioNote()}>
            <span id="n-audio-note" class="blocked">
              Click anywhere once to allow sound.
            </span>
          </Show>
          <Show when={n.browserNote().text}>
            <span id="n-browser-note" class="blocked">
              {n.browserNote().text}
            </span>
          </Show>
        </div>
      </Show>
      <ul class="notifs" id="notifs">
        <For each={ui.panelOpen() ? n.items() : []} keyed={(e) => e.key} fallback={<li class="empty muted">Nothing yet.</li>}>
          {(e) => (
            <li class={(n.isUnread(e()) ? "unread" : "read") + (e().important ? " important" : "")} data-key={e().key} onClick={() => n.readOne(e().key)}>
              <span class="dot" />
              <span>
                <div class="meta">
                  <span class="kind">
                    {e().kind}
                    {e().important ? ", needs you" : ""}
                  </span>
                  {n.who(e())}
                </div>
                {e().text}
                {aboutLink(e().decision)}
              </span>
              <When at={e().at} relative />
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

/** The one toast that stands for everything that arrived. */
export function Toasts(): JSX.Element {
  const { ui } = usePage();
  const n = ui.notify;

  return (
    <div
      class="toasts"
      id="toasts"
      aria-live="polite"
      onClick={(ev) => {
        const onButton = ev.target instanceof Element && ev.target.closest("button") !== null;

        if (n.openToast(onButton)) ev.stopPropagation();
      }}
    >
      <Show when={n.toast()}>
        {(t) => (
          <div class={"toast opens" + (t().shown.important ? " important" : "")}>
            <div>
              <div class="meta">
                <span class="kind">
                  {t().shown.kind}
                  {t().shown.important ? ", needs you" : ""}
                </span>
                {n.who(t().shown)}, <When at={t().shown.at} />
              </div>
              <div class="text">{t().shown.text}</div>
              <Show when={t().more}>
                <div class="more">and {t().more} more</div>
              </Show>
            </div>
            <button type="button" aria-label="Dismiss">
              ×
            </button>
          </div>
        )}
      </Show>
    </div>
  );
}

/** The masthead. */
export function Masthead(): JSX.Element {
  const { m, ui } = usePage();
  const n = ui.notify;
  const asked = createMemo(() => m.everyDecision().filter((d) => Core.awaiting(d, m.messages())));
  const openBlocks = createMemo(() => m.state.roadblocks.filter((r) => !r.resolved).length);
  /* Decision activity counts only while the chat shows it; the Decisions tab and the notifications cover it otherwise. */
  const chatUnread = createMemo(() => unreadInChat(m.messages(), m.read(), m.decisionActivity()));
  const unread = createMemo(() => n.unread());
  const tab = (view: string): "true" | "false" => tf(m.place().view === view);

  /* The tab's title and icon carry the unread count. */
  createEffect(
    () => {
      const u = unread();

      return [u.length, u.filter((e) => e.important).length] as const;
    },
    ([count, imp]) => {
      document.title = (count ? `(${count}${imp ? "!" : ""}) ` : "") + "Fleet Board";
      const favicon = document.getElementById("favicon");

      if (favicon instanceof HTMLLinkElement) favicon.href = faviconOf(count, imp > 0);
    },
  );

  return (
    <div class="masthead" id="masthead">
      <header class="top">
        <div class="top-name">
          {/* The mark is the way home: the hub's index of every fleet (off the hub, the manager's page). */}
          <Show
            when={m.hubRoot()}
            fallback={
              <span class="mark" id="top-mark" aria-hidden="true">
                <Mark />
              </span>
            }
          >
            {(home) => (
              <a class="mark" id="top-mark" href={home()} aria-label="Home: every fleet" title="Home: every fleet">
                <Mark />
              </a>
            )}
          </Show>
          <h1 id="top-project">{m.state.project}</h1>
          <span id="top-status">
            <Pill s={m.state.status} />
          </span>
        </div>
        <Switcher />
        <a class="up" id="top-manager" hidden={!m.state.manager} href={m.state.manager ? (m.managerPage() ?? undefined) : undefined}>
          <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 19V6M6 11.5 12 5.5l6 6" />
          </svg>
          Manager
        </a>
        <button class="bell" id="find-open" type="button" aria-label="Search (Ctrl+K)" title="Search (Ctrl+K)" aria-haspopup="dialog" onClick={() => ui.openFinder()}>
          <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m20 20-4.2-4.2" />
          </svg>
        </button>
        <button
          class={"bell" + (n.prefs().sound === "off" ? " muted" : "")}
          id="bell"
          type="button"
          aria-label="Notifications"
          aria-expanded={tf(ui.panelOpen())}
          aria-controls="panel"
          title="Notifications"
          ref={(el) => (ui.refs.bell = el)}
          onClick={() => {
            const open = !ui.panelOpen();
            ui.setPanelOpen(open);

            if (open) n.showAudioNote();
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15z" />
            <path d="M10 21h4" />
          </svg>
          <span class="badge" id="bell-badge" hidden={!unread().length}>
            {unread().length > 99 ? "99+" : String(unread().length)}
          </span>
        </button>
      </header>
      <nav class="tabs" id="dock" aria-label="Views">
        <a href="#decisions" data-view="decisions" aria-current={tab("decisions")} title={asked().length ? `${Core.kindCount(asked())} on you` : "Nothing waits on you"}>
          <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="8.5" />
            <path d="m8.5 12.2 2.4 2.4 4.6-5" />
          </svg>
          <span class="lbl">Decisions</span>
          <span class={"badge" + (asked().some((d) => d.blocking) ? " alert" : "")} id="nav-decisions" hidden={!asked().length}>
            {String(asked().length)}
          </span>
        </a>
        <a href="#plan" data-view="plan" aria-current={tab("plan")}>
          <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 21V4" />
            <path d="M5 4h12l-2.5 4L17 12H5" />
          </svg>
          <span class="lbl">Plan</span>
          <span class="badge alert" id="nav-blocks" hidden={!openBlocks()}>
            {String(openBlocks())}
          </span>
        </a>
        <a href="#fleet" data-view="fleet" aria-current={tab("fleet")}>
          <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12.5" r="3" />
            <circle cx="5" cy="6" r="2" />
            <circle cx="19" cy="6" r="2" />
            <circle cx="12" cy="20.5" r="1.8" />
            <path d="m9.8 10.5-3.3-3M14.2 10.5l3.3-3M12 15.5v3.2" />
          </svg>
          <span class="lbl" id="tab-fleet">
            {m.managed() ? "Fleets" : "Fleet"}
          </span>
        </a>
        <a href="#links" data-view="links" aria-current={tab("links")}>
          <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2" />
            <path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2" />
          </svg>
          <span class="lbl">Links</span>
        </a>
        <a href="#log" data-view="log" aria-current={tab("log")}>
          <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 12h4l3-7 4 14 3-7h4" />
          </svg>
          <span class="lbl">Log</span>
        </a>
        <button
          type="button"
          class="to-chat"
          id="chat-toggle"
          aria-controls="chat"
          aria-expanded={tf(m.docked() ? !m.chatCollapsed() : m.chatOpen())}
          aria-label={chatUnread() ? `Chat, ${chatUnread()} unread` : "Chat"}
          title="Chat"
          ref={(el) => (ui.refs.chatToggle = el)}
          onClick={() => ((m.docked() ? !m.chatCollapsed() : m.chatOpen()) ? ui.closeChat() : ui.openChat())}
        >
          <ChatIcon />
          <span class="lbl">Chat</span>
          <span class="badge" id="chat-badge" hidden={!chatUnread()}>
            {chatUnread() > 99 ? "99+" : String(chatUnread())}
          </span>
        </button>
      </nav>
      <Panel />
    </div>
  );
}

