// The manifest beside the executable: what this plugin is called, and which files make up its view.
//
// The view's files are named relative to the executable, never absolutely, so a plugin copied into
// another folder still finds its own view. A path that climbs out of the plugin's folder, or names an
// absolute one, is refused: the manifest is a list of this plugin's own files, and nothing else.
package main

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// manifestFile is the name of the file read from the folder the executable sits in.
const manifestFile = "plugin.json"

// manifest is the plugin's own description of itself, and the source of the version it answers with.
type manifest struct {
	Name     string          `json:"name"`
	Version  string          `json:"version"`
	Protocol int             `json:"protocol"`
	Visual   *visualManifest `json:"visual"`
}

// visualManifest names the files of the view. The entry is the page a host puts in a frame; the styles
// and scripts are the files it must also serve, kept apart from the page so the page needs no inline
// code and a host can cache them.
type visualManifest struct {
	Entry   string   `json:"entry"`
	Styles  []string `json:"styles"`
	Scripts []string `json:"scripts"`
}

// loadManifest reads the manifest from folder, which is the folder of the executable, and checks that
// every path it names stays inside that folder.
func loadManifest(folder string) (manifest, error) {
	data, err := os.ReadFile(filepath.Join(folder, manifestFile))
	if err != nil {
		return manifest{}, failf(internalError, "%s cannot be read: %s", manifestFile, errText(err))
	}
	var read manifest
	if err := json.Unmarshal(data, &read); err != nil {
		return manifest{}, failf(internalError, "%s is not JSON: %s", manifestFile, errText(err))
	}
	if read.Name == "" {
		read.Name = "git-history"
	}
	if read.Version == "" {
		read.Version = "0.0.0"
	}
	if read.Visual != nil {
		named := append([]string{read.Visual.Entry}, read.Visual.Styles...)
		named = append(named, read.Visual.Scripts...)
		for _, file := range named {
			if !insideFolder(file) {
				return manifest{}, failf(internalError, "%s names %q, which is not a file inside the plugin folder", manifestFile, file)
			}
		}
	}
	return read, nil
}

// insideFolder says whether a path the manifest wrote is a plain relative path that stays in the folder.
func insideFolder(file string) bool {
	if file == "" || strings.HasPrefix(file, "/") || strings.Contains(file, "\\") || strings.ContainsRune(file, 0) {
		return false
	}
	cleaned := path.Clean(file)
	return cleaned != "." && cleaned != ".." && !strings.HasPrefix(cleaned, "../")
}

// executableFolder is where the running program sits, which is the folder every manifest path is
// relative to.
func executableFolder() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", failf(internalError, "this plugin cannot find its own executable: %s", errText(err))
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		resolved = exe
	}
	return filepath.Dir(resolved), nil
}
