// Throwaway repositories for the tests: real git, real commits, made in a folder the test owns.
package main

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// gitIn runs one git command in a repository the test made, with an identity and no user config, so the
// commit ids and the messages come out the same on every machine.
func gitIn(t *testing.T, folder string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = folder
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Test Writer",
		"GIT_AUTHOR_EMAIL=writer@example.com",
		"GIT_AUTHOR_DATE=2024-01-02T03:04:05+00:00",
		"GIT_COMMITTER_NAME=Test Writer",
		"GIT_COMMITTER_EMAIL=writer@example.com",
		"GIT_COMMITTER_DATE=2024-01-02T03:04:05+00:00",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"LC_ALL=C",
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s failed: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// newRepo is an empty repository on `main`, which is a folder with a .git in it and no commit.
func newRepo(t *testing.T) string {
	t.Helper()
	folder := t.TempDir()
	gitIn(t, folder, "init", "-q", "-b", "main")
	return folder
}

// commitFile writes a file and commits it, answering the commit id.
func commitFile(t *testing.T, folder, name, content, message string) string {
	t.Helper()
	full := filepath.Join(folder, name)
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatalf("could not make the folder for %s: %v", name, err)
	}
	if err := os.WriteFile(full, []byte(content), 0o644); err != nil {
		t.Fatalf("could not write %s: %v", name, err)
	}
	gitIn(t, folder, "add", "--", name)
	gitIn(t, folder, "commit", "-q", "-m", message)
	return gitIn(t, folder, "rev-parse", "HEAD")
}

// mergeBranch merges one branch into the current one and answers the merge commit.
func mergeBranch(t *testing.T, folder, name string) string {
	t.Helper()
	gitIn(t, folder, "merge", "-q", "--no-ff", "--no-edit", name)
	return gitIn(t, folder, "rev-parse", "HEAD")
}

// commitEmpty makes a commit that changes nothing, which is the cheapest way to a long history.
func commitEmpty(t *testing.T, folder, message string) string {
	t.Helper()
	gitIn(t, folder, "commit", "-q", "--allow-empty", "-m", message)
	return gitIn(t, folder, "rev-parse", "HEAD")
}

// mustRepo resolves a fixture folder through the same path a request takes.
func mustRepo(t *testing.T, folder string) repo {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	found, err := openRepo(ctx, folder)
	if err != nil {
		t.Fatalf("openRepo(%s): %v", folder, err)
	}
	return found
}

// mustHistory reads one page of a fixture's history.
func mustHistory(t *testing.T, folder string, offset, limit int) history {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	answer, err := readHistory(ctx, mustRepo(t, folder), offset, limit)
	if err != nil {
		t.Fatalf("readHistory: %v", err)
	}
	return answer
}
