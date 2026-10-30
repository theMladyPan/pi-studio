# The boss and its children

A boss thread does no work of its own. It reads the request, decides which flow to run, and spawns
children with `board_thread`; each child carries one role, gets a worktree cut from the boss's own, and
answers once. What the boss reads is that answer, so the flow is the shape of the work and the roles
are the hands.

The three flows below are the three shapes a task can take. Each is a file under `prompts/flows/`,
appended to the boss prompt when the flow is known, and each is drawn once here so the diagram and the
steps can be read together.

## What a thread is told to be

A thread the human started gets a **mode**; a spawned thread gets a **role**. The two never mix: a mode
is why a human's thread exists, a role is what one child was asked to be.

| mode | what it does | tools it loses |
|---|---|---|
| `agent` | the baseline, nothing added | none |
| `plan` | writes a plan and throwaway scripts under `/tmp` | `write`, `edit` |
| `boss` | spawns children and reports what came back | `write`, `edit` |

A boss with no `write` and no `edit` cannot quietly do the work itself, so a flow that skipped a child
would show on the board as a card with nothing on it.

| role | what it is for | tools it loses | thinking |
|---|---|---|---|
| `scout` | maps files and the relationships between them | `write`, `edit` | medium |
| `implement` | makes one coherent change, on a branch | none | high |
| `review` | judges an artifact against the goal | `write`, `edit` | high |
| `chore` | runs separable tests, checks, maintenance | none | medium |
| `architect` | settles one structural decision | `write`, `edit` | high |

The read-only roles keep `bash`, so a scout can run a query and a reviewer can run the checks it is
judging. Tool rules live in `server/child/roles.ts` beside `ROLE_THINKING`; the prompt text lives in
`prompts/roles/`, because that is the part a human edits.

## Choosing a flow

A boss starts on `auto` or on a named flow. On `auto` it reads none of the three files, decides from
the request, and says which with `board_path` before it spawns anything, so its card carries the flow
it is running. The prompt for the chosen flow is appended to the boss prompt, and a boss told `simple`
runs `simple` even where `complex` would fit.

### simple — one step with checks

One file, one known behaviour, a test that can sit next to the change. There is no plan and no separate
reviewer: the test is the review.

```svg
<svg viewBox="0 0 800 150" width="100%" xmlns="http://www.w3.org/2000/svg">
 <defs>
  <marker id="s1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
   <path d="M0,0 L10,5 L0,10 Z" fill="#64748b"/>
  </marker>
 </defs>
 <g stroke="#94a3b8" fill="#f8fafc" stroke-width="1.5">
  <rect x="10" y="45" width="160" height="58" rx="12"/>
  <rect x="216" y="45" width="160" height="58" rx="12"/>
  <rect x="422" y="45" width="160" height="58" rx="12"/>
 </g>
 <rect x="628" y="45" width="160" height="58" rx="12" fill="#dcfce7" stroke="#16a34a" stroke-width="1.5"/>
 <g fill="#0f172a" font-size="15" text-anchor="middle">
  <text x="90" y="80">scout</text>
  <text x="296" y="80">implement</text>
  <text x="502" y="80">isolated tests</text>
  <text x="708" y="80">done</text>
 </g>
 <g stroke="#64748b" stroke-width="1.5" marker-end="url(#s1)">
  <line x1="174" y1="74" x2="210" y2="74"/>
  <line x1="380" y1="74" x2="416" y2="74"/>
  <line x1="586" y1="74" x2="622" y2="74"/>
 </g>
</svg>
```

1. `scout` — find the files the change touches and report the insertion points.
2. `implement` — one coherent slice, on a branch.
3. `chore` — the smallest check that would catch a regression, then the project's own suite.
4. Done: what changed, how it was checked, what is left.

A red check goes back to `implement` once, with the failure quoted. Red again means stop.

### advanced — a plan, and a reviewer who reads it

Files are known, the edges between them are not. A scout and a throwaway script that answers the
question by running it start together, and the plan waits for both.

```svg
<svg viewBox="0 0 600 600" width="100%" xmlns="http://www.w3.org/2000/svg">
 <defs>
  <marker id="c2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
   <path d="M0,0 L10,5 L0,10 Z" fill="#64748b"/>
  </marker>
 </defs>
 <g stroke="#94a3b8" fill="#f8fafc" stroke-width="1.5">
  <rect x="80" y="20" width="180" height="54" rx="12"/>
  <rect x="285" y="20" width="190" height="54" rx="12"/>
  <rect x="150" y="104" width="220" height="54" rx="12"/>
  <rect x="150" y="188" width="220" height="54" rx="12"/>
  <rect x="150" y="272" width="220" height="54" rx="12"/>
  <rect x="150" y="356" width="220" height="54" rx="12"/>
  <rect x="420" y="272" width="150" height="54" rx="12" fill="#f8fafc" stroke="#94a3b8" stroke-dasharray="6 5"/>
  <rect x="420" y="356" width="150" height="54" rx="12" fill="#f8fafc" stroke="#94a3b8" stroke-dasharray="6 5"/>
 </g>
 <rect x="150" y="440" width="220" height="54" rx="12" fill="#eff6ff" stroke="#2563eb" stroke-width="1.5"/>
 <rect x="150" y="524" width="220" height="54" rx="12" fill="#dcfce7" stroke="#16a34a" stroke-width="1.5"/>
 <rect x="420" y="520" width="150" height="54" rx="12" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
 <g fill="#0f172a" font-size="14" text-anchor="middle">
  <text x="170" y="53">scout</text>
  <text x="380" y="44">throwaway script</text>
  <text x="380" y="62">smoke test</text>
  <text x="260" y="137">plan</text>
  <text x="260" y="221">implement</text>
  <text x="260" y="305">isolated tests</text>
  <text x="260" y="389">full suite</text>
  <text x="260" y="473" fill="#1d4ed8">review code + plan</text>
  <text x="260" y="557">done</text>
  <text x="495" y="296" font-size="13" fill="#475569">fix (if red)</text>
  <text x="495" y="313" font-size="11" fill="#94a3b8">one round</text>
  <text x="495" y="380" font-size="13" fill="#475569">fix (if red)</text>
  <text x="495" y="397" font-size="11" fill="#94a3b8">one round</text>
  <text x="495" y="543" font-size="13" fill="#b91c1c">abort + tell</text>
  <text x="495" y="560" font-size="13" fill="#b91c1c">the user why</text>
 </g>
 <g stroke="#64748b" stroke-width="1.5" marker-end="url(#c2)">
  <path d="M170 74 V89 H260 V102" fill="none"/>
  <path d="M380 74 V89 H260 V102" fill="none"/>
  <line x1="260" y1="162" x2="260" y2="186"/>
  <line x1="260" y1="246" x2="260" y2="270"/>
  <line x1="260" y1="330" x2="260" y2="354"/>
  <line x1="260" y1="414" x2="260" y2="438"/>
  <line x1="260" y1="498" x2="260" y2="522"/>
 </g>
 <g stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="6 5">
  <line x1="371" y1="288" x2="415" y2="288" marker-end="url(#c2)"/>
  <line x1="419" y1="312" x2="376" y2="312" marker-end="url(#c2)"/>
  <line x1="371" y1="372" x2="415" y2="372" marker-end="url(#c2)"/>
  <line x1="419" y1="396" x2="376" y2="396" marker-end="url(#c2)"/>
 </g>
 <g fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="6 5">
  <path d="M150 470 H100 V215 H146" marker-end="url(#c2)"/>
  <path d="M370 467 H470 V516" marker-end="url(#c2)"/>
 </g>
 <text x="0" y="0" font-size="11" fill="#64748b" text-anchor="middle" transform="translate(92 350) rotate(90)">on findings</text>
 <text x="478" y="500" font-size="11" fill="#64748b">still failing</text>
</svg>
```

1. A throwaway script under `/tmp` that shows the outcome asked for: red before the work, green after.
2. `scout` — map the code the change touches, in parallel with that script.
3. The plan, on the board. It waits for both, and it is what the reviewer judges the code against.
4. `implement` — the change, one slice, on a branch.
5. `chore` — the isolated tests for what changed.
6. `chore` — the full suite, once the isolated ones are green.
7. `review` — the plan **and** the diff, so every finding is one `implement` can act on.
8. One repair round, then re-run only the checks that failed.

### complex — two maps, a plan gate, and a re-review

Too big for one plan, or too risky for one reviewer. Discovery splits, the plan is a gate the human
accepts before any code, and the checks go narrow, wide, then end to end.

```svg
<svg viewBox="0 0 570 700" width="100%" xmlns="http://www.w3.org/2000/svg">
 <defs>
  <marker id="c3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
   <path d="M0,0 L10,5 L0,10 Z" fill="#64748b"/>
  </marker>
 </defs>
 <g stroke="#94a3b8" fill="#f8fafc" stroke-width="1.5">
  <rect x="140" y="16" width="220" height="52" rx="12"/>
  <rect x="80" y="92" width="160" height="52" rx="12"/>
  <rect x="270" y="92" width="160" height="52" rx="12"/>
  <rect x="140" y="244" width="220" height="52" rx="12"/>
  <rect x="140" y="320" width="220" height="52" rx="12"/>
  <rect x="140" y="396" width="220" height="52" rx="12"/>
  <rect x="140" y="472" width="220" height="52" rx="12"/>
  <rect x="80" y="548" width="160" height="52" rx="12"/>
  <rect x="270" y="548" width="160" height="52" rx="12"/>
  <rect x="400" y="320" width="150" height="52" rx="12" fill="#f8fafc" stroke="#94a3b8" stroke-dasharray="6 5"/>
  <rect x="400" y="396" width="150" height="52" rx="12" fill="#f8fafc" stroke="#94a3b8" stroke-dasharray="6 5"/>
  <rect x="400" y="472" width="150" height="52" rx="12" fill="#f8fafc" stroke="#94a3b8" stroke-dasharray="6 5"/>
 </g>
 <rect x="140" y="168" width="220" height="52" rx="12" fill="#fef3c7" stroke="#f59e0b" stroke-width="1.5"/>
 <rect x="140" y="624" width="220" height="52" rx="12" fill="#dcfce7" stroke="#16a34a" stroke-width="1.5"/>
 <rect x="8" y="620" width="124" height="52" rx="12" fill="#fef2f2" stroke="#dc2626" stroke-width="1.5"/>
 <g fill="#0f172a" font-size="13" text-anchor="middle">
  <text x="250" y="47">triage &amp; scope</text>
  <text x="160" y="123">scout A</text>
  <text x="350" y="123">scout B</text>
  <text x="250" y="199">plan + approval</text>
  <text x="250" y="275">implement slices</text>
  <text x="250" y="351">isolated tests</text>
  <text x="250" y="427">full suite</text>
  <text x="250" y="503">E2E tests</text>
  <text x="160" y="579" fill="#1d4ed8">review + plan</text>
  <text x="350" y="579" fill="#1d4ed8">static checks</text>
  <text x="250" y="655">done</text>
  <text x="475" y="342" font-size="12" fill="#475569">fix (if red)</text>
  <text x="475" y="358" font-size="11" fill="#94a3b8">one round</text>
  <text x="475" y="418" font-size="12" fill="#475569">fix (if red)</text>
  <text x="475" y="434" font-size="11" fill="#94a3b8">one round</text>
  <text x="475" y="494" font-size="12" fill="#475569">fix (if red)</text>
  <text x="475" y="510" font-size="11" fill="#94a3b8">one round</text>
  <text x="70" y="641" font-size="12" fill="#b91c1c">abort + tell</text>
  <text x="70" y="657" font-size="12" fill="#b91c1c">the user why</text>
 </g>
 <g fill="none" stroke="#64748b" stroke-width="1.5" marker-end="url(#c3)">
  <path d="M250 68 V80 H160 V90"/>
  <path d="M250 68 V80 H350 V90"/>
  <path d="M160 144 V156 H250 V166"/>
  <path d="M350 144 V156 H250 V166"/>
  <path d="M250 220 V242"/>
  <path d="M250 296 V318"/>
  <path d="M250 372 V394"/>
  <path d="M250 448 V470"/>
  <path d="M250 524 V536 H160 V546"/>
  <path d="M250 524 V536 H350 V546"/>
  <path d="M160 600 V612 H250 V622"/>
  <path d="M350 600 V612 H250 V622"/>
 </g>
 <g stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="6 5">
  <line x1="361" y1="336" x2="395" y2="336" marker-end="url(#c3)"/>
  <line x1="399" y1="358" x2="366" y2="358" marker-end="url(#c3)"/>
  <line x1="361" y1="412" x2="395" y2="412" marker-end="url(#c3)"/>
  <line x1="399" y1="434" x2="366" y2="434" marker-end="url(#c3)"/>
  <line x1="361" y1="488" x2="395" y2="488" marker-end="url(#c3)"/>
  <line x1="399" y1="510" x2="366" y2="510" marker-end="url(#c3)"/>
 </g>
 <g fill="none" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="6 5">
  <path d="M80 574 H60 V270 H136" marker-end="url(#c3)"/>
  <path d="M100 600 V616" marker-end="url(#c3)"/>
 </g>
 <text x="0" y="0" font-size="11" fill="#64748b" text-anchor="middle" transform="translate(52 400) rotate(90)">on findings</text>
</svg>
```

1. Triage and scope: what is in, what is out, what the human must decide. One round of questions.
2. Two `scout` threads in parallel: the code the change touches, and the code that depends on it.
3. The plan, waiting for both maps. Nothing is implemented until the human accepts it.
4. `implement` — the change in slices, one child per slice, each reviewable alone.
5. `chore` — isolated tests, then the full suite, then the end-to-end tests.
6. `review` and `chore` in parallel: the review reads plan and slices, the chore runs the static checks.
7. `implement` — one targeted repair carrying every blocker from both reports, quoted.
8. `review` again on the repair alone.
9. Final verify: the checks that failed, run once more. Then done, or a named blocker.

## How a step becomes a child

The boss fans out from its own thread. A spawned child cannot spawn another, so every step that runs in
parallel is a second `board_thread` call in the same turn: two scouts in `complex`, review and static
checks in parallel, the scout and the throwaway script in `advanced`.

A child cannot see the boss's conversation, so a task that says "the plan above" carries no plan. The
plan text goes into the task, with the paths, the acceptance criteria and the checks the child may run.
When findings travel on to the next child, they travel in the reviewer's own words, quoted.

`after` takes the ids of the cards a child follows from, which is how the flow is visible on the board:
each child hangs under the step it came from. `timeoutSeconds`, `maxTurns` and `maxCostUsd` bound a run,
and all three are reported when they are crossed.

## Gates and the one repair round

Every flow has the same stop rule, drawn as the dashed `fix (if red)` boxes: a check that refuses to go
green sends the work back to the step that broke it, **once**. A second refusal aborts the flow and
tells the human what is red and why it could not be settled — the red `abort + tell the user why` node.
The complex flow spends that one round on a repair carrying both reports, and re-reviews the repair
alone rather than the whole change.

The rule is in all three flow files and in `prompts/modes/boss.md`. A flow that loops on its own
findings is a boss spending the human's money to learn nothing new.

## Where this lives

| file | what it holds |
|---|---|
| `prompts/modes/boss.md` | what a boss is, how it runs a flow, how it finishes |
| `prompts/flows/{simple,advanced,complex}.md` | the three flows, as the boss reads them |
| `prompts/roles/*.md` | one role per file, the text a child is given |
| `server/child/modes.ts` | `MODE_NAMES`, `PATH_NAMES`, `MODE_TOOLS_OFF`, the prompt lookup |
| `server/child/roles.ts` | `ROLE_NAMES`, `ROLE_TOOLS_OFF`, `ROLE_THINKING`, the frame around a role |
| `bridge/child-bridge.mjs` | `board_thread` and `board_path`, the two tools a boss works with |

`prompts/README.md` is the shorter account of the same folders. The settings page lists these files
from disk on every open, so a prompt edited by hand is the prompt the next spawn gets.
