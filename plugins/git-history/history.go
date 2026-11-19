// The commit walk and the lanes it is drawn in.
//
// Rows are read newest first in topological order, so a commit is always seen after every commit that
// points at it. That one property is what makes the lanes possible without a second pass: a lane is a
// column waiting for a commit, a merge is two lanes reaching the same commit, and a fork is one commit
// sending a line into a lane that was not there before. Columns are allocated once and stay put while
// a lane lives, so a line drawn down the page is straight and a merge bends exactly once.
//
// Paging slices rows after the walk, never before: a page that starts at row 40 still has to know what
// the 40 rows above it did to the lanes, so the walk always starts at the newest commit and stops once
// the page has one row more than it shows, which is how it knows there is more.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// What a page may hold, and how far into a history a request may ask to start. A page is drawn in one
// answer that has to fit a megabyte frame, so the limits are there to keep the answer small enough to be
// sent, not to hide history: a caller pages towards what it wants.
const (
	defaultLimit = 40
	maxLimit     = 200
	maxScan      = 5000
)

// ref is a label a commit carries, as the graph draws it beside the row.
type ref struct {
	Kind string `json:"kind"`
	Name string `json:"name"`
}

// edge is one line crossing a row that is not the commit's own column: a lane passing straight through,
// a lane bending into the commit (a merge reaching it) or a line bending out of it (a branch forking
// away). The commit's own column is drawn from `Up` and from the parents it has, so a renderer never has
// to guess where a line starts.
type edge struct {
	From int    `json:"from"`
	To   int    `json:"to"`
	Kind string `json:"kind"`
}

// row is one commit as the view draws it: the commit, the column it sits in, and the lines that cross
// its row. `Cols` is how many columns that row used, which is what the view sizes its gutter from.
type row struct {
	SHA     string   `json:"sha"`
	Short   string   `json:"short"`
	Parents []string `json:"parents"`
	Author  string   `json:"author"`
	Email   string   `json:"email"`
	At      int64    `json:"at"`
	Subject string   `json:"subject"`
	Lane    int      `json:"lane"`
	Cols    int      `json:"cols"`
	Up      bool     `json:"up"`
	Edges   []edge   `json:"edges"`
	Refs    []ref    `json:"refs"`
	Head    bool     `json:"head"`
	Root    bool     `json:"root"`
}

// rawCommit is one commit as git log printed it, before any lane is decided.
type rawCommit struct {
	sha     string
	short   string
	parents []string
	author  string
	email   string
	at      int64
	subject string
}

// page is what the view needs to draw one page and ask for the next.
type page struct {
	Offset  int  `json:"offset"`
	Limit   int  `json:"limit"`
	HasMore bool `json:"hasMore"`
	Next    *int `json:"next"`
	Scanned int  `json:"scanned"`
	Total   *int `json:"total"`
}

// history is the answer to a page of the graph.
type history struct {
	Repo      repoInfo `json:"repo"`
	Rows      []row    `json:"rows"`
	LaneCount int      `json:"laneCount"`
	Page      page     `json:"page"`
	Notes     []string `json:"notes,omitempty"`
}

// repoInfo is the repository as the header of the view says it: where it is, and where HEAD points.
type repoInfo struct {
	Root     string `json:"root"`
	Branch   string `json:"branch"`
	Head     string `json:"head"`
	Short    string `json:"short"`
	Detached bool   `json:"detached"`
	Unborn   bool   `json:"unborn"`
	Branches int    `json:"branches"`
	Tags     int    `json:"tags"`
}

func describeRepo(r repo) repoInfo {
	info := repoInfo{
		Root:     r.root,
		Branch:   r.branch,
		Head:     r.head,
		Detached: r.detach,
		Unborn:   r.unborn,
	}
	if r.head != "" {
		info.Short = shortSHA(r.head)
	}
	return info
}

// shortSHA is the seven characters git shows in a title bar, and never fewer than the sha it was given.
func shortSHA(sha string) string {
	if len(sha) <= 7 {
		return sha
	}
	return sha[:7]
}

// pageParams reads a limit and an offset out of a request, refusing values a page cannot be drawn for.
func pageParams(params json.RawMessage) (offset, limit int, err error) {
	offset, limit = 0, defaultLimit
	if len(params) == 0 {
		return offset, limit, nil
	}
	var ask struct {
		Offset *int   `json:"offset"`
		Limit  *int   `json:"limit"`
		Scope  string `json:"scope"`
	}
	if err := json.Unmarshal(params, &ask); err != nil {
		return 0, 0, failf(invalidParams, "params must be an object with an optional offset and limit")
	}
	if ask.Offset != nil {
		offset = *ask.Offset
	}
	if offset < 0 {
		return 0, 0, failf(invalidParams, "offset must not be negative")
	}
	if ask.Limit != nil {
		limit = *ask.Limit
	}
	if limit <= 0 {
		return 0, 0, failf(invalidParams, "limit must be greater than zero")
	}
	if limit > maxLimit {
		limit = maxLimit
	}
	return offset, limit, nil
}

// readHistory walks the commits and keeps the page asked for.
func readHistory(ctx context.Context, r repo, offset, limit int) (history, error) {
	answer := history{Repo: describeRepo(r), Rows: []row{}}
	branches, tags, err := countRefs(ctx, r.root)
	if err == nil {
		answer.Repo.Branches, answer.Repo.Tags = branches, tags
	}
	if r.unborn {
		// A repository with no commit has no rows to draw and no page after this one.
		empty := 0
		answer.Page = page{Offset: offset, Limit: limit, Scanned: 0, Total: &empty}
		answer.Rows = []row{}
		return answer, nil
	}
	want := offset + limit + 1
	if want > maxScan {
		// The walk is bounded, so a page that would start past the bound is refused rather than read
		// for a minute: a caller that wants an older commit narrows the graph first.
		if offset >= maxScan {
			total := 0
			answer.Page = page{Offset: offset, Limit: limit, Scanned: 0, Total: &total}
			answer.Notes = []string{fmt.Sprintf("offset %d is past the %d commit walk this plugin reads", offset, maxScan)}
			return answer, nil
		}
		want = maxScan
	}
	verbose := ctx
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		var cancel context.CancelFunc
		verbose, cancel = context.WithTimeout(ctx, walkTimeout)
		defer cancel()
	}
	// HEAD is named first so the commit the human is looking at takes the leftmost lane, and --all is
	// what puts the branches nobody has merged into on their own line.
	out, truncated, err := runGit(verbose, r.root, []string{
		"log", "--topo-order", "HEAD", "--all", "-z",
		fmt.Sprintf("--max-count=%d", want),
		"--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s",
	}, walkBudget)
	if err != nil {
		return answer, err
	}
	if truncated {
		answer.Notes = append(answer.Notes, "the commit list was cut at the output budget; the page holds what was read")
	}
	commits := parseCommits(out)
	labels, err := readRefs(ctx, r.root)
	if err != nil {
		return answer, err
	}
	rows, laneCount := drawLanes(commits, r, labels)

	answer.LaneCount = laneCount
	if offset < len(rows) {
		end := offset + limit
		if end > len(rows) {
			end = len(rows)
		}
		answer.Rows = rows[offset:end]
		answer.Page.HasMore = end < len(rows)
		if answer.Page.HasMore {
			next := end
			answer.Page.Next = &next
		}
	}
	answer.Page.Offset = offset
	answer.Page.Limit = limit
	answer.Page.Scanned = len(commits)
	// A walk that ended before its own bound saw the whole history, so its count is a total the view can
	// show; one that stopped on the bound knows only what it read.
	if len(commits) < want {
		total := len(commits)
		answer.Page.Total = &total
	}
	return answer, nil
}

// parseCommits reads the records git log wrote, one per NUL, one field per unit separator. The subject
// is the last field and may hold anything a subject can hold, so it is taken as the rest of the record.
func parseCommits(out []byte) []rawCommit {
	var commits []rawCommit
	for _, record := range strings.Split(string(out), "\x00") {
		record = strings.TrimLeft(record, "\n")
		if record == "" {
			continue
		}
		fields := strings.SplitN(record, "\x1f", 7)
		if len(fields) < 7 {
			continue
		}
		seconds, err := strconv.ParseInt(strings.TrimSpace(fields[5]), 10, 64)
		if err != nil {
			seconds = 0
		}
		commit := rawCommit{
			sha:     fields[0],
			short:   fields[1],
			parents: strings.Fields(fields[2]),
			author:  fields[3],
			email:   fields[4],
			at:      seconds,
			subject: strings.TrimRight(fields[6], "\n"),
		}
		commits = append(commits, commit)
	}
	return commits
}

// readRefs maps a commit to the labels pointing at it. An annotated tag is peeled to the commit it
// names, which is the row the label belongs beside.
func readRefs(ctx context.Context, root string) (map[string][]ref, error) {
	probe, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	out, _, err := runGit(probe, root, []string{
		"for-each-ref",
		"--format=%(objectname)%1f%(objecttype)%1f%(*objectname)%1f%(refname)%1f%(refname:short)",
		"refs/heads", "refs/tags", "refs/remotes",
	}, probeBudget)
	if err != nil {
		return nil, err
	}
	labels := make(map[string][]ref)
	for _, line := range strings.Split(string(out), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		fields := strings.Split(line, "\x1f")
		if len(fields) < 5 {
			continue
		}
		name, kind := fields[3], "branch"
		switch {
		case strings.HasPrefix(name, "refs/tags/"):
			kind = "tag"
		case strings.HasPrefix(name, "refs/remotes/"):
			kind = "remote"
		}
		sha := fields[0]
		if fields[1] == "tag" && fields[2] != "" {
			sha = fields[2]
		}
		if name == "refs/remotes/origin/HEAD" {
			// A symbolic remote HEAD is a name for another row's label, not a label of its own.
			continue
		}
		labels[sha] = append(labels[sha], ref{Kind: kind, Name: fields[4]})
	}
	return labels, nil
}

// countRefs counts the labels the header shows, without the cost of reading their names.
func countRefs(ctx context.Context, root string) (branches, tags int, err error) {
	probe, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	out, _, err := runGit(probe, root, []string{"for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"}, probeBudget)
	if err != nil {
		return 0, 0, err
	}
	for _, line := range strings.Split(string(out), "\n") {
		switch {
		case strings.HasPrefix(line, "refs/heads/"):
			branches++
		case strings.HasPrefix(line, "refs/tags/"):
			tags++
		}
	}
	return branches, tags, nil
}

// drawLanes places every commit in a column and records the lines that cross its row.
//
// Columns are slots that live while a lane lives: `waiting[column]` is the commit that lane is running
// towards, and an empty slot is free from `freeFrom` onwards. A commit is placed in the column that was
// waiting for it; if several were, the extras bend into that column, which is a merge. Its first parent
// takes over the column and each further parent either bends into a column already waiting for it or
// opens one, which is a fork.
func drawLanes(commits []rawCommit, r repo, labels map[string][]ref) ([]row, int) {
	var waiting []string
	freeFrom := map[int]int{}
	laneCount := 0

	// alloc finds the leftmost free column, or grows the walk by one on the right. A column freed on an
	// earlier row is reused only two rows later, so a line ending and a line starting do not share a
	// pixel on the row where they meet.
	alloc := func(rowIndex int) int {
		for column := 0; column < len(waiting); column++ {
			if waiting[column] != "" {
				continue
			}
			if freeFrom[column] <= rowIndex {
				return column
			}
		}
		waiting = append(waiting, "")
		return len(waiting) - 1
	}

	rows := make([]row, 0, len(commits))
	for index, commit := range commits {
		lane := -1
		var merges []int
		for column, want := range waiting {
			if want != commit.sha {
				continue
			}
			if lane == -1 {
				lane = column
			} else {
				merges = append(merges, column)
			}
		}
		// A commit nobody was waiting for starts its own line: the row above it has nothing to draw.
		up := lane != -1
		if lane == -1 {
			lane = alloc(index)
			waiting[lane] = commit.sha
		}
		// The lines crossing this row: every other live lane keeps its column, and the lanes that were
		// waiting for this commit bend into it instead, so they are not drawn straight as well.
		absorbed := make(map[int]bool, len(merges))
		for _, column := range merges {
			absorbed[column] = true
		}
		edges := make([]edge, 0, len(waiting)+len(commit.parents))
		for column, want := range waiting {
			if column == lane || want == "" || absorbed[column] {
				continue
			}
			edges = append(edges, edge{From: column, To: column, Kind: "pass"})
		}
		for _, column := range merges {
			edges = append(edges, edge{From: column, To: lane, Kind: "merge"})
			waiting[column] = ""
			freeFrom[column] = index + 2
		}

		if len(commit.parents) == 0 {
			waiting[lane] = ""
			freeFrom[lane] = index + 2
		} else {
			waiting[lane] = commit.parents[0]
			for _, parent := range commit.parents[1:] {
				target := -1
				for column, want := range waiting {
					if want == parent && column != lane {
						target = column
						break
					}
				}
				if target == -1 {
					target = alloc(index)
					waiting[target] = parent
				}
				edges = append(edges, edge{From: lane, To: target, Kind: "fork"})
			}
		}

		sort.SliceStable(edges, func(a, b int) bool {
			if edges[a].To != edges[b].To {
				return edges[a].To < edges[b].To
			}
			return edges[a].From < edges[b].From
		})
		cols := lane + 1
		for _, line := range edges {
			if line.From+1 > cols {
				cols = line.From + 1
			}
			if line.To+1 > cols {
				cols = line.To + 1
			}
		}
		if cols > laneCount {
			laneCount = cols
		}
		row := row{
			SHA:     commit.sha,
			Short:   commit.short,
			Parents: append([]string{}, commit.parents...),
			Author:  commit.author,
			Email:   commit.email,
			At:      commit.at,
			Subject: commit.subject,
			Lane:    lane,
			Cols:    cols,
			Up:      up,
			Edges:   edges,
			Refs:    append([]ref{}, labels[commit.sha]...),
			Head:    commit.sha == r.head,
			Root:    len(commit.parents) == 0,
		}
		sortRefs(row.Refs)
		rows = append(rows, row)
	}
	return rows, laneCount
}

// sortRefs puts the labels of one commit in the order the view shows them: HEAD's branch, then other
// local branches, then remote branches, then tags.
func sortRefs(refs []ref) {
	weight := map[string]int{"branch": 0, "remote": 1, "tag": 2}
	sort.SliceStable(refs, func(a, b int) bool {
		if weight[refs[a].Kind] != weight[refs[b].Kind] {
			return weight[refs[a].Kind] < weight[refs[b].Kind]
		}
		return refs[a].Name < refs[b].Name
	})
}

// shaPattern is what a revision may look like before it is handed to git: hexadecimal, and only that.
// Nothing that starts with a dash matches, so a revision can never be read as an option.
var shaPattern = regexp.MustCompile(`^[0-9a-fA-F]{4,64}$`)

// checkSHA refuses anything that is not a plain hexadecimal revision.
func checkSHA(value string) (string, error) {
	if !shaPattern.MatchString(value) {
		return "", failf(invalidParams, "sha must be 4 to 64 hexadecimal characters")
	}
	return strings.ToLower(value), nil
}

// resolveCommit turns a revision a caller named into the full sha of the commit it is.
func resolveCommit(ctx context.Context, root, sha string) (string, error) {
	checked, err := checkSHA(sha)
	if err != nil {
		return "", err
	}
	probe, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	out, _, err := runGit(probe, root, []string{"rev-parse", "--verify", "--quiet", checked + "^{commit}"}, probeBudget)
	if err != nil || strings.TrimSpace(string(out)) == "" {
		return "", failf(invalidParams, "%s is not a commit in this repository", sha)
	}
	return strings.TrimSpace(string(out)), nil
}
