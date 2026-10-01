"""A worker's lane: the repository paths it may edit, each entry a path or a glob.

A path covers itself and everything under it (`src/` covers `src/a/b.ts`); in a glob, `*`, `?` and
`[...]` stay inside one path segment, `**` as a whole segment spans any number of them (`src/**`,
`src/**/x.ts`, `**/x.ts`), and `{a,b}` is either. Two entries meet when some path matches both (L7):
`src/*.ts` and `src/a/b.ts` do not, `src/**` and `src/a/b.ts` do. fleet/src/ledger/lanes.ts is the same
rule. `matches` reads one path by a regular expression; `witness` decides the intersection on the product
of the two entries' automata and returns a path both match. Stdlib only.
"""
import re

SLASH = 0x2F
MAX_CODE = 0x10FFFF
MAX_EXPANSIONS = 64

# A character class: (negated, ranges, slash) — a set of (lo, hi) code ranges, or all but them; `/` only when slash.
IN_SEGMENT = (True, (), False)
ANY = (True, (), True)


def _literal(code: int) -> tuple:
    return (False, ((code, code),), code == SLASH)


def _contains(chars: tuple, code: int) -> bool:
    negated, ranges, slash = chars
    if code == SLASH:
        return slash
    inside = any(lo <= code <= hi for lo, hi in ranges)
    return not inside if negated else inside


def patterns(entry: str) -> list[str]:
    """An entry as the globs it stands for: a plain path is itself and everything under it."""
    e = entry.strip()
    while e.startswith("./"):
        e = e[2:]
    e = e.rstrip("/")
    if e in ("", "."):
        return ["**"]
    if not re.search(r"[*?[{]", e):
        return [e, f"{e}/**"]
    return _expand(e)


def _brace_group(glob: str):
    open_ = glob.find("{")
    while open_ >= 0:
        depth, start, choices = 0, open_ + 1, []
        for i in range(open_, len(glob)):
            c = glob[i]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    choices.append(glob[start:i])
                    if len(choices) > 1:
                        return open_, i, choices
                    break
            elif c == "," and depth == 1:
                choices.append(glob[start:i])
                start = i + 1
        open_ = glob.find("{", open_ + 1)
    return None


def _expand(glob: str) -> list[str]:
    """`a{b,c}d` as `abd` and `acd`; a brace without a closing one or a comma is a plain character."""
    out, pending = [], [glob]
    while pending and len(out) < MAX_EXPANSIONS:
        g = pending.pop()
        group = _brace_group(g)
        if group is None:
            out.append(g)
            continue
        open_, close, choices = group
        for choice in reversed(choices):
            pending.append(g[:open_] + choice + g[close + 1:])
    return out


def _bracket(chars: str, at: int):
    i = at + 1
    negated = i < len(chars) and chars[i] in "!^"
    if negated:
        i += 1
    close = chars.find("]", i + 1 if i < len(chars) and chars[i] == "]" else i)
    if close < 0:
        return None
    body = [ord(c) for c in chars[i:close]]
    ranges, k = [], 0
    while k < len(body):
        lo = body[k]
        if k + 2 < len(body) and body[k + 1] == 0x2D:
            if lo <= body[k + 2]:
                ranges.append((lo, body[k + 2]))
            k += 3
        else:
            ranges.append((lo, lo))
            k += 1
    return (negated, tuple(ranges), False), close


def _tokens(glob: str) -> list[tuple]:
    out, i = [], 0
    while i < len(glob):
        c = glob[i]
        if c == "*":
            j = i
            while j + 1 < len(glob) and glob[j + 1] == "*":
                j += 1
            whole = j > i and (i == 0 or glob[i - 1] == "/")
            if whole and j + 1 == len(glob):
                out.append(("rest",))
            elif whole and glob[j + 1] == "/":
                out.append(("dirs",))
                j += 1
            else:
                out.append(("star",))
            i = j
        elif c == "?":
            out.append(("one", IN_SEGMENT))
        elif c == "[":
            found = _bracket(glob, i)
            if found is None:
                out.append(("one", _literal(0x5B)))
            else:
                out.append(("one", found[0]))
                i = found[1]
        else:
            out.append(("one", _literal(ord(c))))
        i += 1
    return out


# -- matching one path ------------------------------------------------------------------------------

def _class_source(chars: tuple) -> str:
    negated, ranges, slash = chars
    body = "".join(re.escape(chr(lo)) if lo == hi else f"{re.escape(chr(lo))}-{re.escape(chr(hi))}" for lo, hi in ranges)
    source = f"[^{body}]" if negated and body else "(?s:.)" if negated else f"[{body}]" if body else "(?!)"
    return source if slash else f"(?!/){source}"


def _regex(glob: str) -> re.Pattern:
    parts = []
    for t in _tokens(glob):
        parts.append({"star": "[^/]*", "dirs": "(?:.+/)?", "rest": ".+"}.get(t[0]) or _class_source(t[1]))
    return re.compile("".join(parts), re.S)


def matches(path: str, entry: str) -> bool:
    """Whether lane entry `entry` covers repository path `path`."""
    return any(_regex(glob).fullmatch(path) for glob in patterns(entry))


# -- whether two entries meet -----------------------------------------------------------------------

def _automaton(glob: str):
    """The glob as a nondeterministic automaton over characters, with free (empty) moves."""
    steps, free = [[]], [[]]

    def fresh() -> int:
        steps.append([])
        free.append([])
        return len(steps) - 1

    at = 0
    for t in _tokens(glob):
        nxt = fresh()
        if t[0] == "one":
            steps[at].append((t[1], nxt))
        elif t[0] == "star":
            free[at].append(nxt)
            steps[nxt].append((IN_SEGMENT, nxt))
        elif t[0] == "rest":
            steps[at].append((ANY, nxt))
            steps[nxt].append((ANY, nxt))
        else:  # dirs
            inside = fresh()
            free[at].append(nxt)
            steps[at].append((ANY, inside))
            steps[inside].append((ANY, inside))
            steps[inside].append((_literal(SLASH), nxt))
        if t[0] == "star":
            after = fresh()
            free[nxt].append(after)
            at = after
        else:
            at = nxt
    return steps, free, at


def _common(a: tuple, b: tuple) -> int | None:
    """A character in both classes: the intersection is a union of intervals, each starting at 0, at a
    range's bound or just past one, or just past `/`; a printable letter is tried first."""
    candidates = [0x78, 0x61, 0x30, SLASH, SLASH + 1, 0]
    for lo, hi in (*a[1], *b[1]):
        candidates += [lo, hi, lo - 1, hi + 1]
    return next((c for c in candidates if 0 <= c <= MAX_CODE and _contains(a, c) and _contains(b, c)), None)


def _witness_of(x, y) -> str | None:
    (xs, xf, xa), (ys, yf, ya) = x, y
    seen, queue, head = {(0, 0)}, [(0, 0, "")], 0
    while head < len(queue):
        p, q, path = queue[head]
        head += 1
        if p == xa and q == ya:
            return path
        moves = [(np, q, "") for np in xf[p]] + [(p, nq, "") for nq in yf[q]]
        for sc, sto in xs[p]:
            for tc, tto in ys[q]:
                c = _common(sc, tc)
                if c is not None:
                    moves.append((sto, tto, chr(c)))
        for np, nq, more in moves:
            if (np, nq) not in seen:
                seen.add((np, nq))
                queue.append((np, nq, path + more))
    return None


def witness(a: str, b: str) -> str | None:
    """A path both lane entries cover, or None when no path does."""
    for x in patterns(a):
        for y in patterns(b):
            found = _witness_of(_automaton(x), _automaton(y))
            if found is not None:
                return found
    return None


def meet(a: str, b: str) -> bool:
    """Whether two lane entries can touch the same file: some path matches both."""
    return witness(a, b) is not None
