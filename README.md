# pi-studio

A local daemon that owns pi agents and gives them a board. A **workspace** is a folder. On that
folder's board, a **thread** is one card and one `pi --mode rpc` child process: you type into the
card, the agent answers there, and you can steer it while it runs.

It replaces the dashboard extension, which was a view of a single pi session and could never
supervise more than one agent.

## Run it

```bash
node server.mjs          # prints the URL and opens the crossroads in your browser
node server.mjs --no-open   # for a service, or when you open it yourself
```

or, with the repository in `PATH` or linked into `~/.local/bin`:

```bash
pi-studio
```

There is no build step and no dependency to install: Node 22 or newer and a working `pi` on the
same machine are the whole requirement.

`PI_STUDIO_STATE` moves everything durable out of `~/.pi/agent/state/pi-studio` into another folder,
and a fresh one holds no port, so a second daemon picks a free one and runs beside the first. That is
what makes the app checkable:

```bash
npm run smoke   # boots a daemon against a scratch folder, runs ten checks, exits 1 on the first failure
```

## How it works

- **Workspaces** are folders you have opened before. The crossroads at `/` lists them, newest first,
  previews the selected one, and opens it as a board in a tab of its own (`/w/<id>`); asking again
  reuses that tab. The folder dialog is the machine's own, through `zenity`. A workspace's board, its threads and their layout live in
  `~/.pi/agent/state/pi-studio/boards/<id>.json`.
- **Threads** are cards. A thread is created with `+` and starts its agent on the first message. A
  thread's pi session is written under `~/.pi/agent/state/pi-studio/sessions/<workspace>/`, so a
  restart of the daemon resumes the conversation instead of starting over.
- **Steering**: send with `steer` to redirect a run in flight, or `queue` to wait behind it.
- **One client, one visual language.** `public/` holds the board client. It is the one the
  dashboard extension used, copied in when this became its own application.

The daemon listens on loopback only. The token in the URL guards every data route.

## Layout

```
server.mjs        the daemon: workspaces, threads, children, routes
public/           the board client (index.html with its styles, board.js)
bin/pi-studio     the wrapper: one word to start it
bin/smoke.mjs     boot a daemon against a scratch folder and hit the routes a change can break
STATE.md          what works, what does not, and what is next
```

## What it does not do yet

Cards a thread draws for you (notes, sources, questions), rail payloads, usage totals, images, and
per-thread stop. `STATE.md` keeps that list current.
