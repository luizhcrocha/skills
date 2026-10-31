/**
 * A fake host service for `fleet project` and `fleet team start`: a real HTTP server on a free loopback port that
 * answers the run server's `/projects` routes as its contract fixes them, and records what it was sent.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** One request the fake host received. */
export interface Sent {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
  readonly type: string | null;
  readonly origin: string | null;
}

/** What the fake host answers a request with, and what it does first (as the host writes cloud.json). */
export interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly before?: () => void;
}

/** A fake host service: its origin, the requests it received, and how to stop it. */
export interface FakeHost {
  readonly origin: string;
  readonly sent: Sent[];
  stop(): void;
}

const hosts: FakeHost[] = [];

/** Stop every fake host started so far. */
export function stopHosts(): void {
  for (const host of hosts.splice(0)) host.stop();
}

/** A fake host answering `METHOD /path` from `replies`; any other route is 404 `{error: "no such route"}`. */
export function fakeHost(replies: Readonly<Record<string, Reply>>): FakeHost {
  const sent: Sent[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();

      sent.push({ method: request.method, path: url.pathname, body: text === "" ? undefined : JSON.parse(text), type: request.headers.get("content-type"), origin: request.headers.get("origin") });
      const reply = replies[`${request.method} ${url.pathname}`];

      if (reply === undefined) return Response.json({ error: "no such route" }, { status: 404 });
      reply.before?.();

      return Response.json(reply.body, { status: reply.status, headers: reply.headers ?? {} });
    },
  });

  const host = { origin: `http://127.0.0.1:${server.port}`, sent, stop: () => void server.stop(true) };
  hosts.push(host);

  return host;
}

/** Team `id`'s ledger folder under `home`, where the host makes it. */
export const ledgerAt = (home: string, id: string): string => join(home, ".local", "state", "fleet", id);

/** What the host does before it answers a join: makes the team's folder (`dir`, else its fixed home) and, once its
 * lane cut it over, its cloud.json. */
export function cutOver(home: string, id: string, dir = ledgerAt(home, id)): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cloud.json"), JSON.stringify({ fleet: id, cloud: "https://fleet.example.dev", since: "2026-10-30T10:00:00Z", host: "office", run: "http://127.0.0.1:7633", project: "court" }));
}

