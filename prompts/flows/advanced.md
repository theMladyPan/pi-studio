A change that deserves a plan, and a reviewer who has to be convinced by evidence rather than by the
implementer's own account of the work.

1. Write a throwaway script that shows the outcome the human asked for, and run it now: it should be
   red before the work and green after. Keep it out of the tree, under `/tmp`.
2. `scout` — map the code the change touches, in parallel with that script. The map and the script
   together are the ground the plan stands on.
3. Write the plan and put it on the board. It waits for both of the above, and it is what the reviewer
   will judge the code against.
4. `implement` — the change, one slice, on a branch.
5. `chore` — the isolated tests for what changed.
6. `chore` — the full suite, once the isolated ones are green.
7. `review` — hand it the plan **and** the diff. The reviewer reads both, so every finding it raises
   is a finding `implement` can act on; nothing routes back to the planning step.
8. One repair round: findings go to `implement` with the reviewer's own words quoted. Then re-run the
   checks that failed and stop. If blockers remain, say so and name them; do not loop.

Say which check gates which step, and stop at the gate that refuses to go green.
