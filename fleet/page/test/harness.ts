/**
 * A stand-in for the hub's fleet routes, for the page's browser tests and screenshots: the page rendered
 * from a template and a fixture view (the real `pageHtml`), `GET events` (SSE `hello`, `state`, `chat`),
 * `POST chat` (keeping its `re`, `decision`, `quote` and `side`), `POST chat/preview`, `POST name` (a worker's or the
 * fleet's name, applied to the view as the hub's ledger and registry would, a worker's name another has refused), `GET skills`, `GET state.json`,
 * and two control routes a test drives: `POST /_state` (a new view, sent to every stream) and `POST /_chat`
 * (a message from the fleet).
 */
import type { Json, JsonRecord } from "../src/core.ts";
import type { Message, View } from "./fixtures.ts";

/** A skill as the hub lists it. */
export interface SkillRow {
  readonly name: string;
  readonly description: string;
  readonly hint: string;
  readonly source: string;
}

/** The page as fleet/src/page/render.ts writes it: the template with the state, as a full document. */
export function pageHtml(template: string, view: View): string {
  const payload = JSON.stringify(view).replaceAll("<", "\\u003c");
  const html = template.replace("/*__STATE__*/", () => payload);
  const lines = html.split("\n");
  let n = 0;

  while (n < lines.length && /^\s*<(?:title|link|meta)/u.test(lines[n] ?? "")) n += 1;

  return (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
    "<style>:root{padding-block:env(safe-area-inset-top,0) env(safe-area-inset-bottom,0)}" +
    "body{margin:0;font:14px system-ui,sans-serif}img{max-width:100%}[hidden]{display:none!important}</style>\n" +
    lines.slice(0, n).map((l) => l + "\n").join("") +
    "</head>\n<body>\n" +
    lines.slice(n).join("\n") +
    "\n</body>\n</html>\n"
  );
}

/** What the harness serves. */
export interface HarnessOptions {
  readonly template: string;
  readonly view: View;
  readonly messages: readonly Message[];
  readonly skills?: readonly SkillRow[];
  readonly port?: number;
}

/** A running harness. */
export interface Harness {
  readonly url: string;
  readonly posted: Message[];
  /** The bodies `POST name` was sent, in order. */
  readonly renames: JsonRecord[];
  setView(view: View): void;
  say(message: Message): void;
  stop(): void;
}

/** The skills route's answer. */
interface SkillList {
  readonly skills: readonly SkillRow[];
  readonly builtins: boolean;
}

/** What the harness sends as JSON: a view, a message, the skills or any plain JSON. */
type Payload = Json | Message | SkillList;

/** Serve the page at `/f/<fleet>/` and its routes beside it. */
export function serveHarness(options: HarnessOptions): Harness {
  let view = options.view;
  const messages: Message[] = [...options.messages];
  const posted: Message[] = [];
  const renames: JsonRecord[] = [];
  const streams = new Set<(text: string) => void>();
  const encoder = new TextEncoder();

  const broadcast = (text: string): void => {
    for (const send of streams) send(text);
  };

  const event = (name: string, data: Payload, id?: number): string => `event: ${name}\n${id === undefined ? "" : `id: ${id}\n`}data: ${JSON.stringify(data)}\n\n`;
  const json = (status: number, body: Payload): Response => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  const server = Bun.serve({
    port: options.port ?? 0,
    idleTimeout: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname.replace(/^\/f\/[^/]+/u, "");

      if (path === "/" || path === "/index.html") {
        return new Response(pageHtml(options.template, view), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (path === "/state.json") return json(200, view);

      if (path === "/skills") return options.skills === undefined ? json(404, { error: "not found" }) : json(200, { skills: options.skills, builtins: false });

      if (path === "/events") {
        const after = Number(new URL(req.url).searchParams.get("after") ?? req.headers.get("Last-Event-ID") ?? 0);
        let send: ((text: string) => void) | undefined;

        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            send = (text) => controller.enqueue(encoder.encode(text));
            streams.add(send);
            send(event("hello", { write: true, you: "luiz@example.com", max_bytes: 256 * 1024 }));
            send(event("state", view));

            for (const m of messages) if (m.id > after) send(event("chat", m, m.id));
          },
          cancel() {
            if (send !== undefined) streams.delete(send);
          },
        });

        return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" } });
      }

      if (req.method === "POST" && path === "/chat/preview") return json(200, { to: ["coordinator"], parts: [] });

      if (req.method === "POST" && path === "/chat") {
        // SAFETY: the page posts a JSON object with these fields.
        const body = (await req.json()) as { text: string; re?: number; decision?: string; quote?: Message["quote"]; side?: number | "new" };
        const id = Math.max(0, ...messages.map((x) => x.id)) + 1;
        let m: Message = { id, at: new Date().toISOString(), from: "user", to: ["coordinator"], text: body.text };

        if (body.re !== undefined) m = { ...m, re: body.re };

        if (body.decision !== undefined) m = { ...m, decision: body.decision };

        if (body.quote !== undefined) m = { ...m, quote: body.quote };

        if (body.side !== undefined) m = { ...m, side: body.side === "new" ? id : body.side };
        messages.push(m);
        posted.push(m);
        broadcast(event("chat", m, m.id));

        return json(201, m);
      }

      if (req.method === "POST" && path === "/name") {
        // SAFETY: the page posts {name} or {agent, name}.
        const body = (await req.json()) as { readonly agent?: string; readonly name: string };
        renames.push(body.agent === undefined ? { name: body.name } : { agent: body.agent, name: body.name });
        const name = body.name.trim();

        if (body.agent === undefined) {
          view = { ...view, named: { id: name.toLowerCase(), session: name === "" ? null : name } };
          broadcast(event("state", view));

          return json(200, { id: name.toLowerCase(), session: name, path: new URL(req.url).pathname.replace(/name$/u, "") });
        }

        const agents = Array.isArray(view["agents"]) ? view["agents"].filter((a): a is JsonRecord => a !== null && Object(a) === a && !Array.isArray(a)) : [];
        const other = agents.find((a) => a["id"] !== body.agent && String(a["name"]).toLowerCase() === name.toLowerCase());

        if (other !== undefined) return json(400, { error: `agent ${body.agent} is called '${name.toLowerCase()}', which is also agent ${String(other["id"])}; a mention could not tell them apart` });
        view = { ...view, agents: agents.map((a) => (a["id"] === body.agent ? { ...a, name: name === "" ? body.agent : name, name_by: "user" } : a)) };
        broadcast(event("state", view));

        return json(200, { agent: body.agent, name, name_by: "user" });
      }

      if (req.method === "POST" && path === "/_state") {
        // SAFETY: the test posts a view.
        view = (await req.json()) as View;
        broadcast(event("state", view));

        return json(200, {});
      }

      if (req.method === "POST" && path === "/_chat") {
        // SAFETY: the test posts a message.
        const m = (await req.json()) as Message;
        messages.push(m);
        broadcast(event("chat", m, m.id));

        return json(200, {});
      }

      return json(404, { error: "not found" });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}/f/billing/`,
    posted,
    renames,
    setView(next) {
      view = next;
      broadcast(event("state", view));
    },
    say(m) {
      messages.push(m);
      broadcast(event("chat", m, m.id));
    },
    stop() {
      void server.stop(true);
    },
  };
}
