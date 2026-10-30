# Porting pi-studio to TypeScript and modules

Plan of record for `refactor/typescript-port-eb3ff34d`. Recorded against `dev` at `fcfe3cc`, measured
in the worktree. Revised once after a GLM-5.3 review; the findings that changed it are folded in and
named in "What the review changed" at the end.

## What the port is

Two files hold the whole application: `server.mjs` at **4027 lines** (12 sections, 226 top-level
declarations) and `public/board.js` at **5325 lines** (20 sections, 403 declarations). Both are split
into sections by `// ----------` comments that already match module boundaries. The port turns each
section into a module, gives the daemon real TypeScript, gives the client JSDoc types that TypeScript
checks, and covers the result with tests. Nothing about what the app does changes.

## Decisions this plan is built on

Chosen by the owner:

- **No build step (option A).** The daemon is `.ts` and Node runs it by stripping types. The client
  stays `.js` with JSDoc types, checked by `tsc --noEmit`. `npm install` is not required to run the
  app; `typescript` is a devDependency for checking only; `bin/pi-studio` stays a one-line launcher.
- **`node --test` only.** No DOM shim, no Playwright. What a test cannot see — canvas, zoom, pointer
  drag — stays a browser look, which the owner does.
- **No barrel files.** No `index.ts` re-exporting a folder. Every import names its path.
- **Existing boards keep working.** The on-disk JSON keeps its shape; the types describe it; no
  migration is written, and a round-trip test guards it.
- **Behaviour freeze.** Inside a move the function bodies stay byte identical. The only edits allowed
  are `import`/`export` lines, type annotations, and the mechanical rewrites a module boundary forces
  — which are listed below, because one of them is unavoidable and touches every module.

Verified on this machine, because the whole plan rests on it:

| what | how | result |
|---|---|---|
| Node runs a `.ts` file with no flag | `node t.ts` | works, 22.22.2 |
| a `.ts` file imports another `.ts` | `import "./imp.ts"` | resolves |
| `node --check` accepts `.ts` | `node --check imp.ts` | exit 0 |
| `node --test` finds `*.test.ts` | one test file | 1 pass |
| `tsc` present | `which tsc` | no — it becomes a devDependency |

Three consequences. Node strips types without transforming them, so the daemon may only use **erasable**
syntax: no `enum`, no `namespace`, no constructor parameter properties. Every import between daemon
modules must carry the `.ts` extension, which `tsc` accepts only with `allowImportingTsExtensions`.
And a type imported without `type` survives stripping as a runtime import of something that does not
exist, so `verbatimModuleSyntax` is on and every type-only import is written `import type`.

## Target layout

The deeper layer from the layout review, applied only where a flat module would pass 400 lines.

Daemon, `.ts` throughout:

```
server.ts                      entry: argv, --state, token bootstrap, listen, signals
server/
  main.ts                      the request handler and the route table, exported, no side effects
  types.ts                     the wire shapes: Card, Row, Meta, Git, Config, Thread
  paths.ts                     REPO_DIR, PUBLIC_DIR, BRIDGE, STATE_DIR, state files, JSON io, build hash
  models.ts                    catalogue, pi settings, scope patterns, defaults, extensions
  http.ts                      readJson, answer, fail, send, serveStatic, staticFileFor
  workspaces.ts                the list on disk, defaults for a new board
  store.ts                     boards in memory, save, load, restore, scheduleSave
  bus.ts                       send, broadcast, resync, addRow, patchRow
  cards.ts                     cardFor, plainCardFor, cardsFor, boardMeta, cleanBoard, threadError
  session.ts                   sessionFacts, sessionCwd, sessionFile, argLine, transcriptOf
  thought.ts                   thoughtEvent, settleThoughts, handleChildLine
  git/repo.ts                  gitIn, repoOf, baseRef, mainRepoOf
  git/graph.ts                 refName, gitGraph, gitStatusOf, gitPicture
  git/watch.ts                 fingerprint, refresh, note, watch, unwatch
  worktrees/make.ts            workType, slugOf, ensureWorktree, workdirOf, headBranch
  worktrees/name.ts            titleFromRequest, namePrompt, plausibleTitle, askOnce, nameThread
  worktrees/retire.ts          retireWorktree, sameFolder
  child/argv.ts                installRoot, piCli, keptArgs, extensionsFor, toolsOffFor, childArgv
  child/prompts.ts             worktreePrompt, boardPrompt
  child/describe.ts            describeTool, headline, resultText, rowResult
  child/run.ts                 ensureChild, prompt, liveTurn, runText, stopStream, streamTick
  routes/crossroads.ts         the workspace list and the picker
  routes/board/thread.ts       onThread, cardPreamble, rootOf, anchorOf, placedRect
  routes/board/lifecycle.ts    closeThread, killChild, forgetCard, onClose, onReopen, onStop, onKill
  routes/board/content.ts      onNote, onSource, onEdit, onRename, onBrowse, readInsideWorkspace
  routes/board/answer.ts       settleQuestion, onAsk, onAnswer
  routes/board/message.ts      onMessage, homeCard, ownedCards, refreshOwned, threadForRuntime
  routes/board/config.ts       onModel, onThinking, onConfig, onLayout, onClean, onNew
```

Client, `.js` with JSDoc. **Every module moves under `public/client/`**, so one prefix rule serves all
of them and `index.html` loads `/client/board.js`. The entry keeps its name and its job:

```
public/client/board.js         composition root: the wiring, then BOARD_START
public/client/state.js         `state` object, view, cards, byId, auth, the DOM refs
public/client/types.js         JSDoc typedefs only, no runtime exports
public/client/lib/dom.js       el, escapeHtml and the other pure helpers
public/client/lib/markdown.js  the renderer
public/client/lib/highlight.js the tokenizer
public/client/body/source.js   sourceBody, detailsBlock, worktreeLine
public/client/body/question.js questionBody, submitAnswer, paintAnswer
public/client/body/thread.js   turnNode, turnShape, paintThread, stickyBody
public/client/card/make.js     makeCard, compact, paintSections, paintFooter, fitContent, bodyFor
public/client/card/paint.js    paintCard, bodySame, applyMessage, cardChanged, markUpdated
public/client/card/select.js   selectCard, attentionCard, reveal, dropCard, closeCard, clearBoard
public/client/card/order.js    tidy, stack, startCardDrag, jumpToFresh
public/client/card/fresh.js    armSeen, clearFresh, paintPill, recomputePill
public/client/rail/shell.js    the rail, railSection, applyActivity, trimRail, applyClosed
public/client/rail/transcript.js  trLoad, trOpen, trClose, agoText
public/client/rail/detail.js   actRow, paintActPanel, fetchActDetail, thought rows
public/client/rail/panels.js   panelBlock, panelCode, panelDiff, looksLikeDiff, panelPicture
public/client/pick/models.js   paintRuntime, drawModels, pickRow, revealRow
public/client/pick/tools.js    drawTools, toolRow, setTools
public/client/pick/levels.js   drawLevels
public/client/view.js          pan, zoom, fit, the halo
public/client/minimap.js
public/client/gitstrip.js
public/client/header.js        applyMeta, renderLive, tick, ticker, title flash, the workspace jump
public/client/transport.js     connect
public/client/composer.js      the field, drafts, setReplyTarget, sendMessage
public/client/picker.js        the popup shell: open, close, place, choose
public/client/files.js         browse, the list, chips, picked paths
public/client/config.js        the settings panel, clean, new
public/client/threads.js       grouping, order, stack
```

`public/index.html`, `public/welcome.html`, `public/welcome.js`, `public/welcome.css` stay where they
are; `welcome.js` is 360 lines and is not part of this port.

## Repo-relative constants move once, into `paths.ts`

`PUBLIC_DIR`, `BRIDGE` (`bridge/child-bridge.mjs`) and the `.git` lookup inside `buildHash()` all
resolve from `import.meta.url`. Inside `server/` every one of them would point one directory too deep.
`PUBLIC_DIR` failing is loud; `BRIDGE` failing is silent — `existsSync` turns false, the `-e` flag is
dropped from the child's argv, and every thread spawns without `board_note`, `board_source` and
`board_ask`. So `paths.ts` defines, once:

```ts
export const REPO_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
export const PUBLIC_DIR = join(REPO_DIR, "public");
export const BRIDGE = join(REPO_DIR, "bridge", "child-bridge.mjs");
```

and a test asserts both paths exist. Nothing else in the daemon may call `fileURLToPath`.

## Where the shared state goes

Measured, not assumed.

**Daemon.** Of the 42 declarations in the preamble only two are used by four or more sections (`run`,
`THINKING_LEVELS`); the coupling is between sections. Heaviest edges: `the server ← routes: the board`
(20), `routes: the board ← preamble` (15), `the child ← worktrees` (8). Section state lands with its
owner: the children registry in `child/run.ts`, the boards map in `store.ts`, live thought rows in
`thought.ts`, the git cache in `git/graph.ts`. `paths.ts` and `types.ts` are the only modules everything
may import, and neither imports anything but Node builtins.

**Client.** Of 44 preamble declarations, seven are used by five or more of the 19 sections — `auth` (12),
`byId` (9), `cards` (8), `view` (7), `workspace` (6), `replyTarget` (6), `live` (5) — and eight `let`
are the real mutable surface: `z`, `newestFirst`, `sawFirstCard`, `replyTarget`, `replaying`,
`framedView`, `freshCount`, `charWidths`.

An imported binding is read-only, so a module that assigns one throws at runtime. That is the one
rewrite the behaviour freeze has to allow: `state.js` exports a single mutable `state` object, and every
assignment becomes `state.z = …`, `state.replyTarget = …`. The sites are mechanical and enumerable —
`transport.js` assigns `replaying`, `sawFirstCard`, `framedView`; `card/order.js` assigns `z`;
`card/fresh.js` assigns `freshCount`; `composer.js` assigns `replyTarget` plus the other four — and the
step that introduces `state.js` does all of them at once, with a `tsc` pass to catch what a grep misses.
Readers may stay bare (`view.x`) where the binding is never assigned; only the writes move.

**Cycles.** Allowed between modules that only call each other's functions, which is most of the client.
Not allowed at module evaluation time: no module may read another module's binding while its own top
level runs. `transport.js` is the likeliest offender and is the last thing the composition root imports.

**No module may import the entry.** `server.ts` and `public/client/board.js` are the only files with
side effects at import. Everything else is a library, which is what makes the tests possible.

## Checks, and how a step is proven

All in `npm run check`, plus the suite:

- `node --check` on the entry files.
- `bin/check-imports.mjs`, extended first to `.ts` and to `server.ts`.
- `tsc -p tsconfig.node.json --noEmit` for the daemon and `tsc -p tsconfig.client.json --noEmit` for
  the client.
- `node --test`.
- `node bin/smoke.mjs`, the existing route checks, on every step.
- Client steps add a headless Chrome look at a board booted on a scratch folder.

**The strictness ratchet, corrected.** `strict` is a program-wide flag: a second strict config that
names one module still checks everything that module imports, which during the port is the untyped
monolith. So there is one config per side, `strict: true` from the first commit, and the file that has
not been ported yet carries `// @ts-nocheck` at the top. Each step that empties part of the monolith
into a module gets that module checked strictly from birth; the pragma shrinks step by step and is
deleted when the monolith is gone. The pragma is the progress bar, and every commit is green.

**Extraction order is dependency order, computed, not guessed.** Before each step, the block is
`rg`-ed for names declared in other sections; a module may only be extracted once everything it calls
is already a module. A module that reached back into the monolith would drag the entry — and its
listening socket — into every test that touched it.

## Order of work

One commit per step, each mergeable on its own. Daemon first.

0. **`bin/check-imports.mjs`.** Landed. Extended here to `.ts` and to the new entry name before
   anything is renamed.
1. **Tooling, rename, and the side-effect boundary.** `typescript` devDependency; `tsconfig.node.json`
   (`strict`, `noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`,
   `module: nodenext`), `tsconfig.client.json`; `package.json` scripts; `engines: >=22.18`;
   `server.mjs` → `server.ts` with `// @ts-nocheck` and no content change; `bin/pi-studio`,
   `bin/smoke.mjs` and `npm run dev` follow the name; `types.ts` and `paths.ts` created. Prove: smoke
   passes, `tsc` passes, `paths` test asserts `PUBLIC_DIR` and `BRIDGE` exist.
2. **`http.ts`, `models.ts`, `child/argv.ts`** (the leaf cluster `models` needs for `piCli`). Prove:
   strict, smoke, tests for scope-pattern resolution and `childArgv`.
3. **`store.ts`, `bus.ts`, `cards.ts`, `workspaces.ts`.** Prove: strict, smoke, tests for `cardFor`,
   `plainCardFor`, and a **board round-trip**: a saved board reloads identically, including the legacy
   shapes (`notes` → `cards`, `defaults` → `config`, `behind` → `hidden`, `worktree` as an object)
   that `restoredThread` still reads.
4. **`git/repo.ts`, `git/graph.ts`, `git/watch.ts`, `session.ts`.** Prove: strict, smoke, tests for
   `gitGraph` against fixture text, `refName`, and **`ensureWorktree`/`retireWorktree` against a
   throwaway git repo** built in `mkdtemp` — never the real one.
5. **`worktrees/make.ts`, `worktrees/name.ts`, `worktrees/retire.ts`.** Prove: strict, smoke, tests for
   `slugOf`, `namePrompt`, `plausibleTitle`, `sameFolder`, and retire reusing the temp repo.
6. **`child/prompts.ts`, `child/describe.ts`, `child/run.ts`, `thought.ts`.** Prove: strict, smoke,
   tests for the two prompts, `describeTool`, and **`handleChildLine`** driven by synthetic JSON lines
   against a fake board — the 242-line state machine is the largest untested thing in the daemon.
7. **`routes/crossroads.ts`, `routes/board/*.ts`, `main.ts`**, and `server.ts` reduced to an entry.
   `@ts-nocheck` deleted. Prove: the **route suite** — boot on a scratch folder and walk `/workspace`,
   `/thread`, `/message`, `/note`, `/ask`, `/answer`, `/source`, `/layout`, `/stop`, `/reopen`,
   `/config`, `/clean`, `/new`, `/browse`, `/transcript`, `/models`, `/state`, the 403 without a token,
   **one `/events` message parsed as a snapshot with `cards`, `closed`, `activity`, `meta` and `git`**,
   and **a 200 for every client module on disk**.
8. **The client switch.** `public/client/lib/{dom,markdown,highlight}.js`, `index.html` loads
   `/client/board.js` with `type="module"`, the inline `BOARD_START` call moves into the entry, the
   static allowlist becomes the `/client/` prefix rule, `bin/smoke.mjs` and `check-imports.mjs` follow.
   Its own commit: a broken import here is the only thing that can fail. Prove: headless screenshot of a
   card on a board, tests for the markdown renderer and the tokenizer.
9. **`types.js` and `state.js`.** The JSDoc shapes for what arrives on the stream and what the routes
   take, then the state object with every assignment site rewritten. Prove: screenshot, `tsc` on the
   client, tests for the pure shape helpers.
10. **`body/*.js`, then `card/{make,paint,select,order,fresh}.js`.** Prove: screenshot, tests for
    `questionWants`.
11. **`rail/{shell,transcript,detail,panels}.js`, `pick/*.js`, `files.js`.** Prove: screenshot, tests
    for `looksLikeDiff`, `diffFromEdits`, `shortModel`, `shortenPath`.
12. **The remaining panels** — `view`, `minimap`, `gitstrip`, `header`, `transport`, `composer`,
    `picker`, `config`, `threads` — until `board.js` is a composition root. Prove: screenshot, tests for
    `clockText`, `rowClock`, `agoText` and the transcript line parser.
13. **The client type ratchet.** `checkJs` switched on, folder by folder, with the unported file still
    under `@ts-nocheck` until step 12 is done.
14. **Docs.** `README.md` layout section, `MODULARIZATION.md` marked superseded, `STATE.md` updated.

## Hazards, each with its answer

- **`BOARD_START` and `type="module"`.** A module runs after parsing, so the inline `<script>` at
  `index.html:884` fires before the entry defines the function and the board never starts. The entry
  calls it itself; the inline call is deleted. Verified by screenshot, because this is how a blank board
  ships.
- **The static allowlist.** Four hand-written paths become one prefix rule for `/client/`, with a
  normalised path check so `..` cannot escape `public/`.
- **Erasable syntax only**, enforced by `erasableSyntaxOnly`.
- **`.ts` extensions in specifiers**, required by Node and covered by `check-imports.mjs`.
- **`handleChildLine`, 242 lines.** Moves whole; gets a test, not a rewrite.
- **A move that quietly changes behaviour.** Bodies byte identical, `git diff --stat` per step, smoke,
  and the round-trip test for what is already on disk.
- **`node --watch`** treats one entry and its graph, so `server.ts` must keep importing the rest.

## Out of scope

No framework, no bundler, no new runtime dependency. No renames of behaviour while moving, no "while I
am here" fixes: those get their own branch so a regression has one suspect. No class hierarchy. No
Playwright. No change to the wire protocol or the on-disk format.

## What the review changed

A GLM-5.3 review of the first draft found twelve things; nine changed this document:

- `check-imports.mjs` only reads `.js`, so the per-step net would have died at the rename. It is
  extended in step 0, before anything moves.
- The strictness ratchet cannot exist as a second config — `strict` is program-wide. Replaced by
  `// @ts-nocheck` on the not-yet-ported file.
- Tests would have imported the monolith, which builds its socket and writes its state at import.
  Fixed by extracting in computed dependency order, and by the rule that no module imports the entry.
- `import { Card } from "./types.ts"` kills the daemon under type stripping. `verbatimModuleSyntax`
  and `import type` are now a decision, not an omission.
- `import.meta.url`-relative constants break silently in `server/`; `BRIDGE` breaks a feature no test
  touches. They move into `paths.ts` once, with a test.
- The client's eight `let` cannot be moved as read-only imports; the rewrite is now named and sized.
- No test guarded the on-disk format the port promises to keep. Round-trip and legacy fixtures added.
- The route suite was missing `/events`, which is the client's whole world, and every client module
  being served.
- `bin/smoke.mjs` hardcodes `server.mjs` and would fail at step 1.

Not accepted: the review's claim that `verbatimModuleSyntax` does not enforce type-only imports — it
does, with error TS1484, which is why it is the guard named above.

## Status after the first pass

What is in the tree, verified by `npm run check` and by hand.

**Done.** The daemon is 28 `.ts` modules: `server.ts` starts `server/main.ts`, which holds the handler and
the route table, and everything else is a library with no side effects at import. Bodies were lifted byte
for byte by the TypeScript parser, and a line-multiset diff against the old `server.mjs` accounts for all
52 differing lines. The client is an ES module at `public/client/board.js`, served by one `/client/` rule,
started by itself rather than by an inline script, and it draws the board in a headless browser with no
console errors. 33 tests cover the restore paths, the git graph, a worktree made and retired, the child's
argv and prompts, and the routes including `/events`. `npm run check` runs `node --check`,
`bin/check-imports.mjs`, `tsc`, `node --test` and `bin/smoke.mjs`.

**Open, in the order they matter.**

1. **The daemon is not type-checked yet.** 26 of 28 modules carry `@ts-nocheck`, so `tsc` reads them and
   checks none of them. Measured: stripping the pragmas under `strict: false, noImplicitAny: false`
   leaves **44 diagnostics**, 37 of them `TS2339` from object literals inferred as a union. That is the
   next commit: a loose pass in `check` that gates, then `strict` module by module.
2. **Steps 9–13 of the plan are not in the tree.** `state.js`, `types.js`, the client module split and
   the `checkJs` ratchet are unwritten. The client is one 5324-line module; the deeper split was
   attempted and reverted because eight panel-level `let`s are assigned from the entry, which needs the
   handlers moved into the panels first. `tsconfig.client.json` was deleted rather than left as a config
   that fails when run and is never run.
3. **`handleChildLine` is still untested.** It is the largest function in the daemon and the one the
   review of this plan named first.
4. **The live-agent half is uncovered.** `child/run.ts`, `routes/board/message.ts` and `answer.ts` have
   no tests, because reaching them means spawning a real `pi`.
