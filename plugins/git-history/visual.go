// What the view on the board asks this plugin, in the words it asks it.
//
// The daemon calls `visual.request` with the workspace, the method and the params the view sent, and the
// answer goes back up the same pipe. The methods are the view's own vocabulary: the graph's header, a
// page of rows, one commit, one file's patch, and the files this plugin's view is made of.
//
//	summary  {}                                   the workspace, its board, and where HEAD points
//	history  { offset?, limit? }                  a page of rows, with the lanes they are drawn in
//	commit   { sha }                              one commit, its message and the files it changed
//	diff     { sha, path, context? }              one file's patch against the commit's first parent
//	assets   {}                                   the visual files, relative to this executable
package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// The method names the view and the daemon call. They are constants so a typo is a compile error here
// rather than a method the view silently never gets an answer for.
const (
	initializeMethod    = "initialize"
	visualRequestMethod = "visual.request"
	shutdownMethod      = "shutdown"

	methodSummary = "summary"
	methodHistory = "history"
	methodCommit  = "commit"
	methodDiff    = "diff"
	methodAssets  = "assets"
)

// visualAsk is the params of one `visual.request`: the workspace, the method, and that method's params.
type visualAsk struct {
	Workspace string          `json:"workspace"`
	Method    string          `json:"method"`
	Params    json.RawMessage `json:"params"`
}

// summary is the header of the view: which workspace this is, whether its board is open, and the
// repository the folder holds.
type summary struct {
	Workspace workspaceInfo `json:"workspace"`
	Open      bool          `json:"open"`
	Cards     int           `json:"cards"`
	Repo      repoInfo      `json:"repo"`
}

// asset is one file the panel is made of, as a host needs it: a path relative to this executable and
// whether it is really there.
type asset struct {
	Path string `json:"path"`
	Has  bool   `json:"has"`
}

// assetList is the answer to `assets`: the panel's files, so whoever serves them can check them without
// guessing. The daemon that runs this plugin serves the files its registration names, and `plugin.json`
// declares those in the registration's own words.
type assetList struct {
	Root  string  `json:"root"`
	Entry string  `json:"entry"`
	Files []asset `json:"files"`
}

// view answers one method the view asked for. Everything it needs from the daemon goes out through the
// workspace resolver, so nothing here trusts the request with a path.
func (p *plugin) view(ctx context.Context, ask visualAsk) (any, error) {
	switch ask.Method {
	case methodAssets:
		return p.assets(), nil
	case methodSummary:
		read, err := p.workspaces.read(ctx, ask.Workspace)
		if err != nil {
			return nil, err
		}
		answer := summary{Workspace: read.Workspace, Open: read.Open, Cards: len(read.Cards)}
		found, err := openRepo(ctx, read.Workspace.Folder)
		if err != nil {
			return nil, err
		}
		answer.Repo = describeRepo(found)
		if branches, tags, err := countRefs(ctx, found.root); err == nil {
			answer.Repo.Branches, answer.Repo.Tags = branches, tags
		}
		return answer, nil
	case methodHistory:
		found, err := p.repoFor(ctx, ask.Workspace)
		if err != nil {
			return nil, err
		}
		offset, limit, err := pageParams(ask.Params)
		if err != nil {
			return nil, err
		}
		return readHistory(ctx, found, offset, limit)
	case methodCommit:
		found, err := p.repoFor(ctx, ask.Workspace)
		if err != nil {
			return nil, err
		}
		var want struct {
			SHA string `json:"sha"`
		}
		if err := asJSON(ask.Params, &want); err != nil {
			return nil, failf(invalidParams, "commit needs a sha")
		}
		return readCommit(ctx, found, want.SHA)
	case methodDiff:
		found, err := p.repoFor(ctx, ask.Workspace)
		if err != nil {
			return nil, err
		}
		var want struct {
			SHA     string `json:"sha"`
			Path    string `json:"path"`
			Context *int   `json:"context"`
		}
		if err := asJSON(ask.Params, &want); err != nil {
			return nil, failf(invalidParams, "diff needs a sha and a path")
		}
		lines := 3
		if want.Context != nil {
			lines = *want.Context
		}
		return readDiff(ctx, found, want.SHA, want.Path, lines)
	default:
		return nil, failf(methodNotFound, "%s is not a method this plugin answers; it answers %s",
			ask.Method, strings.Join([]string{methodSummary, methodHistory, methodCommit, methodDiff, methodAssets}, ", "))
	}
}

// repoFor resolves a workspace to the repository it points at.
func (p *plugin) repoFor(ctx context.Context, workspace string) (repo, error) {
	known, err := p.workspaces.folder(ctx, workspace)
	if err != nil {
		return repo{}, err
	}
	return openRepo(ctx, known.Folder)
}

// assets is what this plugin's panel is made of. A host serves the files from the paths named here, all of
// them relative to the executable, so a plugin installed anywhere finds its own files.
func (p *plugin) assets() assetList {
	list := assetList{Root: p.root, Files: []asset{}}
	if p.manifest.Visual == nil {
		return list
	}
	list.Entry = p.manifest.Visual.Entry
	for _, file := range p.manifest.Visual.Files {
		list.Files = append(list.Files, p.describeAsset(file))
	}
	return list
}

func (p *plugin) describeAsset(path string) asset {
	_, err := os.Stat(filepath.Join(p.root, filepath.FromSlash(path)))
	return asset{Path: path, Has: err == nil}
}
