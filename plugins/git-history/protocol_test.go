// The pipe: the handshake, the refusals, and the calls the plugin makes back to a host that is only
// listening on the other end of the same pipe.
//
// The host here is a fake, but it is a fake on a real pipe: frames go in and come out as lines, the
// workspaces come from a folder the test made, and a `visual.request` reaches git for real. The one
// thing it proves that a function test cannot is that a handler waiting for the host does not stop the
// plugin from reading the host's answer.
package main

import (
	"encoding/json"
	"errors"
	"io"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// harness is the daemon's end of the pipe, doing exactly what the daemon does: handshake, answer the two
// workspace methods, and take the result of each call the view made.
type harness struct {
	t *testing.T
	// stdin is this end's pipe to the plugin, and toPlugin is the one writer every frame the plugin is
	// given goes through, requests and answers alike, so two of them cannot interleave.
	stdin    *io.PipeWriter
	toPlugin *frameWriter

	mu        sync.Mutex
	waiting   map[string]chan frame
	nextID    int
	hostCalls []string
	workspace workspaceInfo
	open      bool

	// holdList is the switch that proves concurrency: while it is set, each `workspace.list` call is
	// recorded and left unanswered until the test closes it, so two requests can only both be answered
	// if the plugin was still reading while its first handler waited.
	holdList   bool
	listSeen   chan struct{}
	listAnswer chan struct{}
}

// startHarness brings a plugin up on a pipe and plays the daemon against it.
func startHarness(t *testing.T, workspace workspaceInfo, open bool) *harness {
	t.Helper()
	inReader, inWriter := io.Pipe()
	outReader, outWriter := io.Pipe()
	h := &harness{
		t:          t,
		stdin:      inWriter,
		toPlugin:   &frameWriter{w: inWriter},
		waiting:    make(map[string]chan frame),
		workspace:  workspace,
		open:       open,
		listSeen:   make(chan struct{}, 8),
		listAnswer: make(chan struct{}),
	}
	// The manifest the built plugin carries, so the version and the view's files answer as they would.
	self := &plugin{
		manifest: manifest{
			Name:    "git-history",
			Version: "0.1.0",
			Visual: &visualManifest{
				Entry:   "assets/history.html",
				Styles:  []string{"assets/history.css"},
				Scripts: []string{"assets/history.js"},
			},
		},
		root:   ".",
		writer: &frameWriter{w: outWriter},
	}
	// The plugin calls the host through the same writer it answers on: one pipe out, as on a real stdin
	// and stdout pair, with the harness reading that end and answering on the plugin's stdin.
	self.host = newHostCaller(self.writer, 5*time.Second)
	self.workspaces = newWorkspaces(self.host)
	go func() {
		defer outWriter.Close()
		_ = self.serve(inReader)
	}()
	go h.readLoop(outReader)
	t.Cleanup(func() {
		_ = inWriter.Close()
		_ = outWriter.Close()
	})
	return h
}

// readLoop is the daemon's reading side: an answer goes to the call waiting for it, and a call from the
// plugin is answered here.
func (h *harness) readLoop(r io.Reader) {
	reader := newLineReader(r)
	for {
		line, err := reader.next()
		if err != nil {
			return
		}
		if len(strings.TrimSpace(string(line))) == 0 {
			continue
		}
		var got frame
		if err := json.Unmarshal(line, &got); err != nil {
			continue
		}
		if got.Method != "" {
			// On its own goroutine: an answer this test holds back must not stop the loop from reading
			// the next call the plugin made, which is the behaviour under test here.
			go h.answerHostCall(got)
			continue
		}
		key := string(got.ID)
		h.mu.Lock()
		waiter := h.waiting[key]
		delete(h.waiting, key)
		h.mu.Unlock()
		if waiter != nil {
			waiter <- got
		}
	}
}

// answerHostCall answers the two methods this plugin may call, and refuses the rest as the daemon does.
func (h *harness) answerHostCall(call frame) {
	h.mu.Lock()
	h.hostCalls = append(h.hostCalls, call.Method)
	hold := h.holdList
	h.mu.Unlock()
	if hold && call.Method == "workspace.list" {
		h.listSeen <- struct{}{}
		<-h.listAnswer
	}
	var result any
	switch call.Method {
	case "workspace.list":
		result = map[string]any{"workspaces": []workspaceInfo{h.workspace}}
	case "workspace.read":
		result = map[string]any{"workspace": h.workspace, "open": h.open, "cards": []any{map[string]any{"id": "c1"}}}
	default:
		_ = h.toPlugin.refuse(call.ID, failf(methodNotFound, "%s is not a method this daemon answers", call.Method))
		return
	}
	_ = h.toPlugin.result(call.ID, result)
}

// call sends one request to the plugin and waits for its answer, failing the test on silence.
func (h *harness) call(method string, params any) (json.RawMessage, *rpcError) {
	h.mu.Lock()
	h.nextID++
	id := h.nextID
	answer := make(chan frame, 1)
	h.waiting[itoa(id)] = answer
	h.mu.Unlock()
	if err := h.toPlugin.send(frame{JSONRPC: "2.0", ID: json.RawMessage(itoa(id)), Method: method, Params: encodeTestParams(h.t, params)}); err != nil {
		h.t.Fatalf("could not write %s to the plugin: %v", method, err)
	}
	select {
	case got := <-answer:
		if got.Error != nil {
			return nil, got.Error
		}
		return mustMarshal(got.Result), nil
	case <-time.After(20 * time.Second):
		h.t.Fatalf("the plugin never answered %s", method)
		return nil, nil
	}
}

// start begins a call without waiting for it, which is what the concurrency test needs.
func (h *harness) start(method string, params any) chan frame {
	h.mu.Lock()
	h.nextID++
	id := h.nextID
	answer := make(chan frame, 1)
	h.waiting[itoa(id)] = answer
	h.mu.Unlock()
	if err := h.toPlugin.send(frame{JSONRPC: "2.0", ID: json.RawMessage(itoa(id)), Method: method, Params: encodeTestParams(h.t, params)}); err != nil {
		h.t.Fatalf("could not write %s to the plugin: %v", method, err)
	}
	return answer
}

// notify writes a frame with no id, which wants no answer.
func (h *harness) notify(method string, params any) {
	if err := h.toPlugin.send(frame{JSONRPC: "2.0", Method: method, Params: encodeTestParams(h.t, params)}); err != nil {
		h.t.Fatalf("could not write %s to the plugin: %v", method, err)
	}
}

// raw writes bytes straight to the plugin, for the frames that are not frames.
func (h *harness) raw(text string) {
	if _, err := io.WriteString(h.stdin, text); err != nil {
		h.t.Fatalf("could not write to the plugin: %v", err)
	}
}

func encodeTestParams(t *testing.T, params any) json.RawMessage {
	t.Helper()
	if params == nil {
		return nil
	}
	data, err := json.Marshal(params)
	if err != nil {
		t.Fatalf("could not marshal params: %v", err)
	}
	return data
}

// itoa is the decimal form of an id, which is the form a JSON-RPC id takes on the wire.
func itoa(value int) string {
	return strconv.Itoa(value)
}

func TestHandshake(t *testing.T) {
	h := startHarness(t, workspaceInfo{ID: "w1", Name: "project", Folder: t.TempDir()}, false)
	answer, failure := h.call("initialize", map[string]any{"protocolVersion": 1, "plugin": "git-history"})
	if failure != nil {
		t.Fatalf("initialize was refused: %+v", failure)
	}
	var said map[string]any
	if err := json.Unmarshal(answer, &said); err != nil {
		t.Fatalf("the initialize answer is not an object: %v", err)
	}
	if said["protocolVersion"] != float64(1) {
		t.Fatalf("the plugin should answer protocol 1, got %v", said["protocolVersion"])
	}
	if said["name"] != "git-history" {
		t.Fatalf("the plugin should name itself, got %v", said["name"])
	}
	if said["version"] != "0.1.0" {
		t.Fatalf("the plugin should answer the version in its manifest, got %v", said["version"])
	}
}

func TestHandshakeOfAnotherProtocol(t *testing.T) {
	h := startHarness(t, workspaceInfo{ID: "w1", Folder: t.TempDir()}, false)
	_, failure := h.call("initialize", map[string]any{"protocolVersion": 2})
	if failure == nil {
		t.Fatalf("a host speaking another protocol should be refused")
	}
	if failure.Code != pluginUnavailable {
		t.Fatalf("a protocol mismatch is -32000, got %d: %s", failure.Code, failure.Message)
	}
	if !strings.Contains(failure.Message, "protocol 1") {
		t.Fatalf("the refusal should say which protocol this plugin speaks: %s", failure.Message)
	}
}

func TestVisualRequestBeforeTheHandshake(t *testing.T) {
	h := startHarness(t, workspaceInfo{ID: "w1", Folder: t.TempDir()}, false)
	_, failure := h.call("visual.request", map[string]any{"workspace": "w1", "method": "history"})
	if failure == nil || failure.Code != invalidRequest {
		t.Fatalf("a call before initialize should be refused with -32600, got %+v", failure)
	}
}

func TestUnknownMethod(t *testing.T) {
	h := startHarness(t, workspaceInfo{ID: "w1", Folder: t.TempDir()}, false)
	if _, failure := h.call("initialize", map[string]any{"protocolVersion": 1}); failure != nil {
		t.Fatalf("initialize: %+v", failure)
	}
	_, failure := h.call("visual.paint", map[string]any{"workspace": "w1"})
	if failure == nil || failure.Code != methodNotFound {
		t.Fatalf("a method this plugin does not answer should be -32601, got %+v", failure)
	}
	_, failure = h.call("visual.request", map[string]any{"workspace": "w1", "method": "nope"})
	if failure == nil || failure.Code != methodNotFound {
		t.Fatalf("a visual method this plugin does not answer should be -32601, got %+v", failure)
	}
}

func TestAFrameThatIsNotJSON(t *testing.T) {
	h := startHarness(t, workspaceInfo{ID: "w1", Folder: t.TempDir()}, false)
	// A parse error names no id, so it is answered with an id-less refusal and the pipe stays up.
	h.raw("this is not json\n")
	if _, failure := h.call("initialize", map[string]any{"protocolVersion": 1}); failure != nil {
		t.Fatalf("the pipe should still answer after a frame that is not JSON: %+v", failure)
	}
}

func TestAnOverlongFrameIsDroppedAndThePipeStaysUp(t *testing.T) {
	h := startHarness(t, workspaceInfo{ID: "w1", Folder: t.TempDir()}, false)
	if _, failure := h.call("initialize", map[string]any{"protocolVersion": 1}); failure != nil {
		t.Fatalf("initialize: %+v", failure)
	}
	h.raw(strings.Repeat("x", maxFrameBytes+10) + "\n")
	if _, failure := h.call("initialize", map[string]any{"protocolVersion": 1}); failure != nil {
		t.Fatalf("the pipe should still answer after an overlong frame: %+v", failure)
	}
}

func TestUnknownWorkspace(t *testing.T) {
	h := startHarness(t, workspaceInfo{ID: "w1", Name: "project", Folder: t.TempDir()}, false)
	if _, failure := h.call("initialize", map[string]any{"protocolVersion": 1}); failure != nil {
		t.Fatalf("initialize: %+v", failure)
	}
	_, failure := h.call("visual.request", map[string]any{"workspace": "not-a-workspace", "method": "history"})
	if failure == nil || failure.Code != invalidParams {
		t.Fatalf("a workspace the daemon does not know should be -32602, got %+v", failure)
	}
}

func TestTheViewIsAskedOnTheWire(t *testing.T) {
	folder := newRepo(t)
	first := commitFile(t, folder, "a.txt", "one\n", "first")
	second := commitFile(t, folder, "a.txt", "two\n", "second")
	h := startHarness(t, workspaceInfo{ID: "w1", Name: "project", Folder: folder}, true)
	if _, failure := h.call("initialize", map[string]any{"protocolVersion": 1}); failure != nil {
		t.Fatalf("initialize: %+v", failure)
	}

	// A page, which needs only the folder.
	rows, failure := h.call("visual.request", map[string]any{"workspace": "w1", "method": "history", "params": map[string]any{"limit": 10}})
	if failure != nil {
		t.Fatalf("history: %+v", failure)
	}
	var graph history
	if err := json.Unmarshal(rows, &graph); err != nil {
		t.Fatalf("history is not a history: %v", err)
	}
	if len(graph.Rows) != 2 || graph.Rows[0].SHA != second {
		t.Fatalf("history should hold both commits newest first, got %+v", graph.Rows)
	}

	// The header, which is the one method that reads the board.
	header, failure := h.call("visual.request", map[string]any{"workspace": "w1", "method": "summary"})
	if failure != nil {
		t.Fatalf("summary: %+v", failure)
	}
	var brief summary
	if err := json.Unmarshal(header, &brief); err != nil {
		t.Fatalf("summary is not a summary: %v", err)
	}
	if !brief.Open || brief.Cards != 1 || brief.Workspace.Name != "project" {
		t.Fatalf("summary should carry the board: %+v", brief)
	}
	if brief.Repo.Head != second || brief.Repo.Branch != "main" {
		t.Fatalf("summary should carry HEAD: %+v", brief.Repo)
	}

	detail, failure := h.call("visual.request", map[string]any{"workspace": "w1", "method": "commit", "params": map[string]any{"sha": first}})
	if failure != nil {
		t.Fatalf("commit: %+v", failure)
	}
	var read commitDetail
	if err := json.Unmarshal(detail, &read); err != nil {
		t.Fatalf("commit is not a commit: %v", err)
	}
	if read.SHA != first || len(read.Files) != 1 {
		t.Fatalf("commit should hold the first commit and its file, got %+v", read)
	}

	patch, failure := h.call("visual.request", map[string]any{"workspace": "w1", "method": "diff", "params": map[string]any{"sha": second, "path": "a.txt"}})
	if failure != nil {
		t.Fatalf("diff: %+v", failure)
	}
	var diff diffAnswer
	if err := json.Unmarshal(patch, &diff); err != nil {
		t.Fatalf("diff is not a diff: %v", err)
	}
	if diff.Added != 1 || diff.Removed != 1 {
		t.Fatalf("the second commit changed one line each way, got %d and %d:\n%s", diff.Added, diff.Removed, diff.Patch)
	}

	// The daemon was asked for the workspace once and then remembered it, which is the cache working.
	h.mu.Lock()
	calls := append([]string{}, h.hostCalls...)
	h.mu.Unlock()
	if len(calls) != 2 || calls[0] != "workspace.list" || calls[1] != "workspace.read" {
		t.Fatalf("history reads the list and summary reads the board, then the folder is remembered, got %v", calls)
	}
}

func TestTwoRequestsOneWaitingOnTheHost(t *testing.T) {
	folder := newRepo(t)
	commitFile(t, folder, "a.txt", "one\n", "first")
	commitFile(t, folder, "a.txt", "two\n", "second")
	h := startHarness(t, workspaceInfo{ID: "w1", Name: "project", Folder: folder}, false)
	if _, failure := h.call("initialize", map[string]any{"protocolVersion": 1}); failure != nil {
		t.Fatalf("initialize: %+v", failure)
	}

	// From here the host holds every workspace answer. If the plugin handled requests one at a time, the
	// second request would never be read and this test would wait for its answer until it timed out.
	h.mu.Lock()
	h.holdList = true
	h.mu.Unlock()
	first := h.start("visual.request", map[string]any{"workspace": "w1", "method": "history", "params": map[string]any{"limit": 5}})
	second := h.start("visual.request", map[string]any{"workspace": "w1", "method": "history", "params": map[string]any{"offset": 1, "limit": 5}})
	for seen := 0; seen < 2; seen++ {
		select {
		case <-h.listSeen:
		case <-time.After(10 * time.Second):
			t.Fatalf("only %d of two requests reached the host at once", seen)
		}
	}
	close(h.listAnswer)
	for name, answer := range map[string]chan frame{"first": first, "second": second} {
		select {
		case got := <-answer:
			if got.Error != nil {
				t.Fatalf("%s was refused: %+v", name, got.Error)
			}
		case <-time.After(20 * time.Second):
			t.Fatalf("%s never came back", name)
		}
	}
}

func TestAssetsAreNamedRelativeToTheExecutable(t *testing.T) {
	h := startHarness(t, workspaceInfo{ID: "w1", Folder: t.TempDir()}, false)
	if _, failure := h.call("initialize", map[string]any{"protocolVersion": 1}); failure != nil {
		t.Fatalf("initialize: %+v", failure)
	}
	answer, failure := h.call("visual.request", map[string]any{"workspace": "", "method": "assets"})
	if failure != nil {
		t.Fatalf("assets: %+v", failure)
	}
	var list assetList
	if err := json.Unmarshal(answer, &list); err != nil {
		t.Fatalf("assets is not a list: %v", err)
	}
	if list.Entry != "assets/history.html" {
		t.Fatalf("the entry should be the page the manifest names, got %q", list.Entry)
	}
	if len(list.Files) != 3 {
		t.Fatalf("the view is a page, a stylesheet and a script, got %+v", list.Files)
	}
	// The test runs in the package folder, which holds the same files the manifest names.
	for _, file := range list.Files {
		if strings.HasPrefix(file.Path, "/") {
			t.Fatalf("an asset path must be relative to the executable, got %q", file.Path)
		}
		if !file.Has {
			t.Fatalf("the manifest names %q, which is not in the plugin folder", file.Path)
		}
	}
}

func TestManifestPathThatLeavesTheFolder(t *testing.T) {
	for _, bad := range []string{"", "/etc/passwd", "../outside.html", "assets/../../outside.html", "a\\b"} {
		if insideFolder(bad) {
			t.Fatalf("%q should not be a path inside the plugin folder", bad)
		}
	}
	for _, good := range []string{"assets/history.html", "history.css", "./assets/x.js"} {
		if !insideFolder(good) {
			t.Fatalf("%q should be a path inside the plugin folder", good)
		}
	}
}

func TestAnAnswerOverTheFrameLimitIsRefused(t *testing.T) {
	writer := &frameWriter{w: io.Discard}
	err := writer.send(map[string]any{"patch": strings.Repeat("x", maxFrameBytes+1)})
	if err == nil {
		t.Fatalf("an answer over the megabyte frame limit should be refused")
	}
	var refusal *rpcError
	if !errors.As(err, &refusal) || refusal.Code != internalError {
		t.Fatalf("an oversized answer is an internal error, got %v", err)
	}
}
