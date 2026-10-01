/**
 * Command lines parsed and refused as Python 3.13's argparse parses and refuses the fleet's: options
 * anywhere among the positionals, `--opt value` and `--opt=value`, a unique prefix for a long option,
 * appends, `nargs` `*`, `?` and `+`, choices, int values, required options, mutually exclusive groups;
 * and its usage text (wrapped to `COLUMNS`, else 80, less 2) and error wording, byte for byte. A
 * subcommand's error is the subcommand's; unrecognized arguments are the top parser's, as in argparse.
 */
import { UsageError } from "../errors.ts";
import { pyStr } from "../json.ts";

/** How an option takes its value. */
export type Takes = "value" | "flag" | "append" | "star";

/** One option of a command. */
export interface OptionSpec {
  readonly flag: string;
  readonly dest: string;
  readonly takes: Takes;
  readonly choices?: readonly string[];
  readonly int?: boolean;
  readonly required?: boolean;
  readonly metavar?: string;
}

/** One positional argument of a command. */
export interface PositionalSpec {
  readonly dest: string;
  readonly nargs?: "?" | "+";
}

/** A command (or a subcommand) and what it takes, in the order argparse declares them. */
export interface CommandSpec {
  readonly name: string;
  readonly options: readonly OptionSpec[];
  readonly positionals: readonly PositionalSpec[];
  readonly exclusive?: readonly (readonly string[])[];
  /** Whether the options were declared before the positionals (the order argparse names missing ones in). */
  readonly optionsFirst?: boolean;
}

/** One parsed argument. */
type Value =
  | { readonly kind: "str"; readonly value: string }
  | { readonly kind: "list"; readonly value: readonly string[] }
  | { readonly kind: "flag" }
  | { readonly kind: "int"; readonly value: number };

/** The parsed arguments of one command, by destination. */
export class Args {
  private readonly values: ReadonlyMap<string, Value>;

  constructor(values: ReadonlyMap<string, Value>) {
    this.values = values;
  }

  /** A string argument, or undefined when not given. */
  str(dest: string): string | undefined {
    const v = this.values.get(dest);

    return v?.kind === "str" ? v.value : undefined;
  }

  /** A list argument (appended, `*`, `+`), or undefined when not given. */
  list(dest: string): readonly string[] | undefined {
    const v = this.values.get(dest);

    return v?.kind === "list" ? v.value : undefined;
  }

  /** Whether a flag was given. */
  flag(dest: string): boolean {
    return this.values.get(dest)?.kind === "flag";
  }

  /** An int argument, or undefined when not given. */
  int(dest: string): number | undefined {
    const v = this.values.get(dest);

    return v?.kind === "int" ? v.value : undefined;
  }
}

/** The width argparse formats usage for: `COLUMNS`, else the terminal's, else 80; less 2. */
export function usageWidth(env: (name: string) => string | undefined, tty: number | undefined): number {
  const columns = Number(env("COLUMNS"));
  const width = Number.isInteger(columns) && columns > 0 ? columns : (tty ?? 80);

  return width - 2;
}

function metavarOf(o: OptionSpec): string {
  return o.metavar ?? (o.choices === undefined ? o.dest.toUpperCase() : `{${o.choices.join(",")}}`);
}

/** argparse's usage text for a parser named `prog` with these parts (optionals, then positionals). */
export function formatUsage(prog: string, optParts: readonly string[], posParts: readonly string[], width: number): string {
  const prefix = "usage: ";
  const usage = [prog, [...optParts, ...posParts].join(" ")].filter((s) => s !== "").join(" ");

  if (prefix.length + usage.length <= width) return `${prefix}${usage}\n`;

  const lines = (parts: readonly string[], indent: string, first?: string): string[] => {
    const out: string[] = [];
    let line: string[] = [];
    let length = first === undefined ? indent.length - 1 : first.length - 1;

    for (const part of parts) {
      if (length + 1 + part.length > width && line.length > 0) {
        out.push(indent + line.join(" "));
        line = [];
        length = indent.length - 1;
      }

      line.push(part);
      length += part.length + 1;
    }

    if (line.length > 0) out.push(indent + line.join(" "));

    if (first !== undefined && out[0] !== undefined) out[0] = out[0].slice(indent.length);

    return out;
  };

  let wrapped: string[];

  if (prefix.length + prog.length <= 0.75 * width) {
    const indent = " ".repeat(prefix.length + prog.length + 1);

    if (optParts.length > 0) wrapped = [...lines([prog, ...optParts], indent, prefix), ...lines(posParts, indent)];
    else if (posParts.length > 0) wrapped = lines([prog, ...posParts], indent, prefix);
    else wrapped = [prog];
  } else {
    const indent = " ".repeat(prefix.length);
    const all = lines([...optParts, ...posParts], indent);
    wrapped = [prog, ...(all.length > 1 ? [...lines(optParts, indent), ...lines(posParts, indent)] : all)];
  }

  return `${prefix}${wrapped.join("\n")}\n`;
}

/** The usage parts of a command: its options (with `-h` first) and its positionals. */
export interface UsageParts {
  readonly opt: string[];
  readonly pos: string[];
}

/** The usage parts of a command's options (with `-h` first) and positionals. */
export function usageParts(spec: CommandSpec): UsageParts {
  const opt: (string | undefined)[] = ["[-h]"];
  const inGroup = new Set((spec.exclusive ?? []).flat());

  for (const o of spec.options) {
    const meta = metavarOf(o);
    const part = o.takes === "flag" ? o.flag : o.takes === "star" ? `${o.flag} [${meta} ...]` : `${o.flag} ${meta}`;
    opt.push(o.required === true || inGroup.has(o.dest) ? part : `[${part}]`);
  }

  for (const group of spec.exclusive ?? []) {
    const start = spec.options.findIndex((o) => o.dest === group[0]) + 1;
    const end = start + group.length;
    const parts = opt.slice(start, end).filter((p): p is string => p !== undefined);
    const last = parts.length - 1;
    parts.forEach((p, i) => {
      opt[start + i] = `${i === 0 ? "[" : ""}${p}${i === last ? "]" : " |"}`;
    });

    for (let i = start + parts.length; i < end; i += 1) opt[i] = undefined;
  }

  const pos = spec.positionals.map((p) => (p.nargs === "?" ? `[${p.dest}]` : p.nargs === "+" ? `${p.dest} [${p.dest} ...]` : p.dest));

  return { opt: opt.filter((p): p is string => p !== undefined), pos };
}

/** Whether argparse reads `token` as an option string (a negative number, `-` or text with a space is not). */
function looksLikeOption(token: string): boolean {
  if (!token.startsWith("-") || token.length < 2) return false;

  if (/^-\d+$|^-\d*\.\d+$/.test(token)) return false;

  return !token.includes(" ");
}

const INT = /^\s*[+-]?\d+(?:_\d+)*\s*$/;

/** What parsing one subcommand gives: its arguments and the tokens it did not recognize. */
export interface Parsed {
  readonly args: Args;
  readonly extras: readonly string[];
}

/** The arguments `argv` gives `spec` (a parser named `prog`), the usage error, or "help". */
export function parseArgs(prog: string, spec: CommandSpec, argv: readonly string[], width: number): Parsed | UsageError | "help" {
  const parts = usageParts(spec);
  const usage = formatUsage(prog, parts.opt, parts.pos, width);
  const error = (reason: string): UsageError => new UsageError({ prog, usage, reason });
  const values = new Map<string, Value>();
  const seen: string[] = [];
  const positional: string[] = [];
  const extras: string[] = [];
  const longs = spec.options.filter((o) => o.flag.startsWith("--"));
  let i = 0;
  let rest = false;

  while (i < argv.length) {
    const token = argv[i] ?? "";
    i += 1;

    if (rest || !looksLikeOption(token)) {
      positional.push(token);
      continue;
    }

    if (token === "--") {
      rest = true;
      continue;
    }

    if (token === "-h" || token === "--help") return "help";
    let option = spec.options.find((o) => o.flag === token);
    let explicit: string | undefined;

    if (option === undefined && token.includes("=")) {
      const eq = token.indexOf("=");
      option = spec.options.find((o) => o.flag === token.slice(0, eq));

      if (option !== undefined) explicit = token.slice(eq + 1);
    }

    if (option === undefined && token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq >= 0 ? token.slice(0, eq) : token;
      const flags = [...longs.map((o) => o.flag), "--help"].filter((flag) => flag.startsWith(name));

      if (flags.length > 1) return error(`ambiguous option: ${name} could match ${flags.join(", ")}`);

      if (flags[0] === "--help") return "help";
      option = longs.find((o) => o.flag === flags[0]);

      if (option !== undefined && eq >= 0) explicit = token.slice(eq + 1);
    }

    if (option === undefined) {
      extras.push(token);
      continue;
    }

    for (const group of spec.exclusive ?? []) {
      if (!group.includes(option.dest)) continue;
      const other = group.find((dest) => dest !== option.dest && seen.includes(dest));

      if (other !== undefined) {
        const flagOf = spec.options.find((o) => o.dest === other)?.flag ?? other;

        return error(`argument ${option.flag}: not allowed with argument ${flagOf}`);
      }
    }

    seen.push(option.dest);

    if (option.takes === "flag") {
      if (explicit !== undefined) return error(`argument ${option.flag}: ignored explicit argument ${pyStr(explicit)}`);
      values.set(option.dest, { kind: "flag" });
      continue;
    }

    if (option.takes === "star") {
      const taken: string[] = explicit === undefined ? [] : [explicit];

      while (explicit === undefined && i < argv.length && !looksLikeOption(argv[i] ?? "")) {
        taken.push(argv[i] ?? "");
        i += 1;
      }

      values.set(option.dest, { kind: "list", value: taken });
      continue;
    }

    let value = explicit;

    if (value === undefined) {
      const next = argv[i];

      if (next === undefined || looksLikeOption(next)) return error(`argument ${option.flag}: expected one argument`);
      value = next;
      i += 1;
    }

    if (option.int === true) {
      if (!INT.test(value)) return error(`argument ${option.flag}: invalid int value: ${pyStr(value)}`);
      values.set(option.dest, { kind: "int", value: Number(value.trim().replace(/_/g, "")) });
      continue;
    }

    if (option.choices !== undefined && !option.choices.includes(value)) {
      return error(
        `argument ${option.flag}: invalid choice: ${pyStr(value)} (choose from ${option.choices.map((c) => pyStr(c)).join(", ")})`,
      );
    }

    if (option.takes === "append") {
      const before = values.get(option.dest);
      values.set(option.dest, { kind: "list", value: [...(before?.kind === "list" ? before.value : []), value] });
    } else {
      values.set(option.dest, { kind: "str", value });
    }
  }

  let at = 0;
  const missing: string[] = [];
  spec.positionals.forEach((p, n) => {
    const after = spec.positionals.slice(n + 1).filter((q) => q.nargs !== "?").length;
    const left = positional.length - at;

    if (p.nargs === "?") {
      if (left > after) {
        values.set(p.dest, { kind: "str", value: positional[at] ?? "" });
        at += 1;
      }
    } else if (p.nargs === "+") {
      const take = Math.max(0, left - after);

      if (take === 0) missing.push(p.dest);
      else values.set(p.dest, { kind: "list", value: positional.slice(at, at + take) });
      at += take;
    } else if (left > 0) {
      values.set(p.dest, { kind: "str", value: positional[at] ?? "" });
      at += 1;
    } else {
      missing.push(p.dest);
    }
  });
  const missingPositionals = spec.positionals.filter((p) => missing.includes(p.dest)).map((p) => p.dest);
  const missingOptions = spec.options.filter((o) => o.required === true && !values.has(o.dest)).map((o) => o.flag);
  const required = spec.optionsFirst === true ? [...missingOptions, ...missingPositionals] : [...missingPositionals, ...missingOptions];

  if (required.length > 0) return error(`the following arguments are required: ${required.join(", ")}`);

  return { args: new Args(values), extras: [...extras, ...positional.slice(at)] };
}

/** The usage of a top parser `prog` over `dir` and its subcommands. */
export function topUsage(prog: string, names: readonly string[], width: number): string {
  return formatUsage(prog, ["[-h]"], ["dir", `{${names.join(",")}} ...`], width);
}

/** A CLI with subcommands, as argparse's `prog DIR {cmd} ...`: the subcommand's spec and arguments, the
 * usage error (the top parser's or the subcommand's), or "help". */
export function parseCommand(
  prog: string,
  commands: readonly CommandSpec[],
  argv: readonly string[],
  width: number,
): { readonly spec: CommandSpec; readonly dir: string; readonly args: Args } | UsageError | "help" {
  const names = commands.map((c) => c.name);
  const top = (reason: string): UsageError => new UsageError({ prog, usage: topUsage(prog, names, width), reason });
  const leading: string[] = [];
  let i = 0;

  while (i < argv.length && looksLikeOption(argv[i] ?? "")) {
    const token = argv[i] ?? "";

    if (token === "-h" || (token.length > 2 && "--help".startsWith(token))) return "help";
    leading.push(token);
    i += 1;
  }

  const dir = argv[i];
  const cmd = argv[i + 1];

  if (dir === undefined || cmd === undefined) {
    return top(`the following arguments are required: ${dir === undefined ? "dir, cmd" : "cmd"}`);
  }

  const spec = commands.find((c) => c.name === cmd);

  if (spec === undefined) {
    return top(`argument cmd: invalid choice: ${pyStr(cmd)} (choose from ${names.map((n) => pyStr(n)).join(", ")})`);
  }

  const parsed = parseArgs(`${prog} dir ${cmd}`, spec, argv.slice(i + 2), width);

  if (parsed === "help" || parsed instanceof UsageError) return parsed;
  const extras = [...leading, ...parsed.extras];

  if (extras.length > 0) return top(`unrecognized arguments: ${extras.join(" ")}`);

  return { spec, dir, args: parsed.args };
}

/** Shorthands for building specs. */
export const opt = {
  value: (flag: string, more: Partial<Omit<OptionSpec, "flag" | "takes">> = {}): OptionSpec => ({
    flag,
    dest: flag.slice(2).replace(/-/g, "_"),
    takes: "value",
    ...more,
  }),
  flag: (flag: string): OptionSpec => ({ flag, dest: flag.slice(2).replace(/-/g, "_"), takes: "flag" }),
  append: (flag: string, more: Partial<Omit<OptionSpec, "flag" | "takes">> = {}): OptionSpec => ({
    flag,
    dest: flag.slice(2).replace(/-/g, "_"),
    takes: "append",
    ...more,
  }),
  star: (flag: string): OptionSpec => ({ flag, dest: flag.slice(2).replace(/-/g, "_"), takes: "star" }),
};
