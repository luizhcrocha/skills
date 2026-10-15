/**
 * What a field's images look like: the tray of thumbnails under it until the message is sent (each removable),
 * the attach button that picks one from the device (a phone whose paste gives no file), and the images of a sent
 * message, each a thumbnail that opens full size.
 */
import { For, Show, type JSX } from "@solidjs/web";

import { IMAGE_TYPES, onPeerFleet, type Attachments } from "./attach.ts";

/** The images waiting to go with a field's message, and why the last one was not taken. */
export function AttachTray(props: { readonly a: Attachments; readonly id?: string }): JSX.Element {
  return (
    <div class="attach-tray" id={props.id} hidden={!props.a.paths().length && !props.a.busy() && !props.a.error()}>
      <ul aria-label="Images to send">
        <For each={props.a.paths()} keyed={(p) => p}>
          {(p, i) => (
            <li>
              <img src={p()} alt={`Image ${String(i() + 1)}`} />
              <button type="button" class="icon-btn" aria-label={`Remove image ${String(i() + 1)}`} title="Remove" onClick={() => props.a.remove(p())}>
                ×
              </button>
            </li>
          )}
        </For>
        <Show when={props.a.busy()}>
          <li class="attach-busy" aria-label="Sending the image">
            …
          </li>
        </Show>
      </ul>
      <p class="attach-error" role="alert" hidden={!props.a.error()}>
        {props.a.error()}
      </p>
    </div>
  );
}

/** The button that picks images from the device: a real button (a keyboard reaches it) that opens the hidden file
 * input. None on a peer hub's fleet, which takes no upload from this page. */
export function AttachButton(props: { readonly a: Attachments; readonly id?: string; readonly disabled?: boolean }): JSX.Element {
  let input: HTMLInputElement | undefined;

  return (
    <Show when={!onPeerFleet()}>
      <span class="attach" id={props.id}>
        <button type="button" class="attach-btn icon-btn" title="Attach an image" aria-label="Attach an image" disabled={props.disabled} onClick={() => input?.click()}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M16.5 6.5 8.4 14.6a2 2 0 0 0 2.8 2.8l8.1-8.1a4 4 0 0 0-5.6-5.6L5.6 11.8a6 6 0 0 0 8.5 8.5l6.4-6.4" />
          </svg>
        </button>
        <input
          ref={(el) => {
            input = el;
          }}
          type="file"
          accept={IMAGE_TYPES.join(",")}
          multiple
          hidden
          tabindex={-1}
          disabled={props.disabled}
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = "";
            props.a.add(files);
          }}
        />
      </span>
    </Show>
  );
}

/** A sent message's images: each a thumbnail, a link to the image full size. */
export function Pictures(props: { readonly images: readonly string[] | undefined }): JSX.Element {
  return (
    <Show when={props.images?.length}>
      <div class="msg-images">
        <For each={props.images ?? []} keyed={(p) => p}>
          {(p, i) => (
            <a href={p()} target="_blank" rel="noopener" title="Open the image full size">
              <img src={p()} alt={`Image ${String(i() + 1)}`} loading="lazy" />
            </a>
          )}
        </For>
      </div>
    </Show>
  );
}
