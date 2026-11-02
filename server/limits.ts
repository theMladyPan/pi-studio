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


/** A child that has reported is spent, and its card goes this long after the answer is read. */
export const CHILD_CLOSE_DELAY_MS = 20_000;


/**
 * How many children the board put away are filed with it. They are the shape `putAwayByBoard` describes — a
 * hidden child carrying `closedAt` and the thread that spawned it — and own no cards, so they stay in
 * `board.threads` for the rail to offer back, and a board that spawns all day would file them for ever.
 * Newest are kept: the one the human wants back is the one they closed last.
 */
export const MAX_PUT_AWAY_CHILDREN = 40;


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


/**
 * A `!command` in the composer is run on the human's own machine and the field waits for it, so it is held to
 * a minute: long enough for a build or a test run, short enough that a command reading input or waiting on
 * nothing ends as a report rather than as a field that never comes back.
 */
export const SHELL_TIMEOUT_MS = 60_000;


/**
 * What a `!command` may put on the board. The output is a card and then a quote inside the next prompt, so it
 * is a glance at what the command said and not a copy of everything it printed.
 */
export const SHELL_OUTPUT_CHARS = 20_000;
