/**
 * The list under the caret, for any field whose text goes to a session as words: skills while the text
 * starts with "/", and, where the field asks for them, people after an "@". A caret owns its field's open
 * list, the keys that move through it, pick from it and close it, and the field's combobox state; the
 * list's view is `CaretList`. Every caret of the page shares one open list, so opening one closes the
 * others. The lists live in signals no update of the fleet's state touches.
 */
import { createEffect, createSignal, flush } from "solid-js";

import { Core, type RosterRow, type Skill, type TokenAt } from "./core.ts";
import type { Model } from "./model.ts";

/** An open list under the caret: people to mention, or skills to run. */
export type Pick =
  | { readonly kind: "mention"; readonly items: readonly RosterRow[]; readonly at: TokenAt }
  | { readonly kind: "command"; readonly items: readonly Skill[]; readonly at: TokenAt };

/** A field a caret list attaches to. */
export type Field = HTMLTextAreaElement | HTMLInputElement;

/** What a caret is for. */
export interface CaretOptions {
  /** The listbox element's id. */
  readonly id: string;
  /** The start of each option's id, followed by its index; the listbox's id and "-" when not given. */
  readonly option?: string;
  /** Whether "@" lists people too; "/" lists skills in every field. */
  readonly mentions?: boolean;
  /** The field, when the caller holds it; else the one given to `attach`. */
  readonly field?: () => Field | undefined;
}

/** One field's list under the caret. */
export interface Caret {
  readonly id: string;
  /** The open list, when it is this field's. */
  list(): Pick | null;
  /** The highlighted row. */
  index(): number;
  setIndex(i: number): void;
  /** The id of option `i`, for aria-activedescendant. */
  optionId(i: number): string;
  field(): Field | undefined;
  /** Open, narrow or close the list from the field's text and caret. */
  update(): void;
  /** Put row `i` in the field, the caret after it; the field hears an input event. */
  pick(i: number): void;
  close(): void;
  /** A key while the list is open: arrows move, Enter or Tab pick, Escape closes. True when it acted. */
  key(e: KeyboardEvent): boolean;
  /** Attach to a field the caller does not wire itself: its listeners and its combobox state. */
  attach(el: Field): void;
}

/** The page's carets, over the model `m`. */
export type Carets = ReturnType<typeof createCarets>;

/** The carets of the page over the model `m`: one open list at a time. */
export function createCarets(m: Model) {
  const [open, setOpen] = createSignal<{ readonly owner: number; readonly pick: Pick } | null>(null);
  const [index, setIndex] = createSignal(0);
  let made = 0;

  /** A caret for one field. */
  function make(o: CaretOptions): Caret {
    const owner = ++made;
    const prefix = o.option ?? o.id + "-";
    let attached: Field | undefined;
    let dismissed = -1;
    const field = (): Field | undefined => o.field?.() ?? attached;

    const list = (): Pick | null => {
      const s = open();

      return s && s.owner === owner ? s.pick : null;
    };

    const close = (): void => {
      if (open()?.owner === owner) setOpen(null);
    };

    const show = (pick: Pick, same: boolean): void => {
      const i = same ? Math.min(index(), pick.items.length - 1) : 0;
      setOpen({ owner, pick });
      setIndex(i);
    };

    function update(): void {
      const el = field();

      if (!el) return;
      const caret = el.selectionStart ?? el.value.length;
      const collapsed = caret === el.selectionEnd && document.activeElement === el;
      const command = collapsed ? Core.commandAt(el.value, caret) : null;
      const at = collapsed && !command && o.mentions ? Core.mentionAt(el.value, caret) : null;
      const token = command ?? at;

      if (!token || token.start === dismissed) {
        if (!token) dismissed = -1;
        close();
        flush();

        return;
      }

      const was = list();
      const same = was !== null && was.at.query === token.query && was.at.start === token.start && was.kind === (command ? "command" : "mention");

      if (command) {
        if (!m.skillsFresh()) {
          void m.loadSkills().then(() => {
            const now = field();

            if (now && document.activeElement === now && Core.commandAt(now.value, now.selectionStart)?.query === command.query) update();
          });
        }

        const items = Core.filterSkills(m.skills(), command.query);

        if (items.length) show({ kind: "command", items, at: command }, same);
        else close();
      } else if (at) {
        const items = Core.filterRoster(m.roster(), at.query);

        if (items.length) show({ kind: "mention", items, at }, same);
        else close();
      }

      flush();
    }

    function pick(i: number): void {
      const shown = list();
      const el = field();

      if (!shown || !el) return;
      const out = shown.kind === "command" ? (shown.items[i] ? Core.insertCommand(el.value, shown.at, shown.items[i]) : null) : shown.items[i] ? Core.insertMention(el.value, shown.at, shown.items[i]) : null;

      if (!out) return;
      el.value = out.text;
      el.setSelectionRange(out.caret, out.caret);
      close();
      el.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
    }

    function key(e: KeyboardEvent): boolean {
      const shown = list();

      if (!shown) return false;
      const action = Core.keyOf(e, false, true);

      if (action === "next" || action === "prev") {
        e.preventDefault();
        setIndex((index() + (action === "next" ? 1 : -1) + shown.items.length) % shown.items.length);
        flush();

        return true;
      }

      if (action === "pick") {
        e.preventDefault();
        pick(index());

        return true;
      }

      if (action === "close") {
        e.preventDefault();
        e.stopPropagation();
        dismissed = shown.at.start;
        close();
        flush();

        return true;
      }

      return false;
    }

    function attach(el: Field): void {
      attached = el;
      el.setAttribute("role", "combobox");
      el.setAttribute("aria-autocomplete", "list");
      el.setAttribute("aria-controls", o.id);
      el.setAttribute("aria-expanded", "false");
      const node: HTMLElement = el;
      node.addEventListener("input", update);
      node.addEventListener("click", update);
      node.addEventListener("keydown", (e) => void key(e));
      node.addEventListener("keyup", (e) => {
        if (/^(Arrow(Left|Right)|Home|End)$/u.test(e.key)) update();
      });
      node.addEventListener("blur", () => {
        close();
        flush();
      });
    }

    /* An attached field says whether its list is open and which row is highlighted. */
    createEffect(
      () => {
        const shown = list();

        return shown ? index() : -1;
      },
      (i) => {
        if (!attached) return;
        attached.setAttribute("aria-expanded", i >= 0 ? "true" : "false");

        if (i >= 0) attached.setAttribute("aria-activedescendant", prefix + String(i));
        else attached.removeAttribute("aria-activedescendant");
      },
    );

    return { id: o.id, list, index, setIndex, optionId: (i) => prefix + String(i), field, update, pick, close, key, attach };
  }

  return {
    make,
    /** Close whichever list is open. */
    close: (): void => {
      setOpen(null);
    },
  };
}
