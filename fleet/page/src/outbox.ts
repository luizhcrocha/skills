/**
 * The outbox of the decision shown (Marks.tsx), as the chat's composer reaches it: a message Luiz sends in
 * the main chat while a decision's page is shown first sends what waits there, in the same flush, so the
 * owner wakes once and reads the comments before the message.
 */

/** Where the decision shown's outbox can be flushed from: null while no decision's page is shown. */
export interface OutboxSlot {
  current: (() => Promise<void>) | null;
}

/** The decision shown's outbox. */
export const outbox: OutboxSlot = { current: null };
