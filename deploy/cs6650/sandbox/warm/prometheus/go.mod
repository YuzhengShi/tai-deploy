// Part of what `tai_live.sh sandbox warm` puts in the shared module cache and the Dockerfile compiles into the image's build cache (docs/GO_SANDBOX.md): a project that has
// only this library in it, as `go mod tidy` makes it. One module for each library on purpose: the versions of what libraries share (x/net, x/sys, protobuf) depend on what else
// is required, and the compiled form of a package is only reused for the very same versions. To change the list: edit the requirements here, run `go mod tidy` in a throwaway container.
module warmprometheus

go 1.27

require github.com/prometheus/client_golang v1.25.0

require (
	github.com/beorn7/perks v1.0.1 // indirect
	github.com/cespare/xxhash/v2 v2.3.0 // indirect
	github.com/munnerz/goautoneg v0.0.0-20191010083416-a7dc8b61c822 // indirect
	github.com/prometheus/client_model v0.6.3 // indirect
	github.com/prometheus/common v0.72.0 // indirect
	github.com/prometheus/procfs v0.22.0 // indirect
	golang.org/x/sys v0.48.0 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
)
