/**
 * The tests' browser: happy-dom's globals, and Solid's JSX compiled for the page's components (dev
 * build, so Solid's diagnostics run too). Run with `bun test --conditions browser`, so Solid resolves
 * its client build.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { transform } from "@solidjs/compiler";
import { plugin } from "bun";
import { afterEach } from "bun:test";

/* The server side of a test (the harness, puppeteer) keeps Bun's own network and streams. */
const own = { fetch, Response, Request, Headers, ReadableStream, WritableStream, TransformStream, AbortController, AbortSignal, TextEncoder, TextDecoder, URL, URLSearchParams, WebSocket };

/* No page loads over the network (offline.test.ts): a frame's src and a link opened in a new page stay addresses.
 * Loaded, they fail against 127.0.0.1:9, or abort when a test removes the frame, and happy-dom prints each. */
GlobalRegistrator.register({ url: "http://127.0.0.1:9/f/billing/", width: 1280, height: 900, settings: { navigation: { disableChildFrameNavigation: true, disableChildPageNavigation: true } } });

Object.assign(globalThis, own);

/* A test that stubs `fetch` (a page's hub) leaves it to its own test: a later file's harness and puppeteer reach
 * their servers through Bun's own. */
afterEach(() => {
  globalThis.fetch = own.fetch;
});

/* happy-dom 20 writes a number set as textContent as nothing; a browser writes its digits. */
const text = Object.getOwnPropertyDescriptor(Node.prototype, "textContent");

if (text?.set && text.get) {
  const set = text.set;
  Object.defineProperty(Node.prototype, "textContent", { ...text, set(this: Node, v: string | number | null) { set.call(this, v === null ? v : String(v)); } });
}

plugin({
  name: "solid",
  setup(build) {
    build.onLoad({ filter: /\.tsx$/u }, async ({ path }) => ({ contents: transform(await Bun.file(path).text(), { filename: path, dev: true }).code, loader: "ts" }));
  },
});
