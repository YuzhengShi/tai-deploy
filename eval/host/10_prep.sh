#!/usr/bin/env bash
# Prepare the evaluation box: directories, Node 22 in the user's home (no system change), the docker network, and a read-only look at
# what the box offers. Prints what TAi's container-runner pays on every spawn without AWS keys (the EC2 metadata call).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
rssh 'bash -s' <<'REMOTE'
set -u
mkdir -p ~/tai-eval/logs ~/tai-eval/results ~/tai-eval/tai
echo "disk:   $(df -h ~ | tail -1)"
echo "memory: $(free -m | awk '/^Mem:/ {print "used " $3 " MB, available " $7 " MB of " $2 " MB"}')"
echo "docker: $(docker --version)"
echo "gcc:    $(gcc --version 2>&1 | head -1)"
echo "make:   $(make --version 2>&1 | head -1)"
echo "python: $(python3 --version 2>&1)"
echo "== the EC2 metadata call TAi makes on each container spawn when no AWS keys are set (cap 20 s)"
curl -sS -m 20 -o /dev/null -w "   http %{http_code} after %{time_total}s\n" http://169.254.169.254/latest/meta-data/ 2>&1 | tail -2
if [ ! -x ~/tai-eval/node/bin/node ]; then
  echo "== installing Node 22 (user space)"
  cd /tmp
  BASE=https://nodejs.org/dist/latest-v22.x
  curl -fsSL "$BASE/SHASUMS256.txt" -o /tmp/SHASUMS256.txt
  F=$(awk '/linux-x64.tar.xz/ {print $2}' /tmp/SHASUMS256.txt)
  curl -fsSL "$BASE/$F" -o "/tmp/$F"
  grep " $F\$" /tmp/SHASUMS256.txt | (cd /tmp && sha256sum -c -)
  mkdir -p ~/tai-eval/node && tar -xJf "/tmp/$F" -C ~/tai-eval/node --strip-components=1
  rm -f "/tmp/$F" /tmp/SHASUMS256.txt
fi
echo "node:   $(~/tai-eval/node/bin/node --version)  npm: $(~/tai-eval/node/bin/npm --version)"
docker network inspect nanoclaw-net >/dev/null 2>&1 && echo "network nanoclaw-net: exists" || { docker network create nanoclaw-net >/dev/null && echo "network nanoclaw-net: created"; }
REMOTE
