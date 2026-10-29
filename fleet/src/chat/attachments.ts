/**
 * Images pasted into the page (the chat's composer, a decision's answer): stored in the fleet's own folder at
 * `attachments/<sha256 prefix>.<ext>`, one file per content, and named by that path on the message that carries
 * them (`images`). The watch line gives each one's absolute path, so the agent it reaches can open it.
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";

import { resolvePath } from "../files.ts";
import { asArray, asNumber, asObject, asString, type Json } from "../json.ts";

/** Images one message may carry. */
export const MAX_IMAGES = 8;

/** The folder under a fleet's DIR the images are kept in. */
export const ATTACHMENTS = "attachments";

const PATH = /^attachments\/[0-9a-f]{16}\.(?:png|jpg|webp|gif)$/u;

/** Whether `path` is a regular file itself, not a symlink to one. */
function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** What is at `path` itself (a symlink is not followed): "none", "file", "dir" or "other". */
function kindAt(path: string): "none" | "file" | "dir" | "other" {
  try {
    const stat = lstatSync(path);

    return stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";
  } catch {
    return "none";
  }
}

/** Whether the fleet at `root` keeps `path` (`attachments/<hash>.<ext>`) as a regular file in a folder of its own:
 * neither the folder nor the file a symlink. */
function isStored(root: string, path: string): boolean {
  return PATH.test(path) && kindAt(join(root, ATTACHMENTS)) === "dir" && isRegularFile(join(root, path));
}

/** The images a post names, checked: each a stored `attachments/<hash>.<ext>` of the fleet at `root`, no more than
 * {@link MAX_IMAGES}, repeats dropped; [] when it names none, undefined when any is not such a file. */
export function imagesOf(root: string, value: Json | undefined): readonly string[] | undefined {
  if (value === undefined || value === null) return [];
  const given = asArray(value);

  if (given === undefined || given.length > MAX_IMAGES) return undefined;
  const paths = given.map((v) => asString(v));

  if (paths.some((p) => p === undefined || !isStored(root, p))) return undefined;

  return [...new Set(paths.flatMap((p) => p ?? []))];
}

/** A mark's images as its batch gives them, their shape only (whether each is stored is `prepare`'s, with
 * `allStored`): at most {@link MAX_IMAGES} `attachments/<hash>.<ext>` paths, repeats dropped; undefined when they
 * are anything else. */
export function imagePathsOf(value: Json): string[] | undefined {
  const given = asArray(value);

  if (given === undefined || given.length > MAX_IMAGES) return undefined;

  const paths = given.flatMap((v) => {
    const p = asString(v);

    return p !== undefined && PATH.test(p) ? [p] : [];
  });

  return paths.length === given.length ? [...new Set(paths)] : undefined;
}

/** Whether each of `paths` is a stored image of the fleet at `root`, a regular file. */
export function allStored(root: string, paths: readonly string[]): boolean {
  return paths.every((p) => isStored(root, p));
}

/** The images on the marks of a batch (`marks.items[].images`), each with its mark's number, in the batch's order. */
export function markImages(marks: Json | undefined): (readonly [number, string])[] {
  return (asArray(asObject(marks)?.["items"]) ?? []).flatMap((raw) => {
    const item = asObject(raw);
    const n = asNumber(item?.["n"]);

    return n === undefined ? [] : storedImages(item?.["images"]).map((p): readonly [number, string] => [n, p]);
  });
}

/** How the watch line names each image on a batch's marks: `[image on mark N: <absolute path>]`. */
export function markImageNotes(root: string, marks: Json | undefined): string[] {
  return markImages(marks).map(([n, p]) => `[image on mark ${String(n)}: ${join(resolvePath(root), p)}]`);
}

/** Why a post's images are refused. */
export const IMAGES_REFUSED = `images are the attachments/<hash>.<png|jpg|webp|gif> files this fleet's page uploaded, at most ${String(MAX_IMAGES)}`;

/** The images a stored message names, as paths under its fleet's DIR. */
export function storedImages(value: Json | undefined): string[] {
  return (asArray(value) ?? []).flatMap((v) => {
    const p = asString(v);

    return p !== undefined && PATH.test(p) ? [p] : [];
  });
}

/** How the watch line names each image of a message of the fleet at `root`: its absolute path. */
export function imageNotes(root: string, value: Json | undefined): string[] {
  return storedImages(value).map((p) => `[image: ${join(resolvePath(root), p)}]`);
}

