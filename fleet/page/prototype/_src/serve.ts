// PROTOTYPE static server for this folder only, on 127.0.0.1:47811 (tailscale serve fronts it on :8487).
const root = new URL("..", import.meta.url).pathname;
Bun.serve({
  hostname: "127.0.0.1",
  port: 47811,
  async fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path.endsWith("/")) path += "index.html";
    if (path.includes("..") || path.includes("/_src/") || path.includes("/.")) return new Response("Not found", { status: 404 });
    const f = Bun.file(root + path.slice(1));
    return (await f.exists()) ? new Response(f, { headers: { "Cache-Control": "no-store" } }) : new Response("Not found", { status: 404 });
  },
});
console.log("prototype server on http://127.0.0.1:47811/");
