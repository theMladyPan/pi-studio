One step is small enough to be a conversation, and the answer is short enough to read in one go.

1. `scout` — find the files the change touches and report the insertion points.
2. `implement` — make the change in one coherent slice, on a branch.
3. `chore` — run the smallest check that would catch a regression, the tests beside it, and the
   project's own suite if there is one.
4. Done: report what changed, how it was checked, and what is left in the thread. Update any plan or
   checklist still in use; a routine completion report does not need its own card.

A red check goes back to `implement` once, with the failure quoted. If it is red again, stop and say
what is red. Do not widen the change to make a check pass.
