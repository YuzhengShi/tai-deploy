#!/usr/bin/env bash
# Runs ON the box. The Dockerfile's `pip install "mcp[cli]"` is unpinned and today resolves to mcp 2.x, where FastMCP was renamed, so
# LeanRAG's MCP server cannot start and the agent never sees mcp__leanrag__query_knowledge. container/Dockerfile now pins mcp[cli]<2;
# this reaches the same end state on the existing image with one thin layer instead of rebuilding twenty (tag stays tai-agent:eval).
set -u
docker build -t tai-agent:eval - <<'EOF'
FROM tai-agent:eval
USER root
RUN /opt/leanrag/bin/pip install --no-cache-dir "mcp[cli]<2" && /opt/leanrag/bin/pip list 2>/dev/null | grep -i -E "^mcp "
USER node
EOF
docker run --rm --entrypoint sh -v "$HOME/tai-eval/tai/leanrag:/workspace/leanrag:ro" tai-agent:eval -c 'cd /workspace && PYTHONPATH=/workspace /opt/leanrag/bin/python3 -c "import leanrag.mcp_server; print(\"leanrag mcp server imports\")" 2>&1 | tail -3'
