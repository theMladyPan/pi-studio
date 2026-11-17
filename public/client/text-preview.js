/**
 * One text surface for the board, and the colour that goes on it.
 *
 * Two places read a file as text: the drawer's editor and the git graph's reader. They differ in
 * whether a caret exists, not in how a line is drawn, so the tokenizer and the surface live here and
 * both pages import them. The board's code panels were the first caller and keep the same colours and
 * the same token classes (`k`, `s`, `c`, `n2`, `f`), which `index.html` and `gitgraph.html` paint.
 *
 * A tokenizer is not a parser: it knows strings, comments, numbers, the name in front of a `(` and a
 * short list of words a language reserves. That is what colour buys a reader, and nothing here
 * guesses at meaning. Every fragment is escaped before it reaches the DOM, because the text being
 * coloured came out of a file and a file is not trusted.
 */

// ---------- escaping -------------------------------------------------------
/** Text into HTML, with every character that could start a tag or an attribute written out. */
export function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------- the grammars ---------------------------------------------------
/**
 * The pieces every grammar is built from, in the order the tokenizer tries them: a string owns the
 * `#` or `//` inside it, a comment owns the words inside it, and only then does a bare number, a name
 * in front of a `(` or a reserved word get a colour. A group left out of a language is `(?!)`, which
 * cannot match, rather than an empty group, which would match everywhere and split nothing.
 */
const NOTHING = "(?!)";

/**
 * The shared fragments, as regex source. A backtick cannot stand inside a template literal, so the two
 * fragments that need one are plain strings; everywhere else `String.raw` leaves the escapes as they read.
 * These are the board's own strings, byte for byte: the code panels' colours may not move.
 */
const QUOTES = String.raw`"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|` + "`(?:[^`\\\\]|\\\\.)*`";
/** Python's triple quotes, which hold newlines, so they are tried before its ordinary ones. */
const PY_STRINGS = String.raw`"""[\s\S]*?"""|'''[\s\S]*?'''|` + QUOTES;
const NUMBERS = String.raw`\b\d+(?:\.\d+)?\b`;
const CALLS = String.raw`\b[A-Za-z_]\w*(?=\()`;
/** The words the board's code panels have always coloured, kept whole with their own boundaries. */
const PLAIN_WORDS = String.raw`\b(?:def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|with|lambda|yield|await|async|const|let|var|function|export|default|new|throw|catch|switch|case|break|continue|type|interface|struct|fn|pub|use|mod|match|impl|self|this|True|False|None|null|true|false|nil|end|do|then)\b`;

const JAVASCRIPT_WORDS = String.raw`\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|throw|try|catch|finally|class|extends|super|this|import|export|default|from|as|await|async|yield|typeof|instanceof|in|of|delete|void|interface|type|enum|implements|public|private|protected|readonly|declare|namespace|true|false|null|undefined)\b`;

const PYTHON_WORDS = String.raw`\b(?:def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|with|lambda|yield|await|async|pass|raise|assert|global|nonlocal|del|in|is|not|and|or|None|True|False|self)\b`;

const SHELL_WORDS = String.raw`\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|function|in|select|time|export|local|readonly|declare|return|shift|set|unset|source|exit|true|false)\b`;

/** A CSS at-rule and the one flag a declaration can carry. Neither has a word boundary to sit on. */
const CSS_WORDS = String.raw`@media|@import|@supports|@font-face|@keyframes|@charset|!important`;

/** Markdown's own marks: the heading a line opens with, and the fence that holds code. */
const MARKDOWN_WORDS = String.raw`^#{1,6}[ \t][^\n]*|^\s*(?:` + "```|~~~" + ")";

/** A tag's name in HTML, opening or closing, and the attribute in front of an `=`. */
const HTML_WORDS = String.raw`<\/?[A-Za-z][\w:-]*`;
const HTML_ATTRS = String.raw`\b[A-Za-z][\w:-]*(?=\s*=)`;

/** A YAML key, and the words that are a value rather than a name. */
const YAML_WORDS = String.raw`^[ \t]*(?:-[ \t]+)?[A-Za-z_][\w.-]*(?=\s*:)|\b(?:true|false|null|yes|no|on|off)\b`;

/**
 * One entry per language name `languageOf` can return. `flags` is part of a grammar because the plain
 * one predates this module: it is compiled without `m`, exactly as the board's panels compile it, so
 * the panels' output does not move by a byte.
 */
const GRAMMARS = {
  plain: {
    flags: "g",
    strings: QUOTES,
    comments: String.raw`#.*$|\/\/.*$`,
    numbers: NUMBERS,
    calls: CALLS,
    words: PLAIN_WORDS,
  },
  py: {
    flags: "gm",
    strings: PY_STRINGS,
    comments: String.raw`#.*$`,
    numbers: NUMBERS,
    calls: CALLS,
    words: PYTHON_WORDS,
  },
  js: {
    flags: "gm",
    strings: QUOTES,
    comments: String.raw`\/\/.*$|\/\*[\s\S]*?\*\/`,
    numbers: NUMBERS,
    calls: CALLS,
    words: JAVASCRIPT_WORDS,
  },
  json: {
    flags: "gm",
    strings: String.raw`"(?:\\.|[^"\\])*"`,
    comments: NOTHING,
    numbers: String.raw`-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`,
    calls: NOTHING,
    words: String.raw`\b(?:true|false|null)\b`,
  },
  md: {
    flags: "gm",
    // A tick holding one run of text; the newline inside it is the regex's own escape, not a literal.
    strings: "`[^`\\n]*`",
    comments: String.raw`<!--[\s\S]*?-->`,
    numbers: NOTHING,
    calls: NOTHING,
    words: MARKDOWN_WORDS,
  },
  sh: {
    flags: "gm",
    strings: QUOTES,
    comments: String.raw`#.*$`,
    numbers: NUMBERS,
    calls: CALLS,
    words: SHELL_WORDS,
  },
  css: {
    flags: "gm",
    strings: QUOTES,
    comments: String.raw`\/\*[\s\S]*?\*\/`,
    numbers: String.raw`#[0-9A-Fa-f]{3,8}\b|\b\d+(?:\.\d+)?\b`,
    calls: CALLS,
    words: CSS_WORDS,
  },
  html: {
    flags: "gm",
    strings: QUOTES,
    comments: String.raw`<!--[\s\S]*?-->`,
    numbers: NOTHING,
    calls: HTML_ATTRS,
    words: HTML_WORDS,
  },
  yaml: {
    flags: "gm",
    strings: QUOTES,
    comments: String.raw`#.*$`,
    numbers: NUMBERS,
    calls: NOTHING,
    words: YAML_WORDS,
  },
};

/** The extension a language is chosen by. One name per family: five JavaScripts share a colour. */
const BY_EXTENSION = {
  py: "py",
  js: "js",
  mjs: "js",
  cjs: "js",
  ts: "js",
  tsx: "js",
  jsx: "js",
  json: "json",
  md: "md",
  markdown: "md",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  css: "css",
  html: "html",
  htm: "html",
  yaml: "yaml",
  yml: "yaml",
};

/** The name an unknown extension is drawn with: plain text, coloured only by the generic grammar. */
export const PLAIN_LANGUAGE = "plain";

/**
 * The language a path asks for, from the last extension in its name. A path with no extension, with a
 * dotfile's leading dot, or with an extension no grammar knows is plain.
 */
export function languageOf(path) {
  const name = String(path ?? "").split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return PLAIN_LANGUAGE;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? PLAIN_LANGUAGE;
}

/** Each grammar's regex, compiled once on first use: a file is opened far less often than a key is typed. */
const COMPILED = new Map();

function grammarFor(language) {
  const key = GRAMMARS[language] ? language : PLAIN_LANGUAGE;
  let compiled = COMPILED.get(key);
  if (!compiled) {
    const grammar = GRAMMARS[key];
    const source = [grammar.strings, grammar.comments, grammar.numbers, grammar.calls, grammar.words]
      .map((part) => `(${part})`)
      .join("|");
    compiled = { tokens: new RegExp(source, grammar.flags) };
    COMPILED.set(key, compiled);
  }
  return compiled;
}

/** Which colour a match wears, in the tokenizer's own order: string, comment, number, call, word. */
function classOf(match) {
  if (match[1]) return "s";
  if (match[2]) return "c";
  if (match[3]) return "n2";
  if (match[4]) return "f";
  return "k";
}

/**
 * One text into escaped HTML spans. The language is a name from `languageOf`, and a name no grammar
 * knows falls back to the generic one rather than to no colour at all.
 */
export function highlight(raw, language = PLAIN_LANGUAGE) {
  const text = String(raw ?? "");
  const { tokens } = grammarFor(language);
  let out = "";
  let last = 0;
  for (const match of text.matchAll(tokens)) {
    const [token] = match;
    if (!token.length) continue;
    out += escapeHtml(text.slice(last, match.index));
    out += `<span class="${classOf(match)}">${escapeHtml(token)}</span>`;
    last = match.index + token.length;
  }
  out += escapeHtml(text.slice(last));
  return out || "&nbsp;";
}

// ---------- the surface ----------------------------------------------------
/**
 * A text area laid over a `<pre>` that holds the same text coloured, both scrolled as one. The area is
 * the truth: it takes the caret, the selection and the typing, and its own text is never coloured, so
 * the colours under it cannot lag a keystroke behind. The `<pre>` is decoration and says so with
 * `aria-hidden`, which keeps a screen reader from reading the file twice.
 *
 * The container is emptied and filled with the two layers; the page styles them by the `tp` class.
 */
export function createTextPreview(container, { readOnly = false, onInput = null } = {}) {
  const doc = container?.ownerDocument ?? globalThis.document;
  const pre = doc.createElement("pre");
  pre.className = "tp-code";
  pre.setAttribute("aria-hidden", "true");
  const lines = doc.createElement("code");
  pre.append(lines);
  const area = doc.createElement("textarea");
  area.className = "tp-input";
  area.spellcheck = false;
  area.setAttribute("wrap", "off");
  area.setAttribute("autocapitalize", "off");
  area.setAttribute("autocomplete", "off");
  area.setAttribute("autocorrect", "off");
  area.setAttribute("aria-label", "the text of this file");
  area.readOnly = Boolean(readOnly);
  container.classList?.add("tp");
  container.replaceChildren(pre, area);

  let path = "";
  let language = PLAIN_LANGUAGE;
  let text = "";

  const paint = () => {
    lines.innerHTML = highlight(area.value, language);
  };

  area.addEventListener("scroll", () => {
    pre.scrollTop = area.scrollTop;
    pre.scrollLeft = area.scrollLeft;
  });
  area.addEventListener("input", () => {
    paint();
    if (typeof onInput === "function") onInput(area.value);
  });

  return {
    /** The file now on the surface: its path decides the colour, its content is what is shown. */
    setDocument(next = {}) {
      path = String(next.path ?? "");
      language = languageOf(path);
      text = String(next.content ?? "");
      area.value = text;
      paint();
    },
    /** The text as it stands, which is the area's own when a human has typed into it. */
    getText() {
      return typeof area.value === "string" ? area.value : text;
    },
    focus() {
      area.focus();
    },
    /**
     * Put the reader on one line, for a caller that knows where the interesting text is. The line
     * height is the page's, so it is read from the area rather than guessed here.
     */
    setLine(line) {
      const at = Math.max(1, Math.trunc(Number(line) || 1));
      const style = typeof globalThis.getComputedStyle === "function" ? globalThis.getComputedStyle(area) : null;
      const each = Number.parseFloat(style?.lineHeight ?? "") || 18;
      area.scrollTop = (at - 1) * each;
      pre.scrollTop = area.scrollTop;
    },
    /** What the surface is showing, for a caller that wants to name it. */
    getPath() {
      return path;
    },
  };
}
