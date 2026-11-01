// @ts-nocheck -- written to the shape of its neighbours, which are lifted byte for byte.
/**
 * The six settings a board holds about the cards its threads write: how often, for whom, and what may be
 * inside one.
 *
 * Two of them choose a prompt file — `prompts/verbosity/<id>.md` and `prompts/audiences/<id>.md` — so
 * the words are editable where every other word this app sends to a model is editable. The four content
 * switches are one sentence each, built here, because a file per boolean is a file too many.
 *
 * This module is the only place the ids are written down. A board file may hold anything; what reaches a
 * prompt is one of these ids or the default.
 */
import { promptText } from "./child/modes.ts";



/** How often a thread opens a card. */
export const CARD_VERBOSITY = ["quiet", "normal", "verbose"];



/** Who a card is written for: the register, and how much is spelled out. */
export const CARD_AUDIENCE = ["programmer", "data-analyst", "designer", "vibecoder", "junior", "mathematician"];



/** What may be inside a card. Four switches, in the order a card reads them. */
export const CARD_SHOWS = ["showCodeFragments", "showMathFormulas", "showCharts", "showReferences"];



/** What a board holds before anybody chooses, and what an older board file is read as. */
export const CARD_DEFAULTS = {
	cardsVerbosity: "normal",
	cardsAudience: "programmer",
	showCodeFragments: true,
	showMathFormulas: true,
	showCharts: true,
	showReferences: true,
};



/**
 * The six values a board holds, each checked against the list it belongs to, and filled in where the
 * board file was written before the setting existed. A value nobody recognises is not a choice.
 */
export function cardSettings(config) {
	const chosen = config ?? {};
	const settings = {
		cardsVerbosity: CARD_VERBOSITY.includes(chosen.cardsVerbosity) ? chosen.cardsVerbosity : CARD_DEFAULTS.cardsVerbosity,
		cardsAudience: CARD_AUDIENCE.includes(chosen.cardsAudience) ? chosen.cardsAudience : CARD_DEFAULTS.cardsAudience,
	};
	for (const key of CARD_SHOWS) settings[key] = typeof chosen[key] === "boolean" ? chosen[key] : CARD_DEFAULTS[key];
	return settings;
}



/**
 * What each switch says to the model, as the two answers it can give. A permission that is off is not a
 * silence: the line says what to do instead, because a card emptied of code and left with nothing is
 * worse than the code that was not allowed.
 */
const SHOW_TEXT = {
	showCodeFragments: [
		"- code fragments: yes. An identifier, a path, or a short snippet, where the exact text is the point.",
		"- code fragments: no. Say what the code does in words instead.",
	],
	showMathFormulas: [
		"- math formulas: yes. Notation and symbols are fine, each one defined where it first appears.",
		"- math formulas: no. The same claim in plain words and numbers.",
	],
	showCharts: [
		"- charts: yes. A chart of real numbers is a fenced svg block, a table of numbers is a table. A mermaid diagram is always fine: it shows structure, not numbers.",
		"- charts: no. No chart and no table of numbers; a mermaid diagram is still fine, because it shows structure.",
	],
	showReferences: [
		"- references: yes. A claim that is not your own reading of the code carries a marker in the line and a source at the foot of the card, and a source is a URL or a file path with a line. A source that resolves to neither is not a source: say you could not ground the claim instead of inventing one.",
		"- references: no. No source block; a claim that will not stand without one is left out rather than asserted.",
	],
};



/**
 * The block a thread that draws on the board is given about the cards. A prompt file is a paragraph and
 * goes under its own heading; a switch is one line. The last line is what keeps the advanced and complex
 * flows running on a quiet board, where the flow itself asks for a card.
 */
export function cardsBlock(config) {
	const cards = cardSettings(config);
	const verbosity = promptText("verbosity", cards.cardsVerbosity);
	const audience = promptText("audiences", cards.cardsAudience);
	return [
		`Cards on this board: ${cards.cardsVerbosity}.${verbosity ? ` ${verbosity}` : ""}`,
		`Cards are written for: ${cards.cardsAudience}.${audience ? ` ${audience}` : ""}`,
		"What a card may contain:",
		...CARD_SHOWS.map((key) => SHOW_TEXT[key][cards[key] ? 0 : 1]),
		"This thread's own flow, or the human asking for a card in so many words, wins over every line above.",
	].join("\n");
}
