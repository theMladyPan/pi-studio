// @ts-nocheck -- written to the shape of its neighbours, which are lifted byte for byte.
/**
 * The six settings a board holds about the cards its threads write: how often, for whom, and what may be
 * inside one.
 *
 * Two of them choose a prompt file — `prompts/verbosity/<id>.md` and `prompts/audiences/<id>.md` — so
 * the words are editable where every other word this app sends to a model is editable. The four content
 * switches are one sentence per level, built here, because a file per switch would be a file too many.
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



/**
 * How much of each. A switch that is only on or off cannot say "where it carries the point", which is the
 * answer a model needs about code, math, charts and sources.
 */
export const CARD_LEVELS = ["none", "some", "many"];



/** What a board holds before anybody chooses, and what an older board file is read as. */
export const CARD_DEFAULTS = {
	cardsVerbosity: "normal",
	cardsAudience: "programmer",
	showCodeFragments: "some",
	showMathFormulas: "some",
	showCharts: "some",
	showReferences: "some",
};



/**
 * One switch as a level. A boolean is what the first build of this setting stored, and it is read rather
 * than thrown away: `true` was permission without a limit, which is nearer to `some` than to `none`, and
 * a board that chose it keeps a card with content on it.
 */
function levelOf(value) {
	if (CARD_LEVELS.includes(value)) return value;
	if (value === false) return "none";
	return CARD_DEFAULTS.showCodeFragments;
}



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
	for (const key of CARD_SHOWS) settings[key] = levelOf(chosen[key]);
	return settings;
}



/**
 * What each switch is called in the prompt and on the panel, and the words a human uses to ask for it.
 * The ask is a trigger: a level says how much of a thing belongs on a card by default, and a human who
 * says "show me the function" outranks the default for the card that ask is about.
 */
const LABELS = {
	showCodeFragments: { name: "code fragments", asked: "\"show me the function\", \"show the diff\"" },
	showMathFormulas: { name: "math formulas", asked: "\"show me the formula\", \"show the math\"" },
	showCharts: { name: "charts", asked: "\"show me the chart\", \"show me the numbers\"" },
	showReferences: { name: "references", asked: "\"where does that come from\", \"show me the source\"" },
};



/**
 * What each switch says to the model, at each of its three levels. A level that allows less is not a
 * silence: the line says what to do instead, because a card emptied of code and left with nothing is
 * worse than the code that was not allowed.
 */
const SHOW_TEXT = {
	showCodeFragments: {
		none: "no code at all. Say what the code does in words.",
		some: "an identifier, a path, or a short snippet, where the exact text is the point.",
		many: "a block whenever the code is the answer: the diff, the query, the function as it now stands.",
	},
	showMathFormulas: {
		none: "no formula and no notation. The same claim in plain words and numbers.",
		some: "notation inline, each symbol defined where it first appears.",
		many: "the derivation and not only the result: the steps, the assumptions, the formula it comes from.",
	},
	showCharts: {
		none: "no chart and no table of numbers.",
		some: "one chart or one table, where it carries the point.",
		many: "a chart per series and a table per comparison, so the numbers read side by side.",
	},
	showReferences: {
		none: "no source block; a claim that will not stand without one is left out rather than asserted.",
		some: "a marker in the line and a source at the foot of the card for every claim that is not your own reasoning. A source is a URL or a file path with a line, and one that resolves to neither is not a source: say you could not ground the claim instead of inventing one.",
		many: "a source for every factual statement, the obvious ones included, each one a URL or a file path with a line.",
	},
};



/**
 * The block a thread that draws on the board is given about the cards. A prompt file is a paragraph and
 * goes under its own heading; a switch is one line. The line about mermaid is the one rule that holds at
 * every level, because a diagram shows structure rather than any of the four things a switch limits. The
 * last line is what keeps the advanced and complex flows running on a quiet board, where the flow itself
 * asks for a card.
 */
export function cardsBlock(config) {
	const cards = cardSettings(config);
	const verbosity = promptText("verbosity", cards.cardsVerbosity);
	const audience = promptText("audiences", cards.cardsAudience);
	return [
		`Cards on this board: ${cards.cardsVerbosity}.${verbosity ? ` ${verbosity}` : ""}`,
		`Cards are written for: ${cards.cardsAudience}.${audience ? ` ${audience}` : ""}`,
		"What a card may contain:",
		...CARD_SHOWS.map((key) => `- ${LABELS[key].name}: ${cards[key]} — ${SHOW_TEXT[key][cards[key]]}`),
		"A fenced mermaid block is fine at every level: a diagram shows structure, not numbers.",
		`A level is a default, not a refusal: when the human asks for the thing by name — ${CARD_SHOWS.map((key) => LABELS[key].asked).join(", ")} — that card carries it at full strength, whatever level the switch holds.`,
		"This thread's own flow, or the human asking for a card in so many words, wins over every level above.",
	].join("\n");
}

