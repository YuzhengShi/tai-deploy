// Part of what `tai_live.sh sandbox warm` puts in the shared module cache and the Dockerfile compiles into the image's build cache (docs/GO_SANDBOX.md): a project that has
// only this library in it, as `go mod tidy` makes it. One module for each library on purpose: the versions of what libraries share (x/net, x/sys, protobuf) depend on what else
// is required, and the compiled form of a package is only reused for the very same versions. To change the list: edit the requirements here, run `go mod tidy` in a throwaway container.
module warmkafka

go 1.27

require github.com/segmentio/kafka-go v0.4.51

require (
	github.com/klauspost/compress v1.15.9 // indirect
	github.com/pierrec/lz4/v4 v4.1.15 // indirect
)
