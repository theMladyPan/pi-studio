// The history walk and the lanes it draws, against repositories made for each shape a graph has to
// survive: no commits at all, a detached HEAD, a merged branch, a branch left forked, and a history long
// enough that a page is a slice of it.
package main

import (
	"context"
	"os"
	"testing"
	"time"
)

func TestHistoryOfAnEmptyRepository(t *testing.T) {
	folder := newRepo(t)
	answer := mustHistory(t, folder, 0, 40)

	if len(answer.Rows) != 0 {
		t.Fatalf("an empty repository drew %d rows", len(answer.Rows))
	}
	if answer.Page.HasMore {
		t.Fatalf("an empty repository said there is a next page")
	}
	if !answer.Repo.Unborn || answer.Repo.Head != "" {
		t.Fatalf("an empty repository should say HEAD is unborn with no sha, got %+v", answer.Repo)
	}
	if answer.Repo.Branch != "main" {
		t.Fatalf("an empty repository should name the branch HEAD points at, got %q", answer.Repo.Branch)
	}
	if answer.Page.Total == nil || *answer.Page.Total != 0 {
		t.Fatalf("an empty repository has a total of zero, got %v", answer.Page.Total)
	}
}

func TestHistoryOfADetachedHead(t *testing.T) {
	folder := newRepo(t)
	commitFile(t, folder, "a.txt", "one\n", "first")
	second := commitFile(t, folder, "a.txt", "two\n", "second")
	third := commitFile(t, folder, "a.txt", "three\n", "third")
	gitIn(t, folder, "checkout", "-q", "--detach", second)

	answer := mustHistory(t, folder, 0, 40)

	if !answer.Repo.Detached {
		t.Fatalf("a detached HEAD should say so, got %+v", answer.Repo)
	}
	if answer.Repo.Head != second {
		t.Fatalf("HEAD is %s, want the detached commit %s", answer.Repo.Head, second)
	}
	if answer.Repo.Branch != "" {
		t.Fatalf("a detached HEAD names no branch, got %q", answer.Repo.Branch)
	}
	if len(answer.Rows) != 3 {
		t.Fatalf("the walk should read every commit once, got %d rows for 3 commits (%s, %s)", len(answer.Rows), second, third)
	}
	var detachedRow *row
	for index := range answer.Rows {
		if answer.Rows[index].SHA == second {
			detachedRow = &answer.Rows[index]
		}
	}
	if detachedRow == nil || !detachedRow.Head {
		t.Fatalf("the commit HEAD points at should be marked as HEAD, got %+v", answer.Rows)
	}
	// Topology decides the order: the third commit is a child of the detached one, so it is drawn first.
	if answer.Rows[0].SHA != third || answer.Rows[0].Head {
		t.Fatalf("the child of the detached commit has no label of HEAD, got %+v", answer.Rows[0])
	}
	// The branch the checkout left behind still labels the commit it points at, which is the third one.
	var labelled bool
	for _, row := range answer.Rows {
		for _, label := range row.Refs {
			if label.Kind == "branch" && label.Name == "main" && row.SHA == third {
				labelled = true
			}
		}
	}
	if !labelled {
		t.Fatalf("the main branch should still label %s after the checkout detached", third)
	}
}

func TestHistoryOfAMergedBranch(t *testing.T) {
	folder := newRepo(t)
	commitFile(t, folder, "a.txt", "one\n", "first on main")
	gitIn(t, folder, "checkout", "-q", "-b", "feature")
	commitFile(t, folder, "b.txt", "feature\n", "work on the feature")
	gitIn(t, folder, "checkout", "-q", "main")
	commitFile(t, folder, "a.txt", "two\n", "second on main")
	merge := mergeBranch(t, folder, "feature")

	answer := mustHistory(t, folder, 0, 40)
	if len(answer.Rows) != 4 {
		t.Fatalf("a merge of two one-commit branches should draw 4 rows, got %d", len(answer.Rows))
	}
	if answer.Rows[0].SHA != merge {
		t.Fatalf("the newest row should be the merge commit %s, got %s", merge, answer.Rows[0].SHA)
	}
	if len(answer.Rows[0].Parents) != 2 {
		t.Fatalf("the merge row should name two parents, got %v", answer.Rows[0].Parents)
	}
	kinds := map[string]int{}
	for _, row := range answer.Rows {
		for _, line := range row.Edges {
			kinds[line.Kind]++
			if line.From < 0 || line.To < 0 || line.From >= row.Cols || line.To >= row.Cols {
				t.Fatalf("row %s draws %+v outside its %d columns", row.Short, line, row.Cols)
			}
		}
		if row.Lane < 0 || row.Lane >= row.Cols {
			t.Fatalf("row %s sits in lane %d outside its %d columns", row.Short, row.Lane, row.Cols)
		}
		if row.Cols > answer.LaneCount {
			t.Fatalf("row %s uses %d columns, more than the walk's %d", row.Short, row.Cols, answer.LaneCount)
		}
	}
	if kinds["fork"] == 0 {
		t.Fatalf("the merge should send a line into a new lane, edges were %+v", kinds)
	}
	if kinds["merge"] == 0 {
		t.Fatalf("the two lines should reach the shared commit, edges were %+v", kinds)
	}
	if answer.LaneCount < 2 {
		t.Fatalf("a branch that forked and merged needs two lanes, got %d", answer.LaneCount)
	}
	// The labels are drawn beside the rows they point at.
	var sawFeature bool
	for _, row := range answer.Rows {
		for _, label := range row.Refs {
			if label.Kind == "branch" && label.Name == "feature" {
				sawFeature = true
			}
		}
	}
	if !sawFeature {
		t.Fatalf("no row carried the feature branch label")
	}
}

func TestHistoryOfAForkedBranchLeftAlone(t *testing.T) {
	folder := newRepo(t)
	commitFile(t, folder, "a.txt", "one\n", "first on main")
	gitIn(t, folder, "checkout", "-q", "-b", "side")
	commitFile(t, folder, "side.txt", "side\n", "work on the side")
	gitIn(t, folder, "checkout", "-q", "main")
	commitFile(t, folder, "a.txt", "two\n", "second on main")

	answer := mustHistory(t, folder, 0, 40)
	if len(answer.Rows) != 3 {
		t.Fatalf("two branches over one shared commit should draw 3 rows, got %d", len(answer.Rows))
	}
	if answer.LaneCount < 2 {
		t.Fatalf("an unmerged branch needs a lane of its own, got %d", answer.LaneCount)
	}
	branches := map[string]bool{}
	for _, row := range answer.Rows {
		for _, label := range row.Refs {
			branches[label.Name] = true
		}
	}
	if !branches["main"] || !branches["side"] {
		t.Fatalf("both branch heads should be labelled, got %+v", branches)
	}
}

func TestHistoryOfARootCommit(t *testing.T) {
	folder := newRepo(t)
	root := commitFile(t, folder, "a.txt", "one\n", "the first commit")

	answer := mustHistory(t, folder, 0, 40)
	if len(answer.Rows) != 1 {
		t.Fatalf("one commit should draw one row, got %d", len(answer.Rows))
	}
	if !answer.Rows[0].Root || len(answer.Rows[0].Parents) != 0 {
		t.Fatalf("the first commit has no parent, got %+v", answer.Rows[0])
	}
	if answer.Rows[0].SHA != root {
		t.Fatalf("the only row should be %s, got %s", root, answer.Rows[0].SHA)
	}
}

func TestHistoryPaging(t *testing.T) {
	folder := newRepo(t)
	var shas []string
	for index := 0; index < 10; index++ {
		shas = append(shas, commitEmpty(t, folder, "commit"))
	}

	first := mustHistory(t, folder, 0, 3)
	if len(first.Rows) != 3 {
		t.Fatalf("page one should hold 3 rows, got %d", len(first.Rows))
	}
	if !first.Page.HasMore || first.Page.Next == nil || *first.Page.Next != 3 {
		t.Fatalf("page one should offer page two, got %+v", first.Page)
	}
	// Only one row past the page was read, so the walk does not know how long the history is.
	if first.Page.Total != nil {
		t.Fatalf("a page that stopped on its bound cannot know the total, got %v", *first.Page.Total)
	}

	second := mustHistory(t, folder, 3, 3)
	if len(second.Rows) != 3 {
		t.Fatalf("page two should hold 3 rows, got %d", len(second.Rows))
	}
	if second.Rows[0].SHA != shas[6] {
		t.Fatalf("page two should start at the seventh commit %s, got %s", shas[6], second.Rows[0].SHA)
	}
	seen := map[string]bool{}
	for _, row := range append(append([]row{}, first.Rows...), second.Rows...) {
		if seen[row.SHA] {
			t.Fatalf("commit %s appeared on two pages", row.SHA)
		}
		seen[row.SHA] = true
	}

	last := mustHistory(t, folder, 9, 3)
	if len(last.Rows) != 1 {
		t.Fatalf("the last page should hold the one remaining row, got %d", len(last.Rows))
	}
	if last.Page.HasMore || last.Page.Next != nil {
		t.Fatalf("the last page should not offer another, got %+v", last.Page)
	}
}

func TestHistoryOutOfRange(t *testing.T) {
	folder := newRepo(t)
	for index := 0; index < 4; index++ {
		commitEmpty(t, folder, "commit")
	}

	past := mustHistory(t, folder, 40, 10)
	if len(past.Rows) != 0 {
		t.Fatalf("an offset past the history should draw no rows, got %d", len(past.Rows))
	}
	if past.Page.HasMore {
		t.Fatalf("an offset past the history has no next page")
	}

	// Past the walk's own bound the answer says so instead of reading for a minute.
	beyond := mustHistory(t, folder, maxScan+10, 10)
	if len(beyond.Rows) != 0 || len(beyond.Notes) == 0 {
		t.Fatalf("an offset past the walk bound should name the bound, got %d rows and %v", len(beyond.Rows), beyond.Notes)
	}
}

func TestHistoryPageRefusals(t *testing.T) {
	if _, _, err := pageParams([]byte(`{"offset":-1}`)); err == nil {
		t.Fatalf("a negative offset should be refused")
	}
	if _, _, err := pageParams([]byte(`{"limit":0}`)); err == nil {
		t.Fatalf("a zero limit should be refused")
	}
	offset, limit, err := pageParams([]byte(`{"offset":5,"limit":100000}`))
	if err != nil {
		t.Fatalf("a huge limit should be clamped, got %v", err)
	}
	if offset != 5 || limit != maxLimit {
		t.Fatalf("a huge limit clamps to %d, got offset %d limit %d", maxLimit, offset, limit)
	}
	if offset, limit, err := pageParams(nil); err != nil || offset != 0 || limit != defaultLimit {
		t.Fatalf("no params should mean the first page, got %d/%d and %v", offset, limit, err)
	}
}

func TestHistoryOfALargePage(t *testing.T) {
	folder := newRepo(t)
	for index := 0; index < 60; index++ {
		commitEmpty(t, folder, "commit")
	}

	answer := mustHistory(t, folder, 0, maxLimit)
	if len(answer.Rows) != 60 {
		t.Fatalf("a page larger than the history should hold every commit, got %d", len(answer.Rows))
	}
	if answer.Page.HasMore {
		t.Fatalf("a page larger than the history has no next page")
	}
	for _, row := range answer.Rows {
		if row.Short == "" || row.Subject == "" || row.Author == "" {
			t.Fatalf("a row should carry the commit's short sha, subject and author, got %+v", row)
		}
	}
	if answer.Page.Total == nil || *answer.Page.Total != 60 {
		t.Fatalf("the total should be 60, got %v", answer.Page.Total)
	}
}

func TestRepoRootFromASubfolder(t *testing.T) {
	folder := newRepo(t)
	commitFile(t, folder, "nested/deep/a.txt", "one\n", "first")
	sub := folder + "/nested/deep"
	if _, err := os.Stat(sub); err != nil {
		t.Fatalf("the fixture did not make the nested folder: %v", err)
	}

	found := mustRepo(t, sub)
	resolved, err := os.Stat(found.root)
	if err != nil || !resolved.IsDir() {
		t.Fatalf("the root %s should be a folder: %v", found.root, err)
	}
	if found.root == sub {
		t.Fatalf("a subfolder should resolve to the top of the working tree, got %s", found.root)
	}
}

func TestNotARepository(t *testing.T) {
	folder := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := openRepo(ctx, folder); err == nil {
		t.Fatalf("a folder outside a repository should be refused")
	}
}

func TestMissingFolder(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := openRepo(ctx, t.TempDir()+"/gone"); err == nil {
		t.Fatalf("a folder that is not there should be refused")
	}
}

func TestRevisionRefusals(t *testing.T) {
	for _, bad := range []string{"", "--upload-pack=touch /tmp/x", "HEAD", "main", "-n1", "abc", "zzzzzzz"} {
		if _, err := checkSHA(bad); err == nil {
			t.Fatalf("%q should be refused as a revision", bad)
		}
	}
	if got, err := checkSHA("ABCDEF1"); err != nil || got != "abcdef1" {
		t.Fatalf("a hexadecimal revision should be lowercased, got %q and %v", got, err)
	}
}

// TestLanesConnectBetweenRows is the invariant a renderer leans on: the columns carrying a line out of
// one row are exactly the columns a line comes into at the next row. A row drawn on its own can then be
// stacked under the one before it without a line ending in mid air or starting from nowhere.
func TestLanesConnectBetweenRows(t *testing.T) {
	folder := newRepo(t)
	commitFile(t, folder, "a.txt", "one\n", "first on main")
	gitIn(t, folder, "checkout", "-q", "-b", "feature")
	commitFile(t, folder, "b.txt", "feature\n", "work on the feature")
	gitIn(t, folder, "checkout", "-q", "main")
	commitFile(t, folder, "a.txt", "two\n", "second on main")
	mergeBranch(t, folder, "feature")
	gitIn(t, folder, "checkout", "-q", "-b", "side")
	commitFile(t, folder, "c.txt", "side\n", "a branch left alone")
	gitIn(t, folder, "checkout", "-q", "main")
	gitIn(t, folder, "checkout", "-q", "feature")
	commitEmpty(t, folder, "one more on the feature")
	gitIn(t, folder, "checkout", "-q", "main")

	answer := mustHistory(t, folder, 0, 40)
	if len(answer.Rows) < 6 {
		t.Fatalf("the fixture should draw at least six rows, got %d", len(answer.Rows))
	}

	below := func(row row) map[int]bool {
		columns := map[int]bool{}
		if !row.Root {
			columns[row.Lane] = true
		}
		for _, line := range row.Edges {
			if line.Kind == "fork" || line.Kind == "pass" {
				columns[line.To] = true
			}
		}
		return columns
	}
	above := func(row row) map[int]bool {
		columns := map[int]bool{}
		if row.Up {
			columns[row.Lane] = true
		}
		for _, line := range row.Edges {
			if line.Kind == "merge" || line.Kind == "pass" {
				columns[line.From] = true
			}
		}
		return columns
	}

	for index, row := range answer.Rows {
		for _, line := range row.Edges {
			if line.Kind != "pass" && line.Kind != "merge" && line.Kind != "fork" {
				t.Fatalf("row %s draws an edge of an unknown kind %q", row.Short, line.Kind)
			}
			if line.Kind == "pass" && line.From != line.To {
				t.Fatalf("a passing lane cannot change column, row %s has %+v", row.Short, line)
			}
			if line.Kind == "merge" && line.To != row.Lane {
				t.Fatalf("a merging lane has to reach the commit's column %d, row %s has %+v", row.Lane, row.Short, line)
			}
			if line.Kind == "fork" && line.From != row.Lane {
				t.Fatalf("a forking lane has to leave the commit's column %d, row %s has %+v", row.Lane, row.Short, line)
			}
		}
		if index == 0 {
			continue
		}
		carried := below(answer.Rows[index-1])
		arrived := above(row)
		for column := range carried {
			if !arrived[column] {
				t.Fatalf("row %d (%s) leaves column %d with a line that row %d (%s) does not pick up", index-1, answer.Rows[index-1].Short, column, index, row.Short)
			}
		}
		for column := range arrived {
			if !carried[column] {
				t.Fatalf("row %d (%s) starts column %d with a line that row %d (%s) did not draw", index, row.Short, column, index-1, answer.Rows[index-1].Short)
			}
		}
	}
}
