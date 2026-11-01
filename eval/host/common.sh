#!/usr/bin/env bash
# Shared by the eval/host scripts. They run from a local Git Bash and operate the evaluation box over ssh.
# The box is the CS6650 host; everything TAi lives under ~/tai-eval there and on its own docker network (nanoclaw-net),
# never in the world's compose project.
HOST="${TAI_HOST:-ubuntu@tai.example.edu}"
SSH_OPTS="-o ConnectTimeout=20 -o ServerAliveInterval=15 -o ServerAliveCountMax=8"
REPO_LOCAL="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

rssh() { ssh $SSH_OPTS "$HOST" "$@"; }
