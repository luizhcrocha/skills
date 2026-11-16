---
name: deliver
description: "Put a file, page or running app in front of Luiz: Quick Look, Artifact, tailnet URL or Taildrop. Use whenever you ask Luiz to look at, read, open or approve something."
---

# Deliver

A path on this machine reaches Luiz only when he sits at it. Before you ask him to look at something, find where he is and pick the channel that suits the content.

## 1. Where he is

- In Rex (`$REX_SESSION` is set): `rex client ls -s "$REX_SESSION" --json`. A client with `info.kind` `app` and `principal.transport` `tailscale` is remote, and its `principal.node` names his device. When no client has `principal.transport` `tailscale`, he is at this machine.
- Outside Rex: a SendUserFile tool in your tool list means he follows the session from another device.

Done when you know whether he is remote and, if he is, his device's node name.

## 2. The channel

Weigh the file's type, how he best reads it, whether it will change, and whether it is a one-off.

- **peek.** A file on this machine he looks at once, or a few times while it changes, such as Markdown, HTML, an image, a PDF or a text file. `peek <file>...` (tstack's `bin/peek`) prints a tailnet URL per file. He hovers it in Rex and presses Cmd+Y, and Quick Look previews it; Markdown arrives as HTML. The URL stays the same for the same file and shows its current content, so after an edit you ask him to press Cmd+Y again. `peek ls` lists what is linked.
- **Artifact.** A page he reads that changes across versions, or that he will comment on or pass along, such as a design, a model, a report or an explainer. Publish it with the Artifact tool. Markdown becomes an HTML page. Republish from the same file path to keep the link.
- **Tailnet URL.** An app or dev server running on this machine, or a folder to browse. Serve a local port: start the server bound to `127.0.0.1` (the app's own, or `python3 -m http.server <port> --bind 127.0.0.1 -d <dir>`), then `tailscale serve --bg --https=<port> <port>`. The URL is `https://<Self.DNSName>:<port>/`, the name from `tailscale status --json`. Serving a file path directly needs root. Use `tailscale serve`, which stays on the tailnet. `funnel` publishes to the internet.
- **Taildrop.** A file he keeps or opens in an app on his device, such as a spreadsheet, a document to edit, a video or an archive. `tailscale file cp <file> <node>:`, or SendUserFile when that is how he follows the session.
- **The path.** `file:line`, only when he is at this machine and the file reads well in his editor.

Content that must stay private (client data, anything secret) goes through peek, a tailnet URL or Taildrop, never an Artifact. Done when one channel is chosen with its reason.

## 3. Hand it over

Put the link, or the name of the file that arrived, in the same message or dialog that asks him to look. Print a URL on a line of its own, so Cmd+Y finds it. When he is done with a tailnet URL you served, run `tailscale serve --https=<port> off` and stop the server you started. Leave peek's server up, since other sessions' links use it. Done when what you sent opens on his device, or he has the path at this machine.
