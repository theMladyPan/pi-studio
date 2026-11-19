// The workspace a request names, answered by the daemon rather than by the request.
//
// A visual asks about a workspace by the id the host gave it. That id is turned into a folder here, by
// asking the daemon, so nothing a browser sends can name a path on this machine and this plugin never
// holds a folder the daemon would not have shown. A folder is kept for a few seconds after the daemon
// names it, which is long enough for the page of a graph and short enough that a workspace moved by the
// human is not read from the old place for long.
//
// `workspace.list` answers the id and the folder without reading a board, and it is what a request that
// only needs the folder uses. `workspace.read` reads the board too, and is used only where the answer
// says something about the board.
package main

import (
	"context"
	"encoding/json"
	"sync"
	"time"
)

// how long a folder the daemon named is used before the daemon is asked again.
const workspaceCacheTTL = 5 * time.Second

// how long the daemon has to answer one call from this plugin. It is shorter than the daemon's own
// deadline for a plugin, so a slow daemon is told about the wait rather than this end going quiet.
const hostCallTimeout = 10 * time.Second

// workspaceInfo is one workspace as the daemon describes it.
type workspaceInfo struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Folder  string `json:"folder"`
	Missing bool   `json:"missing"`
	Scratch bool   `json:"scratch"`
}

// workspaceRead is what `workspace.read` says about a workspace: where it is, whether its board is open,
// and the cards the board holds.
type workspaceRead struct {
	Workspace workspaceInfo     `json:"workspace"`
	Open      bool              `json:"open"`
	Cards     []json.RawMessage `json:"cards"`
}

type cachedFolder struct {
	folder string
	at     time.Time
}

// workspaces turns a workspace id into a folder, asking the daemon and remembering the answer briefly.
type workspaces struct {
	host  *hostCaller
	mu    sync.Mutex
	cache map[string]cachedFolder
	now   func() time.Time
}

func newWorkspaces(host *hostCaller) *workspaces {
	return &workspaces{host: host, cache: make(map[string]cachedFolder), now: time.Now}
}

// folder is the folder the daemon says a workspace is in, refusing an id the daemon does not know and a
// folder the daemon itself reports as missing.
func (w *workspaces) folder(ctx context.Context, id string) (workspaceInfo, error) {
	if id == "" {
		return workspaceInfo{}, failf(invalidParams, "workspace must be the id of a workspace the daemon knows")
	}
	w.mu.Lock()
	known, cached := w.cache[id]
	w.mu.Unlock()
	if cached && w.now().Sub(known.at) < workspaceCacheTTL {
		return workspaceInfo{ID: id, Folder: known.folder}, nil
	}
	answer, err := w.host.call("workspace.list", struct{}{})
	if err != nil {
		return workspaceInfo{}, err
	}
	var listed struct {
		Workspaces []workspaceInfo `json:"workspaces"`
	}
	if err := json.Unmarshal(answer, &listed); err != nil {
		return workspaceInfo{}, failf(pluginUnavailable, "the daemon's workspace list could not be read: %s", errText(err))
	}
	for _, workspace := range listed.Workspaces {
		if workspace.ID != id {
			continue
		}
		if workspace.Missing || workspace.Folder == "" {
			return workspaceInfo{}, failf(invalidParams, "the folder of workspace %s is missing", id)
		}
		w.mu.Lock()
		w.cache[id] = cachedFolder{folder: workspace.Folder, at: w.now()}
		w.mu.Unlock()
		return workspace, nil
	}
	_ = ctx
	return workspaceInfo{}, failf(invalidParams, "%s is not a workspace the daemon knows", id)
}

// read is the workspace with its board: what `workspace.read` answers, for the one method that says
// something about the board itself.
func (w *workspaces) read(ctx context.Context, id string) (workspaceRead, error) {
	if id == "" {
		return workspaceRead{}, failf(invalidParams, "workspace must be the id of a workspace the daemon knows")
	}
	_ = ctx
	answer, err := w.host.call("workspace.read", map[string]string{"workspace": id})
	if err != nil {
		return workspaceRead{}, err
	}
	var read workspaceRead
	if err := json.Unmarshal(answer, &read); err != nil {
		return workspaceRead{}, failf(pluginUnavailable, "the daemon's workspace could not be read: %s", errText(err))
	}
	if read.Workspace.Folder == "" || read.Workspace.Missing {
		return workspaceRead{}, failf(invalidParams, "the folder of workspace %s is missing", id)
	}
	w.mu.Lock()
	w.cache[id] = cachedFolder{folder: read.Workspace.Folder, at: w.now()}
	w.mu.Unlock()
	return read, nil
}
