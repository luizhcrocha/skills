/**
 * The shell lexer `fleet waste` reads Bash calls with: words, cuts, redirections, comments, heredocs and
 * expansion, each on the shapes agents' real commands took.
 */
import { describe, expect, test } from "bun:test";

import { assignmentOf, expand, lex, literal, type Simple } from "../src/shell-words.ts";

/** Each simple command as its words' text, then `op target` for each redirection. */
const split = (line: string): string[][] => lex(line).commands.map((c: Simple) => [...c.words.map(literal), ...c.redirects.map((r) => `${r.op} ${literal(r.target)}`)]);

describe("shell words", () => {
  test("quotes join a word and hide the operators inside them", () => {
    expect(split(`echo "a;b > c" 'd && e'f`)).toEqual([["echo", "a;b > c", "d && ef"]]);
  });

  test('an escaped \\" stays inside its double quotes', () => {
    expect(split(String.raw`grep -n "a\|case \"ops\"" f.ts; grep -n "status >= 400" h.ts`)).toEqual([
      ["grep", "-n", String.raw`a\|case "ops"`, "f.ts"],
      ["grep", "-n", "status >= 400", "h.ts"],
    ]);
  });

  test("an escaped backslash does not escape the quote after it", () => {
    expect(split('echo "a\\\\" > out')).toEqual([["echo", "a\\", "> out"]]);
  });

  test("an unbalanced ' runs to the end of its line only", () => {
    expect(split("echo it's here\ncat a > out")).toEqual([["echo", "its here"], ["cat", "a", "> out"]]);
  });

  test("a balanced quote spans lines", () => {
    expect(split("jj describe -m 'one\n\ntwo > three'")).toEqual([["jj", "describe", "-m", "one\n\ntwo > three"]]);
  });

  test("a redirection before the program is kept", () => {
    expect(split("> f echo hi")).toEqual([["echo", "hi", "> f"]]);
  });

  test("a # comment is dropped, a # inside a word is not", () => {
    expect(split("ls # > out\necho a#b")).toEqual([["ls"], ["echo", "a#b"]]);
  });

  test("an fd joins its operator only when it is a whole bare word before it", () => {
    expect(split("cat a 2> err; cat a 2 > out; cat a2>f; cat b 2>&1; c &> all; d >> log")).toEqual([
      ["cat", "a", "2> err"],
      ["cat", "a", "2", "> out"],
      ["cat", "a2", "> f"],
      ["cat", "b", "2>& 1"],
      ["c", "&> all"],
      ["d", ">> log"],
    ]);
  });

  test("&&, ||, |, & and parentheses cut commands", () => {
    expect(split("a && b || c | d & e; (f)")).toEqual([["a"], ["b"], ["c"], ["d"], ["e"], ["f"]]);
  });

  test("a heredoc's body is dropped, a here-string is not a heredoc", () => {
    expect(split("python3 - <<'EOF'\nprint(1 > 0)\nEOF\ncat a")).toEqual([["python3", "-", "<< EOF"], ["cat", "a"]]);
    expect(split("cat <<< EOF\nx > out")).toEqual([["cat", "<<< EOF"], ["x", "> out"]]);
  });

  test("a <<- heredoc ends at its tab-indented terminator", () => {
    expect(split("cat <<-EOF\n\tx > y\n\tEOF\ncat a")).toEqual([["cat", "<<- EOF"], ["cat", "a"]]);
  });

  test("a > inside $(( )) is part of the word, not a redirection", () => {
    expect(split("echo $((a>b)) x; n=$((1 > 0))")).toEqual([["echo", "$((a>b))", "x"], ["n=$((1 > 0))"]]);
  });

  test("each command counts the subshells it opens before it and closes after it", () => {
    expect(lex("(cd a; (b)); c").commands.map((c) => [literal(c.words[0] ?? []), c.opens, c.closes])).toEqual([
      ["cd", 1, 0],
      ["b", 1, 2],
      ["c", 0, 0],
    ]);
  });

  test("the bare line keeps the shape without quoted text, comments or heredoc bodies", () => {
    expect(lex(`echo "while sleep 60" # sleep 99\ncat <<EOF\nsleep 40\nEOF\ntail -n 20 -f log`).bare).toBe('echo "" \ncat <<EOF\n\ntail -n 20 -f log');
  });

  test("expansion uses the variables given, a leading ~ is HOME, a quoted one is not", () => {
    const vars = new Map([
      ["HOME", "/home/u"],
      ["S", "/tmp/x"],
    ]);

    const word = (line: string) => lex(line).commands[0]?.words[0] ?? [];

    expect(expand(word("$S/out"), vars)).toBe("/tmp/x/out");
    expect(expand(word('"${S}"/o'), vars)).toBe("/tmp/x/o");
    expect(expand(word("~/repos/a.ts"), vars)).toBe("/home/u/repos/a.ts");
    expect(expand(word("'~/a'"), vars)).toBe("~/a");
    expect(expand(word("'$S'"), vars)).toBe("$S");
    expect(expand(word(String.raw`\$S`), vars)).toBe("$S");
    expect(expand(word("$T/out"), vars)).toBeUndefined();
    expect(expand(word("$(pwd)/out"), vars)).toBeUndefined();
  });

  test("an assignment is its name and its value's word", () => {
    const [name, value] = assignmentOf(lex("D=~/r").commands[0]?.words[0] ?? []) ?? ["", []];

    expect([name, expand(value, new Map([["HOME", "/h"]]))]).toEqual(["D", "/h/r"]);
    expect(assignmentOf(lex("'D=x'").commands[0]?.words[0] ?? [])).toBeUndefined();
  });
});
