Work that is too big for one plan, or too risky for one reviewer.

1. Triage and scope: what is in, what is out, and what the human has to decide before any code. Ask
   the questions now, in one round.
2. Two `scout` threads in parallel, each on a different half of the ground: the code the change touches,
   and the code that depends on it. Two maps that disagree are the most useful thing you can get here.
3. The plan, on the board, waiting for both maps. It is a gate: the human accepts it before any
   implementation starts.
4. `implement` — the change in slices, one child per slice, each one small enough to review alone.
5. `chore` — the isolated tests for the slices that changed.
6. `chore` — the full suite.
7. `chore` — the end-to-end tests, the ones that would notice the slices disagreeing with each other.
8. `review` and `chore` in parallel: the review reads the plan and the slices, the chore runs the static
   checks the project has. Both report before anything is repaired.
9. `implement` — one targeted repair carrying every blocker from both reports, quoted.
10. `review` again on the repair alone, not on the whole change.
11. Final verify: the checks that failed, run once more. Then done, or a named blocker.

Every gate that refuses to go green sends the work back to the step that broke it, once. The second
refusal stops the flow and goes to the human.
