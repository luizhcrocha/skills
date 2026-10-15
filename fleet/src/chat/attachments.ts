/**
 * Images pasted into the page (the chat's composer, a decision's answer): stored in the fleet's own folder at
 * `attachments/<sha256 prefix>.<ext>`, one file per content, and named by that path on the message that carries
 * them (`images`). The watch line gives each one's absolute path, so the agent it reaches can open it.
 */
import { createHash, randomBytes } from "node:crypto";
import { constants, copyFileSync, linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeDirs, resolvePath } from "../files.ts";
import { asArray, asNumber, asObject, asString, type Json } from "../json.ts";

/** The most bytes one image may have. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Images one message may carry. */
export const MAX_IMAGES = 8;

/** The folder under a fleet's DIR the images are kept in. */
export const ATTACHMENTS = "attachments";

/** Each image type taken, its extension, and whether bytes start as that type's do. */
const KINDS: ReadonlyMap<string, { readonly ext: string; readonly is: (b: Buffer) => boolean }> = new Map([
  ["image/png", { ext: "png", is: (b: Buffer) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) }],
  ["image/jpeg", { ext: "jpg", is: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff }],
  ["image/webp", { ext: "webp", is: (b: Buffer) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" }],
  ["image/gif", { ext: "gif", is: (b: Buffer) => /^GIF8[79]a$/u.test(b.subarray(0, 6).toString("latin1")) }],
]);

const PATH = /^attachments\/[0-9a-f]{16}\.(?:png|jpg|webp|gif)$/u;

const KINDS_REFUSED = "Only a PNG, JPEG, WebP or GIF image can be attached.";

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

/** Make the fleet's `attachments` folder, or say why it cannot be one: a symlink, or not a folder. */
function attachmentsDir(root: string): string | undefined {
  const dir = join(root, ATTACHMENTS);
  const kind = kindAt(dir);

  if (kind === "none") makeDirs(dir);
  else if (kind !== "dir") return undefined;

  return dir;
}

const LINKED = "The fleet's attachments folder is a symlink: the hub keeps images only in a folder of its own.";

/** Write `bytes` to `path` (a seam: a test cuts a write short). */
export type Write = (path: string, bytes: Buffer) => void;

const writeNew: Write = (path, bytes) => writeFileSync(path, bytes, { flag: "wx" });

/** The image type a `Content-Type` names, without parameters and in lower case. */
function typeOf(contentType: string | null): string {
  return (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

/** What a 413 says of an image of `bytes`. */
export function imageTooBig(bytes: number): string {
  return `This image is ${String(Math.ceil(bytes / 1024))} KiB; the most an image can be is ${String(MAX_IMAGE_BYTES / 1024 / 1024)} MB.`;
}

/** Why an upload is refused before its body is read, as [status, error], or undefined: its type and its length. */
export function uploadRefusal(header: (name: string) => string | null): readonly [number, string] | undefined {
  if (!KINDS.has(typeOf(header("Content-Type")))) return [415, KINDS_REFUSED];
  const length = header("Content-Length");

  if (length === null) return [411, "An image is sent with its Content-Length."];

  if (!/^\d+$/u.test(length)) return [400, "bad Content-Length"];

  return Number(length) > MAX_IMAGE_BYTES ? [413, imageTooBig(Number(length))] : undefined;
}

/** Store `bytes` of `contentType` in the fleet at `root`: its path there (`attachments/<hash>.<ext>`), the same
 * for the same bytes, or why it is refused, as [status, error]. The bytes are written to a file of their own in
 * the folder and linked in whole, so a write cut short is never the image; neither the folder nor the image's
 * place is ever a symlink written through. */
export function storeImage(root: string, contentType: string | null, bytes: Buffer, write: Write = writeNew): { readonly path: string } | { readonly refused: readonly [number, string] } {
  const type = typeOf(contentType);
  const kind = KINDS.get(type);

  if (kind === undefined) return { refused: [415, KINDS_REFUSED] };

  if (bytes.length === 0) return { refused: [400, "The image is empty."] };

  if (bytes.length > MAX_IMAGE_BYTES) return { refused: [413, imageTooBig(bytes.length)] };

  if (!kind.is(bytes)) return { refused: [415, `This file is not the ${type} it says it is.`] };
  const path = `${ATTACHMENTS}/${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.${kind.ext}`;
  const target = join(root, path);
  const notOurs = { refused: [500, `${path} is there and is not an image the hub stored: it is left as it is.`] } as const;

  try {
    const dir = attachmentsDir(root);

    if (dir === undefined) return { refused: [500, LINKED] };
    const there = kindAt(target);

    if (there === "file") return { path };

    if (there !== "none") return notOurs;
    const temp = join(dir, `.${randomBytes(8).toString("hex")}.part`);

    try {
      write(temp, bytes);
      linkSync(temp, target);
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;

      if (kindAt(target) !== "file") return notOurs;
    } finally {
      try {
        unlinkSync(temp);
      } catch {
        // Never written.
      }
    }

    return { path };
  } catch (e) {
    return { refused: [500, `Could not store the image: ${e instanceof Error ? e.message : String(e)}`] };
  }
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

/** Copy the images a message of the fleet at `from` names into the fleet at `to`, under the same paths (a copy of
 * the message delivered there names them): the paths that are there now. A copy never replaces what is there
 * (`COPYFILE_EXCL`): the same bytes already there are the image, anything else (other bytes, a symlink) leaves it
 * out, as does a symlinked `attachments` folder. */
export function copyImages(from: string, to: string, value: Json | undefined): string[] {
  return storedImages(value).flatMap((p) => {
    const source = join(from, p);
    const target = join(to, p);

    try {
      if (!isStored(from, p) || attachmentsDir(to) === undefined) return [];

      try {
        copyFileSync(source, target, constants.COPYFILE_EXCL);
      } catch (e) {
        if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;

        return isRegularFile(target) && readFileSync(target).equals(readFileSync(source)) ? [p] : [];
      }

      return [p];
    } catch {
      return [];
    }
  });
}

/** What a mark that was an image alone says once its image did not reach the fleet: a mark has words or an image. */
export const LOST_IMAGE = "(an image that did not reach this fleet)";

/** A batch's marks (`marks.items[].images`) with only the images `kept` names: each item's list cut to them, and
 * dropped when none is left (a delivered copy names only the images that reached its fleet); a mark left with no
 * words then says so ({@link LOST_IMAGE}). */
export function keepMarkImages(marks: Json | undefined, kept: readonly string[]): Json | undefined {
  const batch = asObject(marks);
  const items = asArray(batch?.["items"]);

  if (batch === undefined || items === undefined) return marks;

  return {
    ...batch,
    items: items.map((raw) => {
      const item = asObject(raw);

      if (item?.["images"] === undefined) return raw;
      const { images, ...rest } = item;
      const left = storedImages(images).filter((p) => kept.includes(p));

      if (left.length > 0) return { ...rest, images: left };

      return (asString(rest["comment"]) ?? "").trim() === "" ? { ...rest, comment: LOST_IMAGE } : rest;
    }),
  };
}
