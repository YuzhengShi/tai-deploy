package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"testing/quick"
	"time"
)

// A test that uses what a course's tests use (a handler, goroutines, a timeout), so that `go test` and `go test -race` compile the test binary's own packages.
func TestWarm(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(204) }))
	defer srv.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var wg sync.WaitGroup
	var mu sync.Mutex
	n := 0
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			mu.Lock()
			n++
			mu.Unlock()
		}()
	}
	wg.Wait()
	if n != 4 || ctx.Err() != nil {
		t.Fatal("unexpected")
	}
	if err := quick.Check(func(a, b int) bool { return a+b == b+a }, nil); err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL, nil)
	if res, err := http.DefaultClient.Do(req); err != nil || res.StatusCode != 204 {
		t.Fatal("handler", err)
	} else {
		res.Body.Close()
	}
}
