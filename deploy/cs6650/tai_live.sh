#!/usr/bin/env bash
# TAi, live, on the CS6650 host (tai.example.edu): the orchestrator and the student page under systemd, its own gateway to
# Cerebras, its own docker network, behind the world's traefik at /tai. Run from the operator's PC (Git Bash); every command that is not
# `deploy` only talks to the host over ssh. Nothing here asks for, prints or stores a secret: those go in with tai_credentials.sh.
#
#   bash deploy/cs6650/tai_live.sh deploy [--expose] [--corpus] [--image] [--npm] [--gateway]
#                                                                 sync this tree, build it, restart the service. The agent image, npm ci and the
#                                                                 gateway are redone only when their inputs changed (or by the flags): an image
#                                                                 build floods the host's disk with trims for minutes: not in class hours
#   bash deploy/cs6650/tai_live.sh status | check | test | logs [N] | start | stop | restart     (test: the unit tests, on the host, where the database module is built;
#                                                                 check: also that the voice model and the agent's each answer through the gateway)
#   bash deploy/cs6650/tai_live.sh expose | unexpose              put /tai behind traefik, or take it away (the service keeps running)
#   bash deploy/cs6650/tai_live.sh set KEY=VALUE ...              orchestrator settings (orch.env), e.g. TAI_GOOGLE_CLIENT_ID=...; then: restart
#   bash deploy/cs6650/tai_live.sh model gpt-oss|qwen|deepseek|glm [--background]
#                                                                 the model every student's turn uses (base.env + .env), at the next container; with
#                                                                 --background only the scheduled tasks' (the patrol): chats keep the model they have.
#                                                                 deepseek and glm are switched to only after the RUNNING gateway has answered for them (a tiny
#                                                                 answer and a tool round trip), so the key (tai_credentials.sh deepseek|zai) and the deploy come first
#   bash deploy/cs6650/tai_live.sh models [MODEL...]              a tiny answer and a tool round trip from each model through the gateway (default: the
#                                                                 ones in use), with the seconds each took; changes nothing: the way to try a model before switching to it
#   bash deploy/cs6650/tai_live.sh patrol [DAYS]                  what the teaching patrol and its gate did in the last DAYS days (default 7): runs by the model,
#                                                                 runs the gate skipped and why (src/patrol-gate.ts; TAI_PATROL_GATE=shadow tries it without skipping)
#   bash deploy/cs6650/tai_live.sh users list|add EMAIL [--name N] [--canvas ID] [--github LOGIN] [--owner] [--from-facts]|remove EMAIL
#   bash deploy/cs6650/tai_live.sh smoke [chat]                   one conversation through the host's own API: as the owner with the real tokens
#                                                                 (read-only), or "chat": a hello from a student with no tokens involved
#   bash deploy/cs6650/tai_live.sh manifest                       write DEPLOYED.json again (tree hash, images, git head)
#   bash deploy/cs6650/tai_live.sh gateway                        (re)create the gateway container (tai-live-litellm) and rebuild .env
#   bash deploy/cs6650/tai_live.sh course 260797                  the Canvas course TAi reads (this term's), then: tai_credentials.sh --check
#   bash deploy/cs6650/tai_live.sh voice status|enable|disable    voice calls and the mock interview (needs the Deepgram key: tai_credentials.sh deepgram)
#   bash deploy/cs6650/tai_live.sh voice lab [N]                  the voice lab (docs/VOICE_SELFBUILT.md, TAI_VOICE_LAB=1): its settings and the last N turns of its calls with the waits, p50/p90 at the end
#   bash deploy/cs6650/tai_live.sh notify status|vapid [--force]  notifications that reach a closed page (docs/NOTIFICATIONS.md). status: is it on (TAI_NOTIFY), is there a
#                                                                 VAPID key, whether e-mail is configured (TAI_NOTIFY_EMAIL, TAI_SMTP_*, the password: yes or no), how many browsers are subscribed (counts only). vapid: makes the key pair here
#                                                                 on the host when there is none (the private key to the file TAI_VAPID_KEY_FILE names, mode
#                                                                 600; only the PUBLIC key is printed); an existing key is left alone, --force replaces it
#                                                                 (and every student's subscription then stops working). Then: set TAI_NOTIFY=1, restart
#   bash deploy/cs6650/tai_live.sh smoke clean [--yes]            remove the chats the smoke tests made (smoke-*): what would go, or with --yes, gone
#   bash deploy/cs6650/tai_live.sh smoke voice [chat|interview|talk]
#                                                                 a synthetic call through the real page, socket and Deepgram, from the host
#   bash deploy/cs6650/tai_live.sh backup now|list|pull [dir]     a dated copy of what students' chats and records are (never a secret); pull = to this PC
#   bash deploy/cs6650/tai_live.sh timers on|off                  every night: the backup, and the knowledge corpus rebuilt from what the world publishes
#   bash deploy/cs6650/tai_live.sh humanness [--days N] [--split ISO] [--judge N] [--include-main]
#                                                                 how much TAi's replies and calls read like a bot (docs/HUMANNESS.md); read-only
#   bash deploy/cs6650/tai_live.sh sandbox build [--base IMAGE] | warm | status | smoke [--only TEXT] [--runtime runc|runsc]
#                                                                 running a student's Go code (docs/GO_SANDBOX.md). build: ships deploy/cs6650/sandbox/ to the host and builds the
#                                                                 image tai-go-sandbox:live (at most 2 CPUs and 3 GB, about ten minutes, a cache of the standard library and of the usual third-party packages compiled in it: not in class hours;
#                                                                 --base names a mirror of the golang image when Docker Hub's pull limit for this address is reached). warm: fills the shared
#                                                                 module cache (data/sandbox/gomodcache) with the modules the course's homework uses (warm/go.mod), through the modules container.
#                                                                 status: the image and its size, the runtime the service starts the containers with (TAI_SANDBOX_RUNTIME: unset = Docker's default
#                                                                 runc, runsc = gVisor) and whether Docker knows it, the cache's size, sandbox containers running, run directories left, runs counted in
#                                                                 the last hour. smoke: runs the checks against the real image (hostile programs and archives, the queue; up to 2 CPUs for several
#                                                                 minutes) on the service's runtime, or the one --runtime names. warm runs on Docker's default runtime (the warm list's own modules, no student code)
#   bash deploy/cs6650/tai_live.sh doc build [--base IMAGE] | status | smoke [--only TEXT]
#                                                                 the document viewer's renderer (docs/DOCUMENTS.md). build: ships deploy/cs6650/doc-render/ to the host and builds the image
#                                                                 tai-doc:live (poppler, LibreOffice and fonts on the python image the host has; at most 2 CPUs and 3 GB; about twelve minutes the first time and under one when only the scripts changed; --base names another copy of that image). status: the
#                                                                 image, the prepared documents kept (counts and sizes only), renderer containers and run directories left. smoke: real PDFs
#                                                                 (text, 10 and 150 pages, a scan, damaged and hostile files) through the real image, from the live tree's dist; up to 2 CPUs for a few minutes.
#                                                                 The image reads PDF, PowerPoint, Word and Excel files (LibreOffice inside it: about ten minutes to build the first time, 940 MB)
#   bash deploy/cs6650/tai_live.sh course-docs add <file-or-directory> [--title T] [--week N] | list | remove <id> | rename <id> [--title T] [--week N|none] | canvas [--course ID] [--yes] [--allow-host HOST]
#                                                                 the course library (docs/COURSE_DOCS.md): the professor's decks, shown to EVERY student in the viewer and found by what they say
#                                                                 (find_course_document). add: ships the files (PDF, PPTX, DOCX, XLSX, at most 20 MB each) to the host, which renders each through the renderer into the library
#                                                                 and skips a file already in it (same SHA-256); the week is taken from a name such as "Week 5" or "W5" when --week is not given. list: id, week, pages, title, source.
#                                                                 remove: by id (or the first six characters). canvas: lists the course's files that are PDF, PPTX, DOCX or XLSX (name, size, type, week) with the token stored on the host
#                                                                 (read only; never printed, sent to Canvas' own host only); with --yes it downloads each (at most 20 MB, never to a host that is not Canvas' own: --allow-host names one
#                                                                 that is fine) and adds it. TEACHING-SAFE: a deck in the library is course material a student may already open in Canvas, and it is yours to keep clear of solutions
#                                                                 to graded assignments (nothing here looks at what a deck says); files Canvas hides from students are not taken
#
# On the host, everything is under ~/tai-live (TAI_LIVE_DIR): tai/ (the tree, its .env, store/ groups/ data/), base.env + credentials.env
# (what .env is built from), orch.env, users.json (who may sign in), portal-secret, secrets.env (the gateway key), run/portal.sock, logs/,
# DEPLOYED.json (what is deployed: tree hash, image, git head). The evaluation stack (~/tai-eval) is never touched: other container
# prefix (tailive-), other network (tai-live-net), other port, other tree and .env.
set -euo pipefail

CMD=${1:-help}
shift || true
ON_HOST=0
if [ "$CMD" = --on-host ]; then
  ON_HOST=1
  CMD=${1:-help}
  shift || true
fi

if [ "$ON_HOST" = 0 ]; then
  case "$CMD" in
    help|-h|--help) sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
  HOST="${TAI_LIVE_HOST:-ubuntu@tai.example.edu}"
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  REPO="$(cd "$HERE/../.." && pwd)"
  SSH=(ssh -o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=8 ${SSH_OPTS:-})
  GIT_HEAD=$(cd "$REPO" && git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)
  GIT_DIRTY=$(cd "$REPO" && git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  if [ "$CMD" = deploy ]; then
    echo "syncing $REPO to $HOST:~/tai-live/tai (nothing there is deleted: store/, groups/, data/ and .env stay) ..." >&2
    ( cd "$REPO" && git ls-files -z --cached --others --exclude-standard \
        | grep -zv -e '^\.claude/' -e '^terraform/' -e '^assets/' -e '^\.github/' -e '^eval/results/' -e '^portal/qa/out/' -e '^groups/global/COURSE_REFERENCE.md$' \
        | tar --null --ignore-failed-read -T - -czf - 2>/dev/null ) \
      | "${SSH[@]}" "$HOST" 'mkdir -p ~/tai-live/tai && tar -xzf - -C ~/tai-live/tai && echo "synced: $(find ~/tai-live/tai -type f -not -path "*/node_modules/*" -not -path "*/dist/*" | wc -l) files"'
  fi
  if [ "$CMD" = backup ] && [ "${1:-}" = pull ]; then
    # the off-box copy: the newest backup, to this PC (it is student data: keep it as such)
    dest=${2:-"$HOME/tai-backups"}
    mkdir -p "$dest"
    latest=$("${SSH[@]}" "$HOST" 'ls -1t ~/tai-live/backups/tai-*.tgz 2>/dev/null | head -n 1') || true
    [ -n "$latest" ] || { echo "no backup on the host yet: tai_live.sh backup now" >&2; exit 1; }
    name=$(basename "$latest")
    "${SSH[@]}" "$HOST" "cat '$latest'" > "$dest/$name.part" && mv "$dest/$name.part" "$dest/$name"
    echo "pulled $dest/$name ($(du -h "$dest/$name" | cut -f1)): student data" >&2
    exit 0
  fi
  if [ "$CMD" = smoke ] && [ "${1:-}" = voice ]; then
    # a call through the real page, socket and Deepgram, with a synthetic student: Windows' own speech engine says the same words every time
    mode=${2:-chat}
    case "$mode" in chat|interview|talk) ;; *) echo "tai_live.sh smoke voice [chat|interview|talk]" >&2; exit 2 ;; esac
    wav="$(mktemp -d)/smoke-voice.wav"
    words=${TAI_SMOKE_TEXT:-Hello. Can you explain in one sentence how Raft elects a leader?}
    if ! powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$HERE/make_test_wav.ps1")" -Text "$words" -Out "$(cygpath -w "$wav")" >/dev/null 2>&1; then
      echo "could not make the test voice (it needs Windows' speech engine: powershell.exe and System.Speech)" >&2
      exit 1
    fi
    scp -q -o ConnectTimeout=20 ${SSH_OPTS:-} "$wav" "$HOST:tai-live/smoke-voice.wav"
    rm -f "$wav"
    set -- voice-run "$mode"
  fi
  if [ "$CMD" = timers ] && [ "${1:-}" = on ]; then
    # the timers run a copy of this script that stays on the host (the one streamed for a command is gone when it ends)
    tr -d '\r' < "${BASH_SOURCE[0]}" | "${SSH[@]}" "$HOST" 'mkdir -p ~/tai-live/bin && cat > ~/tai-live/bin/tai_live.sh && chmod 700 ~/tai-live/bin/tai_live.sh'
  fi
  if [ "$CMD" = sandbox ] && { [ "${1:-}" = build ] || [ "${1:-}" = warm ]; }; then
    # the image's build context goes to the host first, in a stream of its own (the script is the other one); `warm` reads the warm list from it, so it ships it too
    # (a warm needs no build before it: the image may have been built from a copy of the tree, and then nothing had left the list on the host)
    ( cd "$HERE" && tar -czf - sandbox ) \
      | "${SSH[@]}" "$HOST" 'set -e; L=${TAI_LIVE_DIR:-$HOME/tai-live}; rm -rf "$L/sandbox-build.new"; mkdir -p "$L/sandbox-build.new"; tar -xzf - -C "$L/sandbox-build.new"; rm -rf "$L/sandbox-build"; mv "$L/sandbox-build.new/sandbox" "$L/sandbox-build"; rmdir "$L/sandbox-build.new"' \
      || { echo "could not ship deploy/cs6650/sandbox to $HOST" >&2; exit 1; }
  fi
  if [ "$CMD" = doc ] && [ "${1:-}" = build ]; then
    # the renderer image's build context goes to the host first, in a stream of its own (the script is the other one)
    ( cd "$HERE" && tar -czf - doc-render ) \
      | "${SSH[@]}" "$HOST" 'set -e; L=${TAI_LIVE_DIR:-$HOME/tai-live}; rm -rf "$L/doc-build.new"; mkdir -p "$L/doc-build.new"; tar -xzf - -C "$L/doc-build.new"; rm -rf "$L/doc-build"; mv "$L/doc-build.new/doc-render" "$L/doc-build"; rmdir "$L/doc-build.new"' \
      || { echo "could not ship deploy/cs6650/doc-render to $HOST" >&2; exit 1; }
  fi
  if [ "$CMD" = course-docs ] && [ "${1:-}" = add ]; then
    # the files of the library's new decks go to the host first, in a stream of their own (the script is the other one); the host side renders each and then removes them
    src=""; skip=0; first=1; kept=()
    for a in "$@"; do
      if [ "$first" = 1 ]; then first=0; continue; fi
      if [ "$skip" = 1 ]; then skip=0; kept+=("$a"); continue; fi
      case "$a" in
        --title|--week) skip=1; kept+=("$a") ;;
        --*) kept+=("$a") ;;
        *) [ -z "$src" ] || { echo "tai_live.sh course-docs add takes ONE file or directory (the decks of a directory are all added)" >&2; exit 2; }; src=$a ;;
      esac
    done
    # what goes to the host is the command and its flags: the path is a place on THIS machine, and the host side adds what was shipped
    set -- add ${kept[@]+"${kept[@]}"}
    [ -n "$src" ] || { echo "tai_live.sh course-docs add <file-or-directory> [--title T] [--week N]" >&2; exit 2; }
    [ -e "$src" ] || { echo "course-docs add: there is no such file or directory: $src" >&2; exit 2; }
    if [ -d "$src" ]; then
      found=$( cd "$src" && find . -maxdepth 4 -type f \( -iname '*.pdf' -o -iname '*.pptx' -o -iname '*.docx' -o -iname '*.xlsx' \) -size -20481k ! -path '*/.*' | wc -l | tr -d ' ')
      [ "$found" -gt 0 ] || { echo "course-docs add: no PDF, PPTX, DOCX or XLSX file of at most 20 MB under $src" >&2; exit 1; }
      shipper() { ( cd "$src" && find . -maxdepth 4 -type f \( -iname '*.pdf' -o -iname '*.pptx' -o -iname '*.docx' -o -iname '*.xlsx' \) -size -20481k ! -path '*/.*' -print0 | tar --null -T - -czf - ); }
    else
      [[ "$src" =~ \.(pdf|pptx|docx|xlsx)$ ]] || [[ "$src" =~ \.(PDF|PPTX|DOCX|XLSX)$ ]] || { echo "course-docs add: that is not a PDF, PPTX, DOCX or XLSX file: $src" >&2; exit 2; }
      [ "$(wc -c < "$src" | tr -d ' ')" -le 20971520 ] || { echo "course-docs add: that file is over 20 MB: $src" >&2; exit 1; }
      shipper() { tar -czf - -C "$(dirname "$src")" -- "$(basename "$src")"; }
    fi
    # (the checks above are outside the pipe: an exit inside a pipe's side leaves only that side)
    shipper | "${SSH[@]}" "$HOST" 'set -e; L=${TAI_LIVE_DIR:-$HOME/tai-live}; rm -rf "$L/course-in"; mkdir -p "$L/course-in"; tar -xzf - -C "$L/course-in"' ||
      { echo "could not ship the files to $HOST" >&2; exit 1; }
  fi
  quoted=
  for a in "$@"; do quoted+=" $(printf '%q' "$a")"; done
  tr -d '\r' < "${BASH_SOURCE[0]}" | "${SSH[@]}" "$HOST" "TAI_GIT_HEAD=$GIT_HEAD TAI_GIT_DIRTY=$GIT_DIRTY bash -s -- --on-host $CMD$quoted"
  exit $?
fi

# ======================================================================== on the host
export LC_ALL=C
umask 077
L="${TAI_LIVE_DIR:-$HOME/tai-live}"
T="$L/tai"
DOMAIN_FILE="$HOME/cs6650-world/.env"
UNIT=tai-live
NET=tai-live-net
# NOT named with the orchestrator's container prefix (tailive-): at every start the orchestrator removes the containers whose names begin
# with it, and on 2026-11-02 the first start took the gateway with them
GATEWAY=tai-live-litellm
EDGE_PROJECT=tai-live
SOCKET="$L/run/portal.sock"
LOOP_PORT=8199
VOICE_LLM_PORT="${TAI_LIVE_GATEWAY_PORT:-4010}"        # the gateway on the host's loopback only: the orchestrator's voice relay forwards Deepgram's thinking requests to it
                                                       # (TAI_LIVE_GATEWAY_PORT is for the tests, which put a fake gateway on another port: nothing sets it live)
export PATH="$L/node/bin:$PATH"

say() { printf '%s\n' "$*" >&2; }
die() { say "$*"; exit 1; }
have_unit() { sudo -n systemctl cat "$UNIT" >/dev/null 2>&1; }

world_domain() { grep -m1 '^DOMAIN=' "$DOMAIN_FILE" 2>/dev/null | cut -d= -f2- | tr -d '"' || true; }

compose_env() {       # .env = base.env + credentials.env (the same rule tai_credentials.sh applies)
  [ -d "$T" ] && [ -f "$L/base.env" ] || return 0
  local tmp
  tmp=$(mktemp "$T/.env.XXXXXX")
  { cat "$L/base.env"; echo; [ ! -f "$L/credentials.env" ] || cat "$L/credentials.env"; } > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$T/.env"
}

write_base_env() {    # write_base_env MODEL [BACKGROUND_MODEL]: the gateway the agent containers talk to, the model they ask for, and the one the scheduled tasks use (default: the same)
  local model=$1 light=${2:-$1} key
  key=$(grep -m1 '^LITELLM_MASTER_KEY=' "$L/secrets.env" | cut -d= -f2-)
  # The mock interview's link is signed with a secret of its own (made once, here) and opens the student page; the tools the owner dropped
  # (YouTube, Amazon's voice notes and pictures) are not offered to the model, so it does not spend turns on tools that cannot work.
  [ -s "$L/voice-secret" ] || { umask 077; openssl rand -hex 32 > "$L/voice-secret"; }
  local domain
  domain=$(world_domain)
  ( umask 077
    cat > "$L/base.env.new" <<EOF
ASSISTANT_NAME=TAi
ANTHROPIC_BASE_URL=http://$GATEWAY:4000
ANTHROPIC_AUTH_TOKEN=$key
ANTHROPIC_MODEL=$model
ANTHROPIC_MODEL_LIGHT=$light
ANTHROPIC_DEFAULT_SONNET_MODEL=$model
ANTHROPIC_DEFAULT_HAIKU_MODEL=$model
ANTHROPIC_DEFAULT_OPUS_MODEL=$model
ANTHROPIC_SMALL_FAST_MODEL=$model
TAI_HARNESS=pi
DISABLE_TELEMETRY=1
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
DISABLE_AUTOUPDATER=1
VOICE_INTERVIEW_SECRET=$(cat "$L/voice-secret")
VOICE_BASE_URL=https://$domain/tai
TAI_DISABLED_TOOLS=youtube_info,youtube_transcript,generate_teaching_image,send_voice_message
EOF
  )
  mv "$L/base.env.new" "$L/base.env"
  chmod 600 "$L/base.env"
}

ensure_orch_key() {   # ensure_orch_key KEY VALUE: adds the setting to orch.env only if it is not there (an operator's change stays)
  grep -q "^$1=" "$L/orch.env" 2>/dev/null || echo "$1=$2" >> "$L/orch.env"
}

prepare() {
  command -v docker >/dev/null || die "docker is not available on this host"
  mkdir -p "$L" "$L/run" "$L/logs" "$T"
  chmod 700 "$L"
  chmod 755 "$L/run"                                     # the proxy container reaches the socket through this directory
  if [ ! -e "$L/node" ]; then
    [ -x "$HOME/tai-eval/node/bin/node" ] || die "no Node here: run eval/host/10_prep.sh first (it installs Node 22 under ~/tai-eval/node)"
    ln -s "$HOME/tai-eval/node" "$L/node"
  fi
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=19)?0:1)' || die "Node $(node --version) is older than 22.19 (pi needs it)"
  [ -f "$L/secrets.env" ] || echo "LITELLM_MASTER_KEY=sk-$(openssl rand -hex 24)" > "$L/secrets.env"
  [ -f "$L/portal-secret" ] || openssl rand -hex 32 > "$L/portal-secret"
  [ -f "$L/users.json" ] || echo '{"users": []}' > "$L/users.json"
  [ -f "$L/gateway.env" ] || : > "$L/gateway.env"
  chmod 600 "$L/secrets.env" "$L/portal-secret" "$L/users.json" "$L/gateway.env"
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
  [ -n "$(world_domain)" ] || die "no DOMAIN in $DOMAIN_FILE: is this the CS6650 host?"
  # the models stay what they were (the chats' and the scheduled tasks'); the rest of base.env (the gateway's name, its key) follows this script
  write_base_env "$(grep -m1 '^ANTHROPIC_DEFAULT_SONNET_MODEL=' "$L/base.env" 2>/dev/null | cut -d= -f2- | grep . || echo "${TAI_MODEL:-gpt-oss}")" \
    "$(grep -m1 '^ANTHROPIC_MODEL_LIGHT=' "$L/base.env" 2>/dev/null | cut -d= -f2- | grep . || true)"
  [ -f "$L/orch.env" ] || : > "$L/orch.env"
  case "$GATEWAY" in "$(grep -m1 '^CONTAINER_PREFIX=' "$L/orch.env" | cut -d= -f2-)"-*) die "the gateway's name must not begin with the container prefix" ;; esac
  chmod 600 "$L/orch.env"
  # what the live orchestrator needs to keep apart from the evaluation's (never overwritten once an operator has set it)
  ensure_orch_key TAI_CHANNELS web
  ensure_orch_key TAI_WEB_PORT "$LOOP_PORT"
  ensure_orch_key TAI_WEB_OUTBOX_LOG 0
  ensure_orch_key TAI_NO_SEEDS 1
  ensure_orch_key CONTAINER_PREFIX tailive
  ensure_orch_key CONTAINER_NETWORK "$NET"
  ensure_orch_key CONTAINER_IMAGE tai-agent:live
  ensure_orch_key TAI_COMPILE_ON_START 0
  ensure_orch_key IDLE_TIMEOUT 120000
  ensure_orch_key CONTAINER_TIMEOUT 900000
  ensure_orch_key MAX_CONCURRENT_CONTAINERS 5
  ensure_orch_key LOG_LEVEL info
  ensure_orch_key TAI_PORTAL_SOCKET "$SOCKET"
  ensure_orch_key TAI_PORTAL_USERS_FILE "$L/users.json"
  ensure_orch_key TAI_PORTAL_SECRET_FILE "$L/portal-secret"
  ensure_orch_key TAI_PORTAL_ORIGIN "https://$(world_domain)"
  ensure_orch_key TAI_PORTAL_BASE_PATH /tai
  ensure_orch_key TAI_PORTAL_TRUST_PROXY 1
  ensure_orch_key TAI_GOOGLE_CLIENT_ID ""
  ensure_orch_key TAI_ADMIN_CHAT 1                # the owner's second chat, with the admin group (read-only mounts: see container-runner.ts)
  ensure_orch_key TZ America/Los_Angeles          # the course keeps Pacific time: the weekday patrol at 9 am, and the date every agent is told
  # voice: on whenever the Deepgram key is stored (without it the hub is simply not built); the gateway key is the one the agents use, kept
  # in step here so a regenerated secrets.env cannot leave the relay with a stale one
  ensure_orch_key TAI_VOICE 1
  ensure_orch_key TAI_VOICE_LLM_URL "http://127.0.0.1:$VOICE_LLM_PORT"
  { grep -v '^TAI_VOICE_LLM_KEY=' "$L/orch.env" || true; echo "TAI_VOICE_LLM_KEY=$(grep -m1 '^LITELLM_MASTER_KEY=' "$L/secrets.env" | cut -d= -f2-)"; } > "$L/orch.env.new"
  mv "$L/orch.env.new" "$L/orch.env"
  chmod 600 "$L/orch.env"
  compose_env
}

# What a deploy skips when nothing it would rebuild has changed: hashes of the inputs, recorded in DEPLOYED.json by `manifest`.
# (The image build writes and then deletes gigabytes; the host's root is ext4 mounted with `discard`, and the trim that follows kept the
# whole machine at 95% IO pressure for several minutes on 2026-11-02. A code-only change must not pay for it: no image builds in class hours.)
hash_of() { ( cd "$T" && find "$@" -type f -not -path '*/node_modules/*' -print0 2>/dev/null | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16 ); }
container_hash() { hash_of container; }
lock_hash() { ( cd "$T" && sha256sum package-lock.json package.json | sha256sum | cut -c1-16 ); }
gateway_hash() { hash_of eval/litellm; }
recorded() { grep -o "\"$1\": \"[^\"]*\"" "$L/DEPLOYED.json" 2>/dev/null | cut -d'"' -f4 || true; }

build_tree() {      # build_tree [force]
  [ -f "$T/package.json" ] || die "no tree at $T: run deploy from the PC (it syncs first)"
  if [ "${1:-0}" = 1 ] || [ ! -d "$T/node_modules" ] || [ "$(lock_hash)" != "$(recorded lockHash)" ]; then
    say "== npm ci"
    ( cd "$T" && npm ci --no-audit --no-fund 2>&1 | tail -n 3 )
  else
    say "== npm ci skipped (package-lock.json unchanged)"
  fi
  say "== build"
  ( cd "$T" && npm run build 2>&1 | tail -n 3 )
  [ -f "$T/dist/index.js" ] || die "the build did not produce dist/index.js"
  ( cd "$T" && node -e "const D=require('better-sqlite3');new D(':memory:');console.log('better-sqlite3 loads')" )
}

build_corpus() {      # the knowledge tool's material: what the world already publishes to students, nothing planted in it
  local pages="$HOME/cs6650-loops/deploy/cs6650-pages"
  [ -d "$pages" ] || die "no released pages at $pages"
  docker image inspect cs6650-nora:local >/dev/null 2>&1 || die "no cs6650-nora:local image (Nora's chunker is what builds the corpus)"
  mkdir -p "$T/leanrag" "$L/corpus"
  docker run --rm -i --user "$(id -u):$(id -g)" --entrypoint python -v "$pages:/data/pages:ro" -v "$L/corpus:/out" cs6650-nora:local - <<'PY'
import json, sys
sys.path.insert(0, "/app")
from nora.knowledge import Corpus
chunks = [{"kind": k.kind, "title": k.title, "where": k.where, "text": k.text, "week": k.week} for k in Corpus("/data/pages").chunks]
json.dump(chunks, open("/out/stub_corpus.json", "w"))
print("corpus chunks:", len(chunks))
PY
  cp "$L/corpus/stub_corpus.json" "$T/leanrag/stub_corpus.json"
  : > "$T/leanrag/graph.pkl"
  if grep -q 'REFSOL\|INSTRUCTOR NOTES' "$T/leanrag/stub_corpus.json"; then die "the corpus holds an instructor-notes marker: it must not ship"; fi
  ensure_reference force
}

# The agents' course reference (weeks, homework, syllabus of THIS term), generated from what the world publishes. The repo's copy is the Spring
# term's and is not shipped by the deploy (see the tar exclusions): the one here is made on the host, with the corpus, so the two never disagree.
ensure_reference() {      # ensure_reference [force]: made when it is missing or is still the repo's, or when forced
  local pages="$HOME/cs6650-loops/deploy/cs6650-pages" ref="$T/groups/global/COURSE_REFERENCE.md"
  if [ "${1:-}" != force ] && grep -q 'Generated from the pages the course publishes' "$ref" 2>/dev/null; then return 0; fi
  if [ ! -d "$pages" ] || [ ! -f "$T/deploy/cs6650/make_course_reference.py" ]; then
    say "== course reference: no published pages here, it stays as it is"
    return 0
  fi
  python3 "$T/deploy/cs6650/make_course_reference.py" "$pages" "$ref" >&2 || say "== course reference: could not be generated, it stays as it is"
}

build_image() {
  say "== agent image tai-agent:live (cached build of $T/container)"
  docker build -t tai-agent:live "$T/container" 2>&1 | tail -n 4
  docker image inspect tai-agent:live >/dev/null 2>&1 || die "no tai-agent:live after the build"
}

gateway_up() {
  local key image=tai-litellm:live
  key=$(grep -m1 '^LITELLM_MASTER_KEY=' "$L/secrets.env" | cut -d= -f2-)
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    # pinned: the image the evaluation gateway runs now, under a name of its own, so a pull for the evaluation cannot change what is live
    docker image inspect ghcr.io/berriai/litellm:main-stable >/dev/null 2>&1 || docker pull ghcr.io/berriai/litellm:main-stable >/dev/null
    docker tag ghcr.io/berriai/litellm:main-stable "$image"
  fi
  local cerebras
  cerebras=$(grep -m1 '^CEREBRAS_API_KEY=' "$DOMAIN_FILE" | cut -d= -f2-)
  [ -n "$cerebras" ] || die "no CEREBRAS_API_KEY in $DOMAIN_FILE (nora_key.sh puts it there)"
  docker rm -f "$GATEWAY" >/dev/null 2>&1 || true
  # published on the host's loopback only (the voice relay in the orchestrator forwards Deepgram's thinking requests here; the agents reach the
  # gateway by its name on their network, and a loopback port is not reachable from that network)
  CEREBRAS_API_KEY="$cerebras" LITELLM_MASTER_KEY="$key" docker run -d --name "$GATEWAY" --network "$NET" --restart unless-stopped --memory 1500m \
    -p "127.0.0.1:$VOICE_LLM_PORT:4000" \
    -e CEREBRAS_API_KEY -e LITELLM_MASTER_KEY -e GATEWAY_LOG=/logs/gateway.jsonl --env-file "$L/gateway.env" \
    -v "$T/eval/litellm:/app/cfg:ro" -v "$L/logs:/logs" "$image" --config /app/cfg/config.yaml --port 4000 >/dev/null
  for i in $(seq 1 60); do
    if docker exec "$GATEWAY" python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:4000/health/liveliness', timeout=3)" >/dev/null 2>&1; then
      say "gateway up after $((i * 3)) s"
      return 0
    fi
    sleep 3
  done
  docker logs --tail 6 "$GATEWAY" 2>&1 | sed -E 's/csk-[A-Za-z0-9_-]+/csk-REDACTED/g' | cut -c1-200 >&2
  die "the gateway did not come up"
}

install_unit() {
  sudo -n true 2>/dev/null || die "sudo without a password is needed to install the service"
  sudo -n tee "/etc/systemd/system/$UNIT.service" >/dev/null <<EOF
[Unit]
Description=TAi, the CS6650 teaching assistant (orchestrator and student page)
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
User=$(id -un)
WorkingDirectory=$T
EnvironmentFile=$L/orch.env
ExecStart=$L/node/bin/node dist/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
NoNewPrivileges=true
PrivateTmp=true
SyslogIdentifier=$UNIT

[Install]
WantedBy=multi-user.target
EOF
  sudo -n systemctl daemon-reload
  sudo -n systemctl enable "$UNIT" >/dev/null 2>&1
}

portal_health() {     # the page's own health answer, through its socket
  curl -fsS -m 3 --unix-socket "$SOCKET" http://portal/api/health 2>/dev/null
}

wait_portal() {
  # up to two minutes: the host's disk mounts ext4 with `discard`, and right after a docker build deleted its layers a database write
  # can sit behind a trim storm for a minute or more (seen on 2026-11-02: the service was fine, only late)
  for _ in $(seq 1 120); do
    if portal_health >/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}

manifest() {
  local tree image gw
  tree=$(cd "$T" && find . -type f -not -path './node_modules/*' -not -path './dist/*' -not -path './store/*' -not -path './data/*' -not -path './groups/*/logs/*' \
           -not -name '.env' -not -name '*.log' -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-16)
  image=$(docker image inspect tai-agent:live --format '{{.Id}}' | cut -c8-19)
  gw=$(docker image inspect tai-litellm:live --format '{{.Id}}' | cut -c8-19)
  cat > "$L/DEPLOYED.json" <<EOF
{"deployedAt": "$(date -u +%FT%TZ)", "gitHead": "${TAI_GIT_HEAD:-unknown}", "gitDirtyFiles": ${TAI_GIT_DIRTY:-0}, "treeHash": "$tree", "agentImage": "$image", "gatewayImage": "$gw", "node": "$(node --version)", "containerHash": "$(container_hash)", "lockHash": "$(lock_hash)", "gatewayConfigHash": "$(gateway_hash)"}
EOF
  # the source that is running, kept by its hash: the deploy comes from a tree that may not be committed, so this is what a rollback would use
  mkdir -p "$L/releases"
  if [ ! -s "$L/releases/$tree.tgz" ]; then
    tar -C "$T" --exclude=./node_modules --exclude=./dist --exclude=./store --exclude=./data --exclude=./.env --exclude='./groups/*/logs' --exclude='*.log' -czf "$L/releases/$tree.tgz" .
  fi
  say "deployed: $(cat "$L/DEPLOYED.json")"
  say "source kept as $L/releases/$tree.tgz ($(du -h "$L/releases/$tree.tgz" | cut -f1))"
}

expose() {
  local domain net proxy
  domain=$(world_domain)
  [ -n "$domain" ] || die "no DOMAIN in $DOMAIN_FILE"
  # the network the world's traefik reaches its services on: asked of the running container, not assumed from a project name
  proxy=$(docker ps --filter 'name=reverse-proxy' --format '{{.Names}}' | grep -m1 '^cs6650' || true)
  [ -n "$proxy" ] || die "the world's traefik (cs6650...-reverse-proxy-...) is not running"
  net=$(docker inspect "$proxy" --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' | tr ' ' '\n' | grep -m1 '^cs6650' || true)
  [ -n "$net" ] || die "could not find the docker network of $proxy"
  say "traefik is $proxy on network $net"
  portal_health >/dev/null || die "the page does not answer on $SOCKET: start the service before exposing it"
  cat > "$L/docker-compose.yaml" <<EOF
# TAi's door in the world's traefik: a container that only hands connections to the page's unix socket. The world's compose project is not
# touched: traefik finds this by its labels because they share a network. Generated by tai_live.sh expose.
name: $EDGE_PROJECT
services:
  tai-edge:
    image: alpine/socat:1.8.0.3
    command: ["TCP-LISTEN:8080,fork,reuseaddr", "UNIX-CONNECT:/run/tai/portal.sock"]
    volumes:
      - $L/run:/run/tai
    networks: [world]
    read_only: true
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
    mem_limit: 64m
    pids_limit: 128
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "printf 'GET /api/health HTTP/1.0\\\\r\\\\n\\\\r\\\\n' | socat -T3 - UNIX-CONNECT:/run/tai/portal.sock | grep -q '\"ok\":true'"]
      interval: 15s
      timeout: 6s
      retries: 3
      start_period: 5s
    labels:
      traefik.enable: "true"
      traefik.docker.network: "$net"
      traefik.http.middlewares.tai-strip.stripprefix.prefixes: "/tai"
      traefik.http.middlewares.tai-robots.headers.customresponseheaders.X-Robots-Tag: "noindex, nofollow"
      traefik.http.routers.tai.rule: "Host(\`$domain\`) && (Path(\`/tai\`) || PathPrefix(\`/tai/\`))"
      traefik.http.routers.tai.entryPoints: "websecure"
      traefik.http.routers.tai.middlewares: "tai-strip@docker,tai-robots@docker"
      traefik.http.routers.tai.priority: "200"
      traefik.http.services.tai.loadbalancer.server.port: "8080"
networks:
  world:
    external: true
    name: $net
EOF
  docker compose -f "$L/docker-compose.yaml" up -d 2>&1 | grep -v 'level=warning' | tail -n 4
  for _ in $(seq 1 30); do
    if [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose -f "$L/docker-compose.yaml" ps -q tai-edge)" 2>/dev/null)" = healthy ]; then break; fi
    sleep 2
  done
  say "edge: $(docker inspect -f '{{.State.Health.Status}}' "$(docker compose -f "$L/docker-compose.yaml" ps -q tai-edge)" 2>/dev/null || echo unknown)"
  sleep 3
  local code
  code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' --resolve "$domain:443:127.0.0.1" "https://$domain/tai/api/health" 2>/dev/null || echo 000)
  say "https://$domain/tai/api/health -> HTTP $code"
  [ "$code" = 200 ] || die "the page is not reachable through traefik yet"
}

unexpose() {
  [ -f "$L/docker-compose.yaml" ] || die "nothing is exposed (no $L/docker-compose.yaml)"
  docker compose -f "$L/docker-compose.yaml" down 2>&1 | grep -v 'level=warning' | tail -n 3
}

users_cmd() {
  local sub=${1:-list}
  shift || true
  python3 - "$L/users.json" "$L/owner-facts.json" "$sub" "$@" <<'PY'
import json, os, re, sys
path, facts_path, sub, rest = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
data = json.load(open(path)) if os.path.exists(path) else {"users": []}
users = data.setdefault("users", [])
EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")

def save():
    tmp = path + ".new"
    with open(tmp, "w") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)

if sub == "list":
    for u in users:
        print("  %-34s %-8s canvas=%-8s github=%-16s %s" % (u.get("email"), u.get("role", "student"), u.get("canvasUserId", "-"), u.get("githubUsername", "-"), u.get("name", "")))
    print("%d user(s)" % len(users))
elif sub == "add":
    if not rest or not EMAIL.match(rest[0]):
        sys.exit("users add EMAIL [--name N] [--canvas ID] [--github LOGIN] [--owner] [--from-facts]")
    entry = {"email": rest[0].strip().lower()}
    i = 1
    while i < len(rest):
        flag = rest[i]
        if flag == "--owner":
            entry["role"] = "owner"
        elif flag == "--from-facts":
            facts = json.load(open(facts_path))
            canvas = facts.get("canvas", {})
            github = facts.get("github", {})
            if canvas.get("userId"):
                entry.setdefault("canvasUserId", str(canvas["userId"]))
            if canvas.get("name"):
                entry.setdefault("name", canvas["name"])
            login = (github.get("enterprise") or github.get("github.com") or {}).get("login")
            if login:
                entry.setdefault("githubUsername", login)
        elif flag in ("--name", "--canvas", "--github") and i + 1 < len(rest):
            entry[{"--name": "name", "--canvas": "canvasUserId", "--github": "githubUsername"}[flag]] = rest[i + 1]
            i += 1
        else:
            sys.exit("unknown argument: %s" % flag)
        i += 1
    if entry.get("canvasUserId") and not re.fullmatch(r"\d{1,15}", str(entry["canvasUserId"])):
        sys.exit("--canvas must be digits")
    if entry.get("githubUsername") and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}", entry["githubUsername"]):
        sys.exit("--github is not a GitHub login")
    users[:] = [u for u in users if u.get("email", "").lower() != entry["email"]] + [entry]
    save()
    print("added %s (%s)" % (entry["email"], entry.get("role", "student")))
elif sub == "remove":
    if not rest:
        sys.exit("users remove EMAIL")
    before = len(users)
    users[:] = [u for u in users if u.get("email", "").lower() != rest[0].strip().lower()]
    save()
    print("removed %d" % (before - len(users)))
else:
    sys.exit("users list | add | remove")
PY
}

course_cmd() {      # the Canvas course TAi reads: a number, not a secret, so it is set here and not at a hidden prompt
  [[ "${1:-}" =~ ^[0-9]{1,12}$ ]] || die "tai_live.sh course <this term's Canvas course id>   (the number in .../courses/<id>)"
  [ -f "$L/credentials.env" ] || die "no credentials are stored yet: run tai_credentials.sh first"
  { grep -v '^CANVAS_COURSE_ID=' "$L/credentials.env" || true; printf 'CANVAS_COURSE_ID="%s"\n' "$1"; } > "$L/credentials.env.new"
  chmod 600 "$L/credentials.env.new"
  mv "$L/credentials.env.new" "$L/credentials.env"
  compose_env
  say "the Canvas course is now $1 (the next agent container reads it); check it: tai_credentials.sh --check"
}

set_cmd() {
  [ $# -gt 0 ] || { cat "$L/orch.env"; return 0; }
  local kv key value
  for kv in "$@"; do
    key=${kv%%=*}
    value=${kv#*=}
    [[ "$key" =~ ^(TAI_[A-Z0-9_]+|CONTAINER_[A-Z_]+|IDLE_TIMEOUT|MAX_CONCURRENT_CONTAINERS|LOG_LEVEL)$ ]] || die "$key is not a setting this command changes"
    [[ "$key" =~ (KEY|TOKEN|SECRET|PASSWORD)$ ]] && die "$key looks like a secret: secrets go in with tai_credentials.sh"
    [[ "$value" =~ ^[A-Za-z0-9_./:@,+=-]*$ ]] || die "the value of $key has characters this command does not take"
    { grep -v "^$key=" "$L/orch.env" || true; echo "$key=$value"; } > "$L/orch.env.new"
    mv "$L/orch.env.new" "$L/orch.env"
    chmod 600 "$L/orch.env"
    say "$key set (restart the service to apply: tai_live.sh restart)"
  done
}

status() {
  echo "service:   $(systemctl is-active "$UNIT" 2>/dev/null || echo not-running)"
  echo "page:      $(portal_health || echo 'not answering')"
  echo "gateway:   $(docker ps --filter "name=^$GATEWAY\$" --format '{{.Status}}' | grep . || echo 'not running')"
  echo "edge:      $(docker ps --filter 'name=tai-edge' --format '{{.Names}} {{.Status}}' | grep . || echo 'not exposed')"
  echo "containers:"; docker ps --filter 'name=^tailive-' --format '  {{.Names}}  {{.Status}}' || true
  echo "users:     $(python3 -c "import json; u=json.load(open('$L/users.json'))['users']; print(len(u), 'on the list;', sum(1 for x in u if x.get('role')=='owner'), 'owner(s)')" 2>/dev/null || echo '?')"
  echo "model:     $(grep -m1 '^ANTHROPIC_DEFAULT_SONNET_MODEL=' "$L/base.env" 2>/dev/null | cut -d= -f2-) (scheduled tasks: $(grep -m1 '^ANTHROPIC_MODEL_LIGHT=' "$L/base.env" 2>/dev/null | cut -d= -f2-)) ; sign-in: $([ -n "$(grep -m1 '^TAI_GOOGLE_CLIENT_ID=.' "$L/orch.env" 2>/dev/null)" ] && echo 'Google client id set' || echo 'closed (no client id)')"
  echo "stored:    $(for k in CANVAS_API_TOKEN GITHUB_TOKEN GITHUB_TOKEN_PUBLIC PIAZZA_PASSWORD DEEPGRAM_API_KEY; do printf '%s=%s ' "$k" "$([ -n "$(grep -m1 "^$k=" "$L/credentials.env" 2>/dev/null)" ] && echo set || echo -)"; done)"
  echo "gateway:   $(for k in DEEPSEEK_API_KEY ZAI_API_KEY; do printf '%s=%s ' "$k" "$([ -n "$(grep -m1 "^$k=." "$L/gateway.env" 2>/dev/null)" ] && echo set || echo -)"; done)(in gateway.env only)"
  echo "voice:     $(grep -m1 '^TAI_VOICE=' "$L/orch.env" 2>/dev/null | cut -d= -f2- | sed 's/^1$/on/; s/^0$/off/' | grep . || echo off); backups: $(ls -1 "$L/backups"/tai-*.tgz 2>/dev/null | wc -l) kept; nightly timers: backup $(systemctl is-active tai-live-backup.timer 2>/dev/null | head -n 1), corpus $(systemctl is-active tai-live-corpus.timer 2>/dev/null | head -n 1)"
  [ ! -f "$L/DEPLOYED.json" ] || echo "deployed:  $(cat "$L/DEPLOYED.json")"
}

model_tool_roundtrip() {    # model_tool_roundtrip MODEL (the gateway key in TAI_PROBE_KEY): a tool call and then the request that carries its result. One line; non-zero when it failed.
  # A plain "Say OK." never makes the second request, and that one is where DeepSeek answers 400 when the reasoning_content of its first answer is not sent
  # back: the text agent and the voice relay always send tools, so a model that fails this is a model that fails every real turn.
  python3 - "http://127.0.0.1:$VOICE_LLM_PORT/v1/chat/completions" "$1" <<'PY'
import json, os, sys, time, urllib.error, urllib.request
url, model = sys.argv[1:3]
key = os.environ.get("TAI_PROBE_KEY", "")


def post(body):
    request = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + key, "content-type": "application/json"})
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read()), time.time() - started
    except urllib.error.HTTPError as err:
        return err.code, (err.read() or b"")[:160].decode("utf-8", "replace").replace("\n", " "), time.time() - started
    except Exception as err:
        return 0, type(err).__name__, time.time() - started


tools = [{"type": "function", "function": {"name": "echo", "description": "Echoes the text back.", "parameters": {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}}}]
messages = [{"role": "user", "content": "Call the echo tool with the text hello. Do not answer in words."}]
status, first, t1 = post({"model": model, "messages": messages, "tools": tools, "max_tokens": 80})
if status != 200:
    print("tool call: the first request failed (HTTP %s) %s" % (status, first))
    sys.exit(1)
message = ((first.get("choices") or [{}])[0].get("message")) or {}
calls = message.get("tool_calls") or []
if not calls:
    print("tool round trip not tried (the model answered in words instead of calling the tool)")
    sys.exit(0)
assistant = {"role": "assistant", "content": message.get("content"), "tool_calls": calls}
if message.get("reasoning_content"):
    assistant["reasoning_content"] = message["reasoning_content"]          # what a correct client sends back
status, second, t2 = post({"model": model, "messages": messages + [assistant, {"role": "tool", "tool_call_id": calls[0]["id"], "content": "hello"}], "tools": tools, "max_tokens": 40})
if status != 200:
    print("tool round trip FAILED on the second request (HTTP %s) %s" % (status, second))
    sys.exit(1)
print("tool round trip ok (%.1f s + %.1f s)" % (t1, t2))
PY
}

models_answer() {    # models_answer [MODEL...]: a tiny completion and a tool round trip from each through the gateway (default: the voice model, the agent's and the scheduled tasks'); non-zero when one fails
  # What /health/liveliness never shows: the provider refusing the key (its billing, quota or an outage of its own). On 2026-11-04 04:36 UTC the
  # provider answered 402 "payment required" to every request, and the first anyone knew of it was the end of a voice call.
  local key m code secs tmp line bad=0 voice agent light
  voice=$(grep -m1 '^TAI_VOICE_MODEL=' "$L/orch.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  agent=$(grep -m1 '^ANTHROPIC_MODEL=' "$L/base.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  light=$(grep -m1 '^ANTHROPIC_MODEL_LIGHT=' "$L/base.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  # shellcheck disable=SC2046
  [ "$#" -gt 0 ] || set -- $(printf '%s\n' "${voice:-qwen}" "${agent:-gpt-oss}" "$light" | awk 'NF && !seen[$0]++')
  key=$(grep -m1 '^TAI_VOICE_LLM_KEY=' "$L/orch.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  [ -n "$key" ] || { echo "models:     no gateway key in orch.env"; return 1; }
  for m in "$@"; do
    tmp=$(mktemp)
    code=$(curl -sS -m 30 -o "$tmp" -w '%{http_code} %{time_total}' -H "Authorization: Bearer $key" -H 'content-type: application/json' \
      -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"Say OK.\"}],\"max_tokens\":8}" \
      "http://127.0.0.1:$VOICE_LLM_PORT/v1/chat/completions" 2>/dev/null) || code="none 0"
    secs=${code#* }
    code=${code%% *}
    case "$code" in
      200)
        if line=$(TAI_PROBE_KEY="$key" model_tool_roundtrip "$m"); then echo "model $m: answers ($secs s); $line"; else echo "model $m: answers ($secs s), but $line"; bad=1; fi ;;
      402) echo "model $m: the provider says PAYMENT REQUIRED (its billing page): voice calls, chats and patrols all fail until it is paid"; bad=1 ;;
      *) echo "model $m: NOT answering (HTTP $code) $(head -c 120 "$tmp" | tr '\n' ' ')"; bad=1 ;;
    esac
    rm -f "$tmp"
  done
  [ "$bad" = 0 ]
}

patrol_cmd() {    # patrol [DAYS]: what the teaching patrol and its gate did in the last DAYS days (default 7), from the scheduler's own log; reads only
  local days=${1:-7}
  [[ "$days" =~ ^[0-9]{1,3}$ ]] || die "tai_live.sh patrol [DAYS]"
  python3 - "$T/store/messages.db" "$days" <<'PY' || echo "patrol:    no data (the database could not be read)"
import datetime, sqlite3, sys
con = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
days = int(sys.argv[2])
since = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S")
# a patrol is the host's own task, by its id (`patrol-...`: an agent's task is `task-...` and cannot be given another id), never by the marker in its prompt, which a
# student's own task can carry. The origin column is not asked: this runs on a database whose host may not have added it yet.
rows = con.execute(
    "select t.group_folder, l.run_at, l.status, l.result from task_run_logs l join scheduled_tasks t on t.id = l.task_id "
    "where substr(t.id, 1, 7) = 'patrol-' and l.run_at >= ? order by l.run_at", (since,)).fetchall()
skipped = [r for r in rows if (r[3] or "").startswith("skipped by the gate")]
shadow = [r for r in rows if (r[3] or "").startswith("[the gate would have skipped")]
ran = [r for r in rows if r not in skipped]
failed = [r for r in ran if r[2] == "error"]
print("patrol:    last %d days: %d patrol runs: %d by the model (%d failed), %d skipped by the gate%s" % (
    days, len(rows), len(ran), len(failed), len(skipped),
    "; in shadow mode the gate would have skipped %d of the model's runs" % len(shadow) if shadow else ""))
# what the gate said, in its own words: ids, counts and dates (never a student's text); a model run's own result is not shown
for folder, at, status, result in skipped[-8:]:
    print("  %s %s: %s" % (at[:10], folder[:12], (result or "")[len("skipped by the gate: "):][:170]))
PY
}

gateway_model_ready() {    # gateway_model_ready ALIAS KEYVAR CREDENTIAL LABEL: 0 when a model with a key of its own (deepseek, glm) works through the RUNNING gateway: the guard of `model ALIAS`
  local alias=$1 keyvar=$2 credential=$3 label=$4
  [ -n "$(grep -m1 "^$keyvar=." "$L/gateway.env" 2>/dev/null)" ] || { say "no $label key is stored: bash deploy/cs6650/tai_credentials.sh $credential"; return 1; }
  # the gateway reads its env file only when it is created
  docker exec "$GATEWAY" sh -c "test -n \"\$$keyvar\"" >/dev/null 2>&1 || { say "the running gateway does not have the key yet: bash deploy/cs6650/tai_live.sh gateway (that cuts calls that are running)"; return 1; }
  # having the key is not the model working: a gateway created before the deploy runs the old config (no such alias), and an account with no balance answers 402
  # to every turn. Both would pass the two checks above and take every chat down, so the switch needs a real answer and a tool round trip from the running gateway.
  local out
  out=$(models_answer "$alias" 2>&1) || { say "$out"; say "$alias does not work through the running gateway (an old config without the alias: deploy first; an empty balance: top it up)"; return 1; }
  case "$out" in
    *"tool round trip ok"*) ;;
    *) say "$out"; say "$alias answered, but no tool round trip could be shown: not switching (try again; the model has to call the tool for the check to count)"; return 1 ;;
  esac
}
deepseek_ready() { gateway_model_ready deepseek DEEPSEEK_API_KEY deepseek DeepSeek; }    # the guard of `model deepseek`
glm_ready() { gateway_model_ready glm ZAI_API_KEY zai z.ai; }                                  # the guard of `model glm` (z.ai, GLM-5.3-Flash, thinking off)

check() {
  local domain code ok=1
  domain=$(world_domain)
  say "== through the socket"
  portal_health >&2 && echo >&2 || { say "the page does not answer"; ok=0; }
  say "unauthenticated /api/me -> $(curl -s -m 3 -o /dev/null -w '%{http_code}' --unix-socket "$SOCKET" http://portal/api/me) (want 401)"
  say "POST without the page's header -> $(curl -s -m 3 -o /dev/null -w '%{http_code}' -X POST -H 'content-type: application/json' -d '{}' --unix-socket "$SOCKET" http://portal/auth/google) (want 403)"
  say "== the models answer"
  models_answer >&2 || ok=0
  say "== the host's own API is on loopback only, and not reachable from the agents' network"
  say "loopback API on :$LOOP_PORT -> $(curl -s -m 3 http://127.0.0.1:$LOOP_PORT/api/health | cut -c1-60)"
  local gw
  gw=$(docker network inspect "$NET" --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}')
  say "from a container on $NET to the host at $gw:$LOOP_PORT -> $(docker run --rm --network "$NET" python:3.12-slim python -c "import urllib.request,sys
try:
    urllib.request.urlopen('http://$gw:$LOOP_PORT/api/health', timeout=4); print('REACHABLE (bad)')
except Exception as e:
    print('refused (good)')" 2>/dev/null || echo 'could not test')"
  if docker ps --filter 'name=tai-edge' -q | grep -q .; then
    say "== through traefik (https://$domain/tai/)"
    code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' --resolve "$domain:443:127.0.0.1" "https://$domain/tai/" 2>/dev/null || echo 000)
    say "page -> HTTP $code (want 200)"
    curl -sS -m 10 -D - -o /dev/null --resolve "$domain:443:127.0.0.1" "https://$domain/tai/" 2>/dev/null | grep -iE '^(content-security-policy|x-frame-options|x-robots-tag|strict-transport)' | cut -c1-110 >&2 || true
    say "unauthenticated /tai/api/history -> $(curl -sS -m 10 -o /dev/null -w '%{http_code}' --resolve "$domain:443:127.0.0.1" "https://$domain/tai/api/history" 2>/dev/null) (want 401)"
    say "the world still answers: / -> $(curl -sS -m 10 -o /dev/null -w '%{http_code}' --resolve "$domain:443:127.0.0.1" "https://$domain/" 2>/dev/null) ; /nora-api/health -> $(curl -sS -m 10 -o /dev/null -w '%{http_code}' --resolve "$domain:443:127.0.0.1" "https://$domain/nora-api/health" 2>/dev/null)"
  else
    say "(not exposed through traefik)"
  fi
  [ "$ok" = 1 ]
}

smoke() {
  # smoke chat: a student with no Canvas or GitHub binding says hello (the model, the gateway, the container: no token involved)
  # smoke:      the owner, bound to their own Canvas user and GitHub login, asks about the week (real tokens, read-only)
  # smoke ask QUESTION ...: the same chat of the owner's, asked something of your own; the tools it used are listed after the answer
  # smoke admin QUESTION ...: the same, in the admin chat (folder main: class-wide tools, read-only view of the groups and the database)
  python3 - "$L" "$LOOP_PORT" "${1:-owner}" "${@:2}" <<'PY'
import json, sys, time, urllib.request
L, port, mode = sys.argv[1], sys.argv[2], sys.argv[3]
extra = " ".join(sys.argv[4:]).strip()
users = json.load(open(L + "/users.json"))["users"]
owner = next((u for u in users if u.get("role") == "owner"), None)
if mode in ("owner", "ask") and (not owner or not owner.get("canvasUserId")):
    sys.exit("no owner with a Canvas user id on the list: tai_live.sh users add EMAIL --owner --from-facts (or: smoke chat)")
base = "http://127.0.0.1:%s" % port
stamp = time.strftime("%d%H%M%S")      # a chat of its own every run: an earlier run's session and memories must not colour this one
def call(path, body=None):
    request = urllib.request.Request(base + path, data=json.dumps(body).encode() if body is not None else None, headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(request, timeout=120))
if mode == "admin":
    if not extra:
        sys.exit('tai_live.sh smoke admin "your question"')
    jid, who, question = "web:main", "the owner, in the admin chat", extra
    call("/api/register", {"jid": jid, "name": "Admin", "folder": "main"})
    name = (owner or {}).get("name", "owner")
elif mode == "chat":
    jid, who = "web:smoke-chat-" + stamp, "nobody (no Canvas or GitHub binding)"
    call("/api/register", {"jid": jid, "name": "Smoke (chat)", "folder": "smoke-chat-" + stamp})
    question, name = "hi! what can you help me with?", "smoke"
else:
    jid, who = "web:smoke-owner-" + stamp, "the owner, Canvas user %s" % owner["canvasUserId"]
    call("/api/register", {"jid": jid, "name": "Smoke (owner)", "folder": "smoke-owner-" + stamp, "canvasUserId": owner["canvasUserId"], "githubUsername": owner.get("githubUsername")})
    try:
        facts = json.load(open(L + "/owner-facts.json"))
    except (OSError, ValueError):
        facts = {}
    roles = set(x.strip() for x in str((facts.get("canvas") or {}).get("role", "")).split(","))
    if mode == "ask":
        if not extra:
            sys.exit('tai_live.sh smoke ask "your question"')
        question = extra
    elif roles & {"teacher", "ta", "designer"} and "student" not in roles:
        # grades are a student's: asked of a teacher's or a TA's account the answer is empty and looks like a failure
        question = "what is due this week, and what does the course material for this week cover?"
    else:
        question = "what is due this week, and how did I do on my latest graded assignment?"
    name = owner.get("name", "owner")
started = time.time()
call("/api/message", {"jid": jid, "text": question, "name": name})
print("asked (as %s): %s" % (who, question))
reply, seen, extras = None, 0, []
def take(entries):
    global reply, seen
    for entry in entries:
        seen = max(seen, entry["seq"])
        if entry["kind"] == "text" and reply is None:
            reply = entry["text"]
        elif entry["kind"] == "image":      # a picture with its caption is a whole answer on the page
            extras.append("a picture (%s KB), caption: %s" % (round((entry.get("bytes") or 0) / 1024), " ".join((entry.get("caption") or "-")[:200].split())))
            if reply is None and entry.get("caption"):
                reply = entry["caption"]
        elif entry["kind"] == "reaction":
            extras.append("a reaction %s to message %s" % (entry.get("emoji"), str(entry.get("messageId"))[:8]))
while time.time() - started < 240 and reply is None:
    take(json.load(urllib.request.urlopen("%s/api/outbox?jid=%s&after=%d&wait=20" % (base, jid, seen), timeout=60))["entries"])
if reply is not None:       # a reaction or a picture can come just after the words
    take(json.load(urllib.request.urlopen("%s/api/outbox?jid=%s&after=%d&wait=3" % (base, jid, seen), timeout=60))["entries"])
print("answered after %.0f s:" % (time.time() - started))
print((reply or "(no reply within 240 s)")[:1500 if mode in ("ask", "admin") else 900])
for extra in extras:
    print("  also sent: " + extra)
if mode in ("ask", "admin"):
    import glob
    folder = jid.split(":", 1)[1]
    files = sorted(glob.glob("%s/tai/data/sessions/%s/.claude/pi-sessions/*.jsonl" % (L, folder)), key=lambda f: f)
    calls, results = {}, {}
    for line in open(files[-1], encoding="utf-8") if files else []:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        msg = row.get("message") or row
        if msg.get("role") == "assistant" and isinstance(msg.get("content"), list):
            for block in msg["content"]:
                if isinstance(block, dict) and block.get("type") == "toolCall":
                    calls[block.get("id")] = "%s %s" % (block.get("name"), json.dumps(block.get("arguments"), ensure_ascii=False)[:70])
        elif msg.get("role") == "toolResult":
            text = "".join(b.get("text", "") for b in (msg.get("content") or []) if isinstance(b, dict))
            results[msg.get("toolCallId")] = ("ERR" if msg.get("isError") else "ok", " ".join(text[:110].split()))
    print("tools used (%d):" % len(calls))
    for cid, label in calls.items():
        state, head = results.get(cid, ("?", ""))
        print("  [%s] %s%s" % (state, label, ("  -> " + head) if state == "ERR" else ""))
PY
}

smoke_voice() {      # smoke_voice [chat|interview]: the WAV is played into a real call through the page's socket; what came back is reported
  local mode=${1:-chat} wav="$L/smoke-voice.wav" owner origin
  [ -f "$wav" ] || die "no $wav: run it from the PC (tai_live.sh smoke voice), which makes the test voice and puts it there"
  [ -f "$T/dist/voice/smoke-client.js" ] || die "this build has no voice smoke client (dist/voice/smoke-client.js): deploy first"
  owner=$(python3 -c "import json; print(next(u['email'] for u in json.load(open('$L/users.json'))['users'] if u.get('role')=='owner'))" 2>/dev/null) || die "no owner on the list: tai_live.sh users add EMAIL --owner"
  origin=$(grep -m1 '^TAI_PORTAL_ORIGIN=' "$L/orch.env" | cut -d= -f2-)
  node "$T/dist/voice/smoke-client.js" --socket "$SOCKET" --origin "$origin" --users "$L/users.json" --secret "$L/portal-secret" --email "$owner" --wav "$wav" --mode "$mode"
}

voice_cmd() {
  case "${1:-status}" in
    status)
      echo "voice:      $(grep -m1 '^TAI_VOICE=' "$L/orch.env" 2>/dev/null | cut -d= -f2- | sed 's/^1$/on/; s/^0$/off/' | grep . || echo 'off (no setting)')"
      echo "Deepgram:   key $([ -n "$(grep -m1 '^DEEPGRAM_API_KEY=' "$L/credentials.env" 2>/dev/null)" ] && echo stored || echo 'NOT stored: tai_credentials.sh deepgram')"
      echo "relay:      gateway on 127.0.0.1:$VOICE_LLM_PORT -> HTTP $(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$VOICE_LLM_PORT/health/liveliness" 2>/dev/null || echo 'none')"
      models_answer "$(grep -m1 '^TAI_VOICE_MODEL=' "$L/orch.env" 2>/dev/null | cut -d= -f2- | tr -d '"' | grep . || echo qwen)" | sed 's/^/models:     /' || true
      echo "interview:  link secret $([ -s "$L/voice-secret" ] && echo made || echo MISSING), links open $(grep -m1 '^VOICE_BASE_URL=' "$L/base.env" 2>/dev/null | cut -d= -f2-)"
      ;;
    enable) set_cmd TAI_VOICE=1 ;;
    disable) set_cmd TAI_VOICE=0 ;;
    lab)
      # the voice lab (docs/VOICE_SELFBUILT.md): is it on, and the per-turn trace of its calls (one line a turn; p50 and p90 of the waits at the end). No words are read from it but the first 80
      # characters the owner said in a turn: the endpoint is his alone.
      local n="${2:-12}" file="$T/data/voice-lab/turns.jsonl" setting
      case "$n" in ''|*[!0-9]*) die "tai_live.sh voice lab [N]   the last N turns of the lab's calls (default 12)" ;; esac
      setting() { grep -m1 "^$1=" "$L/orch.env" 2>/dev/null | cut -d= -f2- | tr -d '"' | grep . || echo "$2"; }
      echo "lab:        $(setting TAI_VOICE_LAB off | sed 's/^1$/on/')  ears $(setting TAI_VOICE_LAB_EARS 'labgpu (default)')  mouth $(setting TAI_VOICE_LAB_MOUTH 'labgpu (default)')  fallback ears $(setting TAI_VOICE_LAB_EARS_FALLBACK 'flux (default)')  eager end of turn $(setting TAI_VOICE_LAB_EAGER_EOT 'off (chains h, fd, c: 0.45)')  barge-in $(setting TAI_VOICE_LAB_BARGE_MS '200 (default)') ms of loud speech in $(setting TAI_VOICE_LAB_BARGE_WINDOW_MS '300 (default)') ms"
      [ -s "$file" ] || { echo "trace:      none yet ($file)"; return 0; }
      python3 - "$file" "$n" <<'PY'
import json, sys
rows = []
with open(sys.argv[1], encoding="utf-8") as handle:
    for line in handle:
        try:
            rows.append(json.loads(line))
        except ValueError:
            pass
def pct(values, p):
    values = sorted(values)
    return values[int((len(values) - 1) * p)] if values else None
last = rows[-int(sys.argv[2]):]
print("trace:      %d turn(s) in all; the last %d (ms: eot = end of speech to the committed turn, total = committed turn to first audio, whole = end of speech to first audio)" % (len(rows), len(last)))
for r in last:
    d = r.get("derived", {})
    extra = []
    if r.get("bargeIn"): extra.append("barge-in by %s, %d sentence(s) spoken" % (r["bargeIn"].get("by"), len(r["bargeIn"].get("spoken", []))))
    for f in r.get("functions", []): extra.append("%s %s ms" % (f.get("name"), (f.get("answeredAt") or 0) - f.get("startedAt", 0)))
    if r.get("fillers"): extra.append("%d filler(s)" % len(r["fillers"]))
    for sp in r.get("specs", []):
        extra.append("eager %s%s" % (sp.get("outcome"), (": " + sp["why"]) if sp.get("why") else (" %s ms ahead" % d.get("headStart", "?"))))
    if r.get("shadow"): extra.append("%s heard: %s" % (r["shadow"].get("ears"), json.dumps(" / ".join(f.get("text", "") for f in r["shadow"].get("finals", [])))[:90]))
    if r.get("fallbacks"): extra.append("fallbacks " + ",".join(r["fallbacks"]))
    print("  %s %s %-9s %s%s+%s #%-2s eot %5s total %5s whole %5s  %s%s" % (r.get("at", "")[11:19], r.get("sid", ""), r.get("mode", ""), (r["chain"] + ":") if r.get("chain") else "", r.get("ears", ""), r.get("mouth", ""), r.get("turn", ""), d.get("eotWait", "-"), d.get("total", "-"), d.get("fromSpeechEnd", "-"), json.dumps(r.get("userText", ""))[:60], ("  [" + "; ".join(extra) + "]") if extra else ""))
for label, key in (("end of speech to committed turn", "eotWait"), ("committed turn to first audio", "total"), ("end of speech to first audio", "fromSpeechEnd")):
    v = [r["derived"][key] for r in rows if isinstance(r.get("derived", {}).get(key), (int, float))]
    plain = [r["derived"][key] for r in rows if isinstance(r.get("derived", {}).get(key), (int, float)) and not r.get("functions")]
    if v: print("  %-32s n=%d p50 %s p90 %s ms; turns with no function n=%d p50 %s p90 %s ms" % (label, len(v), pct(v, .5), pct(v, .9), len(plain), pct(plain, .5), pct(plain, .9)))
over = [rd["afterAnswerMs"] for r in rows for rd in r.get("rounds", []) if isinstance(rd.get("afterAnswerMs"), (int, float))]
if over: print("  %-32s n=%d p50 %s p90 %s ms (docs/VOICE_SELFBUILT.md C5, amendment A3: p90 <= 100)" % ("function answer to next request", len(over), pct(over, .5), pct(over, .9)))
# round 2 (amendment A10): the eager requests and what became of them, and the whole wait of the plain turns by chain
specs = [sp for r in rows for sp in r.get("specs", [])]
if specs:
    by = {}
    for sp in specs:
        key = "adopted" if sp.get("outcome") == "adopted" else "dropped (%s)" % sp.get("why")
        by[key] = by.get(key, 0) + 1
    print("  eager requests: %d  %s" % (len(specs), "; ".join("%s %d" % kv for kv in sorted(by.items()))))
# C12 (a): no function may have been started for a turn before the turn was confirmed (a held answer asks nothing of the session); every function's start is at or after its turn's commit
early = sum(1 for r in rows if r.get("commit") is not None for f in r.get("functions", []) if f.get("startedAt", 0) < r["commit"])
if any(r.get("specs") for r in rows) or any(r.get("chain") in ("h", "fd", "c") for r in rows): print("  functions started before their turn's commit: %d (C12 a: must be 0)" % early)
heads = [r["derived"]["headStart"] for r in rows if isinstance(r.get("derived", {}).get("headStart"), (int, float))]
if heads: print("  %-32s n=%d p50 %s p90 %s ms (the model was asked this long before the turn was confirmed)" % ("head start of adopted requests", len(heads), pct(heads, .5), pct(heads, .9)))
for chain in sorted({r.get("chain", "") for r in rows}):
    mine = [r["derived"]["fromSpeechEnd"] for r in rows if r.get("chain", "") == chain and not r.get("functions") and isinstance(r.get("derived", {}).get("fromSpeechEnd"), (int, float))]
    if mine and (chain or len({r.get("chain", "") for r in rows}) > 1): print("  chain %-4s plain turns, end of speech to first audio: n=%d p50 %s p90 %s ms" % (chain or "(none)", len(mine), pct(mine, .5), pct(mine, .9)))
PY
      ;;
    *) die "tai_live.sh voice status|enable|disable|lab [N]" ;;
  esac
}

# ---- notifications (src/notify, docs/NOTIFICATIONS.md): the VAPID key pair, and what is subscribed. Nothing here prints a private key, an endpoint or a student's folder.
vapid_public() {     # vapid_public FILE: the public key of the private key in FILE (base64url of the 32-byte scalar, or a PEM), unpadded base64url; empty when it cannot be read
  node -e '
const c = require("node:crypto"), fs = require("node:fs");
try {
  const t = fs.readFileSync(process.argv[1], "utf8").trim();
  let pub;
  if (t.startsWith("-----BEGIN")) {
    const k = c.createPublicKey(c.createPrivateKey(t)).export({ format: "jwk" });
    pub = Buffer.concat([Buffer.from([4]), Buffer.from(k.x, "base64url"), Buffer.from(k.y, "base64url")]).toString("base64url");
  } else {
    const d = Buffer.from(t, "base64url");
    if (!/^[A-Za-z0-9_-]{43}$/.test(t) || d.length !== 32) throw new Error("not a 32-byte key");
    const e = c.createECDH("prime256v1");
    e.setPrivateKey(d);
    pub = e.getPublicKey().toString("base64url");
  }
  console.log(pub);
} catch (err) { process.exit(1); }
' "$1" 2>/dev/null || true
}

notify_cmd() {
  local orch="$L/orch.env" file
  file=$(grep -m1 '^TAI_VAPID_KEY_FILE=' "$orch" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  case "${1:-status}" in
    status)
      local on=off
      case "$(grep -m1 '^TAI_NOTIFY=' "$orch" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr 'A-Z' 'a-z')" in 1|true|on|yes) on=on ;; esac
      echo "notify:        $on (TAI_NOTIFY)"
      if [ -z "$file" ]; then echo "VAPID key:     none named (TAI_VAPID_KEY_FILE is not set): tai_live.sh notify vapid"
      elif [ ! -s "$file" ]; then echo "VAPID key:     TAI_VAPID_KEY_FILE names a file that is missing or empty: tai_live.sh notify vapid"
      elif [ -z "$(vapid_public "$file")" ]; then echo "VAPID key:     the file is there but is not a key this host can read: tai_live.sh notify vapid --force"
      else echo "VAPID key:     present (mode $(stat -c %a "$file" 2>/dev/null || echo '?'); never shown)"; fi
      # e-mail: whether it is on and whether everything it needs is there (yes or no, and the names of what is missing: no value, no address, no password)
      local mail_on=off mail_missing=() mail_login=
      case "$(grep -m1 '^TAI_NOTIFY_EMAIL=' "$orch" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr 'A-Z' 'a-z')" in 1|true|on|yes) mail_on=on ;; esac
      [ -n "$(grep -m1 '^TAI_SMTP_HOST=.' "$orch" 2>/dev/null)" ] || mail_missing+=(TAI_SMTP_HOST)
      [ -n "$(grep -m1 '^TAI_NOTIFY_FROM=.' "$orch" 2>/dev/null)" ] || mail_missing+=(TAI_NOTIFY_FROM)
      if [ -n "$(grep -m1 '^TAI_SMTP_USER=.' "$orch" 2>/dev/null)" ]; then
        mail_login=", login and password"
        [ -n "$(grep -m1 '^SMTP_PASSWORD=.' "$L/credentials.env" 2>/dev/null)" ] || mail_missing+=("SMTP_PASSWORD (tai_credentials.sh smtp)")
      fi
      if [ ${#mail_missing[@]} -gt 0 ]; then echo "email:         $mail_on (TAI_NOTIFY_EMAIL); NOT configured, missing: ${mail_missing[*]}"
      else echo "email:         $mail_on (TAI_NOTIFY_EMAIL); configured (server, from address$mail_login)"; fi
      python3 - "$T/store/portal" <<'PY'
import json, os, sys
folder = sys.argv[1]
students = browsers = mail = zones = files = 0
try:
    names = sorted(os.listdir(folder))
except OSError:
    names = []
for name in names:
    if not name.endswith(".prefs.json"):
        continue
    files += 1
    try:
        with open(os.path.join(folder, name), encoding="utf-8") as handle:
            doc = json.load(handle)
    except (OSError, ValueError):
        continue
    if not isinstance(doc, dict):
        continue
    notify = doc.get("notify") if isinstance(doc.get("notify"), dict) else {}
    push = notify.get("push") if isinstance(notify.get("push"), list) else []
    count = sum(1 for s in push if isinstance(s, dict) and isinstance(s.get("endpoint"), str))
    browsers += count
    students += 1 if count else 0
    email = notify.get("email")
    mail += 1 if isinstance(email, dict) and email.get("enabled") is True else 0
    zones += 1 if isinstance(doc.get("tz"), str) else 0
print("subscriptions: %d browser(s) of %d student(s); e-mail on for %d; %d preference file(s), %d with a time zone" % (browsers, students, mail, files, zones))
PY
      ;;
    vapid)
      local force=0 public tmp
      case "${2:-}" in "") ;; --force) force=1 ;; *) die "tai_live.sh notify status|vapid [--force]" ;; esac
      [ -n "$file" ] || file="$L/vapid.key"
      if [ -s "$file" ] && [ "$force" = 0 ]; then
        public=$(vapid_public "$file")
        [ -n "$public" ] || die "$file exists but is not a key this host can read: nothing was changed (tai_live.sh notify vapid --force makes a new one)"
        say "a VAPID key is there already ($file): left as it is. To replace it, which ends every student's subscription: tai_live.sh notify vapid --force"
        ensure_orch_key TAI_VAPID_KEY_FILE "$file"
      else
        [ ! -s "$file" ] || { cp -p "$file" "$file.previous"; say "the key that was there is kept as $file.previous (mode 600)"; }
        tmp=$(mktemp "$(dirname "$file")/.vapid.XXXXXX")
        # (getPrivateKey() drops leading zero bytes, and one key in 256 begins with one: the scalar is padded to the 32 bytes the service reads)
        node -e 'const c = require("node:crypto"); const e = c.createECDH("prime256v1"); e.generateKeys(); const k = e.getPrivateKey(); process.stdout.write(Buffer.concat([Buffer.alloc(32 - k.length), k]).toString("base64url") + "\n");' > "$tmp" || { rm -f "$tmp"; die "could not make a key (is Node there?)"; }
        chmod 600 "$tmp"
        mv "$tmp" "$file"
        public=$(vapid_public "$file")
        [ -n "$public" ] || die "the key that was made cannot be read back: $file"
        # the setting the service reads, and no public key left over from an earlier pair (a disagreeing VAPID_PUBLIC_KEY keeps push off)
        { grep -v -e '^TAI_VAPID_KEY_FILE=' -e '^VAPID_PUBLIC_KEY=' "$orch" 2>/dev/null || true; echo "TAI_VAPID_KEY_FILE=$file"; } > "$orch.new"
        mv "$orch.new" "$orch"
        chmod 600 "$orch"
        say "VAPID key pair made: the private key is in $file (mode 600, never printed); TAI_VAPID_KEY_FILE is set. Next: tai_live.sh set TAI_NOTIFY=1, then restart"
      fi
      say "the public key, which the page hands to browsers (not a secret):"
      echo "$public"
      ;;
    *) die "tai_live.sh notify status|vapid [--force]" ;;
  esac
}

smoke_clean() {      # smoke_clean [--yes]: the registry rows, folders, sessions and memories of the smoke tests' chats (folders smoke-*); no student's is ever matched
  local yes=0 db="$T/store/messages.db"
  [ "${1:-}" != --yes ] || yes=1
  [ -f "$db" ] || die "no database at $db"
  if [ "$yes" = 1 ]; then
    say "stopping the service, keeping a copy of the database first"
    sudo -n systemctl stop "$UNIT"
    cp -p "$db" "$db.bak-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  python3 - "$db" "$T" "$yes" <<'PY'
import json, os, shutil, sqlite3, sys
db, tree, yes = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
con = sqlite3.connect(db)
cols = lambda table: [row[1] for row in con.execute('pragma table_info("%s")' % table)]
tables = [row[0] for row in con.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '%_fts%'")]
groups = con.execute("select jid, folder from registered_groups where folder like 'smoke-%'").fetchall()
jids, folders = [g[0] for g in groups], [g[1] for g in groups]
print("%d smoke chat(s): %s" % (len(groups), ", ".join(sorted(folders)) or "-"))
task_ids = []
if "scheduled_tasks" in tables:
    task_ids = [row[0] for row in con.execute("select id from scheduled_tasks where group_folder like 'smoke-%'")]
marks = lambda items: ",".join("?" * len(items))
for table in tables:
    where, args = [], []
    for col, values in (("jid", jids), ("chat_jid", jids), ("folder", folders), ("group_folder", folders), ("student_folder", folders), ("task_id", task_ids)):
        if col in cols(table) and values:
            where.append("%s in (%s)" % (col, marks(values)))
            args += values
    if not where:
        continue
    n = con.execute('select count(*) from "%s" where %s' % (table, " or ".join(where)), args).fetchone()[0]
    if n:
        print("  %-24s %d row(s)" % (table, n))
    if yes and n:
        con.execute('delete from "%s" where %s' % (table, " or ".join(where)), args)
if "router_state" in tables and jids:
    for key, value in con.execute("select key, value from router_state").fetchall():
        try:
            data = json.loads(value)
        except ValueError:
            continue
        if isinstance(data, dict) and any(j in data for j in jids):
            print("  router_state %-12s %d key(s)" % (key, sum(1 for j in jids if j in data)))
            if yes:
                con.execute("update router_state set value = ? where key = ?", (json.dumps({k: v for k, v in data.items() if k not in jids}), key))
con.commit()
if yes:
    for folder in folders:
        for base in ("groups", "data/sessions", "data/ipc", "store/portal-media"):
            path = os.path.join(tree, base, folder)
            if os.path.isdir(path) and os.path.basename(path).startswith("smoke-"):
                shutil.rmtree(path, ignore_errors=True)
    print("removed their folders too")
else:
    print("(nothing was changed: with --yes this is what goes)")
PY
  if [ "$yes" = 1 ]; then
    sudo -n systemctl start "$UNIT"
    wait_portal && say "the service is up again" || die "the service did not come up"
  fi
}

# ---- backups: a dated copy of what students' chats and records are. Never a secret: no .env, credentials, portal secret or gateway key.
BACKUPS="$L/backups"
backup_now() {
  local stamp out work part
  mkdir -p "$BACKUPS"
  chmod 700 "$BACKUPS"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  out="$BACKUPS/tai-$stamp.tgz"
  work=$(mktemp -d "$BACKUPS/.work-XXXXXX")
  mkdir -p "$work/store"
  # SQLite's own online backup: a plain copy of a database in use can be torn
  python3 - "$T/store/messages.db" "$work/store/messages.db" <<'PY'
import sqlite3, sys
src = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
dst = sqlite3.connect(sys.argv[2])
src.backup(dst)
dst.close()
src.close()
PY
  for part in store/portal store/portal-media groups data/sessions; do
    if [ -e "$T/$part" ]; then
      mkdir -p "$work/$(dirname "$part")"
      if [ "$part" = store/portal ]; then
        # the prepared documents (store/portal/docs: page images and words, up to 60 MB a student) are made again from the files in groups/<folder>/uploads: they are not records, and they are big
        mkdir -p "$work/$part"
        find "$T/$part" -mindepth 1 -maxdepth 1 ! -name docs -exec cp -a {} "$work/$part/" \;
      else
        cp -a "$T/$part" "$work/$part"
      fi
    fi
  done
  find "$work/groups" -type d -name logs -prune -exec rm -rf {} + 2>/dev/null || true       # logs are not records
  cp -p "$L/users.json" "$work/users.json"
  tar -C "$work" -czf "$out.part" . && mv "$out.part" "$out"
  rm -rf "$work"
  chmod 600 "$out"
  ls -1t "$BACKUPS"/tai-*.tgz 2>/dev/null | tail -n +15 | xargs -r rm -f                  # the newest fourteen stay
  say "backup: $out ($(du -h "$out" | cut -f1)); $(ls -1 "$BACKUPS"/tai-*.tgz | wc -l) kept"
}

backup_cmd() {
  case "${1:-list}" in
    now) backup_now ;;
    list) ls -lht "$BACKUPS"/tai-*.tgz 2>/dev/null | awk '{print "  " $6, $7, $8, $5, $9}' || true
          echo "timer: $(systemctl is-active tai-live-backup.timer 2>/dev/null | head -n 1)" ;;
    *) die "tai_live.sh backup now|list|pull [dir]" ;;
  esac
}

# one nightly job as a systemd timer that runs this script's own copy kept on the host (the copy streamed for a command is gone when it ends)
install_timer() {      # install_timer NAME DESCRIPTION HH:MM COMMAND
  local name=$1 desc=$2 at=$3 command=$4
  sudo -n tee "/etc/systemd/system/tai-live-$name.service" >/dev/null <<EOF
[Unit]
Description=TAi live: $desc
[Service]
Type=oneshot
User=$(id -un)
ExecStart=/usr/bin/env bash $L/bin/tai_live.sh --on-host $command
EOF
  sudo -n tee "/etc/systemd/system/tai-live-$name.timer" >/dev/null <<EOF
[Unit]
Description=TAi live: $desc, every night
[Timer]
OnCalendar=*-*-* $at:00 UTC
Persistent=true
RandomizedDelaySec=600
[Install]
WantedBy=timers.target
EOF
  sudo -n systemctl daemon-reload
  sudo -n systemctl enable --now "tai-live-$name.timer" >/dev/null 2>&1
  say "$name: $(systemctl list-timers "tai-live-$name.timer" --no-pager 2>/dev/null | sed -n 2p | cut -c1-90)"
}

timers_cmd() {
  case "${1:-}" in
    on)
      [ -f "$L/bin/tai_live.sh" ] || die "the script is not on the host yet: run this from the PC (it uploads it first)"
      install_timer backup "a dated copy of the students' chats and records" 08:30 "backup now"
      install_timer corpus "the knowledge corpus rebuilt from the pages the world publishes" 09:15 "corpus" ;;
    off)
      sudo -n systemctl disable --now tai-live-backup.timer tai-live-corpus.timer >/dev/null 2>&1 || true
      say "the nightly jobs are off" ;;
    *) die "tai_live.sh timers on|off" ;;
  esac
}

humanness() {        # humanness [report options]: the report of src/humanness (read-only; the judge, with --judge N, asks the gateway)
  [ -f "$T/dist/humanness/cli.js" ] || die "this build has no humanness report (dist/humanness/cli.js): deploy first"
  local dump key url
  dump=$(grep -m1 '^TAI_VOICE_RELAY_DUMP=' "$L/orch.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  key=$(grep -m1 '^TAI_VOICE_LLM_KEY=' "$L/orch.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  url=$(grep -m1 '^TAI_VOICE_LLM_URL=' "$L/orch.env" 2>/dev/null | cut -d= -f2- | tr -d '"' || true)
  ( cd "$T" && TAI_VOICE_LLM_KEY="$key" TAI_VOICE_LLM_URL="${url:-http://127.0.0.1:$VOICE_LLM_PORT}" "$L/node/bin/node" dist/humanness/cli.js --store store --groups groups ${dump:+--dump "$dump"} "$@" )
}

# ---- running a student's Go code (docs/GO_SANDBOX.md): the image, the shared module cache, and the checks. The orchestrator itself starts the containers; these are the operator's.
SANDBOX_IMAGE=tai-go-sandbox:live
sandbox_dir() { echo "$T/data/sandbox"; }
sandbox_runtime() { grep -m1 '^TAI_SANDBOX_RUNTIME=' "$L/orch.env" 2>/dev/null | cut -d= -f2- | tr -d '" ' || true; }   # the service's runtime setting; empty: Docker's default

sandbox_build() {      # sandbox_build [--base IMAGE]: the context was shipped by the PC-side part of this script into $L/sandbox-build
  local base="" ctx="$L/sandbox-build" log="$L/logs/sandbox-build.log"
  while [ $# -gt 0 ]; do
    case "$1" in
      --base) [ -n "${2:-}" ] || die "--base needs an image name"; base=$2; shift 2 ;;
      *) die "tai_live.sh sandbox build [--base IMAGE]" ;;
    esac
  done
  [ -z "$base" ] || [[ "$base" =~ ^[A-Za-z0-9._/:@-]+$ ]] || die "--base is not an image name: $base"
  command -v docker >/dev/null || die "docker is not available on this host"
  [ -f "$ctx/Dockerfile" ] || die "no build context at $ctx: run this from the PC (it ships deploy/cs6650/sandbox first)"
  mkdir -p "$L/logs"
  say "== sandbox image $SANDBOX_IMAGE from $ctx: at most 2 CPUs and 3 GB for about ten minutes (the standard library and the course's usual third-party packages are compiled into it); not in class hours"
  local args=(--cpu-period=100000 --cpu-quota=200000 --memory=3g --memory-swap=3g -t "$SANDBOX_IMAGE")
  [ -z "$base" ] || args+=(--build-arg "GO_IMAGE=$base")
  if ! docker build "${args[@]}" "$ctx" > "$log" 2>&1; then
    tail -n 12 "$log" | cut -c1-200 >&2
    if grep -q toomanyrequests "$log"; then
      say "Docker Hub's pull limit for this address was reached. Wait, or build from a mirror of the same official image: tai_live.sh sandbox build --base mirror.gcr.io/library/golang:<go version>-bookworm"
    fi
    die "the sandbox image did not build (log: $log)"
  fi
  say "built $SANDBOX_IMAGE ($(docker images --format '{{.Size}}' "$SANDBOX_IMAGE")); the next step: tai_live.sh sandbox warm"
}

sandbox_warm() {      # the shared module cache, filled through a container with a network that runs `go mod download` and nothing else (the same one the runner uses), once for each module of warm/
  local dir cache src group run n=0
  dir=$(sandbox_dir); cache="$dir/gomodcache"; src="$L/sandbox-build/warm"
  docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1 || die "no $SANDBOX_IMAGE yet: tai_live.sh sandbox build"
  compgen -G "$src/*/go.mod" >/dev/null || die "no warm list at $src/*/go.mod: tai_live.sh sandbox build ships it (deploy/cs6650/sandbox/warm/)"
  mkdir -p "$cache"
  for group in "$src"/*/; do
    [ -f "$group/go.mod" ] || continue
    n=$((n + 1))
    run=$(mktemp -d "$L/.sandbox-warm.XXXXXX")
    mkdir -p "$run/in/files"
    cp "$group/go.mod" "$run/in/files/go.mod"
    chmod -R a+rX "$run/in"
    say "== downloading $(basename "$group") into $cache (checked against the Go checksum database; no student code runs here)"
    if ! docker run --rm --name "tai-sandbox-warm-$$" --label tai-sandbox=1 --pull never --init --log-driver none --cap-drop ALL --security-opt no-new-privileges --read-only         --pids-limit 128 --memory 1g --memory-swap 1g --cpus 1 --user "$(id -u):$(id -g)" --ulimit nofile=256:256 --ulimit core=0 --hostname sandbox         --tmpfs /tmp:rw,exec,nosuid,nodev,size=512m --tmpfs /work:rw,exec,nosuid,nodev,size=96m,mode=1777 --workdir /work         -v "$run/in:/in:ro" -v "$cache:/gomodcache:rw"         -e 'GOFLAGS=-mod=mod -modcacherw' -e GOPROXY=https://proxy.golang.org -e GOSUMDB=sum.golang.org -e GOTOOLCHAIN=local -e GOPRIVATE= -e GONOSUMDB= -e GONOPROXY= -e GOINSECURE=         -e GOMODCACHE=/gomodcache -e GOCACHE=/tmp/gocache -e GOPATH=/tmp/gopath -e HOME=/tmp -e GOWORK=off -e 'GOVCS=*:off'         "$SANDBOX_IMAGE" /usr/local/bin/sandbox-modules 600 - 2>&1 | tail -n 15 >&2; then
      rm -rf "$run"
      die "the download of $(basename "$group") failed"
    fi
    rm -rf "$run"
  done
  say "module cache: $(du -sm "$cache" | cut -f1) MB in $cache ($n module(s) of the warm list)"
}

sandbox_status() {
  local dir; dir=$(sandbox_dir)
  if docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1; then
    echo "image:        $SANDBOX_IMAGE present, $(docker images --format '{{.Size}}' "$SANDBOX_IMAGE"), built $(docker image inspect "$SANDBOX_IMAGE" --format '{{.Created}}' | cut -c1-19)"
  else
    echo "image:        $SANDBOX_IMAGE NOT built (tai_live.sh sandbox build): running code is off"
  fi
  local rt known
  rt=$(sandbox_runtime)
  if [ -z "$rt" ]; then
    echo "runtime:      Docker's default (runc; TAI_SANDBOX_RUNTIME is not set)"
  else
    known=$(docker info --format '{{range $k, $v := .Runtimes}}{{$k}} {{end}}' 2>/dev/null || true)
    case "$rt" in
      runc|runsc)
        if [[ " $known " == *" $rt "* ]]; then echo "runtime:      $rt (TAI_SANDBOX_RUNTIME; Docker knows it)"
        else echo "runtime:      $rt (TAI_SANDBOX_RUNTIME) but Docker does NOT know it: running code is off until it does (docs/GO_SANDBOX.md, gVisor)"; fi ;;
      *) echo "runtime:      TAI_SANDBOX_RUNTIME=$rt is not runc or runsc: running code is off" ;;
    esac
  fi
  echo "module cache: $([ -d "$dir/gomodcache" ] && du -sm "$dir/gomodcache" | cut -f1 || echo 0) MB in $dir/gomodcache (the orchestrator empties it above 3000 MB: SANDBOX_LIMITS.moduleCacheMb; sandbox warm refills it)"
  echo "containers:   $(docker ps --filter 'label=tai-sandbox=1' --format '{{.Names}}' | grep -c . || true) sandbox container(s) running"
  echo "run dirs:     $(find "$dir" -maxdepth 1 -type d -name 'run-*' 2>/dev/null | wc -l) left in $dir"
  python3 - "$T/store/messages.db" 2>/dev/null <<'PY' || echo "runs:         no data (the database could not be read)"
import sqlite3, sys, time
con = sqlite3.connect("file:%s?mode=ro" % sys.argv[1], uri=True)
try:
    since = int((time.time() - 3600) * 1000)
    hour = con.execute("select count(*), count(distinct student_folder) from sandbox_runs where started_at >= ?", (since,)).fetchone()
    day = con.execute("select count(*) from sandbox_runs where started_at >= ?", (since - 23 * 3600 * 1000,)).fetchone()
    print("runs:         %d in the last hour (%d student(s)), %d in the last day" % (hour[0], hour[1], day[0]))
except sqlite3.OperationalError:
    print("runs:         n/a (no sandbox_runs table yet: this build has not run since the sandbox was deployed)")
PY
}

sandbox_smoke() {      # the checks of docs/GO_SANDBOX.md against the real image
  [ -f "$T/dist/sandbox/smoke.js" ] || die "this build has no sandbox smoke (dist/sandbox/smoke.js): deploy first"
  docker image inspect "$SANDBOX_IMAGE" >/dev/null 2>&1 || die "no $SANDBOX_IMAGE yet: tai_live.sh sandbox build"
  local rt a
  rt=$(sandbox_runtime)
  for a in "$@"; do [ "$a" != --runtime ] || rt=""; done   # the caller named one: theirs
  [ -z "$rt" ] || set -- "$@" --runtime "$rt"
  say "== the sandbox smoke ($([ -n "$rt" ] && echo "the service's runtime: $rt" || echo "runtime: as given, else Docker's default")): hostile programs and archives, up to 2 CPUs for several minutes; not in class hours, not during a voice call"
  ( cd "$T" && node dist/sandbox/smoke.js "$@" )
}

sandbox_cmd() {
  local sub=${1:-status}
  shift || true
  case "$sub" in
    build) sandbox_build "$@" ;;
    warm) sandbox_warm ;;
    status) sandbox_status ;;
    smoke) sandbox_smoke "$@" ;;
    *) die "tai_live.sh sandbox build [--base IMAGE] | warm | status | smoke [--only TEXT] [--runtime runc|runsc]" ;;
  esac
}

# ---- the document viewer's renderer (docs/DOCUMENTS.md): the image, what is kept, and the checks. The orchestrator itself starts the containers; these are the operator's.
DOC_IMAGE=tai-doc:live
doc_dir() { echo "$T/data/docs"; }
doc_store() { echo "$T/store/portal/docs"; }

doc_build() {      # doc_build [--base IMAGE]: the context was shipped by the PC-side part of this script into $L/doc-build
  local base="" ctx="$L/doc-build" log="$L/logs/doc-build.log"
  while [ $# -gt 0 ]; do
    case "$1" in
      --base) [ -n "${2:-}" ] || die "--base needs an image name"; base=$2; shift 2 ;;
      *) die "tai_live.sh doc build [--base IMAGE]" ;;
    esac
  done
  [ -z "$base" ] || [[ "$base" =~ ^[A-Za-z0-9._/:@-]+$ ]] || die "--base is not an image name: $base"
  command -v docker >/dev/null || die "docker is not available on this host"
  [ -f "$ctx/Dockerfile" ] || die "no build context at $ctx: run this from the PC (it ships deploy/cs6650/doc-render first)"
  mkdir -p "$L/logs"
  say "== document renderer image $DOC_IMAGE from $ctx: at most 2 CPUs and 3 GB for about twelve minutes the first time (poppler, LibreOffice and fonts from the Debian mirrors; under a minute when only the scripts changed); not in class hours"
  local args=(--cpu-period=100000 --cpu-quota=200000 --memory=3g --memory-swap=3g -t "$DOC_IMAGE")
  [ -z "$base" ] || args+=(--build-arg "BASE_IMAGE=$base")
  if ! docker build "${args[@]}" "$ctx" > "$log" 2>&1; then
    tail -n 12 "$log" | cut -c1-200 >&2
    if grep -q toomanyrequests "$log"; then
      say "Docker Hub's pull limit for this address was reached. Wait, or build from a mirror of the same image: tai_live.sh doc build --base mirror.gcr.io/library/python:3.12-slim"
    fi
    die "the document renderer image did not build (log: $log)"
  fi
  say "built $DOC_IMAGE ($(docker images --format '{{.Size}}' "$DOC_IMAGE")); the next step: tai_live.sh doc smoke (after a deploy that has dist/docs/smoke.js)"
}

doc_status() {
  local dir store docs students
  dir=$(doc_dir); store=$(doc_store)
  if docker image inspect "$DOC_IMAGE" >/dev/null 2>&1; then
    echo "image:        $DOC_IMAGE present, $(docker images --format '{{.Size}}' "$DOC_IMAGE"), built $(docker image inspect "$DOC_IMAGE" --format '{{.Created}}' | cut -c1-19)"
  else
    echo "image:        $DOC_IMAGE NOT built (tai_live.sh doc build): opening documents is off"
  fi
  docs=0; students=0
  if [ -d "$store" ]; then
    docs=$(find "$store" -mindepth 2 -maxdepth 2 -type d -regextype posix-extended -regex '.*/[0-9a-f]{32}' 2>/dev/null | wc -l | tr -d ' ')
    students=$(find "$store" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
  fi
  echo "documents:    $docs prepared document(s) of $students student(s), $([ -d "$store" ] && du -sm "$store" | cut -f1 || echo 0) MB in $store (kept 30 days after the last open, at most 8 documents and 60 MB a student; the backup leaves them out)"
  echo "course docs:  $(find "$T/store/course-docs" -mindepth 1 -maxdepth 1 -type d -regextype posix-extended -regex '.*/[0-9a-f]{32}' 2>/dev/null | wc -l | tr -d ' ') in $T/store/course-docs (tai_live.sh course-docs list)"
  echo "containers:   $(docker ps -a --filter 'label=tai-doc=1' --format '{{.Names}}' | grep -c . || true) renderer container(s) running or left, $(docker ps -a --filter 'label=tai-doc-operator=1' --format '{{.Names}}' | grep -c . || true) of the operator's"
  echo "run dirs:     $(find "$dir" -maxdepth 1 -type d -name 'run-*' 2>/dev/null | wc -l | tr -d ' ') left in $dir"
}

doc_smoke() {      # the checks of docs/DOCUMENTS.md against the real image
  [ -f "$T/dist/docs/smoke.js" ] || die "this build has no document smoke (dist/docs/smoke.js): deploy first"
  docker image inspect "$DOC_IMAGE" >/dev/null 2>&1 || die "no $DOC_IMAGE yet: tai_live.sh doc build"
  say "== the document smoke: real PDFs (text, 10 and 150 pages, a scan, damaged and hostile files), up to 2 CPUs for a few minutes; not in class hours, not during a voice call"
  ( cd "$T" && node dist/docs/smoke.js "$@" )
}

doc_cmd() {
  local sub=${1:-status}
  shift || true
  case "$sub" in
    build) doc_build "$@" ;;
    status) doc_status ;;
    smoke) doc_smoke "$@" ;;
    *) die "tai_live.sh doc build [--base IMAGE] | status | smoke [--only TEXT]" ;;
  esac
}

# ---- the course library (docs/COURSE_DOCS.md): the professor's decks, for every student. The commands are node's (dist/docs/course-docs.js, from the live tree), with the library in the store and the renderer's own
# run directory (data/docs-operator: the service's reaper never looks there). The Canvas token is read from the host's env file by name and handed to the command through its environment, never on a command line.
course_docs_node() {
  [ -f "$T/dist/docs/course-docs.js" ] || die "this build has no course-docs command (dist/docs/course-docs.js): deploy first"
  ( cd "$T" && node dist/docs/course-docs.js "$@" --store "$T/store" --data "$T/data/docs-operator" )
}

course_docs_add() {
  local in="$L/course-in" rc=0
  [ -d "$in" ] || die "no files were shipped: run this from the PC (tai_live.sh course-docs add <file-or-directory>)"
  [ -f "$T/dist/docs/course-docs.js" ] || { rm -rf "$in"; die "this build has no course-docs command (dist/docs/course-docs.js): deploy first"; }
  docker image inspect "$DOC_IMAGE" >/dev/null 2>&1 || { rm -rf "$in"; die "no $DOC_IMAGE yet: tai_live.sh doc build"; }
  say "== adding to the course library: each file is rendered in a container of its own (a few seconds to a minute each); every student will see what is added: only course material, nothing that solves a graded assignment"
  course_docs_node add --dir "$in" "$@" || rc=$?
  rm -rf "$in"
  return "$rc"
}

course_docs_canvas() {
  local file="$L/credentials.env" token base course
  [ -f "$file" ] || die "no credentials are stored yet: run tai_credentials.sh first"
  token=$(grep -m1 '^CANVAS_API_TOKEN=' "$file" | cut -d= -f2- | tr -d '"' || true)
  base=$(grep -m1 '^CANVAS_BASE_URL=' "$file" | cut -d= -f2- | tr -d '"' || true)
  course=$(grep -m1 '^CANVAS_COURSE_ID=' "$file" | cut -d= -f2- | tr -d '"' || true)
  [ -n "$token" ] && [ -n "$base" ] || die "no Canvas address or token is stored on this host: tai_credentials.sh canvas"
  [ -f "$T/dist/docs/course-docs.js" ] || die "this build has no course-docs command (dist/docs/course-docs.js): deploy first"
  case " $* " in *" --yes "*) docker image inspect "$DOC_IMAGE" >/dev/null 2>&1 || die "no $DOC_IMAGE yet: tai_live.sh doc build" ;; esac
  ( cd "$T" && CANVAS_API_TOKEN="$token" CANVAS_BASE_URL="$base" CANVAS_COURSE_ID="$course" node dist/docs/course-docs.js canvas "$@" --store "$T/store" --data "$T/data/docs-operator" )
}

course_docs_cmd() {
  local sub=${1:-}
  shift || true
  case "$sub" in
    add) course_docs_add "$@" ;;
    list) course_docs_node list "$@" ;;
    remove) course_docs_node remove "$@" ;;
    rename) course_docs_node rename "$@" ;;
    canvas) course_docs_canvas "$@" ;;
    *) die "tai_live.sh course-docs add <file-or-directory> [--title T] [--week N] | list | remove <id> | rename <id> [--title T] [--week N|none] | canvas [--course ID] [--yes] [--allow-host HOST]" ;;
  esac
}

case "$CMD" in
  deploy)
    expose_after=0; corpus=0; image=0; npm_force=0; gateway_force=0
    for a in "$@"; do
      case "$a" in
        --expose) expose_after=1 ;;
        --corpus) corpus=1 ;;
        --image) image=1 ;;
        --npm) npm_force=1 ;;
        --gateway) gateway_force=1 ;;
        *) die "unknown argument: $a" ;;
      esac
    done
    prepare
    build_tree "$npm_force"
    if [ "$corpus" = 1 ] || [ ! -s "$T/leanrag/stub_corpus.json" ]; then build_corpus; fi
    ensure_reference
    if [ "$image" = 1 ] || ! docker image inspect tai-agent:live >/dev/null 2>&1 || [ "$(container_hash)" != "$(recorded containerHash)" ]; then
      build_image
    else
      say "== agent image unchanged (container/ hash $(container_hash)): not rebuilt"
    fi
    if [ "$gateway_force" = 1 ] || [ "$(gateway_hash)" != "$(recorded gatewayConfigHash)" ] || ! docker ps -q --filter "name=^$GATEWAY\$" | grep -q . \
       || ! docker port "$GATEWAY" 4000/tcp 2>/dev/null | grep -q "127.0.0.1:$VOICE_LLM_PORT"; then
      gateway_up
    else
      say "== gateway unchanged and running: left alone"
    fi
    install_unit
    sudo -n systemctl restart "$UNIT"
    wait_portal || { sudo -n journalctl -u "$UNIT" -n 15 --no-pager | cut -c1-200 >&2; die "the page did not come up (see the log above)"; }
    manifest
    [ "$expose_after" = 0 ] || expose
    say "done. next: tai_live.sh check"
    ;;
  status) status ;;
  check) check ;;
  test) ( cd "$T" && npx vitest run --color=false 2>&1 | grep -E "^ *(PASS|FAIL|✓|×|❯)|Test Files|Tests " | tail -n "${1:-60}" ) ;;
  logs) sudo -n journalctl -u "$UNIT" -n "${1:-40}" --no-pager | cut -c1-220 ;;
  start) sudo -n systemctl start "$UNIT"; wait_portal && say "up" || die "did not come up" ;;
  stop) sudo -n systemctl stop "$UNIT"; say "stopped" ;;
  restart) sudo -n systemctl restart "$UNIT"; wait_portal && say "up" || die "did not come up" ;;
  expose) expose ;;
  unexpose) unexpose ;;
  set) set_cmd "$@" ;;
  model)
    case "${1:-}" in gpt-oss|qwen|deepseek|glm) ;; *) die "tai_live.sh model gpt-oss|qwen|deepseek|glm [--background]" ;; esac
    case "${2:-}" in ""|--background) ;; *) die "tai_live.sh model gpt-oss|qwen|deepseek|glm [--background]" ;; esac
    # a model the running gateway cannot call would take every chat down with it: refused here, nothing changed
    [ "$1" != deepseek ] || deepseek_ready || die "not switched: nothing was changed"
    [ "$1" != glm ] || glm_ready || die "not switched: nothing was changed"
    if [ "${2:-}" = --background ]; then
      chats=$(grep -m1 '^ANTHROPIC_DEFAULT_SONNET_MODEL=' "$L/base.env" 2>/dev/null | cut -d= -f2- | grep . || echo "${TAI_MODEL:-gpt-oss}")
      write_base_env "$chats" "$1"
      compose_env
      say "background model: $1 (the patrol and the other scheduled tasks, at the next agent container); the chats stay on $chats"
    else
      write_base_env "$1"
      compose_env
      say "model: $1 (the chats and the scheduled tasks, at the next agent container)"
    fi
    ;;
  models) models_answer "$@" ;;
  patrol) patrol_cmd "$@" ;;
  users) users_cmd "$@" ;;
  smoke)
    case "${1:-}" in
      clean) shift; smoke_clean "$@" ;;
      voice-run) shift; smoke_voice "$@" ;;
      *) smoke "$@" ;;
    esac ;;
  voice) voice_cmd "$@" ;;
  notify) notify_cmd "$@" ;;
  backup) backup_cmd "$@" ;;
  timers) timers_cmd "$@" ;;
  humanness) humanness "$@" ;;
  sandbox) sandbox_cmd "$@" ;;
  doc) doc_cmd "$@" ;;
  course-docs) course_docs_cmd "$@" ;;
  corpus) build_corpus ;;
  manifest) manifest ;;
  course) course_cmd "$@" ;;
  gateway) prepare; gateway_up; compose_env ;;
  *) die "unknown command: $CMD (try help)" ;;
esac
