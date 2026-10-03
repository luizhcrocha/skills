/**
 * The side chats, in the chat's place: newest activity first, the last hour's under their own heading at the
 * top, each with its title (the first line of what opened it), the item it is about (a decision's ref and
 * title, else where its quote is from), how long ago it last moved, and its unread answers. A search reads
 * every message of each; a filter keeps one item's; archived ones (`ui.isArchived`, kept in this browser)
 * have a view of their own.
 */
import { createMemo, createSignal } from "solid-js";
import { For, Show, type JSX } from "@solidjs/web";

import { usePage } from "./bits.tsx";
import type { SideSummary } from "./chatlog.ts";
import { fullTime } from "./format.ts";

const HOUR_MS = 60 * 60_000;

/** The item a side chat is about, as its filter's value and its words. */
export function useAbout(): (s: SideSummary) => { readonly key: string; readonly label: string } {
  const { m } = usePage();

  return (s) => {
    if (s.decision) {
      const d = m.decisionAnywhere(s.decision);

      return { key: "d:" + s.decision, label: d ? [d.ref ?? "", d.title].filter(Boolean).join(" ") : s.from || s.decision };
    }

    return s.from ? { key: "q:" + s.from, label: s.from } : { key: "q:", label: "the chat" };
  };
}

function Row(props: { readonly s: SideSummary; readonly archived: boolean }): JSX.Element {
  const { m, ui } = usePage();
  const about = useAbout();

  return (
    <li class="sl-row" data-side={String(props.s.id)}>
      <button type="button" class="sl-open" onClick={() => ui.openSide(props.s.id)} aria-label={`${props.s.title}, about ${about(props.s).label}${props.s.unread ? `, ${props.s.unread} unread` : ""}`}>
        <span class="sl-line">
          <span class="sl-title">{props.s.title}</span>
          <time datetime={props.s.lastAt} title={fullTime(props.s.lastAt)}>
            {m.ago(props.s.lastAt)}
          </time>
        </span>
        <span class="sl-line">
          <span class="sl-about">{about(props.s).label}</span>
          <Show when={props.s.unread}>
            <span class="sl-unread">{props.s.unread}</span>
          </Show>
        </span>
      </button>
      <button type="button" class="icon-btn sl-arch" aria-label={props.archived ? "Unarchive" : "Archive"} title={props.archived ? "Unarchive" : "Archive"} onClick={() => ui.setArchive(props.s.id, !props.archived)}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <Show when={props.archived} fallback={<path d="M4 5h16v4H4zM5.5 9v10h13V9M10 13h4" />}>
            <path d="M4 5h16v4H4zM5.5 9v10h13V9M12 18v-6M9.5 14.5 12 12l2.5 2.5" />
          </Show>
        </svg>
      </button>
    </li>
  );
}

/** The list of side chats. */
export function SideList(): JSX.Element {
  const { m, ui } = usePage();
  const about = useAbout();
  const [query, setQuery] = createSignal("");
  const [item, setItem] = createSignal("");
  const [showArchived, setShowArchived] = createSignal(false);

  const archivedCount = createMemo(() => ui.sides().filter((s) => ui.isArchived(s)).length);

  /** Every item a side chat is about, once, in the order of their refs. */
  const items = createMemo(() => {
    const seen = new Map<string, string>();

    for (const s of ui.sides()) {
      const a = about(s);

      if (!seen.has(a.key)) seen.set(a.key, a.label);
    }

    return [...seen].sort((a, b) => (a[0].startsWith("d:") === b[0].startsWith("d:") ? a[1].localeCompare(b[1], undefined, { numeric: true }) : a[0].startsWith("d:") ? -1 : 1));
  });

  const shown = createMemo(() => {
    const words = query().trim().toLowerCase();

    return ui.sides().filter((s) => ui.isArchived(s) === showArchived() && (!item() || about(s).key === item()) && (!words || s.words.includes(words) || about(s).label.toLowerCase().includes(words)));
  });

  const recent = createMemo(() => shown().filter((s) => m.tick() - Date.parse(s.lastAt) < HOUR_MS));
  const earlier = createMemo(() => shown().filter((s) => !(m.tick() - Date.parse(s.lastAt) < HOUR_MS)));

  return (
    <section class="side-list" id="side-list" aria-labelledby="sl-title" hidden={!ui.sideList()}>
      <div class="side-head">
        <button type="button" class="btn small" id="sl-back" onClick={() => ui.openSide(null)}>
          Back to the chat
        </button>
        <h3 class="side-title" id="sl-title">
          Side chats
        </h3>
      </div>
      <div class="sl-tools">
        <label class="vh" for="sl-q">
          Search side chats
        </label>
        <input id="sl-q" type="search" placeholder="Search side chats" autocomplete="off" spellcheck={false} onInput={(e) => setQuery(e.currentTarget.value)} />
        <div class="sl-filters">
          <label class="vh" for="sl-item">
            Item
          </label>
          <select id="sl-item" onChange={(e) => setItem(e.currentTarget.value)}>
            <option value="">All items</option>
            <For each={items()} keyed={(i) => i[0]}>
              {(i) => <option value={i()[0]}>{i()[1]}</option>}
            </For>
          </select>
          <div class="seg" role="group" aria-label="Which side chats">
            <button type="button" id="sl-open" aria-pressed={showArchived() ? "false" : "true"} onClick={() => setShowArchived(false)}>
              Open
            </button>
            <button type="button" id="sl-archived" aria-pressed={showArchived() ? "true" : "false"} onClick={() => setShowArchived(true)}>
              {"Archived" + (archivedCount() ? " " + String(archivedCount()) : "")}
            </button>
          </div>
        </div>
      </div>
      <ol class="sl-rows" id="sl-rows">
        <Show when={recent().length}>
          <li class="sl-group">Last hour</li>
        </Show>
        <For each={recent()} keyed={(s) => s.id}>
          {(s) => <Row s={s()} archived={showArchived()} />}
        </For>
        <Show when={earlier().length}>
          <li class="sl-group">Earlier</li>
        </Show>
        <For each={earlier()} keyed={(s) => s.id}>
          {(s) => <Row s={s()} archived={showArchived()} />}
        </For>
      </ol>
      <Show when={!shown().length}>
        <p class="sl-empty">{query().trim() || item() ? "No side chat matches." : showArchived() ? "No side chat is archived." : "No side chats yet. Select text and press Side chat, or use Side chat on a decision."}</p>
      </Show>
    </section>
  );
}
