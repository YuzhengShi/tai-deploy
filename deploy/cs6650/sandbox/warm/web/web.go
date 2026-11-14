// Package warmweb is never run: it imports what a Gin homework imports, so that the Dockerfile compiles those packages (with and without -race) into the image build cache.
// What a run compiles from nothing it compiles in memory it does not have: Gin with its dependencies needs about 1.4 GB the first time, the sandbox gives 512 MB.
package warmweb

import (
	_ "github.com/gin-gonic/gin"
	_ "github.com/google/uuid"
	_ "github.com/gorilla/mux"
	_ "github.com/stretchr/testify/assert"
	_ "github.com/stretchr/testify/mock"
	_ "github.com/stretchr/testify/require"
	_ "github.com/stretchr/testify/suite"
	_ "golang.org/x/sync/errgroup"
	_ "golang.org/x/sync/semaphore"
)
