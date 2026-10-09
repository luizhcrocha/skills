/**
 * A decision's body where it is read: after the ask and before the recommendation and the options, since it
 * is what the user needs to understand the question. A short body shows whole. A long one shows its start
 * (the body opens with In short and Why this needs you) and a control under it that opens the rest, and
 * folds it again.
 */
import { createSignal, onCleanup } from "solid-js";
import { Show, type JSX } from "@solidjs/web";

import { tf } from "./bits.tsx";

/** A body taller than this, in pixels, is long: it folds. */
export const FOLD_PX = 900;

/** How much of a folded body shows, in pixels. */
export const FOLDED_PX = 640;

/** `children` (the body's section), folded while long and not opened. */
export function DetailsFold(props: { readonly what: string; readonly children: JSX.Element }): JSX.Element {
  const [long, setLong] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  let watch: ResizeObserver | undefined;

  const measure = (el: HTMLDivElement): void => {
    if (!("ResizeObserver" in globalThis)) return;
    watch = new ResizeObserver(() => setLong(el.scrollHeight > FOLD_PX));
    watch.observe(el);
  };

  onCleanup(() => watch?.disconnect());

  return (
    <div class={"dv-fold" + (long() && !open() ? " folded" : "")}>
      <div class="dv-fold-in" ref={measure}>
        {props.children}
      </div>
      <Show when={long()}>
        <button type="button" class="btn small dv-fold-toggle" aria-expanded={tf(open())} onClick={() => setOpen(!open())}>
          {open() ? `Fold ${props.what}` : `Show all ${props.what}`}
        </button>
      </Show>
    </div>
  );
}
