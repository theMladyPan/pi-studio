// The line protocol a plugin speaks with the daemon, and the calls it makes back.
//
// Both directions carry one JSON-RPC 2.0 message per LF-terminated line. A line is the frame because a
// pipe has no boundaries of its own; LF is the boundary because every language can write one. A frame
// larger than a megabyte is dropped rather than buffered: the other end would drop it too, and nothing
// that big is a request anybody meant to make.
//
// The read loop never runs a handler itself. Each request becomes a goroutine, so a handler waiting on a
// call back to the host cannot stop this end from reading the answer to it. That is the whole reason
// the loop is separate: a plugin that asked the host for a workspace and handled calls inline would
// deadlock the moment the host answered.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

const (
	// protocolVersion is the only version this plugin speaks, and the one it names in initialize.
	protocolVersion = 1

	// maxFrameBytes is how large one frame may be, in bytes of the line without its LF.
	maxFrameBytes = 1024 * 1024

	parseError        = -32700
	invalidRequest    = -32600
	methodNotFound    = -32601
	invalidParams     = -32602
	internalError     = -32603
	pluginUnavailable = -32000
)

// frame is one message on the wire. A request carries Method; a response carries ID and one of
// Result or Error. RawMessage keeps an id exactly as the other end wrote it, number or string alike.
type frame struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// rpcError is a refusal in the shape every JSON-RPC client reads.
type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    any    `json:"data,omitempty"`
}

func (e *rpcError) Error() string { return e.Message }

// failf builds a refusal with the code the daemon decides what to do with.
func failf(code int, format string, args ...any) *rpcError {
	return &rpcError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// errFrameTooLong says one incoming line passed the limit and was thrown away.
var errFrameTooLong = errors.New("frame is longer than the megabyte limit")

// lineReader reads LF-terminated frames, refusing to keep one that grows past the limit.
type lineReader struct {
	reader *bufio.Reader
	limit  int
}

func newLineReader(r io.Reader) *lineReader {
	return &lineReader{reader: bufio.NewReaderSize(r, 64*1024), limit: maxFrameBytes}
}

// next returns one frame without its LF. A frame over the limit is discarded up to its LF and
// reported as errFrameTooLong, which the caller answers and then keeps reading.
func (l *lineReader) next() ([]byte, error) {
	var line []byte
	for {
		chunk, err := l.reader.ReadSlice('\n')
		if len(line)+len(chunk) > l.limit {
			// Keep draining to the LF so the next frame starts on a boundary, then report it.
			for err == bufio.ErrBufferFull {
				_, err = l.reader.ReadSlice('\n')
			}
			if err != nil && err != io.EOF {
				return nil, err
			}
			return nil, errFrameTooLong
		}
		line = append(line, chunk...)
		if err == bufio.ErrBufferFull {
			continue
		}
		if err != nil {
			if len(line) > 0 && errors.Is(err, io.EOF) {
				return trimLF(line), nil
			}
			return nil, err
		}
		return trimLF(line), nil
	}
}

// trimLF drops the frame boundary and the one CR a Windows writer leaves before it.
func trimLF(line []byte) []byte {
	if n := len(line); n > 0 && line[n-1] == '\n' {
		line = line[:n-1]
	}
	if n := len(line); n > 0 && line[n-1] == '\r' {
		line = line[:n-1]
	}
	return line
}

// frameWriter writes one frame at a time, so two handlers answering at once cannot interleave bytes.
type frameWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (f *frameWriter) send(v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(data) > maxFrameBytes {
		return failf(internalError, "the answer of %d bytes is over the %d byte frame limit", len(data), maxFrameBytes)
	}
	data = append(data, '\n')
	f.mu.Lock()
	defer f.mu.Unlock()
	_, err = f.w.Write(data)
	return err
}

// result answers a call this end was given.
func (f *frameWriter) result(id json.RawMessage, result any) error {
	return f.send(frame{JSONRPC: "2.0", ID: id, Result: result})
}

// refuse answers a call this end was given with the reason it was not answered.
func (f *frameWriter) refuse(id json.RawMessage, failure *rpcError) error {
	return f.send(frame{JSONRPC: "2.0", ID: id, Error: failure})
}

// pendingCall is one call waiting for the host's answer, with the clock that gives up on it.
type pendingCall struct {
	answer  chan frame
	timeout *time.Timer
}

// hostCaller makes calls of the host over the same pipe, by id, without blocking the read loop.
type hostCaller struct {
	writer  *frameWriter
	timeout time.Duration

	mu     sync.Mutex
	nextID int64
	open   map[string]*pendingCall
	closed bool
}

func newHostCaller(writer *frameWriter, timeout time.Duration) *hostCaller {
	return &hostCaller{writer: writer, timeout: timeout, open: make(map[string]*pendingCall)}
}

// call asks the host for one thing and waits for the answer with the same id, or for the deadline.
func (h *hostCaller) call(method string, params any) (json.RawMessage, error) {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return nil, failf(pluginUnavailable, "the host connection is closed")
	}
	h.nextID++
	id := h.nextID
	key := fmt.Sprintf("%d", id)
	waiter := &pendingCall{answer: make(chan frame, 1)}
	waiter.timeout = time.AfterFunc(h.timeout, func() {
		h.mu.Lock()
		delete(h.open, key)
		h.mu.Unlock()
		waiter.answer <- frame{Error: failf(pluginUnavailable, "the host did not answer %s in time", method)}
	})
	h.open[key] = waiter
	h.mu.Unlock()

	raw := json.RawMessage(fmt.Sprintf("%d", id))
	if err := h.writer.send(frame{JSONRPC: "2.0", ID: raw, Method: method, Params: mustMarshal(params)}); err != nil {
		h.forget(key)
		return nil, err
	}
	answer := <-waiter.answer
	waiter.timeout.Stop()
	if answer.Error != nil {
		return nil, answer.Error
	}
	return mustMarshal(answer.Result), nil
}

// deliver hands the host's answer to the call that is waiting for it. An answer to a call already
// given up on is dropped, because the deadline has already told its caller what happened.
func (h *hostCaller) deliver(f frame) {
	key := string(f.ID)
	h.mu.Lock()
	waiter := h.open[key]
	delete(h.open, key)
	h.mu.Unlock()
	if waiter == nil {
		return
	}
	select {
	case waiter.answer <- f:
	default:
	}
}

func (h *hostCaller) forget(key string) {
	h.mu.Lock()
	waiter := h.open[key]
	delete(h.open, key)
	h.mu.Unlock()
	if waiter != nil {
		waiter.timeout.Stop()
	}
}

// shutdown is the host going away: every call still waiting is told instead of waiting out its clock.
func (h *hostCaller) shutdown() {
	h.mu.Lock()
	waiting := h.open
	h.open = make(map[string]*pendingCall)
	h.closed = true
	h.mu.Unlock()
	for _, waiter := range waiting {
		waiter.timeout.Stop()
		select {
		case waiter.answer <- frame{Error: failf(pluginUnavailable, "the host connection closed")}:
		default:
		}
	}
}

// mustMarshal marshals a value this end already knows how to write.
func mustMarshal(v any) json.RawMessage {
	if v == nil {
		return nil
	}
	data, err := json.Marshal(v)
	if err != nil {
		return nil
	}
	return data
}
