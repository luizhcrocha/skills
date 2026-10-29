/**
 * The Links page's facts: a link's kind as people recognise it (old `dev`/`page` rows read at display time),
 * where it is reached from, and which file under the fleet's files root a link names.
 */
import { describe, expect, test } from "bun:test";

import { filePathOf, filesRoot, linkKind, reachOf, servedRel } from "../src/ledger/links.ts";

describe("a link's kind and reach", () => {
  test("old rows read as the kinds people recognise, without being rewritten", () => {
    const cases: readonly (readonly [string | undefined, string, string, string])[] = [
      ["dev", "https://box.ts.net:7501/", "Live preview", "preview"],
      ["page", "https://box.ts.net:4518/", "Gold-marking page", "doc"],
      ["page", "https://claude.ai/artifact/Bcwsy", "Agent tool architecture", "doc"],
      ["dev", "https://claude.ai/artifact/Bcwsy", "x", "doc"],
      ["page", "https://box.ts.net:7501/caso/CA1014/prototipo/mapa", "Map", "prototype"],
      ["dev", "https://box.ts.net:5424/caso/CA1116/tarefas", "Tarefas tab prototype (throwaway)", "prototype"],
      ["page", "file:///home/u/.local/state/infra/auth-review.md", "Auth review", "doc"],
      ["tool", "https://box.ts.net:7501/caso/CA1014/prototipo/mapa", "Map", "tool"],
      [undefined, "http://localhost:8000", "Lab lakeFS", "preview"],
    ];

    const got: string[] = cases.map(([k, u, t]) => linkKind(k, u, t));

    expect(got).toEqual(cases.map((c) => c[3]));
  });

  test("this machine and its tailnet are probed; elsewhere is not; a file is a file", () => {
    const urls = ["http://localhost:8000", "https://box.ts.net:1/", "http://100.69.17.95:3/", "https://claude.ai/artifact/x", "file:///tmp/x.md", "http://example.com/"];
    expect(urls.map((u) => reachOf(u))).toEqual(["machine", "machine", "machine", "external", "file", "external"]);
    expect(filePathOf("file:///a/coordinator/../b%20c.md")).toBe("/a/b c.md");
    expect(filePathOf("file://elsewhere/a.md")).toBeUndefined();
  });

  test("a host is read as fetch reads it: what does not read plainly is elsewhere, never probed", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["http://0127.0.0.1/", "external"],
      ["http://0100.64.0.1/", "external"],
      ["http://evil.example\\@127.0.0.1/", "external"],
      ["http://user@127.0.0.1/", "external"],
      ["http://user:pw@localhost:3000/", "external"],
      ["http://[::ffff:7f00:1]/", "external"],
      ["http://127.0.0.1\t.evil.com/", "external"],
      ["http://2130706433/", "machine"],
      ["http://[::1]:3000/", "machine"],
      ["http://127.0.0.1:8080/", "machine"],
      ["http://100.64.0.1/", "machine"],
    ];

    expect(cases.map(([u]) => [u, reachOf(u)])).toEqual(cases.map(([u, r]) => [u, r]));
  });

  test("a ts.net name is this machine's only under its own tailnet's suffix, once a hub read it", () => {
    const url = "https://foo.tail1234.ts.net/";
    expect([reachOf(url, "tail1234.ts.net"), reachOf(url, "other.ts.net"), reachOf(url, null), reachOf(url)]).toEqual(["machine", "external", "external", "machine"]);
    expect(reachOf("https://tail1234.ts.net.evil.com/", "tail1234.ts.net")).toBe("external");
  });

  test("a file is served from under the files root only, with no hidden part", () => {
    expect(servedRel("/r", "/r/a b/c.md")).toBe("a%20b/c.md");
    expect([servedRel("/r", "/r/../etc/passwd"), servedRel("/r", "/r/.env"), servedRel("/r", "/elsewhere/x.md"), servedRel("/r", "/r")]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const env = (vars: Record<string, string>) => (name: string) => vars[name];
    expect(filesRoot("/tmp/s/scratchpad/coordinator", env({ HOME: "/home/u" }))).toBe("/tmp/s/scratchpad");
    expect(filesRoot("/home/u/.local/state/infra-coordinator/fleet", env({ HOME: "/home/u" }))).toBe("/home/u/.local/state/infra-coordinator");
    expect(filesRoot("/home/u/.local/state/fleet", env({ HOME: "/home/u" }))).toBe("/home/u/.local/state/fleet");
    expect(filesRoot("/home/u/work/coordinator", env({ HOME: "/home/u" }))).toBe("/home/u/work/coordinator");
  });
});
