/**
 * Images pasted into a field where Luiz writes to the fleet (the chat's composer, a decision's answer), or picked
 * with the attach button where a phone's paste gives no file: each checked here, uploaded to the hub's
 * `attachments` (only the fleet's own page may: the page token, as a grant), and named by the path the hub gives
 * on the message that carries them (`images`). `pastedImages` and `filesOf` are picasso's
 * (client/src/image-attach.js), typed.
 */
import { createSignal } from "solid-js";

import { pageToken } from "./chat-headers.ts";
import type { Json, JsonRecord } from "./core.ts";

/** The image types the hub takes. */
export const IMAGE_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

/** The most bytes one image may have (the hub's `MAX_IMAGE_BYTES`). */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Images one message may carry (the hub's `MAX_IMAGES`). */
export const MAX_IMAGES = 8;

const isRecord = (v: Json | undefined): v is JsonRecord => v !== null && v !== undefined && Object(v) === v && !Array.isArray(v);

const isImageFile = (f: File | null): f is File => f !== null && f.type.startsWith("image/");

/** What a paste or a drop carries, as far as images go: a `DataTransfer`. */
export interface Carried {
  getData(format: string): string;
  readonly items?: ArrayLike<{ readonly kind: string; readonly type: string; getAsFile(): File | null }>;
  readonly files?: ArrayLike<File>;
}

function filesOf(data: Carried): File[] {
  const fromItems = Array.from(data.items ?? []).flatMap((it) => {
    const f = it.kind === "file" && it.type.startsWith("image/") ? it.getAsFile() : null;

    return isImageFile(f) ? [f] : [];
  });

  return fromItems.length ? fromItems : Array.from(data.files ?? []).filter(isImageFile);
}

/** The image files a paste carries, or none when it carries text: an office app copies a picture of what was
 * copied along with its text, and the text is what Luiz meant. */
export function pastedImages(data: Carried | null): File[] {
  if (!data) return [];

  if ((data.getData("text/plain") || "").trim() !== "") return [];

  return filesOf(data);
}

const isText = (v: Json | undefined): v is string => v === String(v);

/** Why `file` is not taken, before it is sent, or "" when it is (the hub's words). */
export function imageRefusal(file: File): string {
  if (!IMAGE_TYPES.includes(file.type)) return "Only a PNG, JPEG, WebP or GIF image can be attached.";

  if (file.size > MAX_IMAGE_BYTES) return `This image is ${String(Math.ceil(file.size / 1024))} KiB; the most an image can be is ${String(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`;

  return "";
}

/** Upload `file` to the hub: its path there, or why not. */
export async function uploadImage(file: File): Promise<{ readonly path: string } | { readonly error: string }> {
  const token = pageToken();
  const headers: Record<string, string> = token === "" ? { "Content-Type": file.type } : { "Content-Type": file.type, "X-Fleet-Page-Token": token };

  try {
    const res = await fetch("attachments", { method: "POST", headers, body: file });
    let data: Json = null;

    try {
      data = await res.json();
    } catch {
      data = null;
    }

    const path = isRecord(data) ? data["path"] : undefined;
    const error = isRecord(data) ? data["error"] : undefined;

    if (res.status === 201 && isText(path)) return { path };

    return { error: isText(error) ? error : `The server refused the image (${String(res.status)}).` };
  } catch {
    return { error: "Could not reach the dashboard's server to send the image." };
  }
}

/** Whether this page is a peer hub's fleet (`/f/<fleet>@<machine>/`): that hub takes no upload from this one's
 * page, so the page has no attach button there and a paste of an image is the browser's. */
export function onPeerFleet(): boolean {
  const segment = /^\/f\/([^/]+)\//u.exec(location.pathname)?.[1] ?? "";

  try {
    return decodeURIComponent(segment).includes("@");
  } catch {
    return false;
  }
}

/** Why one more image is not taken when `held` are in the tray and `taken` are on what it adds to already. */
function tooMany(held: number, taken: number): string {
  if (held + taken < MAX_IMAGES) return "";

  return taken > 0 ? `${String(MAX_IMAGES)} images at most go together; ${String(taken)} are there already.` : `${String(MAX_IMAGES)} images at most go together.`;
}

/** The images of one field until its message is sent. */
export interface Attachments {
  /** The paths the hub gave, in the order added. */
  readonly paths: () => readonly string[];
  /** Images being uploaded. */
  readonly busy: () => number;
  /** Why the last image was not taken, or "". */
  readonly error: () => string;
  /** Take `files`: checked, then uploaded. */
  readonly add: (files: readonly File[]) => void;
  readonly remove: (path: string) => void;
  readonly clear: () => void;
  /** Start again from `paths` (a saved draft's images, opened to edit). */
  readonly seed: (paths: readonly string[]) => void;
  /** A paste on a field: its images taken, and the browser's paste stopped; a paste of text left to the browser. */
  readonly onPaste: (e: ClipboardEvent) => void;
}

/** A field's images. `taken` counts the images already on what the field adds to (a waiting comment a reply joins,
 * a side chat's waiting words its post joins): with the tray's, never more than {@link MAX_IMAGES}. Images are
 * not kept across a reload, as a draft's words are. */
export function createAttachments(taken: () => number = () => 0): Attachments {
  const [paths, setPaths] = createSignal<readonly string[]>([]);
  const [busy, setBusy] = createSignal(0);
  const [error, setError] = createSignal("");
  /* Bumped by `clear` and `seed`: an upload started before lands nowhere (the field is another thread's now). */
  let generation = 0;

  function add(files: readonly File[]): void {
    if (onPeerFleet()) return;
    setError("");
    /* Counted here: a signal set in this loop reads as it was until the next flush. */
    let held = paths().length + busy();

    for (const file of files) {
      const why = imageRefusal(file) || tooMany(held, taken());

      if (why) {
        setError(why);
        continue;
      }

      const mine = generation;

      held += 1;
      setBusy((n) => n + 1);
      void uploadImage(file).then((got) => {
        if (mine !== generation) return;
        setBusy((n) => n - 1);

        if ("error" in got) setError(got.error);
        else if (!paths().includes(got.path)) setPaths((p) => [...p, got.path]);
      });
    }
  }

  const restart = (given: readonly string[]): void => {
    generation += 1;
    setBusy(0);
    setPaths([...new Set(given)]);
    setError("");
  };

  return {
    paths,
    busy,
    error,
    add,
    remove: (path) => setPaths((p) => p.filter((x) => x !== path)),
    clear: () => restart([]),
    seed: restart,
    onPaste: (e) => {
      const files = onPeerFleet() ? [] : pastedImages(e.clipboardData);

      if (!files.length) return;
      e.preventDefault();
      add(files);
    },
  };
}
