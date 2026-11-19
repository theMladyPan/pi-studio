// One commit in full: the message, the files it changed, and the patch of a file that was picked. The
// root commit is here because it has no parent to diff against, which is the case that quietly draws
// nothing when it is forgotten.
package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCommitDetailsOfAnOrdinaryCommit(t *testing.T) {
	folder := newRepo(t)
	commitFile(t, folder, "a.txt", "one\n", "first")
	sha := commitFile(t, folder, "b.txt", "two\n", "add b")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	detail, err := readCommit(ctx, mustRepo(t, folder), sha[:8])
	if err != nil {
		t.Fatalf("readCommit: %v", err)
	}
	if detail.SHA != sha {
		t.Fatalf("a short sha should resolve to %s, got %s", sha, detail.SHA)
	}
	if detail.Subject != "add b" || !strings.Contains(detail.Message, "add b") {
		t.Fatalf("the message should be read whole, got subject %q and body %q", detail.Subject, detail.Message)
	}
	if len(detail.Files) != 1 || detail.Files[0].Status != "A" || detail.Files[0].Path != "b.txt" {
		t.Fatalf("the commit added b.txt, got %+v", detail.Files)
	}
	if len(detail.Parents) != 1 || detail.Merge || detail.Root {
		t.Fatalf("an ordinary commit has one parent and is neither merge nor root, got %+v", detail)
	}
	if !detail.Head {
		t.Fatalf("the newest commit should be marked as HEAD")
	}
}

func TestCommitDetailsOfARootCommit(t *testing.T) {
	folder := newRepo(t)
	sha := commitFile(t, folder, "a.txt", "one\ntwo\n", "the first commit")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	detail, err := readCommit(ctx, mustRepo(t, folder), sha)
	if err != nil {
		t.Fatalf("readCommit: %v", err)
	}
	if !detail.Root || len(detail.Parents) != 0 {
		t.Fatalf("the first commit has no parent, got %+v", detail)
	}
	if len(detail.Files) != 1 || detail.Files[0].Status != "A" || detail.Files[0].Path != "a.txt" {
		t.Fatalf("a root commit adds every file it holds, got %+v", detail.Files)
	}

	patch, err := readDiff(ctx, mustRepo(t, folder), sha, "a.txt", 3)
	if err != nil {
		t.Fatalf("readDiff: %v", err)
	}
	if patch.Parent != "" {
		t.Fatalf("a root commit diffs against the empty tree, so it has no parent, got %q", patch.Parent)
	}
	if patch.Added != 2 || patch.Removed != 0 {
		t.Fatalf("the root commit added two lines, got %d added and %d removed: %s", patch.Added, patch.Removed, patch.Patch)
	}
	if !strings.Contains(patch.Patch, "+one") || !strings.Contains(patch.Patch, "+two") {
		t.Fatalf("the patch should hold both added lines, got:\n%s", patch.Patch)
	}
}

func TestDiffOfOneFile(t *testing.T) {
	folder := newRepo(t)
	commitFile(t, folder, "a.txt", "one\ntwo\nthree\n", "first")
	sha := commitFile(t, folder, "a.txt", "one\nTWO\nthree\nfour\n", "change two")
	commitFile(t, folder, "other.txt", "other\n", "unrelated")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	answer, err := readDiff(ctx, mustRepo(t, folder), sha, "a.txt", 3)
	if err != nil {
		t.Fatalf("readDiff: %v", err)
	}
	if answer.Path != "a.txt" || answer.Parent == "" {
		t.Fatalf("a patch names its path and the parent it was read against, got %+v", answer)
	}
	if answer.Added != 2 || answer.Removed != 1 {
		t.Fatalf("the change added two lines and removed one, got %d and %d:\n%s", answer.Added, answer.Removed, answer.Patch)
	}
	if strings.Contains(answer.Patch, "other.txt") {
		t.Fatalf("a patch for one file should mention no other file:\n%s", answer.Patch)
	}
	if answer.Truncated || answer.Binary {
		t.Fatalf("an ordinary text patch is neither truncated nor binary, got %+v", answer)
	}
}

func TestDiffOfAFileWithAnAwkwardName(t *testing.T) {
	folder := newRepo(t)
	commitFile(t, folder, "a.txt", "one\n", "first")
	sha := commitFile(t, folder, "sub/--weird name.txt", "x\n", "add an awkward name")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	answer, err := readDiff(ctx, mustRepo(t, folder), sha, "sub/--weird name.txt", 3)
	if err != nil {
		t.Fatalf("readDiff: %v", err)
	}
	if answer.Added != 1 {
		t.Fatalf("the file was added with one line, got %d:\n%s", answer.Added, answer.Patch)
	}
}

func TestDiffOfABinaryFile(t *testing.T) {
	folder := newRepo(t)
	commitFile(t, folder, "a.txt", "one\n", "first")
	binary := filepath.Join(folder, "picture.bin")
	if err := os.WriteFile(binary, []byte{0x00, 0x01, 0x02, 0xff, 0xfe}, 0o644); err != nil {
		t.Fatalf("could not write the binary fixture: %v", err)
	}
	gitIn(t, folder, "add", "--", "picture.bin")
	gitIn(t, folder, "commit", "-q", "-m", "add a picture")
	sha := gitIn(t, folder, "rev-parse", "HEAD")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	answer, err := readDiff(ctx, mustRepo(t, folder), sha, "picture.bin", 3)
	if err != nil {
		t.Fatalf("readDiff: %v", err)
	}
	if !answer.Binary {
		t.Fatalf("a patch of a binary file should say so, got:\n%s", answer.Patch)
	}
	if answer.Added != 0 || answer.Removed != 0 {
		t.Fatalf("a binary patch has no added or removed lines, got %d and %d", answer.Added, answer.Removed)
	}
}

func TestDiffRefusals(t *testing.T) {
	folder := newRepo(t)
	sha := commitFile(t, folder, "a.txt", "one\n", "first")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	found := mustRepo(t, folder)

	if _, err := readDiff(ctx, found, sha, "", 3); err == nil {
		t.Fatalf("a patch of no path should be refused")
	}
	if _, err := readDiff(ctx, found, "--upload-pack=touch /tmp/x", "a.txt", 3); err == nil {
		t.Fatalf("a revision that is not hexadecimal should be refused")
	}
	if _, err := readCommit(ctx, found, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"); err == nil {
		t.Fatalf("a commit that is not in the repository should be refused")
	}
	// A path that is not in the commit is an empty patch, not a failure.
	answer, err := readDiff(ctx, found, sha, "not-here.txt", 3)
	if err != nil {
		t.Fatalf("a path the commit did not touch should answer an empty patch: %v", err)
	}
	if answer.Added != 0 || strings.TrimSpace(answer.Patch) != "" {
		t.Fatalf("a path the commit did not touch should have no patch, got:\n%s", answer.Patch)
	}
}

func TestDiffOfAMergeReadsTheFirstParent(t *testing.T) {
	folder := newRepo(t)
	commitFile(t, folder, "a.txt", "one\n", "first on main")
	gitIn(t, folder, "checkout", "-q", "-b", "feature")
	commitFile(t, folder, "b.txt", "feature\n", "work on the feature")
	gitIn(t, folder, "checkout", "-q", "main")
	commitFile(t, folder, "a.txt", "two\n", "second on main")
	merge := mergeBranch(t, folder, "feature")

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	found := mustRepo(t, folder)
	detail, err := readCommit(ctx, found, merge)
	if err != nil {
		t.Fatalf("readCommit: %v", err)
	}
	if !detail.Merge || len(detail.Parents) != 2 {
		t.Fatalf("the merge commit has two parents, got %+v", detail)
	}
	if detail.Note == "" {
		t.Fatalf("a merge should say which parent its patch is read against")
	}
	// The file the merge brought in from the feature branch is listed against the first parent.
	var brought bool
	for _, file := range detail.Files {
		if file.Path == "b.txt" {
			brought = true
		}
	}
	if !brought {
		t.Fatalf("the merge should list b.txt as brought in, got %+v", detail.Files)
	}
	answer, err := readDiff(ctx, found, merge, "b.txt", 3)
	if err != nil {
		t.Fatalf("readDiff: %v", err)
	}
	if answer.Parent != detail.Parents[0] {
		t.Fatalf("the patch should be read against the first parent %s, got %s", detail.Parents[0], answer.Parent)
	}
	if answer.Added != 1 {
		t.Fatalf("the merge added one line of b.txt against its first parent, got %d:\n%s", answer.Added, answer.Patch)
	}
}
