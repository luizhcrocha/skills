/**
 * The page's entry: the state the renderer embedded in `#fleet-state`, parsed by the rules of the
 * `fleet-core` script, rendered into `#page`. A template rendered without a state says so.
 */
import { render } from "@solidjs/web";

import { App } from "./App.tsx";
import { Core, type Json, type State } from "./core.ts";

/** The state embedded in the page, or null. */
function embedded(): State | null {
  try {
    // SAFETY: JSON.parse returns JSON; parseState checks it.
    return Core.parseState(JSON.parse(document.getElementById("fleet-state")?.textContent ?? "") as Json);
  } catch {
    return null;
  }
}

const root = document.getElementById("page");

const state = embedded();

if (root && state) render(() => <App state={state} />, root);
else if (root) {
  render(
    () => (
      <div class="wrap" id="app">
        <div class="error">No fleet state embedded. Render this template with fleet render.</div>
      </div>
    ),
    root,
  );
}
