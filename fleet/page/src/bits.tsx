/**
 * The small pieces every view uses: the context the components read the model from, a state pill, a row's
 * number, a worker's name as a control that opens it, a moment, the icons, and a listener for a component's life.
 */
import { createContext, onCleanup, useContext } from "solid-js";
import { Show, type JSX } from "@solidjs/web";

import { clock, fullTime } from "./format.ts";
import type { Model } from "./model.ts";
import type { Ui } from "./ui.ts";

/** Listen on `target` while the component lives. */
export function listen<K extends keyof DocumentEventMap>(target: Document, type: K, fn: (e: DocumentEventMap[K]) => void): void;
export function listen<K extends keyof WindowEventMap>(target: Window, type: K, fn: (e: WindowEventMap[K]) => void): void;
export function listen(target: Document | Window, type: string, fn: (e: Event) => void): void {
  target.addEventListener(type, fn);
  onCleanup(() => target.removeEventListener(type, fn));
}

/** What every component reads: the model and the viewer's controls. */
export interface Page {
  readonly m: Model;
  readonly ui: Ui;
}

/** The page's context. */
export const PageContext = createContext<Page>();

/** The model and the controls of the page being rendered. */
export const usePage = (): Page => useContext(PageContext);

/** A state, said in a word. */
export function Pill(props: { readonly s: string | null | undefined }): JSX.Element {
  return (
    <Show when={props.s}>
      <span class={"pill " + String(props.s)}>{props.s}</span>
    </Show>
  );
}

/** A pill with its own class and words. */
export function PillAs(props: { readonly cls: string; readonly text: string }): JSX.Element {
  return <span class={"pill " + props.cls}>{props.text}</span>;
}

/** The number a row goes by (D3, A1, L2, R1), to refer to it in the chat and in the session. */
export function RefTag(props: { readonly of: { readonly ref?: string | undefined } | null | undefined }): JSX.Element {
  return (
    <Show when={props.of?.ref}>
      <span class="ref">{props.of?.ref}</span>{" "}
    </Show>
  );
}

/** A worker's or a coordinator's name as a control that opens it; anyone else's as plain text. */
export function Who(props: { readonly id: string | null | undefined; readonly extra?: string }): JSX.Element {
  const { m } = usePage();

  return (
    <Show when={m.person(props.id)} fallback={<span class="by">{props.id || m.host()}</span>}>
      {(p) => (
        <button type="button" class={"who " + (props.extra ?? "")} data-agent={p().id} style={`--c:${m.colorOf(p().id)}`}>
          <span class="swatch" />
          <span>{p().name}</span>
        </button>
      )}
    </Show>
  );
}

/** A moment: "5 min ago" (kept current) or its clock time, the full date and time on hover. */
export function When(props: { readonly at: string | null | undefined; readonly relative?: boolean }): JSX.Element {
  const { m } = usePage();
  const valid = (): boolean => !isNaN(new Date(String(props.at ?? "")).getTime());

  return (
    <Show when={valid()}>
      <time datetime={String(props.at)} title={fullTime(props.at)} data-ago={props.relative ? "" : undefined}>
        {props.relative ? m.ago(props.at) : clock(props.at)}
      </time>
    </Show>
  );
}

/** A close (x) icon. */
export function CloseIcon(props: { readonly small?: boolean }): JSX.Element {
  return (
    <svg class="i" viewBox="0 0 24 24" aria-hidden="true" style={props.small ? "width:16px;height:16px" : undefined}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

/** The chat bubble icon. */
export function ChatIcon(): JSX.Element {
  return (
    <svg class="i" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20.5 12a8.5 8.5 0 0 1-12.4 7.5L3.5 20.5l1-4.4A8.5 8.5 0 1 1 20.5 12z" />
    </svg>
  );
}

/** The fleet mark: one hub, three workers. */
export function Mark(): JSX.Element {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
      <rect width="64" height="64" rx="14" fill="#1e1b4b" />
      <path d="M32 33L15 19M32 33l17-14M32 33v18" stroke="#a5b4fc" stroke-width="4" stroke-linecap="round" />
      <circle cx="15" cy="19" r="7" fill="#818cf8" />
      <circle cx="49" cy="19" r="7" fill="#818cf8" />
      <circle cx="32" cy="51" r="7" fill="#818cf8" />
      <circle cx="32" cy="33" r="10" fill="#eef2ff" />
    </svg>
  );
}

/** A boolean as an ARIA state's words. */
export const tf = (on: boolean): "true" | "false" => (on ? "true" : "false");
