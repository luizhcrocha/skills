/**
 * The page's stream: `state` events replace the page's state, `chat` events fill the conversation, both
 * from one EventSource on "events" beside the page. The browser resumes a dropped stream with
 * Last-Event-ID; a stream the server closed is reopened here with ?after=<last id>. When the stream never
 * opens (a file, a claude.ai artifact, a server without the route), the page polls state.json and the chat
 * shows as unavailable. Polling also covers a reconnect.
 */
import { flush } from "solid-js";

import type { Json } from "./core.ts";
import type { Model } from "./model.ts";
import type { Ui } from "./ui.ts";

/** Where the page stands with the stream and the poll. */
interface Connection {
  opened: boolean;
  replayUntil: number;
  retry: number;
  lastAttempt: number;
  poller: ReturnType<typeof setInterval> | undefined;
}

/** Keep the page live: connect, and poll while the stream is down. */
export function goLive(m: Model, ui: Ui): void {
  const live: Connection = { opened: false, replayUntil: 0, retry: 0, lastAttempt: 0, poller: undefined };

  const setConn = (c: Parameters<Model["setConn"]>[0]): void => {
    m.setConn(c);
    flush();
  };

  async function poll(): Promise<void> {
    try {
      const res = await fetch("state.json", { cache: "no-store" });

      if (!res.ok) return;
      m.takeState(await res.text());

      if (m.conn() === "unavailable" && Date.now() - live.lastAttempt > 60_000) connect();
    } catch {
      // not served beside a state file
    }
  }

  const startPolling = (): void => {
    live.poller ??= setInterval(() => void poll(), 5000);
  };

  const stopPolling = (): void => {
    clearInterval(live.poller);
    live.poller = undefined;
  };

  function connect(): void {
    live.lastAttempt = Date.now();

    if (!("EventSource" in globalThis)) {
      setConn("unavailable");
      startPolling();

      return;
    }

    let es: EventSource;

    try {
      es = new EventSource(m.lastId() ? "events?after=" + String(m.lastId()) : "events");
    } catch {
      setConn("unavailable");
      startPolling();

      return;
    }

    setConn(live.opened ? "reconnecting" : "connecting");
    es.addEventListener("open", () => {
      if (!live.opened) live.replayUntil = Date.now() + 1500;
      live.opened = true;
      live.retry = 0;
      setConn("live");
      stopPolling();
    });
    es.addEventListener("hello", (ev) => {
      try {
        // SAFETY: the hub's hello is a JSON object; each field is read through a check.
        const h = JSON.parse(ev.data) as { readonly write?: Json; readonly reason?: Json; readonly you?: Json; readonly max_bytes?: Json };
        m.setWrite(h.write === false ? { ok: false, reason: String(h.reason || "") } : { ok: true, reason: "" });
        m.setYou(h.you === String(h.you) ? h.you : "");
        m.setMaxBytes(Number.isSafeInteger(h.max_bytes) && Number(h.max_bytes) > 0 ? Number(h.max_bytes) : undefined);
      } catch {
        m.setWrite({ ok: true, reason: "" });
      }

      flush();
    });
    es.addEventListener("chat", (ev) => {
      try {
        // SAFETY: parsed JSON; parseMessage checks it.
        ui.addMessage(JSON.parse(ev.data) as Json, Date.now() > live.replayUntil);
      } catch {
        // a malformed line is skipped
      }
    });
    es.addEventListener("state", (ev) => m.takeState(ev.data));
    es.onerror = () => {
      if (es.readyState === EventSource.CONNECTING) {
        if (live.opened) {
          setConn("reconnecting");
          startPolling();
        }

        return;
      }

      es.close();

      if (!live.opened) {
        setConn("unavailable");
        startPolling();

        return;
      }

      setConn("reconnecting");
      startPolling();
      setTimeout(connect, Math.min(30_000, 1000 * 2 ** live.retry++));
    };
  }

  if (location.protocol.startsWith("http")) connect();
  else setConn("unavailable");
}
