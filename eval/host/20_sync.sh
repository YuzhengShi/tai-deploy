#!/usr/bin/env bash
# Copy the working tree of this fork to ~/tai-eval/tai on the evaluation box (tar over ssh; nothing is deleted there, so the runtime
# folders store/, groups/<student>/ and data/ survive a sync). Line endings are LF in this clone (core.autocrlf=false).
set -u
. "$(dirname "${BASH_SOURCE[0]}")/common.sh"
cd "$REPO_LOCAL" || exit 1
tar -czf - --exclude='.git' --exclude='node_modules' --exclude='terraform' --exclude='assets' --exclude='.claude' \
    --exclude='eval/results' --exclude='dist' . | rssh 'mkdir -p ~/tai-eval/tai && tar -xzf - -C ~/tai-eval/tai && echo "synced: $(find ~/tai-eval/tai -type f -not -path "*/node_modules/*" | wc -l) files, $(du -sm ~/tai-eval/tai --exclude=node_modules | cut -f1) MB"'
