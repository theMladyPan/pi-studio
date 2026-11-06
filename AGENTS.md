# pi-studio

A local daemon that owns pi agents: a workspace is a folder, a thread on its board is an agent.

## Keyboard shortcuts

The `keys` button in the header lists every shortcut. That panel renders from one list, `SHORTCUTS` in
`public/client/board.js`, which is the single source of truth for it.

Any change to a shortcut handler must change that same list in the same commit, and the `map` button's
title in the same client, which names its own key (`"hide the board overview (m)"`).
