/**
 * A worker's lane: the repository paths it may edit, each entry a path or a glob. A path covers itself and
 * everything under it (`src/` covers `src/a/b.ts`); in a glob, `*`, `?` and `[...]` stay inside one path
 * segment, `**` as a whole segment spans any number of them (`src/**`, `src/**\/x.ts`, `**\/x.ts`), and
 * `{a,b}` is either. Two entries meet when some path matches both (L7): `src/*.ts` and `src/a/b.ts` do not,
 * `src/**` and `src/a/b.ts` do. Python's `lanes.py` is the same rule, so both implementations warn alike.
 *
 * {@link laneMatches} matches one path by a regular expression; {@link laneWitness} decides the
 * intersection on the product of the two entries' automata and returns a path both match. Each checks the
 * other in test/lanes.test.ts.
 */

const SLASH = 0x2f;

const MAX_CODE = 0x10ffff;

const MAX_EXPANSIONS = 64;

/** The characters one step of a glob takes: a set of ranges, or all but them; `/` only when `slash`. */
interface CharClass {
  readonly negated: boolean;
  readonly ranges: readonly (readonly [number, number])[];
  readonly slash: boolean;
}

type Token =
  | { readonly kind: "one"; readonly chars: CharClass }
  | { readonly kind: "star" }
  | { readonly kind: "dirs" }
  | { readonly kind: "rest" };

const IN_SEGMENT: CharClass = { negated: true, ranges: [], slash: false };

const ANY: CharClass = { negated: true, ranges: [], slash: true };

function literal(code: number): CharClass {
  return { negated: false, ranges: [[code, code]], slash: code === SLASH };
}

function contains(chars: CharClass, code: number): boolean {
  if (code === SLASH) return chars.slash;
  const inside = chars.ranges.some(([lo, hi]) => lo <= code && code <= hi);

  return chars.negated ? !inside : inside;
}

/** An entry as the globs it stands for: a plain path is itself and everything under it. */
export function lanePatterns(entry: string): string[] {
  let e = entry.trim();

  while (e.startsWith("./")) e = e.slice(2);
  e = e.replace(/\/+$/, "");

  if (e === "" || e === ".") return ["**"];

  if (!/[*?[{]/.test(e)) return [e, `${e}/**`];

  return expandBraces(e);
}

/** `a{b,c}d` as `abd` and `acd`; a brace without a closing one or a comma is a plain character. */
function expandBraces(glob: string): string[] {
  const out: string[] = [];
  const pending = [glob];

  while (pending.length > 0 && out.length < MAX_EXPANSIONS) {
    const g = pending.pop() ?? "";
    const group = braceGroup(g);

    if (group === undefined) {
      out.push(g);
      continue;
    }

    for (const choice of group.choices.toReversed()) pending.push(`${g.slice(0, group.open)}${choice}${g.slice(group.close + 1)}`);
  }

  return out;
}

function braceGroup(glob: string): { readonly open: number; readonly close: number; readonly choices: string[] } | undefined {
  for (let open = glob.indexOf("{"); open >= 0; open = glob.indexOf("{", open + 1)) {
    let depth = 0;
    let start = open + 1;
    const choices: string[] = [];

    for (let i = open; i < glob.length; i += 1) {
      const c = glob[i];

      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;

        if (depth === 0) {
          choices.push(glob.slice(start, i));

          if (choices.length > 1) return { open, close: i, choices };

          break;
        }
      } else if (c === "," && depth === 1) {
        choices.push(glob.slice(start, i));
        start = i + 1;
      }
    }
  }

  return undefined;
}

/** A bracket expression at `at` (the `[`) and the index of its `]`, or undefined when it does not close. */
function bracket(chars: readonly string[], at: number): { readonly chars: CharClass; readonly end: number } | undefined {
  let i = at + 1;
  const negated = chars[i] === "!" || chars[i] === "^";

  if (negated) i += 1;
  const close = chars.indexOf("]", chars[i] === "]" ? i + 1 : i);

  if (close < 0) return undefined;
  const body = chars.slice(i, close).map((c) => c.codePointAt(0) ?? 0);
  const ranges: [number, number][] = [];

  for (let k = 0; k < body.length; k += 1) {
    const lo = body[k] ?? 0;
    const hi = body[k + 2];

    if (body[k + 1] === 0x2d && hi !== undefined) {
      if (lo <= hi) ranges.push([lo, hi]);
      k += 2;
    } else ranges.push([lo, lo]);
  }

  return { chars: { negated, ranges, slash: false }, end: close };
}

function tokens(glob: string): Token[] {
  const out: Token[] = [];
  const chars = [...glob];

  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i] ?? "";

    if (c === "*") {
      let j = i;

      while (chars[j + 1] === "*") j += 1;
      const whole = j > i && (i === 0 || chars[i - 1] === "/");

      if (whole && j + 1 === chars.length) out.push({ kind: "rest" });
      else if (whole && chars[j + 1] === "/") {
        out.push({ kind: "dirs" });
        j += 1;
      } else out.push({ kind: "star" });
      i = j;
    } else if (c === "?") out.push({ kind: "one", chars: IN_SEGMENT });
    else if (c === "[") {
      const found = bracket(chars, i);

      if (found === undefined) out.push({ kind: "one", chars: literal(0x5b) });
      else {
        out.push({ kind: "one", chars: found.chars });
        i = found.end;
      }
    } else out.push({ kind: "one", chars: literal(c.codePointAt(0) ?? 0) });
  }

  return out;
}

// -- matching one path ----------------------------------------------------------------------------

function classSource(chars: CharClass): string {
  const set = chars.ranges.map(([lo, hi]) => (lo === hi ? `\\u{${lo.toString(16)}}` : `\\u{${lo.toString(16)}}-\\u{${hi.toString(16)}}`)).join("");
  const body = chars.negated ? `[^${set}]` : set === "" ? "[^\\s\\S]" : `[${set}]`;

  return chars.slash ? body : `(?!/)${body}`;
}

function regexOf(glob: string): RegExp {
  const source = tokens(glob)
    .map((t) => {
      switch (t.kind) {
        case "star":
          return "[^/]*";
        case "dirs":
          return "(?:.+/)?";
        case "rest":
          return ".+";
        case "one":
          return classSource(t.chars);
      }
    })
    .join("");

  return new RegExp(`^${source}$`, "su");
}

/** Whether lane entry `entry` covers repository path `path`. */
export function laneMatches(path: string, entry: string): boolean {
  return lanePatterns(entry).some((glob) => regexOf(glob).test(path));
}

// -- whether two entries meet ---------------------------------------------------------------------

interface Automaton {
  readonly steps: readonly (readonly { readonly from: number; readonly chars: CharClass; readonly to: number }[])[];
  readonly free: readonly (readonly number[])[];
  readonly accept: number;
}

/** The glob as a nondeterministic automaton over characters, with free (empty) moves. */
function automaton(glob: string): Automaton {
  const steps: { from: number; chars: CharClass; to: number }[][] = [[]];
  const free: number[][] = [[]];

  const fresh = (): number => {
    steps.push([]);
    free.push([]);

    return steps.length - 1;
  };

  const step = (from: number, chars: CharClass, to: number): void => {
    steps[from]?.push({ from, chars, to });
  };

  let at = 0;

  for (const t of tokens(glob)) {
    const next = fresh();

    switch (t.kind) {
      case "one":
        step(at, t.chars, next);
        break;
      case "star":
        free[at]?.push(next);
        step(next, IN_SEGMENT, next);
        break;
      case "rest":
        step(at, ANY, next);
        step(next, ANY, next);
        break;
      case "dirs": {
        const inside = fresh();
        free[at]?.push(next);
        step(at, ANY, inside);
        step(inside, ANY, inside);
        step(inside, literal(SLASH), next);
        break;
      }
    }

    if (t.kind === "star") {
      const after = fresh();
      free[next]?.push(after);
      at = after;
    } else at = next;
  }

  return { steps, free, accept: at };
}

/** A character in both classes, or undefined: the intersection is a union of intervals, each starting at
 * 0, at a range's bound or just past one, or just past `/`; a printable letter is tried first. */
function common(a: CharClass, b: CharClass): number | undefined {
  const candidates = [0x78, 0x61, 0x30, SLASH, SLASH + 1, 0];

  for (const [lo, hi] of [...a.ranges, ...b.ranges]) candidates.push(lo, hi, lo - 1, hi + 1);

  return candidates.find((c) => c >= 0 && c <= MAX_CODE && contains(a, c) && contains(b, c));
}

function witnessOf(x: Automaton, y: Automaton): string | undefined {
  const key = (p: number, q: number): string => `${p} ${q}`;
  const seen = new Set([key(0, 0)]);
  const queue: { readonly p: number; readonly q: number; readonly path: string }[] = [{ p: 0, q: 0, path: "" }];

  for (let head = 0; head < queue.length; head += 1) {
    const { p, q, path } = queue[head] ?? { p: 0, q: 0, path: "" };

    if (p === x.accept && q === y.accept) return path;

    const visit = (np: number, nq: number, more: string): void => {
      if (seen.has(key(np, nq))) return;
      seen.add(key(np, nq));
      queue.push({ p: np, q: nq, path: path + more });
    };

    for (const np of x.free[p] ?? []) visit(np, q, "");

    for (const nq of y.free[q] ?? []) visit(p, nq, "");

    for (const s of x.steps[p] ?? []) {
      for (const t of y.steps[q] ?? []) {
        const c = common(s.chars, t.chars);

        if (c !== undefined) visit(s.to, t.to, String.fromCodePoint(c));
      }
    }
  }

  return undefined;
}

/** A path both lane entries cover, or undefined when no path does. */
export function laneWitness(a: string, b: string): string | undefined {
  for (const x of lanePatterns(a)) {
    for (const y of lanePatterns(b)) {
      const found = witnessOf(automaton(x), automaton(y));

      if (found !== undefined) return found;
    }
  }

  return undefined;
}

/** Whether two lane entries can touch the same file: some path matches both. */
export function lanesMeet(a: string, b: string): boolean {
  return laneWitness(a, b) !== undefined;
}
