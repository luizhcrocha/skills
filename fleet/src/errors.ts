/**
 * The fleet's expected failures. Each CLI prints a refusal as `<prefix>: <reason>` on stderr and exits 1,
 * as the Python scripts' `fail()` does; a usage error exits 2, as argparse does.
 */
import * as Schema from "effect/Schema";

/** Who refuses: the prefix the Python script that refused printed. */
export const Speaker = Schema.Literals(["state", "chat", "fleets", "render_dashboard", "hub", "serve", "usage", "spend", "ws", "brief", "turn"]);

/** A refused command: nothing is written, the CLI exits 1. */
export class Refusal extends Schema.TaggedError<Refusal>()("Refusal", {
  speaker: Speaker,
  reason: Schema.String,
}) {}

/** A command line that does not parse: the CLI prints its usage and exits 2. */
export class UsageError extends Schema.TaggedError<UsageError>()("UsageError", {
  prog: Schema.String,
  usage: Schema.String,
  reason: Schema.String,
}) {}

/** A refused chat message or an unknown participant (Python's `ChatError`): the CLI exits 1 with it. */
export class ChatError extends Schema.TaggedError<ChatError>()("ChatError", {
  reason: Schema.String,
}) {}

/** The ledger refused by `state`. */
export function stateRefusal(reason: string): Refusal {
  return new Refusal({ speaker: "state", reason });
}

/** The ledger refused by the final check, as `render_dashboard.validate` words it. */
export function invalid(reason: string): Refusal {
  return new Refusal({ speaker: "render_dashboard", reason });
}
