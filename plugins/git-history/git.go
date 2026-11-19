// Git, run as a program with arguments this file builds and nothing else.
//
// Every command is a fixed argument list this package wrote, with the workspace folder handed to `git
// -C` as a value rather than through a shell, so no part of a request can turn into another command or
// another option. Nothing here writes: no checkout, no fetch, no index update, and the lock file git
// would take for one is turned off. A command gets a deadline and a budget on how much of its output is
// kept, so a huge repository costs a slow answer instead of the daemon's memory.
package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

// The deadlines and budgets one request may spend. They are constants rather than settings: a plugin
// that hangs is worse than one that says its repository is too large to draw in time.
const (
	probeTimeout  = 5 * time.Second
	walkTimeout   = 15 * time.Second
	detailTimeout = 10 * time.Second

	walkBudget   = 8 << 20
	detailBudget = 4 << 20
	diffBudget   = 512 << 10
	probeBudget  = 256 << 10
)

// gitError is a command that could not be run or that exited non-zero, with what it said on stderr.
type gitError struct {
	args   []string
	code   int
	stderr string
	err    error
}

func (e *gitError) Error() string {
	said := strings.TrimSpace(e.stderr)
	if said == "" {
		said = "no message"
	}
	if e.err != nil && !errors.Is(e.err, context.DeadlineExceeded) {
		return fmt.Sprintf("git %s failed: %s", strings.Join(e.args, " "), said)
	}
	return fmt.Sprintf("git %s failed: %s", strings.Join(e.args, " "), said)
}

func (e *gitError) Unwrap() error { return e.err }

// capWriter keeps at most limit bytes and remembers that it dropped the rest.
type capWriter struct {
	buf       bytes.Buffer
	limit     int
	truncated bool
}

func (c *capWriter) Write(p []byte) (int, error) {
	room := c.limit - c.buf.Len()
	if room <= 0 {
		c.truncated = true
		return len(p), nil
	}
	if len(p) > room {
		// A partial multi-byte character at the cut is the price of a budget; the flag says so.
		c.buf.Write(p[:room])
		c.truncated = true
		return len(p), nil
	}
	c.buf.Write(p)
	return len(p), nil
}

// gitEnv is the environment git is run with: the daemon's own, minus anything that would make git wait
// for a human, take a lock on somebody's index, or answer in a language this file cannot read.
func gitEnv() []string {
	keep := make([]string, 0, len(os.Environ())+6)
	for _, entry := range os.Environ() {
		name, _, _ := strings.Cut(entry, "=")
		switch name {
		case "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "GIT_PAGER", "GIT_ASKPASS", "LC_ALL", "LANG":
			continue
		}
		keep = append(keep, entry)
	}
	return append(keep,
		"GIT_OPTIONAL_LOCKS=0",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_PAGER=cat",
		"GIT_ASKPASS=/bin/false",
		"LC_ALL=C",
		"LANG=C",
	)
}

// runGit runs one read-only git command in folder and returns what it wrote, cut to budget.
func runGit(ctx context.Context, folder string, args []string, budget int) ([]byte, bool, error) {
	argv := append([]string{"-c", "color.ui=false", "-c", "core.quotepath=false", "-c", "log.showSignature=false", "--no-pager", "-C", folder}, args...)
	cmd := exec.CommandContext(ctx, "git", argv...)
	cmd.Env = gitEnv()
	// No stdin: a command that would ask a question reads end-of-file instead of waiting for a daemon
	// that has nothing to type.
	cmd.Stdin = bytes.NewReader(nil)
	out := &capWriter{limit: budget}
	errOut := &capWriter{limit: 8 << 10}
	cmd.Stdout = out
	cmd.Stderr = errOut
	if err := cmd.Run(); err != nil {
		code := -1
		var exit *exec.ExitError
		if errors.As(err, &exit) {
			code = exit.ExitCode()
		}
		return out.buf.Bytes(), out.truncated, &gitError{args: args, code: code, stderr: errOut.buf.String(), err: err}
	}
	return out.buf.Bytes(), out.truncated, nil
}

// repo is the folder a workspace resolves to: the top of the working tree, and what HEAD says.
type repo struct {
	root   string
	branch string
	head   string
	detach bool
	unborn bool
}

// openRepo resolves the folder a workspace points at into the repository that holds it, without
// writing anything. A folder that is missing, is not a directory, or is not inside a working tree is
// refused with what was wrong rather than an empty graph.
func openRepo(ctx context.Context, folder string) (repo, error) {
	facts, err := os.Stat(folder)
	if err != nil {
		return repo{}, failf(invalidParams, "the workspace folder %s cannot be read: %s", folder, errText(err))
	}
	if !facts.IsDir() {
		return repo{}, failf(invalidParams, "the workspace folder %s is not a directory", folder)
	}
	sub, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	out, _, err := runGit(sub, folder, []string{"rev-parse", "--show-toplevel"}, probeBudget)
	if err != nil {
		return repo{}, failf(invalidParams, "%s is not a git working tree: %s", folder, errText(err))
	}
	root := strings.TrimSpace(string(out))
	if root == "" {
		return repo{}, failf(invalidParams, "%s is not a git working tree", folder)
	}
	found := repo{root: root}
	if data, _, headErr := runGit(sub, root, []string{"rev-parse", "--verify", "--quiet", "HEAD"}, probeBudget); headErr == nil {
		found.head = strings.TrimSpace(string(data))
	} else {
		// A repository with no commits answers nothing here: HEAD names a branch that does not exist yet.
		found.unborn = true
	}
	if data, _, refErr := runGit(sub, root, []string{"symbolic-ref", "--quiet", "--short", "HEAD"}, probeBudget); refErr == nil {
		found.branch = strings.TrimSpace(string(data))
	} else {
		found.detach = !found.unborn
	}
	return found, nil
}

// errText is an error as one line, so a refusal stays one line on the wire.
func errText(err error) string {
	text := strings.TrimSpace(err.Error())
	text = strings.ReplaceAll(text, "\n", " ")
	return text
}
