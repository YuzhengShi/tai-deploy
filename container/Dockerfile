# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    ffmpeg \
    unzip \
    poppler-utils \
    sqlite3 \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install puppeteer-core and AWS SDK for SharePoint auth script
RUN npm install -g puppeteer-core @aws-sdk/client-s3 @aws-sdk/client-bedrock-runtime @aws-sdk/client-transcribe

# Install Python 3 + venv for LeanRAG MCP server
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/leanrag \
    && /opt/leanrag/bin/pip install --no-cache-dir \
        boto3 networkx numpy python-dotenv "mcp[cli]<2" requests python-docx pymupdf openpyxl python-pptx piazza-api

# Install LeanRAG build_graph dependencies (copy of leanrag/requirements.txt)
COPY leanrag-requirements.txt /tmp/leanrag-requirements.txt
RUN /opt/leanrag/bin/pip install --no-cache-dir -r /tmp/leanrag-requirements.txt

# Install agent-browser, claude-code, and mermaid-cli globally
RUN npm install -g agent-browser @anthropic-ai/claude-code @mermaid-js/mermaid-cli
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# pi's grep and find tools run ripgrep and fd; without them pi would try to download them, which the runner forbids (PI_OFFLINE=1).
# ripgrep is Debian's. fd is not: Debian's fd-find is 8.6.0, which rejects --no-require-git (pi's find passes it outside a git
# repository), so every find call failed. A static release of fd instead, checked against the sha256 pinned here (the digest GitHub
# lists for each asset, recomputed from the downloaded file). pi looks for "fd" and then "fdfind" (Debian's name); the binary is
# installed under both, and the build stops if the one called fdfind does not know the flag. Change FD_VERSION and both sums together.
# A layer of its own, after the heavy ones above, so a rebuild keeps those cached.
# The same apt line carries tesseract with its English data, for the read_image_text tool (scripts/ocr_image.py reads the text of a screenshot a
# student attached). Measured on bookworm: tesseract-ocr 5.3.0-2 and tesseract-ocr-eng 1:4.1.0-2 are 7 packages and 23 MiB installed, 10 MiB of
# them the orientation data that Debian's tesseract-ocr depends on whatever --no-install-recommends says. It runs as the node user (no root needed).
ARG FD_VERSION=10.5.0
ARG FD_SHA256_X86_64=761c72dc8e120d85b22292063be8a796e2eeb20eb3e4f38b8fa2343ccf3514a7
ARG FD_SHA256_AARCH64=d76c4317f7d5dba69f8a2a15856c90c777e7f0dd4e85f0de8c76de6992c374d4
RUN apt-get update && apt-get install -y --no-install-recommends ripgrep tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/* \
    && case "$(dpkg --print-architecture)" in \
         amd64) fd_arch=x86_64; fd_sha256="$FD_SHA256_X86_64" ;; \
         arm64) fd_arch=aarch64; fd_sha256="$FD_SHA256_AARCH64" ;; \
         *) echo "no fd release is pinned for $(dpkg --print-architecture)" >&2; exit 1 ;; \
       esac \
    && fd_dir="fd-v${FD_VERSION}-${fd_arch}-unknown-linux-musl" \
    && curl -fsSL --retry 3 --retry-delay 2 -o /tmp/fd.tar.gz "https://github.com/sharkdp/fd/releases/download/v${FD_VERSION}/${fd_dir}.tar.gz" \
    && echo "${fd_sha256}  /tmp/fd.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/fd.tar.gz -C /tmp "${fd_dir}/fd" \
    && install -m 0755 "/tmp/${fd_dir}/fd" /usr/local/bin/fd \
    && ln -s fd /usr/local/bin/fdfind \
    && rm -rf /tmp/fd.tar.gz "/tmp/${fd_dir}" \
    && fdfind --help | grep -q -- --no-require-git

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy helper scripts (TTS, etc.)
COPY scripts/ /opt/scripts/
RUN ln -s /usr/local/lib/node_modules /opt/scripts/node_modules

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/global /workspace/extra /workspace/leanrag /workspace/ipc/messages /workspace/ipc/tasks

# Entrypoint: runs the dist built above. TAI_COMPILE_ON_START=1 (development, the evaluation harness) compiles the agent-runner source
# the host mounts at /app/src instead, which costs 8-10 s of tsc at every container start, so it is off by default.
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
