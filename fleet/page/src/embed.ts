/**
 * What a fleet's page in the manager's frame (`?embed=1`) tells the manager, posted to its own origin only:
 * its height, `{fleetEmbed: true, height}`, and an answer sent there, `{fleetEmbed: true, answered}`.
 */
import type { Json, JsonRecord } from "./core.ts";

/** A message from the frame, as the manager reads it. */
export type EmbedMessage = { readonly kind: "height"; readonly height: number } | { readonly kind: "answered"; readonly id: string };

/** The tallest a frame is made, whatever height it reports. */
export const FRAME_MAX_PX = 20_000;

const isRecord = (v: Json | undefined): v is JsonRecord => v !== null && v !== undefined && Object(v) === v && !Array.isArray(v);

/** A message as the frame posts it, or null for anything else (the evidence frame's, another page's). */
export function parseEmbedMessage(data: Json | undefined): EmbedMessage | null {
  if (!isRecord(data) || data["fleetEmbed"] !== true) return null;
  const height = data["height"];
  const answered = data["answered"];

  if (height === Number(height) && Number(height) > 0) return { kind: "height", height: Number(height) };

  return answered === String(answered) && answered ? { kind: "answered", id: String(answered) } : null;
}

const post = (data: Json): void => parent.postMessage(data, location.origin);

export const postHeight = (): void => post({ fleetEmbed: true, height: Math.ceil(document.documentElement.getBoundingClientRect().height) });

export const postAnswered = (id: string): void => post({ fleetEmbed: true, answered: id });
