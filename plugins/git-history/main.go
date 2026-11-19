// The plugin itself: one process, one pipe, and the frames it answers on it.
//
// The daemon starts this program with no shell, asks it to initialize, and from then on each
// `visual.request` is one thing the view on the board wants. Every request is answered on its own
// goroutine, because a request that needs the workspace has to call the daemon back through the same
// pipe, and a handler that blocked the read loop would wait for an answer nobody could read.
//
// Nothing here writes to a repository. Git is run read-only, with fixed arguments, a deadline and a
// budget, so the worst a bad request costs is a slow refusal.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
)

// plugin is one running instance: where its files are, what it is called, and the pipe it answers on.
type plugin struct {
	manifest   manifest
	root       string
	writer     *frameWriter
	host       *hostCaller
	workspaces *workspaces

	mu          sync.Mutex
	initialized bool
}

func main() {
	if err := run(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintf(os.Stderr, "git-history: %s\n", errText(err))
		os.Exit(1)
	}
}

// run brings the plugin up and serves the pipe until the daemon goes away.
func run(in io.Reader, out io.Writer) error {
	root, err := executableFolder()
	if err != nil {
		return err
	}
	read, err := loadManifest(root)
	if err != nil {
		return err
	}
	writer := &frameWriter{w: out}
	host := newHostCaller(writer, hostCallTimeout)
	self := &plugin{
		manifest:   read,
		root:       root,
		writer:     writer,
		host:       host,
		workspaces: newWorkspaces(host),
	}
	return self.serve(in)
}

// serve reads frames until the pipe closes or the daemon says stop. A frame it cannot read is answered
// and the pipe stays up: a bad message is not a reason to lose the view.
func (p *plugin) serve(in io.Reader) error {
	reader := newLineReader(in)
	var handlers sync.WaitGroup
	defer handlers.Wait()
	for {
		line, err := reader.next()
		if errors.Is(err, errFrameTooLong) {
			// The overlong frame was dropped whole, so a parse error names no id and the next frame reads.
			_ = p.writer.refuse(nil, failf(parseError, "a frame longer than %d bytes was dropped", maxFrameBytes))
			continue
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var got frame
		if err := json.Unmarshal(line, &got); err != nil {
			_ = p.writer.refuse(nil, failf(parseError, "the frame is not JSON"))
			continue
		}
		if got.JSONRPC != "2.0" {
			_ = p.writer.refuse(idOrNil(got.ID), failf(invalidRequest, `every frame must say "jsonrpc": "2.0"`))
			continue
		}
		if got.Method != "" {
			if len(got.ID) == 0 {
				// A notification wants no answer. The one this plugin knows is the daemon leaving.
				if got.Method == shutdownMethod {
					p.host.shutdown()
					return nil
				}
				continue
			}
			handlers.Add(1)
			go func(call frame) {
				defer handlers.Done()
				p.answer(call)
			}(got)
			continue
		}
		if len(got.ID) == 0 {
			_ = p.writer.refuse(nil, failf(invalidRequest, "a frame is a request, a response or a notification"))
			continue
		}
		// An answer to a call this end made: hand it to whoever is waiting, or drop it if nobody is.
		p.host.deliver(got)
	}
}

// answer runs one request and writes its result or its refusal. A result too large for a frame is
// answered with the reason instead of being truncated, so the view is never shown half an answer.
func (p *plugin) answer(call frame) {
	var result any
	var failure *rpcError
	switch call.Method {
	case initializeMethod:
		result, failure = p.initialize(call.Params)
	case visualRequestMethod:
		result, failure = p.visual(call.Params)
	default:
		failure = failf(methodNotFound, "%s is not a method this plugin answers; it answers %s, %s",
			call.Method, initializeMethod, visualRequestMethod)
	}
	if failure != nil {
		_ = p.writer.refuse(idOrNil(call.ID), failure)
		return
	}
	if err := p.writer.result(idOrNil(call.ID), result); err != nil {
		var refusal *rpcError
		if errors.As(err, &refusal) {
			_ = p.writer.refuse(idOrNil(call.ID), refusal)
		}
	}
}

// initialize is the handshake: the daemon says which protocol it speaks, and this plugin answers with the
// same number or refuses. It also repeats the panel `plugin.json` declares, so a reader of the handshake
// sees what this plugin offers; the daemon serves a panel from its own registration, not from here.
func (p *plugin) initialize(params json.RawMessage) (any, *rpcError) {
	var ask struct {
		ProtocolVersion *int `json:"protocolVersion"`
	}
	if len(params) > 0 {
		if err := json.Unmarshal(params, &ask); err != nil {
			return nil, failf(invalidParams, "initialize params must be an object with a protocolVersion")
		}
	}
	if ask.ProtocolVersion == nil || *ask.ProtocolVersion != protocolVersion {
		spoke := "no protocol version"
		if ask.ProtocolVersion != nil {
			spoke = fmt.Sprintf("protocol %d", *ask.ProtocolVersion)
		}
		return nil, failf(pluginUnavailable, "the host asked with %s; this plugin speaks protocol %d", spoke, protocolVersion)
	}
	p.mu.Lock()
	p.initialized = true
	p.mu.Unlock()
	answer := map[string]any{
		"protocolVersion": protocolVersion,
		"name":            p.manifest.Name,
		"version":         p.manifest.Version,
	}
	if p.manifest.Visual != nil {
		answer["visual"] = p.manifest.Visual
	}
	return answer, nil
}

// visual runs one thing the view asked for. A request before the handshake is refused, because the view
// is not there yet and a workspace id means nothing until the daemon has said what it is.
func (p *plugin) visual(params json.RawMessage) (any, *rpcError) {
	p.mu.Lock()
	ready := p.initialized
	p.mu.Unlock()
	if !ready {
		return nil, failf(invalidRequest, "initialize must be asked before %s", visualRequestMethod)
	}
	var ask visualAsk
	if err := asJSON(params, &ask); err != nil {
		return nil, failf(invalidParams, "visual.request needs { workspace, method, params }")
	}
	if ask.Method == "" {
		return nil, failf(invalidParams, "visual.request needs a method")
	}
	// One request may take up to a walk and a patch; the deadline is the outside bound for the whole of
	// it, including the call back to the daemon for the workspace.
	ctx, cancel := context.WithTimeout(context.Background(), walkTimeout+2*hostCallTimeout)
	defer cancel()
	answer, err := p.view(ctx, ask)
	if err != nil {
		var refusal *rpcError
		if errors.As(err, &refusal) {
			return nil, refusal
		}
		return nil, failf(internalError, "%s failed: %s", ask.Method, errText(err))
	}
	return answer, nil
}

// idOrNil is the id a frame should be answered with, or nothing when it named none.
func idOrNil(id json.RawMessage) json.RawMessage {
	if len(id) == 0 || string(id) == "null" {
		return nil
	}
	return id
}
