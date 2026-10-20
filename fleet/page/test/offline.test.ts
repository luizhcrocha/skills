/**
 * The tests' browser (setup.ts) loads no page over the network: a frame the page opens (the manager's embed of
 * a fleet's page, `#dv-embed`) and a link that opens a new page reach no server, so no load is in flight when a
 * test removes its frame, and none fails against the window's own address (127.0.0.1:9).
 */
import { expect, test } from "bun:test";

test("a frame's page and a link opened in a new page reach no server", async () => {
  const asked: string[] = [];

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      asked.push(new URL(req.url).pathname);

      return new Response("<p>A fleet's page.</p>", { headers: { "content-type": "text/html" } });
    },
  });

  const base = `http://127.0.0.1:${String(server.port)}`;
  const frame = document.createElement("iframe");
  const link = document.createElement("a");

  try {
    frame.src = `${base}/f/infra/?embed=1#decision/d172`;
    link.href = `${base}/f/billing/x`;
    link.target = "_blank";
    document.body.append(frame, link);
    link.click();
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    frame.remove();
    link.remove();
    void server.stop(true);
  }

  expect(asked).toEqual([]);
});
