---
name: deliver
description: "Put a file, page or running app in front of Luiz: Quick Look, Artifact, tailnet URL or Taildrop. Use whenever you ask Luiz to look at, read, open or approve something."
---

# Deliver

Name every file by its path, as you always do. A path on this machine opens only when Luiz sits at it, so before you ask him to look at something, find where he is and, when he is remote, add a channel that reaches his device.

## 1. Where he is

- In Rex (`$REX_SESSION` is set): `rex client ls -s "$REX_SESSION" --json`. A client with `info.kind` `app` and `principal.transport` `tailscale` is remote, and its `principal.node` names his device. When no client has `principal.transport` `tailscale`, he is at this machine.
- Outside Rex: a SendUserFile tool in your tool list means he follows the session from another device.

Done when you know whether he is remote and, if he is, his device's node name.

## 2. The channel

The path goes out in every case: `file:line`, or the file's absolute path. When he is remote in Rex, every file he previews also gets its peek URL beside the path. For other content, weigh its type, how he best reads it, whether it will change, and whether it is a one-off.

- **peek.** The companion to a path when he is remote in Rex: Markdown, HTML, an image, a Word document (docx, doc, odt, rtf) or a spreadsheet (xlsx, xls, ods). `peek <file>...` (tstack's `bin/peek`) prints a tailnet URL per file. He hovers it in Rex and presses Cmd+Y, and Quick Look previews it. Quick Look renders only HTML and images from a URL, so peek serves Markdown, Word documents and spreadsheets as HTML (their URLs end in `.html`). A PDF or a slide deck shows "cannot be safely displayed": send those by Taildrop. The URL stays the same for the same file and shows its current content, so after an edit you ask him to press Cmd+Y again. `peek ls` lists what is linked.
- **Artifact.** A page he reads that changes across versions, or that he will comment on or pass along, such as a design, a model, a report or an explainer. Publish it with the Artifact tool. Markdown becomes an HTML page. Republish from the same file path to keep the link.
- **Tailnet URL.** An app or dev server running on this machine, or a folder to browse. Serve a local port: start the server bound to `127.0.0.1` (the app's own, or `python3 -m http.server <port> --bind 127.0.0.1 -d <dir>`), then `tailscale serve --bg --https=<port> <port>`. The URL is `https://<Self.DNSName>:<port>/`, the name from `tailscale status --json`. Serving a file path directly needs root. Use `tailscale serve`, which stays on the tailnet. `funnel` publishes to the internet.
- **Taildrop.** A file he keeps or opens in an app on his device, such as a PDF, a slide deck, a spreadsheet or document he will edit, a video or an archive. `tailscale file cp <file> <node>:`, or SendUserFile when that is how he follows the session.

Content that must stay private (client data, anything secret) goes through peek, a tailnet URL or Taildrop, never an Artifact. Done when every file has its path and, when he is remote, the channel that reaches his device, with its reason.

## 3. Hand it over

Put the path, and the link or the name of the file that arrived, in the same message or dialog that asks him to look. Print each peek URL on a line of its own under its path, so Cmd+Y finds it:

```
/path/to/Contrato.docx
https://<host>.ts.net:8517/<id>/Contrato.docx.html
```

When he is done with a tailnet URL you served, run `tailscale serve --https=<port> off` and stop the server you started. Leave peek's server up, since other sessions' links use it. Done when he has every path and, when he is remote, what you sent opens on his device.
