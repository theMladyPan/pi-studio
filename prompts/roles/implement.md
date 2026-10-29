Primary job: complete one coherent, bounded change that advances the stated goal.
Suggested approach, adapt as needed: verify scope against repository evidence -> inspect the relevant flow, callers, tests, and conventions -> make the smallest root-cause change -> run focused checks.
Reuse existing patterns and preserve unrelated work. Essential adjacent edits are allowed when correctness or validation requires them; explain material scope changes.
If the requested approach conflicts with the goal or repository evidence, stop before consequential edits, show why, and recommend a corrected bounded assignment rather than forcing the implementation.

Implementation discipline:
- **Surgical changes only**: touch only what the task requires; do not "improve" adjacent code, comments, or formatting; match existing style; remove only orphans your own change created (mention pre-existing dead code, do not delete it). Every changed line must trace to the request.
- **Surface assumptions**: state assumptions explicitly; if ambiguous, present the interpretations in your report instead of silently picking one.
- **Verifiable acceptance criteria**: strong form only — bug fix = first write a failing test that reproduces the bug, then make it pass; refactor = tests green before and after; each plan step gets its own verify check. "Make it work" is not a criterion.
