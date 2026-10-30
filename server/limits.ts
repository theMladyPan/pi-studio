// @ts-nocheck -- lifted byte for byte; annotating it is its own commit.
/**
 * Caps and timeouts. They are policy rather than behaviour, so they live in one place and every module
 * that enforces one imports it from here.
 */


export const MAX_BODY_BYTES = 1_000_000;


/** One row of the rail keeps what the panel draws, and the rail is filed to disk on every change. */
export const MAX_ROW_CHARS = 64_000;


/** A note is markdown the board repaints on every change, so its size has a ceiling. */
export const MAX_NOTE_CHARS = 100_000;


/** A source card carries a whole file, so the ceiling is higher and still finite. */
export const MAX_SOURCE_CHARS = 200_000;


/** A card's name is read at a glance, so it is one short line and not a paragraph. */
export const MAX_TITLE_CHARS = 200;


/** A question whose agent is waiting holds that child's turn open, so it cannot wait forever. */
export const ASK_TIMEOUT_MS = 5 * 60_000;


/** One card asks at most this many questions: more than five tabs is a form, not a question. */
export const MAX_ASK_QUESTIONS = 5;


export const BROWSE_LIMIT = 200;


export const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;


/** A spawned run is bounded: the timeout is the only thing that ends a child nobody is watching. */
export const SPAWN_TIMEOUT_MS = 10 * 60_000;


/** Compaction is one summarising call in the child, and the button waits on the child's answer. */
export const COMPACT_TIMEOUT_MS = 2 * 60_000;


/** A child asked to stop still reports what it had, so the kill waits a moment for that. */
export const SPAWN_ABORT_GRACE_MS = 5_000;


/** What a spawned child may say back. The master reads it in its own context, so it has a ceiling. */
export const SPAWN_REPLY_CHARS = 20_000;
