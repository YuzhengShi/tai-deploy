// Part of what `tai_live.sh sandbox warm` puts in the shared module cache and the Dockerfile compiles into the image's build cache (docs/GO_SANDBOX.md): a project that has
// only this library in it, as `go mod tidy` makes it. One module for each library on purpose: the versions of what libraries share (x/net, x/sys, protobuf) depend on what else
// is required, and the compiled form of a package is only reused for the very same versions. To change the list: edit the requirements here, run `go mod tidy` in a throwaway container.
module warmredis

go 1.27

require github.com/redis/go-redis/v9 v9.23.0

require (
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	go.uber.org/atomic v1.12.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
)
