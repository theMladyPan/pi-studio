/**
 * The shapes that cross a boundary as plain JSON: what the daemon writes to disk and what it puts on
 * the wire. They are the contract the client and the on-disk format both depend on, so they live here
 * rather than beside whichever module happens to build them first.
 */

/** `daemon.json`: what the last run left behind, read back so a restarted daemon keeps its token. */
export type DaemonRecord = {
	token: string;
	port: number;
	at: string;
};
