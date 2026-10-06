/**
 * A name the viewer changes in place: the name and a Rename button, which turns it into a field. Enter
 * saves (an empty name gives it back to its automatic source), Escape leaves it as it was, and a refusal
 * stays under the field.
 */
import { createSignal } from "solid-js";
import { Show, type JSX } from "@solidjs/web";

/** What a rename shows and does. */
export interface RenameProps {
  /** The name now, which the field opens with. */
  readonly name: string;
  /** What is renamed, in the button's and the field's labels ("a1", "this fleet"). */
  readonly what: string;
  /** The prefix of the button's and the field's ids. */
  readonly id: string;
  /** Why the viewer may not rename, or "" when they may. */
  readonly denied: string;
  /** Save `name`: "" once it is saved, else why not. */
  readonly save: (name: string) => Promise<string>;
  /** The name as it shows. */
  readonly children: JSX.Element;
}

/** The pencil icon. */
function PencilIcon(): JSX.Element {
  return (
    <svg class="i" viewBox="0 0 24 24" aria-hidden="true" style="width:16px;height:16px">
      <path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4" />
    </svg>
  );
}

/** A name with its Rename control. */
export function Rename(props: RenameProps): JSX.Element {
  const [editing, setEditing] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal("");

  async function commit(field: HTMLInputElement): Promise<void> {
    setBusy(true);
    setProblem("");
    const why = await props.save(field.value);
    setBusy(false);

    if (why === "") {
      setEditing(false);

      return;
    }

    setProblem(why);
    field.focus();
  }

  return (
    <span class="rename">
      <Show
        when={editing()}
        fallback={
          <>
            {props.children}
            <button
              type="button"
              class="icon-btn rename-open"
              id={props.id + "-rename"}
              aria-label={"Rename " + props.what}
              title={props.denied || "Rename " + props.what}
              disabled={props.denied !== ""}
              onClick={() => {
                setProblem("");
                setEditing(true);
              }}
            >
              <PencilIcon />
            </button>
          </>
        }
      >
        <span class="rename-edit">
          <input
            class="rename-field"
            id={props.id + "-field"}
            type="text"
            value={props.name}
            aria-label={"New name for " + props.what + ": Enter saves, an empty name goes back to the automatic one, Escape cancels"}
            aria-describedby={problem() ? props.id + "-why" : undefined}
            readonly={busy()}
            aria-busy={busy() ? "true" : undefined}
            ref={(el) =>
              queueMicrotask(() => {
                el.focus();
                el.select();
              })
            }
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                void commit(e.currentTarget);
              } else if (e.key === "Escape") {
                // Inside the worker sheet, Escape would close the dialog too.
                e.preventDefault();
                e.stopPropagation();
                setEditing(false);
              }
            }}
          />
          <Show when={problem()}>
            <span class="rename-why" id={props.id + "-why"} role="alert">
              {problem()}
            </span>
          </Show>
        </span>
      </Show>
    </span>
  );
}
