# React, Vue, Vite, TypeScript — analysis

Written against `dev` at `99e38e9` beside `MODULARIZATION.md`. Nothing implemented. This is a
decision document, not a plan of record: the one thing I would ask you to approve is the ordering at
the bottom.

## The answer, up front

- **React or Vue: no, not now.** The client is not a component tree, and a migration would rewrite
  5305 lines with no regression net in exchange for no user-visible gain.
- **Vite: only if a build step ever becomes acceptable.** It buys HMR and TypeScript emit and costs
  the promise the README leads with, that there is nothing to install.
- **TypeScript: yes, as a checker, not as a build.** `tsc --noEmit` over the existing `.js` with
  JSDoc annotations costs no runtime change and gives the modularization the safety net it is
  missing.

None of these is an alternative to the split in `MODULARIZATION.md`. One of them competes with it, and
that is worth being explicit about: a React migration replaces the client half of that plan, so doing
the split first and the framework second pays for the same work twice.

## What the client actually is

Measurements from `public/board.js` as it stands:

| | count |
|---|---:|
| lines | 5305 |
| functions | 197 |
| `addEventListener` calls | 114 |
| `getElementById` | 93 |
| `querySelector` / `All` | 46 |
| direct DOM construction (`createElement`, `appendChild`, `innerHTML`, `replaceChildren`, `dataset`) | 178 |
| `classList` and inline `style` writes | 105 |
| canvas operations, minimap and git strip | 61 |
| `fetch` calls plus one `EventSource` | 21 |

That shape matters more than the line count. The board is:

- **absolutely positioned**, with `style.left` and `style.top` computed from a layout the client owns,
  dragged with pointer events, and resized by a corner grip;
- **zoomed by a CSS `zoom` on `#world`**, so hit testing and every stored rect divide by the zoom;
- **canvas** for the two pictures (minimap, git graph), which no framework improves;
- **one shared mutable view** (`view.x`, `view.y`, `view.k`) read by pan, zoom, fit, the minimap, the
  hit testers and the halo.

This is an imperative editor, closer to a drawing app than to a form. React and Vue are built for the
opposite case: a state tree that produces DOM, replaced wholesale on change.

## Option by option

### React

What it would buy: composition by component, a real dev story with Vite, ecosystem components for
lists and dialogs, and a familiar shape for anyone joining.

What it would cost here:

- the board stays canvas and pointer maths inside `useRef`/`useEffect` escape hatches, so the hard
  900-line card section does not get simpler, it gets wrapped;
- `zoom` on `#world` and per-card absolute rects fight React's own layout assumptions, and the
  minimap and git strip read `style.left` off DOM nodes — that coupling is exactly what a framework
  would want to own instead;
- a rewrite of the whole client with no tests, in one branch, with the board as the only acceptance
  test;
- a runtime and a build in a repository whose README says there is neither.

### Vue

Same trade, plus single-file components, which means a compiler. Nothing about this app is a better
fit for Vue specifically. It would be a defensible choice for a *new* client, not a reason to port
this one.

### Vite

Not a UI decision, so judge it alone.

Gains: HMR while working on the client, TypeScript and JSX without hand wiring, minification, a module
graph that survives hundreds of files, and a proxy for `/events` during development.

Costs, concretely, in this repository:

- `npm install` becomes mandatory, and `node_modules` appears where today `node server.mjs` is the
  whole requirement;
- `bin/pi-studio` must serve built assets, so either `dist/` is committed (a stale-build class of bug
  appears: "which build am I running?") or the wrapper builds on start (a first run that needs the
  network);
- the daemon's four-path static allowlist (`server.mjs:3695`) becomes a real static handler over
  `dist/`, with cache headers to design;
- two ports in development, and the SSE route proxied, which is where dev-only bugs come from.

Worth it if the client grows into something that needs a component library or if you want HMR badly.
Not worth it to split files.

### TypeScript

This is really three decisions, and only one of them needs a build.

| how | build step | what you get | verdict |
|---|---|---|---|
| `tsc --allowJs --checkJs --noEmit` over `.js` with JSDoc types | none | type errors in CI/terminal, editor autocomplete, no runtime change | **recommended**, and it is the missing check for the split |
| `.ts` files on the daemon, run by Node's own type stripping | none at runtime | real TS syntax on the server | viable — this machine is Node 24, `package.json` says `>=22`, so the floor rises or `--experimental-strip-types` is named |
| `.ts` or JSX in the browser | yes, tsc or Vite | types in the client | only with Vite, so it inherits everything above |

The daemon is the half where types pay first: board files, git payloads, card shapes and the wire
format all cross a boundary as plain JSON, and a wrong field name there is a silent `undefined`, not an
exception. `node --check` catches none of it.

The client is the half where types pay second, and JSDoc gets most of the way — the interesting types
are the ones on payloads coming off the event stream, and those are the same shapes the daemon already
has.

## Cost and risk, side by side

| option | effort | risk | reversibility | gain |
|---|---|---|---|---|
| ESM split (`MODULARIZATION.md`) | medium, 11 steps | medium, no tests | high, one commit per step | maintainability, reviewable diffs |
| JSDoc + `tsc --noEmit` | small | very low | high | catches wire-shape and rename mistakes |
| TypeScript as the language, daemon only | medium | low | high | same, plus real syntax |
| Vite, no framework | medium | medium: install step, dist, two ports | medium | HMR, module graph, minify |
| Vue or React, with Vite | large: client rewrite | high, no regression net | low | composition and ecosystem |

The asymmetry is plain: the two cheap rows are additive and can be undone; the last row cannot be
undone in a week.

## What I would do, in order

1. `MODULARIZATION.md` step 0: the state-folder override and a boot smoke test. Without it nothing
   below can be checked.
2. `tsc --noEmit` over `.js` with `checkJs`, added as `npm run check` alongside `node --check`. This is
   the safety net the split lacks, and it is cheaper than the first module move.
3. The split, daemon first, one commit per section.
4. Revisit this document. By then the module boundaries are real, and a framework decision is a choice
   about the client alone rather than about the whole app.

## What would change my mind

Concrete triggers, any one of which makes React or Vue worth costing properly:

- a second consuming surface with the same components (the crossroads already shares a visual language
  with the board, and duplicating it twice more would tip this);
- wanting a component library for forms, menus and virtualised lists rather than the hand-built ones;
- more than one person editing the client at once;
- HMR being worth a build step to you in itself;
- the client passing roughly 8–10k lines before the split lands, meaning the split is losing ground.

Until one of those is true, a framework is a rewrite whose first customer is the rewrite.

## Open questions for you

- Is "nothing to install" a promise you want to keep? It is the one line in the README that shapes
  every option here.
- Would you accept a check step (`tsc --noEmit`) in `npm run check` even though it adds a
  `devDependency`? It is the only way to get types without touching the runtime.
