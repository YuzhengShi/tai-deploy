# Running a student's Go code (design, 2026-11-06)

The owner asked for it after a real call in which TAi said "I can't run Go here, I have no runtime" and the student asked it to run their code: "run it, show me the output". The TA's mock interview has "demonstrate
running code" in its format, and the course is a Go course (concurrency, vector clocks, Raft, load tests). This document is the design: what runs, where, with what limits, who may ask, and what it is NOT.

## What it is, what it is not

* It runs Go commands on code of THEIRS: `go run`, `go test` (with `-race` and `-run`), `go vet`, `go build`, of a few inline files, of their own GitHub repository (or a folder of it), or of a `.go`
  file they attached to the chat. It returns the output (capped), the exit code and the time, in plain words for the model.
* It is NOT a shell, not a way to run Terraform, Docker or AWS commands (those cannot be sandboxed in any useful way), not a server that stays up, not a place to host anything, not reachable from the network. A program
  that listens on a port can only talk to itself (there is no network).
* It never runs in the agent container. That container has the student's tokens in its environment (the Canvas token reads the whole class, the tools' own processes are the same user) and a network; student code
  there could read them. The code runs in a DISPOSABLE container started by the host, with no secrets, no network while it runs, and nothing of the host mounted but a read-only copy of the code.

## Threat model (the code is untrusted: a student, a bug, or text a model was talked into running)

| threat | what stops it |
|---|---|
| escape from the container to the host | On either runtime: no capabilities (`--cap-drop ALL`), `no-new-privileges`, read-only root file system, not privileged, no Docker socket, no host path mounted except the code (read-only), a user that is not root in the container, the host's cgroup limits. With runc (Docker's default: `TAI_SANDBOX_RUNTIME` unset or `runc`), Docker's own seccomp profile too, and a kernel bug could still let code out. With `TAI_SANDBOX_RUNTIME=runsc`, as the live service runs it since 2026-11-23 05:12 UTC (gVisor, see "gVisor" below): the program's system calls are answered by gVisor's Sentry, a kernel that runs in user space, not by the host's kernel; the Sentry reaches the host through a small set of system calls under its own seccomp filter, from its own user and mount namespaces (runsc leaves Docker's seccomp profile out: its `--oci-seccomp` flag is off by default); the remaining risk is then a flaw in gVisor, or in the part of the host's kernel the Sentry still uses. |
| the code reads secrets | none in the container: no environment from the host, no mounts of the project, no tokens; the module download phase runs only `go mod download` (our binary, no student code) |
| network abuse, scanning, mining, exfiltration | `--network none` while any student code runs (the module download is a separate earlier step with no student code); CPU 1 core, 20 s wall for a run, 45 s for tests; `--pids-limit` |
| fork bomb, memory bomb, disk fill, endless output | `--pids-limit 128`, `--memory 512m` with the same swap, two memory-backed tmpfs (`/tmp` 256 MB for Go's build cache and the programs it builds, `/work` 96 MB for the project: the only writable places, both charged to the 512 MB), `--ulimit fsize=50 MB nofile=256 core=0` (no core dump reaches the host's crash handler), `--log-driver none` (a flood is not also written to a log file on the host's disk; the attached `docker run` still streams it), output read by the host with a cap (64 KB: the first 60% and the last 40% kept) and the container killed when the program has printed 4 MB, a hard wall-clock kill from the host (`docker kill`) whatever happens inside |
| one student starving the others or the host | at most 2 runs at once on the host, a short queue (4) that says "busy" instead of waiting long, per student 10 runs an hour and 40 a day (a table in the database, survives restarts), CPU and memory per run as above; the world's services (WorkAdventure, Nora) have 6 of the 8 cores left |
| a path or archive that writes outside its directory (`../`, absolute paths, symlinks, hard links, devices, a zip/tar bomb) | inline files: names are validated (relative, no `..`, letters, digits, `._-/`, depth 6, an allowlist of extensions), at most 40 files and 256 KB; the HOST NEVER UNPACKS anything: an archive (a repository's, or an upload) is handed to the run container as one read-only file and extracted INSIDE it, into its size-limited tmpfs (a bomb is stopped by the tmpfs size, a link can only point at the container's own files), with `--no-same-owner --no-same-permissions`; the host only fetches bytes (20 MB cap) and writes one file |
| reading another student's code | each run has its own directory; the repository is fetched from the account the HOST bound to the student (the model passes a repository name only); the shared module cache holds only downloaded, checksum-verified modules and is mounted read-only into the run |
| poisoning the shared module cache | only the download phase writes it, only `go mod download` (checked against the checksum database, `GONOSUMDB` and `GOFLAGS=-insecure` never set, `GOPROXY` is the Go module proxy only, `GOTOOLCHAIN=local`), never student code; the run mounts it read-only |
| a model talked into running something harmful | the model cannot name a command, a path on the host, an account or an environment: the request is a kind of run (run, test, vet, build), a package pattern, validated arguments and the code; everything else is fixed by the host. The result is data for the model, never an instruction (the same framing as other tool results) |
| leaving things behind | every container is named `tai-sandbox-<12 hex>` with the label `tai-sandbox=1` and is NOT started with `--rm` (the runner asks Docker how it ended, and whether the kernel killed it for memory, and then runs `docker rm -f` in a `finally`); a reaper at startup and every minute removes the containers that carry the label AND have exactly that name pattern and are older than two minutes, and the run directories (`run-<16 hex>`) older than two minutes, never one of a run in progress; the run's directory is removed in the `finally` of the run; a crash leaves at most one directory, which the reaper also removes |
| abuse to get a homework solved | the host cannot tell a solution from a demo. The persona rule stands: TAi runs the STUDENT'S code, or a tiny demo of a concept; it never writes a solution to a graded assignment and runs that. The audit log says whether the code was inline, a repository or an upload (never the code or the output). |

## How it runs

```
student's chat (text agent)                      voice call (conversation / interviewer)
  container tool run_go                            function run_code (host side, session.ts)
    writes IPC `sandbox_run` + waits for              |
    results/<id>.json (up to 65 s)                    |
            \                                        /
             v                                      v
          host: src/sandbox/ (validate -> limits -> stage the code -> modules -> run -> answer)
             1. the request is validated (src/sandbox/types.ts: nothing from the model reaches a command line unvalidated)
             2. per-student and global limits (rate table, 2 at once, queue of 4)
             3. stage: a fresh directory of the host's user: inline files, or the repository's archive (the host fetches it from
                the student's bound GitHub account, 20 MB cap), or the attached file; an archive stays ONE file, the run container extracts it
             4. modules (inline files: only if the go.mod at the top has requirements and there is no vendor folder beside it, the script's own rule, and NOT when
                the shared cache already holds every module that go.mod requires: "Module step skipped" below; an ARCHIVE: always, because the host does not look
                inside it, and the container finds out for itself and exits at once when there is nothing to download): a container WITH network that runs
                `sandbox-modules` = `go mod download` only, into the shared cache (checked against the Go checksum database), 60 s at the most. The code is
                unpacked in it so that its go.mod can be read; nothing of the student's runs, and the only thing of the request on its command line is a folder name
             5. run: a container with NO network: `/in` read-only (`files/`, `source.tgz`, `stdin`), a tmpfs `/work` (exec) the code is copied or unpacked to, the
                module cache read-only, `sandbox-run` with the request as separate argument elements, wall-clock timeout inside and outside
             6. the answer: ok, exit code, timed out, truncated, the output, the duration, and a host-worded sentence when it did not run
```

* Image: `tai-go-sandbox:live`, built on the host by `tai_live.sh sandbox build [--base IMAGE]` (Go 1.27.3 on Debian bookworm, so that `-race` works: it needs cgo and gcc), from `deploy/cs6650/sandbox/Dockerfile`, in at most 2 CPUs and 3 GB (about ten minutes on a healthy host, twenty on the CS6650 one, whose disk is slow; the image is 2.4 GB).
  `--base` names a mirror of the official golang image (Docker Hub limits anonymous pulls per address and this host shares one: `mirror.gcr.io/library/golang:1.27.3-bookworm` is the same image). The image holds the two scripts the
  host ever starts (`sandbox-run`, `sandbox-modules`, with `sandbox-common`) and a BUILD CACHE of the standard library (with and without `-race`) AND of the usual third-party packages (891 MB, 7204 files, built under the settings of a run),
  because Go compiles what is not cached from nothing, into an empty cache and on one CPU: for the standard library that is 9 s for a hello world, 18 s for a `go test` and 20 s and more for anything that imports `net/http`, and for Gin and
  its dependencies it is about 1.4 GB and 40 s (numbers below). The third-party part is built from the modules under `deploy/cs6650/sandbox/warm/` (the Dockerfile downloads them into `/gomodcache`, the path a run mounts the module cache at,
  because the directory a package sits in is part of the key of its compiled form; the sources are trusted and the network is the build's): `web` (Gin 1.12, testify, uuid, gorilla/mux, `x/sync`; with and without `-race`), `web-gin1110` (the same libraries with Gin 1.11.0, which has dependency versions of its own; a warm directory that holds a file named `race` is compiled with `-race` as well), `aws` (the SDK core, config,
  credentials), `kafka`, `redis`, `prometheus`. ONE MODULE FOR EACH LIBRARY, each as `go mod tidy` makes a project with only that library in it, because a compiled package is only reused for the very same versions of everything below it and
  the versions of what libraries share (x/net, x/sys, protobuf) depend on what else is required (a project with only Gin gets x/net 0.51, the three libraries together 0.59). Each run LINKS that cache into its own
  memory-backed `/tmp/gocache` (symbolic links: 52 ms for the 7204 files, nothing counted in the tmpfs), makes the directories writable (Go adds entries beside the image's: its index of module directories, the student's packages) and writes the time of the
  last cache trim as now (Go trims entries older than five days, once a day, by the time written in `trim.txt`: without that, a run on an image built a week ago would trim the whole of it and silently compile from nothing).
  `tai_live.sh sandbox warm` fills the shared module cache (`<live tree>/data/sandbox/gomodcache`, writable only for the modules container) from those same modules, one download for each (613 MB with the extracted copies, six modules; the image's
  cache hits for exactly their versions). `status` says what is there; `smoke` runs the checks in "Checks" below against the real
  image. The image is separate from the agent image: deploying TAi does not rebuild it, and a change to the scripts rebuilds only the last two steps of the Dockerfile.
* Commands (fixed by the host, never composed from the request; the scripts build the word list and `exec` it, no `eval`, no shell string): `go run <pkg> <args>`, `go test [-race] [-run=<pattern>] -count=1 -timeout=<wall minus 10>s <pkg>` (Go's own
  timeout sits under the wall clock, so a test that hangs is stopped with every goroutine's stack printed, not just killed), `go vet <pkg>`, `go build -o /dev/null <pkg>`; with `-mod=vendor` added when the project has `vendor/modules.txt`.
  The environment of the run is exactly `GOPROXY=off`, `GOFLAGS=-mod=mod -buildvcs=false`, `GOSUMDB=off` (go may complete an incomplete go.sum in the memory-backed copy from the cache's own checksums, which is safe because only the
  checked download phase fills the cache), `GOTOOLCHAIN=local`, `GOMODCACHE=/gomodcache` (read-only), `GOCACHE=/tmp/gocache`, `GOPATH=/tmp/gopath`, `CGO_ENABLED=1`, `HOME=/tmp`, `GOWORK=off` (a go.work in a student's repository
  would be an error with `-mod=mod`), `GOVCS=*:off` (no version control tool is ever run). `-mod=mod` instead of the first draft's `-mod=readonly`: a go.sum that lacks lines is the usual state of a student's repository.
  The modules container's: `GOFLAGS=-mod=mod -modcacherw` (without `-modcacherw` Go makes the cache's directories read-only and nothing, not even an operator, can clean it), the Go proxy and checksum database, `GOPRIVATE`, `GONOSUMDB`,
  `GONOPROXY`, `GOINSECURE` empty. The scripts also pin `LC_ALL=C` (their character ranges are by code point), unpack with `tar --no-same-owner --no-same-permissions` under a 20 s clock, refuse (one line, exit 2) an archive that does not
  unpack, has more than 2000 entries or holds a pipe, socket or device (the first container that looks inside an archive is the modules one, so the runner answers that line as `phase: 'stage'`, not as a failed download), work in the one directory GitHub
  wraps an archive in (not for loose files), and make a `go.mod` (`module sandbox`, the image's Go) at the top of the project when there is none up the tree.
* Limits, in one place (`src/sandbox/types.ts` `SANDBOX_LIMITS`): wall clock 20 s (run) or 45 s (test, vet, build), 512 MB memory, 1 CPU, 128 processes, tmpfs 256 MB (`/tmp`) and 96 MB (`/work`), output 64 KB, stdin 4 KB, arguments at most 4 of 60 characters,
  inline files 40 and 256 KB, an archive 20 MB (80 MB unpacked, 2000 files), 10 runs an hour and 40 a day per student (the admin folder `main` is exempt; the early check gives the right sentence, and the run is looked at again and
  recorded in the same breath when it gets its place, so two requests at the edge cannot both pass), 2 runs at once, a queue of 4 that waits at most 15 s, a shared module cache of at most 3000 MB (`moduleCacheMb`: the reaper looks at its
  size, with `du -sk` started from an argument array, at most every 10 minutes and only when no run is in flight; over the cap it empties the cache, which is writable thanks to `-modcacherw`, and logs ONE warn line with the sizes; a run asked
  for in those seconds is told the sandbox is busy; `tai_live.sh sandbox warm` refills it, and what a student's go.mod asks for downloads again).
* The minute: `run` answers within SANDBOX_TOTAL_MS whatever Docker does. The queue, the fetch, the modules and the program draw from one budget; the program gets the wall clock of its kind or what is left less the cost of getting a
  container going and the clean-up (and is not started when under 5 s are left). What a container start costs is a property of the host, learned from the runs (Docker's own `StartedAt`): well under a second on a healthy one, 6 to 14 seconds
  on the CS6650 host on 2026-11-06 for ANY image (its disk answered a write in 13 ms and a container start needs some 500 of them), so the budget starts from an estimate of 4 s and follows what it sees. The host's clock kills the container
  20 s after the program's wall clock, or 3 s before the minute ends, whichever is first; a guard answers 1 s before the minute ends if Docker itself hangs. `timedOut` is set when the host's clock fired, or when the exit is 124 or 137
  after the wall clock was used (137 is also what an OOM kill looks like, which Docker's `OOMKilled` tells apart: it is true when a grandchild of the script was killed, `go run`'s program, too).
* Module step skipped (2026-11-23, `src/sandbox/modcache.ts`): a container start is the dearest part of the minute on this host (2.5 to 42 s, "gVisor" below), and a Gin test needed two of them even when every module was in the cache.
  For INLINE code the host now leaves the modules container out when the go.mod at the top is plain (a `go` line of 1.17 or later, so that it names every module the build needs; `require` lines and blocks of checked
  paths and canonical versions, at most 200; no `replace`, `exclude`, unknown verb, quote or block comment) and the shared cache already holds each module it requires the way Go 1.27.3 takes it with no network:
  the unpacked `<path>@<version>` directory, `cache/download/<path>/@v/<version>.mod` and `.ziphash`, and no `.partial` (capitals escaped as Go does, `!` and the small letter). That list was measured on the host, one file put
  aside at a time: without the `.mod` Go says "module lookup disabled by GOPROXY=off"; without the directory or the `.ziphash`, or with a `.partial`, it tries to unpack the zip again and fails on the read-only cache
  ("…/@v/<version>.lock: read-only file system"); without the `.zip` or the `.info` the test passes; a directory of a module that is required but never imported is not needed either (the check asks for it anyway).
  The host only `lstat`s names it built from checked parts, inside the cache; it reads nothing there and writes nothing. If Go misses a module all the same (one of those two messages, and a failing exit), the runner runs the modules
  container and the program again in what is left of the same minute (one run counted), and remembers that go.mod (by its SHA-256, the last 500) so that it gets the modules container first from then on. Nothing changes for
  a repository or an attached archive (the host never opens one), and the first run of a project whose versions are not in the cache still downloads first. The image and its scripts are unchanged.
  Measured in round 3 ("gVisor"): no run whose modules were in the cache started the modules container. The live cache, read on the host on 2026-11-23 (`lstat` only), holds every module of the six warm lists by this rule.

## Who may ask, and what the model is told

* The student's chat: the container tool `run_go` (the text agent), through the IPC request described above; the admin chat as well. A student's agent can only run code for its own group: the host answers for the group the
  IPC directory belongs to, as it does for every request.
* The voice call: `run_code` in the conversation and in the interview (the interviewer may run a student's repository or file when the student asks, or to check a claim; it never speaks the output as a list: one or two
  sentences of what it showed).
* Teaching rule (persona and tool descriptions): ASK the student what they expect to see BEFORE running ("what do you think this prints?"), run, then compare and ask why. Run THEIR code or a tiny demo of a concept,
  never a solution to a graded assignment; never run code the student has not seen; the output is evidence to talk about, not an answer to give away.
* The result is untrusted data like every tool result: program output can contain anything, including text that looks like instructions; the tool's description says so, and the output is returned inside a framed block.

## Measured (the CS6650 host, 2026-11-06; 1 CPU, 512 MB, the limits above)

The program's own time, by Docker's `StartedAt` and `FinishedAt` (a container start costs 6 to 14 s more on this host, for any image). "Cold" is an empty build cache, "warm" the image's linked in:

| program | cold | warm |
|---|---|---|
| hello world, `go run` | 9.3 s | 0.9 s |
| a program with `net/http`, `httptest`, `encoding/json`, `go run` | killed at the 20 s clock | 1.8 s, 59 MB |
| a `go test` with goroutines | 18.3 s | 1.8 s |
| the same with `-race` (finds a data race) | 21.7 s | 1.5 s |

Also measured: `go run` of a program that allocates without end exits 1 with "signal: killed" and Docker's `OOMKilled` is TRUE (the killed process was the program, a grandchild of the script), so the memory sentence is reliable; `go build -o /dev/null ./...` works
on a two-package module; the modules phase on an empty cache then the run phase (no network, cache read-only, no go.sum) works, and a module that does not exist fails the modules phase with the proxy's 404 in plain words; a vendored project runs with an empty cache
and no network; the process peak was at most 21 of 128 in every run (threads count); with every file of the image's cache dated 30 days back the runs still hit it (the trim guard works); the AWS SDK's `config` and `service/dynamodb`, `go test -race`: 22.8 s and
352 MB (without `-race` 17.6 s, 380 MB), inside the limits.

**Gin: fits at the warmed versions, and mostly beyond.** Third-party packages compile on every run unless the image's cache holds them (the run's build cache is its own, in memory); cold, Gin 1.12 with testify needs 1369 MB and 40 s (`ugorji/go/codec` and `quic-go` are the
big ones: killed at 512 MB and at 1 GB, also with `-p=1`). With the third-party cache of the image (gin 1.12.0, testify 1.12.1 and what a project with only them pulls in), 512 MB: `go test` 5.8 s (374 MB peak), `go test -race` 8.0 s (384 MB), `go vet` 5.6 s (352 MB), and
`go run` of an app that serves one request to itself in-process 1.6 s (98 MB). Other versions of gin with the dependencies of the warm list kept (so only gin itself compiles): v1.11.0 `go test` 7.1 s / 377 MB, `go run` 3.1 s / 120 MB; v1.10.1 7.2 s / 368 MB and 4.2 s / 120 MB.
A project made from scratch with another gin gets that gin's own dependency versions, and what is not cached compiles: gin v1.10.1 (an older, smaller ugorji codec, no quic-go) still fits, `go test` 14.3 s / 366 MB and `go run` 10.3 s / 352 MB; gin v1.11.0 from scratch (quic-go 0.54.0,
ugorji codec 1.3.0) did NOT: killed for memory at 512 MB after 18.4 s (`go test`) and 16.0 s (`go run`), and at 1 GB as well (30.1 s; `go run` runs into the 20 s clock at 25 s). **Fixed on 2026-11-07 by a module of its own, `warm/web-gin1110`** (compiled with and without `-race`: +250 MB of
image, +175 MB of module cache, no change to any limit). The smoke has a case for it, and each version below was run the way a student's project gets it (`go mod init`, `go get gin@VERSION testify`, `go mod tidy`, in a throwaway container) through the real sandbox from an EMPTY module cache, so each time is the module download (the first
container) and the run (the second) together: a handler test with httptest and testify, then the same with `-race`.

| gin | `go test` | `go test -race` |
|---|---|---|
| v1.9.1 | 40.6 s | 47.1 s |
| v1.10.0 | 42.9 s | 50.4 s |
| v1.10.1 | 54.1 s | 52.4 s |
| v1.11.0 | 37.6 s | 39.7 s |
| v1.12.0 | 36.5 s | 36.2 s |

None ran out of memory. The seconds are whole runs on this host, where two container starts cost 25 s or more; v1.10.1 came within 6 s of the minute a run may take in total (SANDBOX_TOTAL_MS): a module download that does not finish says so, and asking again a minute later finds what was fetched.
Memory, which costs the host, would be the answer for versions not listed: a cold gin needs about 1.4 GB, and 2 GB passes `go test` in 40 s (not `go run`, whose clock is 20 s).

## gVisor (runsc), 2026-11-22

**Status (2026-11-23): SWITCHED ON in the live service** (the owner: "部署"), in three steps:
1. Release 926d873 (this setting and "Module step skipped") was deployed at 05:00:56 UTC, still on runc. A real run through the service's own path (its IPC verb, from a smoke chat, with no model: the model's provider refused with "payment required" that day) took 15.5 s and started one container: the module step was skipped against the live cache.
2. The smoke on runsc against the live image, round-2 style, passed 27 of 27 (its fill pass 3 of 3; the two Gin tests passed on their first try, at 44 and 45 s).
3. `TAI_SANDBOX_RUNTIME=runsc` was set and the service restarted at 05:12:19 UTC. The same real run then printed gVisor's kernel (`4.19.0-gvisor`) in 14.5 s, again with one container.

Every isolation check of the smoke passed under runsc in all four rounds. The cost, measured before the switch ("Measured" below): Gin runs from an empty module cache ran out of their minute more often than under runc (6 against 8 of 10 first tries in round 3; the host's disk varied more than that), and warm runs take 1 to 3 s longer for a small program and up to 9 s longer for Gin.

Not tried under runsc: a run from a voice call (`run_code`). The model's provider refused that day. The voice function says "still running" at 50 s, so a Gin run in a call will reach that limit more often than under runc.

To go back to runc: `tai_live.sh set TAI_SANDBOX_RUNTIME=runc`, then a restart (`~/tai-live/rollback-pre-sandboxruntime/ROLLBACK.txt`). Beware: a later deploy of a tree WITHOUT this change runs code that does not read the setting, so the sandbox goes back to runc and loses the skip, silently.

**What it is here.** `TAI_SANDBOX_RUNTIME` (`SETTINGS.md`) picks the OCI runtime of the sandbox's two containers (the one that downloads modules and the one that runs the code). Unset: Docker's default (runc), as before.
`runsc`: both are started with `docker run --runtime runsc`, so the program's system calls go to gVisor's Sentry, a kernel that runs in user space, instead of to the host's kernel. Nothing else changes runtime: Docker's default stays runc, and the agent containers, the voice tool host,
the document renderer, the world's services and `tai_live.sh sandbox warm` (the warm list's own modules, no student code) keep it. A value other than `runc` or `runsc` turns running code off (an error line at start), and a runtime Docker does not know makes the
sandbox "not set up" (a warning; asked with the image, every 30 s): never a fall-back to runc. `tai_live.sh sandbox status` says which runtime is set and whether Docker knows it; `sandbox smoke` runs on the service's runtime, and its case "the program runs on the
runtime the sandbox is set to" reads `/proc/version` (gVisor answers with a kernel of its own).

**Installed on the host on 2026-11-22** (the owner: "请你装gVisor"). gVisor release-20261116.0 (`runsc --version`: `release-20261116.0`, OCI spec 1.2.1), from the official release bundle
`https://storage.googleapis.com/gvisor/releases/release/20261116/x86_64/gvisor.tar.bz2` (84,718,885 bytes; the sha512 published beside it in the same bucket matched: that proves the download, it is not a signature), unpacked into `/usr/local/bin` as gVisor's install
page says: `runsc` (19,532,779 bytes), `containerd-shim-runsc-v1` (24,403,683; Docker does not use it here) and `gvisor-bin/` (the Sentry, `gvisor_sentry`, and six helpers that runsc looks for next to itself). Registered with Docker as an EXTRA runtime in a new
`/etc/docker/daemon.json` (there was none) that holds only `{"runtimes": {"runsc": {"path": "/usr/local/bin/runsc"}}}`, checked with `dockerd --validate`, read with `systemctl reload docker` (SIGHUP: Docker was not restarted, which on this host, with live-restore off,
would stop every container; its process stayed the same, the 15 containers kept their start times and restart counts, and the only container events of the reload were health checks). Platform: systrap, gVisor's default (`/dev/kvm` exists on this virtual machine; KVM
was not tried). No runtime flags. Taking it back, and in which order: `~/tai-live/rollback-pre-gvisor/ROLLBACK.txt` (the setting back to runc and a restart FIRST, then the entry out of daemon.json and a reload). Updates are by hand, the same steps with a newer bundle:
no package manager sees it.

**What changes for a program** (measured on this host on 2026-11-22, the deployed image, the runner's own flags; runc beside it):

* Inside, `/proc/version` reads `Linux version 4.19.0-gvisor`, `/proc/meminfo` shows the container's 512 MB, and `runtime.NumCPU()` is 2 (runsc rounds the 1-CPU quota up to its minimum of 2: `--cpu-num-from-quota`, on by default). `GOMAXPROCS` is 2 under both runtimes
  (under runc `NumCPU` is the host's 8, and Go takes the cgroup's quota, with the same minimum of 2), so the compiler is as parallel. No cgroup files inside.
* The host enforces the same limits: the container's cgroup (`system.slice/docker-<id>.scope`) has `memory.max` 512 MiB, `memory.swap.max` 0, `cpu.max` 100000 100000 and `pids.max` 128, read on the host while a program ran, as under runc.
* An allocation without end: Docker's `OOMKilled` is true under both. Under runc the kernel kills the program and `go run` prints "signal: killed" (exit 1); under runsc the whole sandbox is killed (exit 137, without that last line). The runner reads `OOMKilled` and says the
  same sentence either way.
* A fork bomb is stopped at 29 children (runc: 30) by the host's process limit (the cgroup's `pids.events` counted the refusals, `pids.peak` was 128); the program is told "cannot allocate memory" where runc's kernel says "resource temporarily unavailable". The
  Sentry's own threads take about 51 of the 128 before the program starts (runc: 13).
* The tmpfs limits hold (`/work` full at 95 MB, `/tmp` at 252 MB: "no space left on device"); `-race` works (ThreadSanitizer finds the race); the modules container downloads over Docker's bridge network through gVisor's own network stack, and what it writes
  into the shared cache belongs to the host's user (uid 1000), as under runc.

**What the host sees.** The gVisor processes of a container (the Sentry, its gofer) run as uid 0 (each in a user namespace of its own, with the identity uid map), in a mount namespace of their own (the Sentry's root is an empty directory), each under a seccomp
filter, with a few capabilities (the Sentry: chown, dac_override, dac_read_search, fowner, fsetid, sys_ptrace). One small helper of runsc, `runsc-fd-parking`, stays in the host's namespaces with full capabilities and no seccomp filter; it does not run the program's
code. That is gVisor's design, not a setting of ours. The student's program runs as uid 1000 inside the Sentry.

**Measured: runc against runsc** (2026-11-22/23, this host, outside the service: the smoke of a scratch build of this change, and the live build's own container arguments with `--runtime` added).

Cold and warm: each program on one runtime right after the sandbox image's Go toolchain and build cache were evicted from the page cache (`posix_fadvise(DONTNEED)` on those files only: 40,026 files, 2.6 GB of the two sandbox images; nothing of another service),
then the same program once more at once; two rounds, the runtimes' order alternating; the medians of the program's own time by Docker's clock, and of the container's peak memory read from its cgroup every 0.15 s:

| program | cold, runc | cold, runsc | warm, runc | warm, runsc | peak memory warm, runc / runsc |
|---|---|---|---|---|---|
| hello world, `go run` | 10.3 s (1 of 2 over the 20 s clock) | 9.2 s | 0.9 s | 2.2 s | 45 / 59 MB |
| a program with `net/http`, `go run` | 14.8 s | 20.0 s (1 of 2 over) | 2.7 s | 2.9 s | - / 100 MB |
| `go test`, passing | 14.1 s | 15.0 s | 0.7 s | 2.7 s | 58 / 86 MB |
| `go test -race`, finds the race | 17.4 s | 16.2 s | 2.2 s | 3.3 s | 55 / 84 MB |
| Gin 1.12 handler, `go test` | 37.6 s (1 of 2 over the 45 s clock) | 35.7 s (1 of 2 over) | 22.7 s | 13.4 s | 423 / 441 MB |
| Gin 1.12 app, `go run` | 21.2 s (2 of 2 over the 20 s clock) | 20.8 s (2 of 2 over) | 2.0 s | 5.3 s | 159 / 247 MB |

Starting a container (from `docker run` to the program's start) cost 6.7 to 12.5 s under both runtimes: the host's own cost, as on 2026-11-06. Warm, runsc adds about 1 to 3 s to a small program and 15 to 90 MB of memory (the Sentry), well inside 512 MB;
the Gin rows vary from run to run (their warm maximum was 28 s on runc and 40 s on runsc: the "warm" run follows a cold one whose reads filled the container's memory, which counts the page cache it reads), and two rounds of this table do not rank the runtimes
there (the smoke and the Gin table below do lean). Cold, the disk decides, not the runtime: both are about as slow and both ran out of the clock in 4 of their 12 cold runs. That is a property of this host which predates gVisor: the first run after the image's files
have left the page cache can run out of its 20 s on runc too (the very first probe of 2026-11-22, a program of hello-world size on runc, did: 28 s and no output). Not changed here; a longer clock or keeping those files warm would be a decision of its own.

**The smoke, three times on each runtime** (2026-11-22/23, a scratch build of this change on the host; round 1 from an empty module cache, round 2 with the three Gin cases run once before into the same cache, round 3 as round 2 with the module step
skipped, "Round 3" below):

| | round 1 (empty cache) | round 2 (cache filled first) | round 3 (as round 2, the module step skipped) |
|---|---|---|---|
| runc | 25 of 27: the Gin handler test and the Gin v1.11.0 `-race` test ran out of their minute | 27 of 27 (the Gin v1.11.0 case on its second try) | 27 of 27 |
| runsc | 25 of 27: the network case (a cold first build, no output within its 20 s) and the Gin v1.11.0 `-race` test ran out of time | 25 of 27: the Gin handler test and the Gin v1.11.0 `-race` test ran out of their minute | 27 of 27 |

Every isolation check (the runtime, the network, the environment, `/`, the read-only root, the limits, the archives, the queue, nothing left over) passed in all six. Every failure is time: a Gin `go test` needed two container starts, the module step and a compile inside
one minute (SANDBOX_TOTAL_MS), and the two runsc failures of round 2 were left 13 and 16 s for the program, the rest gone to the starts and the module step. With the pre-fill passes counted too, the two Gin `go test` cases passed 2 of 6 times on each runtime in rounds 1
and 2; the Gin `go run` case passed every time on both.

**Gin from an empty module cache, both runtimes** (2026-11-23, 02:12 to 02:48 UTC; the five versions and two modes of "Gin" above, made the same way, through the real runner; the runtimes' order alternating by version; a configuration that failed was run once more on
the cache its first try left):

| | passed on the first try | passed within two tries | attempts that passed |
|---|---|---|---|
| runc | 2 of 10 | 6 of 10 | 6 of 18 |
| runsc | 1 of 10 | 3 of 10 | 3 of 19 |

Gin v1.11.0 with `-race` never passed under runsc (0 of 5, the smoke and this table together; runc 2 of 5). No run in the table ran out of memory (the highest peak: 441 MB). A container's start (Docker's `Created` to `StartedAt`) took 2.5 to 42 s in these runs under both
runtimes (medians: about 7 to 8 s for the module step's container, 5 s for the run's). The samples are small and the host's own slowness varies more than the runtimes do, so they do not prove runsc worse; but every Gin comparison except the smoke's tie leans against
it, and none leans for it.

**Older than gVisor, found on the way:** on 2026-11-07 all ten of these configurations passed on runc from an empty cache, in 36 to 54 s (the table under "Gin" above); on 2026-11-23 only 2 did on the first try. So the live service (runc) may be running out of the
minute on a student's first Gin test today. The host's disk was slow while this was measured: a 4 KB synchronous write into a scratch directory took 8 ms to 1.4 s (median 0.11 s) over a minute from 02:58 UTC, and for a few minutes around 02:54 the kernel counted
80 to 93 % of the time stalled on the disk, a kernel worker waiting on it; the root file system is mounted with online `discard`. After round 3 (04:42 to 04:49 UTC), with no process or container of these tests left,
the disk spent all its time on discards (10 s of discard time in each 10 s, about 1.6 GB of ranges in 39 requests), io stalled about 90 % of the time, and the waiting kernel worker was ext4's discard work (`ext4_discard_work`, `blkdev_issue_discard`): with online
`discard`, deleting files costs this virtual disk minutes afterwards, and the tests delete a module cache of a few hundred MB after each configuration, so their runs slow each other (and the host). The weekly `fstrim` (enabled; 3.5 GiB in 44 s at 01:17 UTC that day)
does the same work in one go. The mount is the owner's call, not this change's. What would make a Gin test fit, on either runtime: no module container when the cache already holds what go.mod needs (one container start less: done for inline code, "Module step
skipped" above, measured in round 3 below), or a longer minute (not done).

**Round 3: the module step skipped** (2026-11-23, 03:29 to 04:41 UTC; a scratch build of this change, with "Module step skipped" above; one job at a time). The pass criteria were written down before the run: the smoke 27 of 27 on runc, and on runsc too to recommend
the switch; the warm list's Gin programs on a warmed cache 12 of 12 on runc and at least 11 of 12 on runsc, none of them starting a modules container; Gin from scratch with a second try ALWAYS run on the cache the first try left, at least 9 of 10 second tries on each
runtime; the switch only if all three hold for runsc.

| | the smoke (cache filled first) | the warm list's Gin programs, three rounds, warmed cache | Gin from scratch: first try | second try | within two tries |
|---|---|---|---|---|---|
| runc | 27 of 27 | 12 of 12, 10 to 22 s | 8 of 10 | 9 of 10 | 9 of 10 |
| runsc | 27 of 27 | 12 of 12, 12 to 25 s | 6 of 10 | 9 of 10 | 10 of 10 |

Every criterion held on both runtimes; the second tries only just (9 of 10 was the bar). None of the 42 runs on the warmed cache and none of the 20 second tries started a modules container. The two second tries that failed: Gin 1.9.1 `go test` on runc (its run
container took 32 s to start; dropped at 59 s) and Gin 1.9.1 `-race` on runsc (started in 5 s; the test's 45 s clock ran out after 46 s of compiling and testing a Gin the warm list does not hold). Before the smoke, its three Gin cases were run once into the empty cache
it then used: on runc all three passed, both tests only at the smoke's own second try (85 and 102 s in all); on runsc two passed, and the Gin v1.11.0 `-race` test ran out of its clock with 19 s of the minute left for it (the smoke tries again when a run was dropped
or left too little time, not when the program's own clock ran out).

What round 3 shows, and what it does not. A first try from an empty cache still starts the modules container, so the skip does not touch it; yet first tries passed 8 and 6 times in 10 where round 2 saw 2 and 1. The host was less busy, and one round cannot tell how much
of the second tries' gain (round 2: runc 4 of 8, runsc 2 of 9) is the skip. What the skip removes is one container start, which took 2.8 to 34 s on the first tries of this round (median about 4 s). Between the runtimes, inside round 3: runsc passed fewer first tries
(6 against 8 of 10; with `-race`, 2 against 4 of 5), and on the warmed cache its Gin runs took up to 9 s longer (medians 22, 23, 20 and 13 s against 17, 14, 20 and 10 s: the handler test, the same with `-race`, Gin 1.11.0 with `-race`, the app), all far inside the
minute.

## Checks (before anything goes live)

Unit tests with a fake Docker for everything the host decides (validation, limits, queue, staging checks, the command lines it builds: flag by flag, the answer's shape), the scripts under bash with a fake `go`, the fetch with a fake `fetch`; the real image on the host with
`tai_live.sh sandbox smoke` (`src/sandbox/smoke.ts`, on the service's runtime or the one `--runtime` names): a hello world; that it ran on that runtime (`/proc/version`: gVisor's own kernel under runsc, the host's under runc); a `go test` that passes and one that fails; `-race` finding a race; a program that loops forever (killed at the wall clock); one that allocates without end (OOM-killed, the host stays up); a fork bomb
(stopped by the process limit; gVisor tells the program "cannot allocate memory" where runc says "resource temporarily unavailable"); a program that writes endless output (cut at the cap); a program that tries the network (no route), reads `/proc/1/environ` and `/proc/self/environ` (nothing of the host in them), lists `/`, writes to `/` (read-only), writes more than the memory-backed
disk holds; an inline go.mod that needs a module (downloaded with network, then run without); a Gin handler tested with httptest and testify, a Gin v1.11.0 project (its own dependency versions, so its own warm module) tested with `-race`, and a Gin app run with `go run` that serves one request to itself and exits (both at the versions of the warm list, so the image's compiled
Gin is used: inside 45 s and 20 s and 512 MB, where a cold Gin needs about 1.4 GB); attached archives with `../x`, an absolute path, a symlink out, a hard link, a bomb (300 MB of zeros in 300 KB) and too many files (all contained: it ends within its limits, a canary
file beside the run directories is untouched); two runs at once, four waiting and a seventh told "busy"; no container and no run directory left after all of it. Each case prints PASS or FAIL with what was expected; the exit code says whether all passed. An adversarial read of
the whole by someone who did not write it is still owed (see "Review" below).

To change the warm list: add or edit a directory under `deploy/cs6650/sandbox/warm/` (a `go.mod` that requires the library at the version the course uses, and a Go file that blank-imports the packages), run `go mod tidy` in it in a throwaway container with a network
(`docker run --entrypoint /bin/bash` on the image, `-e GOPROXY=https://proxy.golang.org`), keep the go.mod it writes (its second block of requirements is what makes `go mod download` fetch the indirect modules, and what a project with only that library gets), then `sandbox build`
(compiles it into the image) and `sandbox warm` (downloads it into the module cache). Both read the directory, so a new library needs no change to either.

## Known gaps (said to the lead with the build of 2026-11-06)

* A project whose module versions are not the warmed ones compiles what is not cached in the memory it has. Gin 1.9.1 to 1.12.0 were tried from scratch and fit (see "Gin" above); a library or a version that is not on the warm list and has dependencies as big as Gin's may not.
  They fit in memory still; in time, on 2026-11-23, many first tries from an empty module cache ran out of the minute, on runc as on runsc (round 2: 2 and 1 of 10; round 3, a less busy host: 8 and 6 of 10). A second try of
  inline code, whose modules the first left in the cache, now skips the module step (round 3: 9 of 10 on each runtime, "gVisor", "Measured").
* The modules container unpacks an archive to read its go.mod, so "nothing of the student's is in it" is "nothing of the student's RUNS in it, and nothing of the request but a folder name is on its command line".

## Review (2026-11-06, by the lead: NOT independent)

A fresh agent was started twice to review the whole as an outsider; the platform's automatic safeguard for security work stopped it both times before it reported anything. So the whole was read, file by file, by the lead who coordinated the build. That is a
careful read, not an independent one: a person, or a tool, that did not write or direct it still owes the adversarial read.

* `docker.ts`: the flags of both containers (`--cap-drop ALL`, `no-new-privileges`, read-only root, pids limit, memory equal to memory-swap, one CPU, ulimits, `--log-driver none` so that a flood does not fill the host's disk through Docker's log, size-limited tmpfs, the code read-only, `--network none` for the run container); the environments are fixed `-e` lists, nothing is inherited; the one directory of the host a container may write is the module cache, in the modules container; mount sources are checked; the host kills and removes only names that match one pattern; `spawn` with argument arrays, no shell anywhere.
* Archives: the host never unpacks one. In the modules container (the cache is writable there) an archive with a link followed by a member under that link was tried on the real image (GNU tar 1.34): tar refuses ("Cannot open: Not a directory") and nothing reaches the mounted cache. The smoke's link case now points at `/gomodcache` (absolute and relative) and checks the host's cache directory.
* `fetch.ts`: the owner of a repository is the account the host bound to the student, the model names the repository only; the token goes only to `api.github.com`; the one redirect is followed by hand, to `codeload.github.com` alone, with no credentials and no further redirect; the body is a capped stream and must start as gzip.
* Output: both ways to a model (the text agent's IPC verb and the voice function) go through `frameSandboxResult` (quoted with a marker the output cannot close; control and bidirectional characters removed); what Go printed when the module download failed is quoted as data too.
* Identity and rates: the student is the folder of the IPC directory (text) or the call's own record (voice), never the request; one gate (`parseSandboxRequest`), run again by the runner; a run is recorded in the same breath its limit is looked at; one run at a time for a folder in each route.

What the host looked like when this was read: Ubuntu 26.04, Docker 29.1.3, runc 1.4.0, containerd 2.2.2, cgroup v2, AppArmor and Docker's built-in seccomp profile active, unprivileged user namespaces restricted by AppArmor, unprivileged BPF off; 358 GB free of 387 GB.

Residual risks, in the order they matter:

1. The kernel is the real boundary of a container. The host had not been restarted since its kernel updates (it ran 7.0.0-28 with 7.0.0-42 installed); it was restarted on 2026-11-07 at 03:25 UTC into 7.0.0-42 (every container and the service came back by themselves, in about 4 minutes for TAi and 8 for the whole world; the whole smoke passed on it). A newer kernel (7.0.0-43) and apparmor 5.0.2 sit in the `-updates` pocket and are not installed: unattended-upgrades takes only the security pocket. A flaw in the kernel or in runc is a flaw in every runc container of this machine. Since gVisor (2026-11-22, "gVisor (runsc)" above), the sandbox's two containers can run on runsc (`TAI_SANDBOX_RUNTIME=runsc`): the program then talks to the Sentry, and only the Sentry's narrow, filtered set of calls reaches the host's kernel; a flaw in gVisor, or in that part of the kernel, remains. The live service sets it since 2026-11-23 05:12 UTC ("gVisor"). The agent containers and the rest of the host stay on runc; a separate virtual machine is still not in this version.
2. The containers run as the service's own user (uid 1000, `ubuntu`), which is in the `sudo` and `docker` groups: whichever uid the container used, an escape would end as root. A dedicated uid was considered and adds nothing here.
3. The shared module cache is written only by the modules container, from the Go proxy, checked by `go` against the checksum database; it is capped (3000 MB) and emptied by the reaper. What a student's program does to its own run is its own business; no student's code ever runs in the container that writes the cache.
4. The tool that runs code refuses in a scheduled task, but the host cannot tell where an IPC request came from: the rate limits (10 runs an hour and 40 a day for a student, 2 at once on the host, a queue of 4) are what bound it.

## Not in this version

A server that stays up between runs, several nodes talking to each other, packet loss or delay, fake clocks, Terraform/Docker/AWS, zip archives, a language other than Go, running code in a scheduled task.
Each is a later decision (several of them build on this runner: a private network of sandboxes for the multi-node case). gVisor, listed here until 2026-11-22, is installed on the host and is now a setting (`TAI_SANDBOX_RUNTIME`, "gVisor" above) for these two containers only; the live service sets it since 2026-11-23.
