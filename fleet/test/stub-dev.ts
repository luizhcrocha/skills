/**
 * A stand-in dev server for the preview's tests: `bun stub-dev.ts PORT [BASE]` serves the files of its
 * working directory under BASE (as Vite does with `--base`), says in headers which path and Host it was
 * asked with, redirects BASE without its slash, and echoes WebSocket messages on the `vite-hmr` protocol.
 */
const [portText = "0", base = "/"] = process.argv.slice(2);

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(portText),
  fetch(req, server) {
    const url = new URL(req.url);

    if ((req.headers.get("upgrade") ?? "").toLowerCase() === "websocket") {
      return server.upgrade(req, { data: undefined, headers: { "Sec-WebSocket-Protocol": "vite-hmr" } }) ? undefined : new Response("no upgrade", { status: 400 });
    }

    if (`${url.pathname}/` === base) return new Response(null, { status: 302, headers: { Location: base } });

    if (!url.pathname.startsWith(base)) return new Response(`not under ${base}: ${url.pathname}`, { status: 404 });
    const name = url.pathname.slice(base.length) || "index.html";

    return new Response(Bun.file(`${process.cwd()}/${name}`), { headers: { "X-Host": req.headers.get("host") ?? "", "X-Path": url.pathname, "X-Method": req.method } });
  },
  websocket: {
    message(ws, message) {
      ws.send(`echo:${String(message)}`);
    },
  },
});

process.stdout.write(`stub dev server on ${portText} at ${base}\n`);
