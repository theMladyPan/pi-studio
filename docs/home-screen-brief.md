# Home screen brief: pi-studio crossroads

Read this whole file before designing. It is the only context you get.

## What pi-studio is

A local daemon that owns pi coding agents and gives them a board.

- A **workspace** is a folder on this machine that the human has opened before. Opening it is what
  creates it; no repository, no config, no account.
- A workspace's **board** (`/w/<id>`) is a canvas. On it, a **thread** is one card and one live
  `pi` agent child process. The human types into the card and the agent answers there, in markdown,
  with mermaid diagrams and code. Threads run in parallel and can be steered while running.
- The daemon listens on loopback only. Everything is a dark, monospace-flavoured developer tool.
- Sessions are persisted per workspace, so a board is resumed, not restarted.

The person using it is a single experienced developer on his own machine. He runs several agents at
once, on several folders, and comes back to the app many times a day. He opens it to do one of three
things:

1. **continue** what he was doing (go straight back into a workspace, or into one specific thread),
2. **start** something new (open a folder he has not opened before, or start a thread on a known
   workspace),
3. occasionally **check** where things stand (which agents are running, which workspace was touched
   last).

## What the home screen is today

Route `/`, three files: `public/welcome.html`, `public/welcome.css`, `public/welcome.js`. It is called
the crossroads. Three fixed columns, full height:

```
+---------------------+------------------------------+------------------+
| + New workspace      | pi-studio                    | NEW BOARDS       |
| (form: folder+browse)| /home/stanke/projekty/pi-st..| START WITH       |
|                      |                              | model  [text]    |
| RECENT               | LAST THREADS                 | thinking [select]|
| ● pi-studio          | ● Refactor the store         | dim others [on]  |
|   3 threads          | ● Home screen mockups        |                  |
| ● pi-studio-dev      | ● Fix the retry loop         | WORKSPACE        |
|   1 thread · 1 run   |                              | branch  dev      |
| ● dashboard          | last activity: turn · 2 h ago| changes 3 modif. |
|   0 threads          |                              | threads 3        |
|                      | [ Open workspace ]           | sessions 12·4 MB |
|                      | opens in a new tab, reuses   |                  |
|                      | it next time                 | AGENT            |
|                      |                              | provider klotilda|
|                      |                              | model DeepSeek.. |
|                      |                              | tools read,bash..|
|                      |                              | STATE            |
|                      |                              | opened 2 h ago   |
|                      |                              | folder ok        |
+---------------------+------------------------------+------------------+
   280px                 flexible                       260px
```

Known problems with it, from the human:

- Clutter. Three columns of small text, most of it reference material nobody reads at a glance.
- The AGENT and STATE blocks are hard-coded and stale (`provider klotilda`, `tools read,bash,edit,write`).
- The defaults form (model, thinking, dim others) is a permanent third column for a rarely used
  setting; it competes with the thing the page exists for.
- The middle column shows a *preview* of a workspace, so the first click selects rather than acts.
  Reaching the place you want to be takes selecting, then clicking Open, then the tab.
- The list, the preview and the facts repeat the same counts.

## Data the daemon actually gives you

Do not invent data. This is the complete payload of `GET /workspaces` for each workspace:

| field | meaning |
| --- | --- |
| `name` | folder basename, e.g. `pi-studio` |
| `folder` | absolute path, e.g. `/home/stanke/projekty/pi-studio` |
| `openedAt` | epoch ms of the last time it was opened |
| `missing` | `true` when the folder is gone from disk |
| `running` | how many threads are running right now |
| `threadCount` | how many threads the board holds |
| `threads[]` | up to 6, newest first: `{ id, title, status: "running"\|"ok"\|... , turns, last }` |
| `lastActivity` | `{ label, at }` — the last thing that happened, e.g. `{ label: "turn", at: 1761… }` |
| `git` | `{ branch, modified }` or `null` when the folder is not a repository |
| `sessions` | `{ count, bytes }` — pi session files for this workspace |

And these exist once, not per workspace:

- `GET /defaults` → `{ defaults: { provider, model, thinking, dimOthers }, levels: ["off","low","medium","high"] }`
- `GET /models` → a catalogue of `{ provider, model }` this machine can run (long, ~100 entries),
  with the human's current pi scope first.
- `GET /events?scope=welcome` → a server-sent stream that pushes a fresh workspace list whenever a
  count changes. The page is live: a thread that starts elsewhere changes these numbers by itself.

## Actions the page can offer

- open a board: `/w/<workspaceId>?token=…` — opens a named tab, so asking again focuses that tab
  instead of making a second one;
- open one thread straight away: `/w/<workspaceId>?thread=<threadId>` (already supported);
- open a folder that is not in the list yet: type an absolute path, or press `browse…` which opens
  the machine's own dialog through the daemon (`POST /pick-folder`), then `POST /workspace`;
- change what a new board is born with: model, thinking level, dim others.

## Hard constraints

- **One self-contained HTML file.** Inline `<style>`. No build step, no CDN, no framework, no
  dependency. It must look right opened directly from disk (`file://`) with no daemon behind it, so
  mock data is written into the markup by hand.
- **Dark only.** Use the existing palette, do not invent a second one:
  `--bg #0b0d10`, `--panel #12151a`, `--panel-2 #161b22`, `--raised #1a1f27`, `--border #1f242c`,
  `--border-2 #2a303a`, `--text #e6edf3`, `--dim #c9d1d9`, `--muted #8b949e`, `--accent #3b82f6`,
  `--ok #3fb950`, `--warn #e3b341`, `--bad #f85149`. UI text is `system-ui` at 12–13px, paths,
  counts, model ids and commit-ish data are `ui-monospace`.
  This page is the door to a board with the same palette, so it has to look like the same product.
- **Target 1440×900**; also sanity-check 1024×700. It must not need horizontal scrolling and must not
  collapse into text soup at the smaller size. Height 100%, no page scroll for the common case.
- **Keyboard reachable.** Focus rings visible, the list navigable, the primary action reachable
  without the mouse. Say how in your notes.
- **Realistic content.** Use 4–6 workspaces with plausible names, folders, counts and thread titles
  from a developer's machine (`pi-studio`, `dashboard`, `ytrack-tools`, `pi`, `agent-skills`, …).
  Write two or three long thread titles, one workspace with `folder missing`, one with a running
  agent, one that is not a git repository. The mockup must survive real data, not just tidy data.
- **No emoji.** No decorative illustration. No gradient washes. No glassmorphism.
- **Minimal clutter is the goal.** Every element on the screen has to earn its pixels. When it
  doubt, leave it out and say why in your notes.

## What to hand back

1. The mockup file, at the exact path you were given (`mockups/home-<variant>.html` inside your own
   worktree). Self-contained, hand-written mock data, CSS-only. Small vanilla JS is allowed only for
   one thing: a state the static picture cannot show (a filter, an open settings popover). If you add
   it, it must degrade to a sensible static picture with JS off.
2. In your final message, and *only* there, your design notes:
   - the layout in words, and the reading order you intended;
   - **what you left out and why** — this is weighted as heavily as what you put in;
   - the one thing a human will find first, and the one action the page is built around;
   - how it survives 1024×700, the missing folder, the running agent, and a 30-workspace list;
   - what you would need from the daemon that does not exist today (be honest; the answer "nothing"
     is fine and good).

## Rules you must not break

- Do not touch anything outside `mockups/` in your own worktree. Do not edit `public/` (those are the
  shipped client files) and do not edit `docs/`.
- Do not start a browser, do not run the daemon, do not kill or signal any process, do not install
  anything. Write the file and answer. Nothing else is expected of you.
- Do not copy the current three-column skeleton and restyle it. If you keep three columns, justify
  each one in the notes against "delete it and the page still works".
