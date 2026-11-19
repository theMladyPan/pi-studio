// The view as the board's host serves it: what `plugin.json` declares, and the words the page speaks.
//
// A panel runs in a frame sandboxed with `allow-scripts` and no origin of its own, so its side of the
// bridge cannot be run here. What can be checked is what it says: the exact message types the board
// answers, the frame it talks to, and the way it asks for its own script: a page served without a CORS
// header and left with an opaque origin cannot load a module, so the page loads a classic script.
package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

// The panel the daemon's registry reads: a title, the entry document, and every file it may serve, all
// relative to the folder the executable sits in.
type registeredPanel struct {
	Title string   `json:"title"`
	Entry string   `json:"entry"`
	Files []string `json:"files"`
}

// TestPluginManifestIsTheRegistrationTheDaemonReads pins the manifest's panel to the registration's shape,
// because the registration is written by hand from this file and a shape it does not read is a panel the
// board never offers.
func TestPluginManifestIsTheRegistrationTheDaemonReads(t *testing.T) {
	raw, err := os.ReadFile(manifestFile)
	if err != nil {
		t.Fatalf("%s cannot be read: %s", manifestFile, err)
	}
	var document struct {
		Visual map[string]json.RawMessage `json:"visual"`
	}
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatalf("%s is not JSON: %s", manifestFile, err)
	}
	if document.Visual == nil {
		t.Fatalf("%s declares no visual panel", manifestFile)
	}
	keys := make([]string, 0, len(document.Visual))
	for key := range document.Visual {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	if strings.Join(keys, ",") != "entry,files,title" {
		t.Fatalf("the panel must be { title, entry, files }, got %v", keys)
	}
	panel, err := registeredPanelOf(raw)
	if err != nil {
		t.Fatalf("%s: %s", manifestFile, err)
	}
	if panel.Title == "" || len(panel.Title) > 80 {
		t.Fatalf("the title is one line of 1 to 80 characters, got %q", panel.Title)
	}
	if panel.Entry != "assets/history.html" {
		t.Fatalf("the entry should be the history page, got %q", panel.Entry)
	}
	if !slices.Contains(panel.Files, panel.Entry) {
		t.Fatalf("the entry has to be one of the files, got %v", panel.Files)
	}
	for _, file := range panel.Files {
		if !insideFolder(file) {
			t.Fatalf("%q is not a file inside the plugin folder", file)
		}
		// The tests run in the package folder, which is where the executable is built.
		if info, err := os.Stat(filepath.FromSlash(file)); err != nil || !info.Mode().IsRegular() {
			t.Fatalf("%q is declared and is not a file in the plugin folder", file)
		}
	}
}

// TestThePageSpeaksTheBoardsOwnWords pins the page to the board's bridge: the names and shapes the board
// posts and answers, and nothing invented beside them.
func TestThePageSpeaksTheBoardsOwnWords(t *testing.T) {
	script, err := os.ReadFile(filepath.Join("assets", "history.js"))
	if err != nil {
		t.Fatalf("the page's script cannot be read: %s", err)
	}
	page := string(script)
	for _, said := range []string{
		"pi-studio.host.hello",
		"pi-studio.visual.request",
		"pi-studio.visual.result",
		"pi-studio.visual.error",
		"pi-studio.visual.close",
	} {
		if !strings.Contains(page, `"`+said+`"`) {
			t.Fatalf("the page never says %q, which is what the board answers", said)
		}
	}
	if strings.Contains(page, "pi-plugin:") {
		t.Fatalf("the page still speaks a bridge the board does not have")
	}
	if !strings.Contains(page, "window.parent.postMessage") {
		t.Fatalf("the page has to answer the board above it, which is window.parent")
	}
	// The board wonders which frame a message came from, and so does the page: only the frame above it is
	// the board, and the sandbox is what keeps another frame from being that window.
	if !strings.Contains(page, "event.source !== window.parent") {
		t.Fatalf("the page has to refuse a message from any frame but the board above it")
	}
}

// TestThePageLoadsAClassicScript is the one asset rule the frame imposes: a document with an opaque origin
// loads a module script with a CORS request, and the daemon serves a panel's files with no CORS header.
func TestThePageLoadsAClassicScript(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("assets", "history.html"))
	if err != nil {
		t.Fatalf("the page cannot be read: %s", err)
	}
	page := string(raw)
	if !strings.Contains(page, `src="history.js"`) {
		t.Fatalf("the page must load history.js next to it, so the entry and its script resolve inside the served files")
	}
	if strings.Contains(page, "type=\"module\"") {
		t.Fatalf("the page must not load a module: the frame's opaque origin makes that a CORS request the daemon refuses")
	}
}

// registeredPanelOf reads the panel out of a manifest document, the way the daemon reads the registration.
func registeredPanelOf(raw []byte) (registeredPanel, error) {
	var document struct {
		Visual registeredPanel `json:"visual"`
	}
	err := json.Unmarshal(raw, &document)
	return document.Visual, err
}
