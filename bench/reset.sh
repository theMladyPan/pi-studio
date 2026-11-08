#!/bin/sh
set -e
cd ${REPRO:-/tmp/bench/repro}
node build.mjs >/dev/null
node mkboard.mjs >/dev/null
git -C doc-compliance rev-list --count dev | sed 's/^/dev commits: /'
git -C doc-compliance worktree list | wc -l | sed 's/^/worktree registrations: /'
python3 -c "import json;d=json.load(open('${REPRO:-/tmp/bench/repro}/stateA/boards/67782bd1546f.json'));print('board trees:',len(d['trees']),'threads:',len(d['threads']))"
