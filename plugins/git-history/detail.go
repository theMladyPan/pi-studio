// One commit in full: who wrote it, what it changed, and the patch of a file that was picked.
//
// The file list comes from diffing the commit against its first parent, which is the change a human
// means when they open one commit. A merge has more than one parent and the same rule is the one the
// view states in words: this is what the merge brought in from the branch it landed on. The root commit
// has no parent at all, so it is diffed against the empty tree git keeps for exactly that case.
//
// A patch is cut at a budget and says so, because a frame has a megabyte and a rewritten lock file can be
// far larger than that.
package main

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"
)

// commitDetail is the panel the view opens when a row is picked.
type commitDetail struct {
	SHA            string        `json:"sha"`
	Short          string        `json:"short"`
	Parents        []string      `json:"parents"`
	Author         string        `json:"author"`
	Email          string        `json:"email"`
	At             int64         `json:"at"`
	Committer      string        `json:"committer"`
	CommitterEmail string        `json:"committerEmail"`
	CommittedAt    int64         `json:"committedAt"`
	Message        string        `json:"message"`
	Subject        string        `json:"subject"`
	Refs           []ref         `json:"refs"`
	Head           bool          `json:"head"`
	Merge          bool          `json:"merge"`
	Root           bool          `json:"root"`
	Files          []changedFile `json:"files"`
	Note           string        `json:"note,omitempty"`
}

// changedFile is one path a commit touched, with the letter git gives the change.
type changedFile struct {
	Status string `json:"status"`
	Path   string `json:"path"`
}

// diffAnswer is one file's patch against the commit's first parent, cut to the budget.
type diffAnswer struct {
	SHA       string `json:"sha"`
	Path      string `json:"path"`
	Parent    string `json:"parent"`
	Patch     string `json:"patch"`
	Binary    bool   `json:"binary"`
	Truncated bool   `json:"truncated"`
	Added     int    `json:"added"`
	Removed   int    `json:"removed"`
}

// readCommit reads one commit: its message, its labels, and the paths it changed.
func readCommit(ctx context.Context, r repo, sha string) (commitDetail, error) {
	full, err := resolveCommit(ctx, r.root, sha)
	if err != nil {
		return commitDetail{}, err
	}
	detail, err := readCommitMeta(ctx, r.root, full)
	if err != nil {
		return commitDetail{}, err
	}
	labels, err := readRefs(ctx, r.root)
	if err != nil {
		return commitDetail{}, err
	}
	detail.Refs = append([]ref{}, labels[full]...)
	sortRefs(detail.Refs)
	detail.Head = full == r.head
	detail.Merge = len(detail.Parents) > 1
	detail.Root = len(detail.Parents) == 0
	if detail.Files, err = readChangedFiles(ctx, r.root, full, detail.Parents); err != nil {
		return commitDetail{}, err
	}
	if detail.Merge {
		detail.Note = "a merge: the files and the patch are read against its first parent"
	}
	return detail, nil
}

// readCommitMeta reads the header and the message of one commit, in one command.
func readCommitMeta(ctx context.Context, root, sha string) (commitDetail, error) {
	detailCtx, cancel := context.WithTimeout(ctx, detailTimeout)
	defer cancel()
	out, _, err := runGit(detailCtx, root, []string{
		"show", "-s", "-z",
		"--format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%s%x1f%B",
		sha,
	}, detailBudget)
	if err != nil {
		return commitDetail{}, err
	}
	fields := strings.SplitN(string(out), "\x1f", 11)
	if len(fields) < 11 {
		return commitDetail{}, failf(internalError, "git said nothing readable about %s", sha)
	}
	return commitDetail{
		SHA:            strings.TrimSpace(fields[0]),
		Short:          fields[1],
		Parents:        strings.Fields(fields[2]),
		Author:         fields[3],
		Email:          fields[4],
		At:             secondsOf(fields[5]),
		Committer:      fields[6],
		CommitterEmail: fields[7],
		CommittedAt:    secondsOf(fields[8]),
		Subject:        fields[9],
		Message:        strings.TrimRight(fields[10], "\n\x00"),
		Files:          []changedFile{},
	}, nil
}

// readChangedFiles lists the paths one commit touched, against its first parent. git writes
// `status NUL path NUL`, a record per change, and --root is what makes a commit with no parent list
// everything it added instead of nothing.
func readChangedFiles(ctx context.Context, root, sha string, parents []string) ([]changedFile, error) {
	detailCtx, cancel := context.WithTimeout(ctx, detailTimeout)
	defer cancel()
	args := []string{"diff-tree", "--root", "--no-commit-id", "-r", "-z", "--name-status", "--no-renames", sha}
	if len(parents) > 0 {
		args = []string{"diff", "--name-status", "-z", "--no-renames", "--no-color", "--no-ext-diff", parents[0], sha}
	}
	out, _, err := runGit(detailCtx, root, args, detailBudget)
	if err != nil {
		return nil, err
	}
	files := []changedFile{}
	fields := strings.Split(string(out), "\x00")
	for index := 0; index+1 < len(fields); index += 2 {
		status := strings.TrimSpace(fields[index])
		path := fields[index+1]
		if status == "" || path == "" {
			continue
		}
		files = append(files, changedFile{Status: status[:1], Path: path})
	}
	return files, nil
}

// readDiff reads one file's patch. The patch is the change this commit made to that path as seen from
// its first parent, which is the same rule the file list follows, so the two always agree.
func readDiff(ctx context.Context, r repo, sha, path string, contextLines int) (diffAnswer, error) {
	if strings.TrimSpace(path) == "" || strings.ContainsRune(path, 0) {
		return diffAnswer{}, failf(invalidParams, "path must name one file in the commit")
	}
	if contextLines < 0 {
		contextLines = 0
	}
	if contextLines > 20 {
		contextLines = 20
	}
	detail, err := readCommit(ctx, r, sha)
	if err != nil {
		return diffAnswer{}, err
	}
	parents := detail.Parents
	unified := strconv.Itoa(contextLines)
	diffCtx, cancel := context.WithTimeout(ctx, detailTimeout)
	defer cancel()
	var args []string
	answer := diffAnswer{SHA: detail.SHA, Path: path}
	if len(parents) == 0 {
		args = []string{"diff-tree", "--root", "-p", "--no-commit-id", "-r", "--no-renames", "--no-color", "--no-ext-diff", "-U" + unified, detail.SHA, "--", path}
	} else {
		answer.Parent = parents[0]
		args = []string{"diff", "--no-renames", "--no-color", "--no-ext-diff", "-U" + unified, parents[0], detail.SHA, "--", path}
	}
	out, truncated, err := runGit(diffCtx, r.root, args, diffBudget)
	if err != nil {
		return diffAnswer{}, err
	}
	answer.Truncated = truncated
	patch := string(out)
	if answer.Truncated {
		// A cut patch can end inside a line; drop the half line rather than draw a lie.
		if cut := strings.LastIndexByte(patch, '\n'); cut >= 0 {
			patch = patch[:cut+1]
		}
	}
	answer.Patch = patch
	for _, line := range strings.Split(patch, "\n") {
		switch {
		case strings.HasPrefix(line, "+++"), strings.HasPrefix(line, "---"):
		case strings.HasPrefix(line, "+"):
			answer.Added++
		case strings.HasPrefix(line, "-"):
			answer.Removed++
		case strings.HasPrefix(line, "Binary files"), strings.HasPrefix(line, "GIT binary patch"):
			answer.Binary = true
		}
	}
	return answer, nil
}

// asJSON turns a request's params into the struct a method reads.
func asJSON(params json.RawMessage, into any) error {
	if len(params) == 0 || string(params) == "null" {
		return failf(invalidParams, "params must be an object")
	}
	if err := json.Unmarshal(params, into); err != nil {
		return failf(invalidParams, "params could not be read: %s", errText(err))
	}
	return nil
}

// secondsOf reads a unix timestamp git wrote, with zero for anything that is not one.
func secondsOf(value string) int64 {
	seconds, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	if err != nil {
		return 0
	}
	return seconds
}
