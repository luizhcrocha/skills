/**
 * `fleet tell FLEET|all TEXT…`: the user's own words to a fleet's coordinator (or the manager), from a
 * terminal, through the same door as the page: a POST to the hub's `/f/<fleet>/chat` on loopback, so the
 * message is the user's, read and answered as one typed on the page. `@worker` in the text addresses a
 * worker as on the page. `all` tells every fleet this machine serves.
 *
 * Refused inside a Claude Code session (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`): an agent writes as itself
 * with `fleet chat DIR say --as <its id>`, never as the user.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { runningHub } from "../hub/server.ts";
import { Out } from "../io.ts";
import { asNumber, asObject, asString, parseObject } from "../json.ts";
import type { Entry } from "../registry.ts";
import { World } from "../world.ts";
import { fleetsNamed } from "./run.ts";

const USAGE = "usage: fleet tell FLEET|all TEXT...\n";

/** What one fleet's hub said to the message. */
interface Told {
  readonly fleet: string;
  readonly line: string;
  readonly ok: boolean;
}

async function tellOne(port: number, fleet: Entry, text: string): Promise<Told> {
  try {
    const answer = await fetch(`http://127.0.0.1:${String(port)}/f/${encodeURIComponent(fleet.id)}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });

    const body = asObject(Option.getOrUndefined(parseObject(await answer.text())));

    if (answer.status !== 201) return { fleet: fleet.id, line: `refused (${String(answer.status)}): ${asString(body?.["error"]) ?? "no reason given"}`, ok: false };
    const message = asObject(body?.["message"]) ?? body;
    const id = asNumber(message?.["id"]);
    const to = message?.["to"];

    return { fleet: fleet.id, line: `#${id === undefined ? "?" : String(id)} to ${Array.isArray(to) ? to.join(", ") : "the fleet"}`, ok: true };
  } catch (cause: unknown) {
    return { fleet: fleet.id, line: `the hub did not answer: ${cause instanceof Error ? cause.message : String(cause)}`, ok: false };
  }
}

export function tellCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const machine = yield* World;
    const [target, ...words] = argv;
    const text = words.join(" ").trim();

    if (target === undefined || text === "") {
      out.err(USAGE);

      return 2;
    }

    if ((machine.env("CLAUDECODE") ?? "") !== "" || (machine.env("CLAUDE_CODE_SESSION_ID") ?? "") !== "") {
      out.err("tell: this is the user's own voice, for a terminal outside Claude Code; an agent writes as itself: `fleet chat DIR say --as <its id> TEXT`\n");

      return 1;
    }

    const hub = runningHub(machine.registry.place.home);

    if (hub === undefined) {
      out.err("tell: no hub runs on this machine (`systemctl --user start fleet-hub`), and the user's words go through it\n");

      return 1;
    }

    const live = machine.registry.live();
    const fleets = target === "all" ? live : fleetsNamed(live, target);

    if (fleets.length === 0) {
      out.err(`tell: no fleet '${target}' is served here; \`fleet ls\` lists them\n`);

      return 1;
    }

    if (target !== "all" && fleets.length > 1) {
      out.err(`tell: '${target}' fits ${fleets.map((e) => e.id).sort().join(", ")}: give more of the name, or \`all\`\n`);

      return 2;
    }

    const told = yield* Effect.promise(() => Promise.all(fleets.map((f) => tellOne(hub.port, f, text))));

    for (const t of told) (t.ok ? out.out : out.err)(`${t.fleet}: ${t.line}\n`);

    return told.every((t) => t.ok) ? 0 : 1;
  });
}
