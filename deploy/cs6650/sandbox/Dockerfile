# The image the sandbox runs a student's Go code in (docs/GO_SANDBOX.md). Built on the host by `tai_live.sh sandbox build`; never rebuilt by a deploy.
#
# Debian, not Alpine: `go test -race` needs cgo and gcc. The Go toolchain is the one in the image (GOTOOLCHAIN=local): a go.mod that wants a newer one is told
# so, nothing is downloaded. The scripts (sandbox-run, sandbox-modules) are the only things the host ever starts in it. No user is made: the host passes
# --user, and nothing in here is written at run time (the root file system is read-only).
#
# GO_IMAGE can name a mirror of the same official image (Docker Hub limits anonymous pulls per address and this host shares one):
#   docker build --build-arg GO_IMAGE=mirror.gcr.io/library/golang:1.27.3-bookworm ...
ARG GO_VERSION=1.27.3
ARG GO_IMAGE=golang:${GO_VERSION}-bookworm
FROM ${GO_IMAGE}

LABEL tai-sandbox-image="1"
ENV GOTOOLCHAIN=local GOTELEMETRY=off GOWORK=off CGO_ENABLED=1

# A build cache with the standard library AND the course's usual third-party packages compiled, built under the same settings a run has (cgo on, the same gcc and Go): a run
# links it into its own memory-backed cache (sandbox-run), so a hello world does not compile `fmt` and `runtime` from nothing on one CPU, and a Gin handler does not compile
# Gin, ugorji/go/codec and quic-go in the 512 MB it has (that takes about 1.4 GB). The third-party packages are those of the modules under warm/ (what `tai_live.sh sandbox
# warm` puts in the shared module cache): one module for each library, each as `go mod tidy` makes a project with only that library in it, because the versions of what
# libraries share depend on what else is required, and a compiled package is only reused for the very same versions. Their sources are downloaded here (trusted code, a network at
# build time) into /gomodcache, THE SAME PATH a run mounts the module cache at, because the directory a package sits in is part of the key of its compiled form. A run only hits
# for the versions of warm/*/go.mod; any other version of a module compiles when it is asked for (its dependencies still hit when they are the same versions). Built with at
# most two CPUs (the host runs other services) and one compile at a time for the third-party part (the biggest packages need over a gigabyte each). WARM=0 skips all of it (a
# build to measure what the cold times are).
ARG WARM=1
COPY warm-std /opt/warm-std
COPY warm /opt/warm
RUN set -eu; \
    if [ "$WARM" = 1 ]; then \
      export GOCACHE=/opt/gocache-warm GOPATH=/tmp/gopath HOME=/tmp GOMAXPROCS=2; \
      cd /opt/warm-std; \
      GOPROXY=off GOFLAGS='-mod=mod -buildvcs=false' nice -n 10 go build -p 2 -o /dev/null ./...; \
      GOPROXY=off GOFLAGS='-mod=mod -buildvcs=false' nice -n 10 go vet -p 2 ./...; \
      GOPROXY=off GOFLAGS='-mod=mod -buildvcs=false' nice -n 10 go test -p 2 -count=1 ./...; \
      GOPROXY=off GOFLAGS='-mod=mod -buildvcs=false' nice -n 10 go test -p 2 -race -count=1 ./...; \
      for d in /opt/warm/*/; do \
        cd "$d"; \
        GOMODCACHE=/gomodcache GOFLAGS=-mod=mod GOPROXY=https://proxy.golang.org GOSUMDB=sum.golang.org go mod download; \
        GOMODCACHE=/gomodcache GOPROXY=off GOSUMDB=off GOFLAGS='-mod=mod -buildvcs=false' GOVCS='*:off' nice -n 10 go build -p 1 -o /dev/null .; \
        if [ -e race ]; then \
          GOMODCACHE=/gomodcache GOPROXY=off GOSUMDB=off GOFLAGS='-mod=mod -buildvcs=false' GOVCS='*:off' nice -n 10 go build -p 1 -race -o /dev/null .; \
        fi; \
      done; \
      rm -f /opt/gocache-warm/trim.txt; \
      chmod -R a-w /opt/gocache-warm; \
    fi; \
    rm -rf /opt/warm-std /opt/warm /gomodcache /tmp/gopath

# The scripts come after the cache on purpose: a change to them rebuilds the last two steps, not the minutes of compiling above.
COPY sandbox-common sandbox-run sandbox-modules /usr/local/bin/
# (the files are LF in the repository; this makes a CRLF copy from a Windows checkout work all the same)
RUN sed -i 's/\r$//' /usr/local/bin/sandbox-common /usr/local/bin/sandbox-run /usr/local/bin/sandbox-modules \
 && chmod 0755 /usr/local/bin/sandbox-run /usr/local/bin/sandbox-modules \
 && chmod 0644 /usr/local/bin/sandbox-common
