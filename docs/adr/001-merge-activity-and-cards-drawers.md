# ADR 001: Merge activity and cards drawers into one activity drawer

## Context

The board kept two left drawers that listed the same threads. Activity grouped settled tool rows under a thread, with counts, context and cost, and a role badge. Cards listed open cards by state and closed cards with a reopen and trash press. Keeping both meant two sorts, two nesting walks and two paints for one thread. Running rows already lived on the canvas card, not in either drawer, and right-click on activity opened the transcript panel directly.

## Decision

Keep one thread drawer named **activity**. It holds open cards and closed cards, one row per card. A thread pairs with its card, because every thread has a thread card whose id is the thread id, so settled activity moves under that card row. The header keeps a single activity door, `a` opens it, `c` and the cards door are removed. It does not open by default, and it names itself `activity` in the header's open-panel label when it is up. It shows no counts for open cards, closed cards or running rows.

Left click on a thread card row expands or collapses its settled activity log inline, collapsed by default. It no longer centers the card on the canvas. Running rows stay only in the card's live strip on the canvas. Right-click on a row opens a small menu: reopen for a closed card, and debug for a thread card, which opens the transcript panel. A settled activity row still opens its detail sheet. Nesting and order are computed once, from the card's parent fields. Row, head and log share one font and colour system. The files, source control and plugin drawers are unchanged.

## Consequences

The drawer is smaller and the thread list has one owner, but it loses the running count, the open and closed counts, the `c` shortcut and the click-to-center shortcut. Context, cost and state compete for the same row width, so the head must carry the state word and leave context and cost to the detail views and footer. A thread with no card of its own has nowhere to show its settled log, and running work for a closed card is only visible on the canvas. Future menu entries go in the same right-click menu instead of a new gesture.

## Sources

- Owner decisions for this merge, thread `aa2caade`.
