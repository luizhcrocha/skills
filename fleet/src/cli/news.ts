/**
 * `fleet news post|read|list` (Python's `news.py`): the machine's news, which wakes nobody.
 */
import * as Effect from "effect/Effect";

import { Refusal, UsageError } from "../errors.ts";
import { Out } from "../io.ts";
import { pyStr } from "../json.ts";
import { KINDS, markRead, newsLine, post, readerName, readNews, unread } from "../news/news.ts";
import { World, type Machine } from "../world.ts";
import { formatUsage, opt, parseArgs, usageWidth, type CommandSpec } from "./args.ts";
import { exitOf, printUsage } from "./exit.ts";

const PROG = "fleet news";

/** Each news command and what it takes, as news.py's argparse declares them. */
export const NEWS_COMMANDS: readonly CommandSpec[] = [
  {
    name: "post",
    positionals: [{ dest: "text" }],
    options: [
      { ...opt.value("--from", { required: true, metavar: "NAME" }), dest: "sender" },
      opt.value("--to", { metavar: "all|FLEET[,FLEET...]" }),
      opt.value("--kind", { choices: KINDS }),
      opt.flag("--keep"),
    ],
    optionsFirst: true,
  },
  { name: "read", positionals: [], options: [{ flag: "--as", dest: "who", takes: "value", required: true }] },
  { name: "list", positionals: [], options: [] },
];

const HELP = `usage: ${PROG} [-h] {post,read,list} ...

The machine's news: what a session tells the fleets that wakes nobody (release notes, FYIs, rules).

    post --from NAME [--to all|FLEET[,FLEET...]] [--kind release|fyi|rule] [--keep] TEXT
                                    append an item to REGISTRY/news/news.jsonl; print its line
    read --as FLEET                 the items FLEET has not read, oldest first; moves FLEET's cursor
    list                            every item, oldest first

A reader sees an item addressed to \`all\` or to it, never its own. A coordinator learns of unread news
from one line its chat watch prints when it wakes for a real message, from every \`fleet state\` command,
and from the plugin's SessionStart and Stop hooks. \`--keep\` marks a durable rule; the default is do not save.`;

function run(machine: Machine, argv: readonly string[]): Effect.Effect<void, Refusal | UsageError | "help", Out> {
  return Effect.gen(function* () {
    const out = yield* Out;
    const width = usageWidth(machine.env, process.stdout.isTTY ? process.stdout.columns : undefined);
    const names = NEWS_COMMANDS.map((c) => c.name);
    const top = (reason: string): UsageError => new UsageError({ prog: PROG, usage: formatUsage(PROG, ["[-h]"], [`{${names.join(",")}} ...`], width), reason });
    const [cmd, ...rest] = argv;

    if (cmd === "-h" || cmd === "--help") return yield* Effect.fail("help" as const);

    if (cmd === undefined) return yield* Effect.fail(top("the following arguments are required: cmd"));
    const spec = NEWS_COMMANDS.find((c) => c.name === cmd);

    if (spec === undefined) return yield* Effect.fail(top(`argument cmd: invalid choice: ${pyStr(cmd)} (choose from ${names.map((n) => pyStr(n)).join(", ")})`));
    const parsed = parseArgs(`${PROG} ${cmd}`, spec, rest, width);

    if (parsed === "help" || parsed instanceof UsageError) return yield* Effect.fail(parsed);

    if (parsed.extras.length > 0) return yield* Effect.fail(top(`unrecognized arguments: ${parsed.extras.join(" ")}`));
    const { args } = parsed;

    if (cmd === "post") {
      const item = post(machine, {
        from: args.str("sender") ?? "",
        to: args.str("to") ?? "all",
        kind: args.str("kind") ?? "fyi",
        keep: args.flag("keep"),
        text: args.str("text") ?? "",
      });

      if (item instanceof Refusal) return yield* Effect.fail(item);
      out.out(`${newsLine(item)}\n`);
    } else if (cmd === "read") {
      const fleet = readerName(args.str("who") ?? "");

      if (fleet instanceof Refusal) return yield* Effect.fail(fleet);
      const items = readNews(machine);
      const fresh = unread(machine, fleet);

      for (const i of fresh) out.out(`${newsLine(i)}\n`);

      if (fresh.length === 0) out.out(`no news for ${fleet}\n`);
      markRead(machine, fleet, items);
    } else {
      const items = readNews(machine);

      for (const i of items) out.out(`${newsLine(i)}\n`);

      if (items.length === 0) out.out("no news\n");
    }
  });
}

/** Run `fleet news` with `argv` (after `news`); the exit code. */
export function newsCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    return yield* run(machine, argv).pipe(
      Effect.as(0),
      Effect.catch((failure) => (failure === "help" ? printUsage(HELP) : exitOf(failure))),
    );
  });
}
