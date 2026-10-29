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


export const BROWSE_LIMIT = 200;


export const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
