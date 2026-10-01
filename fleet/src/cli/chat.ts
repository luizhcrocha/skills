/**
 * `fleet chat DIR COMMAND …` (Python's `chat.py`): say, inbox, log, watch, wait. Every message prints as
 * exactly one line.
 */
import { readFileSync } from "node:fs";

import * as Effect from "effect/Effect";

import { append, openFor, renderLines, type Draft } from "../chat/chat.ts";
import { readChat } from "../chat/store.ts";
import { wait, watch } from "../chat/watch.ts";
import { stampOf } from "../clock.ts";
import { ChatError, UsageError } from "../errors.ts";
import { resolvePath } from "../files.ts";
import { Out } from "../io.ts";
import { World, type Machine } from "../world.ts";
import { opt, parseCommand, usageWidth, type CommandSpec } from "./args.ts";
import { exitOf, printUsage } from "./exit.ts";

const AS = { flag: "--as", dest: "who", takes: "value", required: true } as const;

/** Each chat command and what it takes, as chat.py's argparse declares them. */
export const CHAT_COMMANDS: readonly CommandSpec[] = [
  {
    name: "say",
    positionals: [{ dest: "text" }],
    options: [AS, opt.value("--re", { int: true }), opt.value("--decision", { metavar: "D" })],
    optionsFirst: true,
  },
  { name: "inbox", positionals: [], options: [AS] },
  { name: "wait", positionals: [{ dest: "decision", nargs: "+" }], options: [] },
  {
    name: "watch",
    positionals: [],
    options: [AS, opt.value("--after", { int: true }), opt.flag("--all"), opt.flag("--resume"), opt.flag("--once")],
  },
  { name: "log", positionals: [], options: [opt.value("--after", { int: true })] },
];

const PROG = "chat.py";

const HELP = `usage: ${PROG} DIR {say,inbox,wait,watch,log} ...

The chat between the user (on the dashboard) and the fleet, stored in DIR/chat.jsonl.

    say   --as WHO [--re N] [--decision D] TEXT   append a message from WHO; print the line written
    inbox --as WHO                                the messages open for WHO, oldest first
    watch --as WHO [--after N | --resume] [--all] [--once]
                                                  what is open for WHO, then each new message as it lands
    wait  DECISION...                             wait for the user's answer to one of these decisions
    log   [--after N]                             the whole conversation, oldest first`;

/** Whether the command line's own bytes for argument `at` (after the program) are valid UTF-8: Bun reads
 * argv with replacement, so a text that is not UTF-8 is told by /proc/self/cmdline. */
function argIsUtf8(text: string): boolean {
  if (!text.includes("�")) return true;

  try {
    const raw = readFileSync("/proc/self/cmdline");
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let start = 0;

    for (let i = 0; i < raw.length; i += 1) {
      if (raw[i] !== 0) continue;

      try {
        decoder.decode(raw.subarray(start, i));
      } catch {
        return false;
      }

      start = i + 1;
    }

    return true;
  } catch {
    return true;
  }
}

function lines(machine: Machine, root: string, messages: Parameters<typeof renderLines>[2]): Effect.Effect<void, never, Out> {
  return Effect.gen(function* () {
    const out = yield* Out;

    for (const line of renderLines(machine, root, messages)) out.out(`${line}\n`);
  });
}

function runCommand(machine: Machine, argv: readonly string[]): Effect.Effect<void, ChatError | UsageError | "help", Out> {
  return Effect.gen(function* () {
    const parsed = parseCommand(PROG, CHAT_COMMANDS, argv, usageWidth(machine.env, process.stdout.isTTY ? process.stdout.columns : undefined));

    if (parsed === "help" || parsed instanceof UsageError) return yield* Effect.fail(parsed);
    const { dir, args } = parsed;
    const cmd = parsed.spec.name;
    const root = resolvePath(dir);
    const who = args.str("who") ?? "";

    if (cmd === "say") {
      const given = args.str("text") ?? "";
      // A text whose bytes are not UTF-8 is refused where Python refuses it, after its sender and `re`.
      const text = argIsUtf8(given) ? given : "\uD800";
      const decision = args.str("decision");

      const draft: Draft = { sender: who, text, re: args.int("re") ?? null };
      const sent = append(machine, root, decision === undefined ? draft : { ...draft, decision }, stampOf(machine.now()));

      if (sent instanceof ChatError) return yield* Effect.fail(sent);
      yield* lines(machine, root, [sent]);
    } else if (cmd === "inbox") {
      const open = openFor(machine, root, who);

      if (open instanceof ChatError) return yield* Effect.fail(open);
      yield* lines(machine, root, open);
    } else if (cmd === "log") {
      yield* lines(machine, root, readChat(root, args.int("after") ?? 0));
    } else if (cmd === "watch") {
      yield* watch(machine, root, {
        who,
        after: args.int("after") ?? 0,
        all: args.flag("all"),
        resume: args.flag("resume"),
        once: args.flag("once"),
      });
    } else {
      yield* wait(machine, root, args.list("decision") ?? []);
    }
  });
}

/** Run `fleet chat` with `argv` (after `chat`); the exit code. */
export function chatCli(argv: readonly string[]): Effect.Effect<number, never, Out | World> {
  return Effect.gen(function* () {
    const machine = yield* World;

    return yield* runCommand(machine, argv).pipe(
      Effect.as(0),
      Effect.catch((failure) => (failure === "help" ? printUsage(HELP) : exitOf(failure))),
    );
  });
}
