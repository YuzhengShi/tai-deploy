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
