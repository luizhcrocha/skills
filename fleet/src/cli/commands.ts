/**
 * Every top-level `fleet` command and its help, in one table: the top-level usage, the unknown-command
 * error, `fleet COMMAND --help` and `fleet search` all read it. A command's help is the text its own module
 * prints (its HELP, else its usage line), never a copy.
 */
import * as Effect from "effect/Effect";

import { USAGE as ADVISOR_USAGE } from "../advisor/advisor.ts";
import { recordingOut } from "../io.ts";
import type { World } from "../world.ts";
import { USAGE as BRIEF_USAGE } from "./brief.ts";
import { HELP as CHAT_HELP } from "./chat.ts";
import { RENDER_USAGE, SERVE_USAGE, SERVED_USAGE, SPEND_USAGE, USAGE_USAGE } from "./control.ts";
import { GATE_USAGE, USAGE as FLEETS_USAGE } from "./fleets.ts";
import { GRANT_HELP, LIST_HELP } from "./grant.ts";
import { HELP as NEWS_HELP } from "./news.ts";
import { HELP as ONEPW_HELP } from "./onepw.ts";
import { USAGE as PREVIEW_SERVE_USAGE } from "./preview-serve.ts";
import { USAGE as PREVIEW_USAGE } from "./preview.ts";
import { HELP as PROJECT_HELP } from "./project.ts";
import { roomCli } from "./room.ts";
import { HELP as STATE_HELP } from "./state.ts";
import { HELP as TAB_HELP } from "./tab.ts";
import { HELP as TEAM_HELP } from "./team.ts";
import { USAGE as TURN_USAGE } from "./turn.ts";
import { HELP as WASTE_HELP } from "./waste.ts";
import { HELP as WORK_HELP } from "./work.ts";
import { USAGE as WS_USAGE } from "./ws.ts";

/** What `fleet search --help` prints. */
export const SEARCH_HELP = `usage: fleet search WORDS...

The fleet commands whose name, summary or options hold these words, best first (a word in the name counts
three times): the top 5, each with the --help that details it. No match lists every command's name.`;

/** One top-level command: its name, its help, and a line on what it is for when its help has none. */
export interface FleetCommand {
  readonly name: string;
  readonly help: string;
  /** What it is for, where its help is a bare usage line (else its help's first sentence says it). */
  readonly about?: string;
}

/** The commands with a help of their own text; `room`'s is read from the command itself (`roomHelp`). */
const TABLE: readonly (FleetCommand | "room")[] = [
  { name: "version", help: "usage: fleet version", about: "this copy of tstack: its version and where it is" },
  { name: "ls", help: "usage: fleet ls", about: "the fleets this machine serves, as `fleet fleets list` prints them" },
  { name: "state", help: STATE_HELP },
  { name: "chat", help: CHAT_HELP },
  {
    name: "fleets",
    help: `${FLEETS_USAGE}\n${GATE_USAGE}`,
    about: "the machine's fleets: those served, what waits on the user, one fleet, the manager, a decision, the gate slot for heavy runs, processes, whose files a landing moves",
  },
  { name: "news", help: NEWS_HELP },
  { name: "secrets", help: ONEPW_HELP },
  {
    name: "ws",
    help: WS_USAGE,
    about: "the jj workspaces a fleet's workers edit in: add one, split a worker's change, list, prune, trash, restore, gc",
  },
  {
    name: "preview",
    help: `${PREVIEW_USAGE}\n${PREVIEW_SERVE_USAGE}`,
    about: "the fleet's live UI preview of every worker's edits: start, status, include or exclude a worker, stop; serve and share previews",
  },
  { name: "brief", help: BRIEF_USAGE, about: "the part of a worker's brief the ledger already holds, composed" },
  { name: "turn", help: TURN_USAGE, about: "whether this fleet holds the landing turn in the manager's landing queue (exit 0) or not (exit 1)" },
  { name: "advisor", help: ADVISOR_USAGE, about: "record the fleet's advisor as a worker row and print the prompt to spawn it with" },
  { name: "team", help: TEAM_HELP },
  { name: "tab", help: TAB_HELP },
  { name: "waste", help: WASTE_HELP },
  { name: "work", help: WORK_HELP },
  { name: "serve", help: SERVE_USAGE, about: "the fleet's host: put DIR's fleet in the registry so its previews are served (--stop takes it out)" },
  { name: "render", help: RENDER_USAGE, about: "render a fleet page from a state file" },
  { name: "usage", help: USAGE_USAGE, about: "keep a status line's rate limits for the account (capture), or print them (show)" },
  { name: "spend", help: SPEND_USAGE, about: "the tokens a fleet's session wrote and read, from its transcript" },
  { name: "served", help: SERVED_USAGE, about: "every port tailscale serve exposes but the dashboards, with its process and fleet" },
  "room",
  { name: "project", help: PROJECT_HELP },
  { name: "grant", help: GRANT_HELP },
  { name: "grants", help: LIST_HELP },
  { name: "search", help: SEARCH_HELP },
];

/** The top-level command names, in usage order. */
export const COMMAND_NAMES: readonly string[] = TABLE.map((c) => (c === "room" ? c : c.name));

/** `fleet room --help`, as the room command prints it. */
function roomHelp(): Effect.Effect<string, never, World> {
  const { layer, recorded } = recordingOut();

  return roomCli(["--help"]).pipe(
    Effect.provide(layer),
    Effect.map(() => recorded.stdout.join("").replace(/\n$/, "")),
  );
}

/** Every top-level command with its help. */
export function fleetCommands(): Effect.Effect<readonly FleetCommand[], never, World> {
  return Effect.gen(function* () {
    const room = yield* roomHelp();

    return TABLE.map((c) => (c === "room" ? { name: "room", help: room } : c));
  });
}

/** The first sentence of a help's description (the first paragraph after its usage lines), else "". */
function firstSentence(help: string): string {
  const lines = help.split("\n");
  const start = lines.findIndex((l, i) => i > 0 && l.trim() !== "" && !l.startsWith("usage: "));

  if (start < 0 || /^\s/.test(lines[start] ?? "")) return "";
  const end = lines.findIndex((l, i) => i > start && (l.trim() === "" || /^\s/.test(l)));
  const paragraph = lines.slice(start, end < 0 ? undefined : end).join(" ");
  const stop = paragraph.search(/\.(\s|$)/);

  return stop < 0 ? paragraph : paragraph.slice(0, stop);
}

/** The longest summary printed, in characters. */
const SUMMARY_MAX = 100;

/** `text` as one line, cut at its first clause and to {@link SUMMARY_MAX} characters. */
export function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const stop = flat.search(/[.;](\s|$)/);
  const clause = stop < 0 ? flat : flat.slice(0, stop);

  return clause.length <= SUMMARY_MAX ? clause : `${clause.slice(0, clause.lastIndexOf(" ", SUMMARY_MAX - 1))}…`;
}

/** The one line on what a command is for. */
export function summaryOf(command: FleetCommand): string {
  return oneLine(command.about ?? firstSentence(command.help));
}
