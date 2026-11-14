# The local-voice service (docs/LOCAL_VOICE.md): LabGPU's recognizer and synthesizer, on our own CPU, on one loopback port. Build context: this folder.
#
#   docker build -t tai-local-voice:latest deploy/cs6650/local-voice
#   docker network create --internal --subnet 172.29.88.0/24 tai-voice-net          # once: a network with NO route out
#   docker run -d --name tai-local-voice --restart unless-stopped --network tai-voice-net --ip 172.29.88.2 \
#       --cpu-shares 128 --cpus 4 --memory 4g --memory-swap 4g --pids-limit 256 \
#       --read-only --tmpfs /tmp:rw,size=64m -e HOME=/tmp --cap-drop ALL --security-opt no-new-privileges \
#       -v /srv/tai-voice/models/parakeet-tdt-0.6b-v2-int8:/models/parakeet-tdt-0.6b-v2-int8:ro \
#       -v /srv/tai-voice/models/supertonic/v1:/models/supertonic/v1:ro \
#       tai-local-voice:latest
#   (the lab then uses ws://172.29.88.2:18800/v1/listen?... and http://172.29.88.2:18800 : the host reaches the container's address on the bridge; nothing is published)
#
# Built and run on the cs6650 host in a scratch folder on 2026-11-14 (docs/LOCAL_VOICE.md, section 9): the build works, both ONNX Runtimes (sherpa-onnx's 1.28.2 and the pip package's 1.32.0) load in one Linux process.
#
# What it is: python:3.12-slim, the pinned packages, the code, a user that is not root. The models are NOT in the image: they are mounted read-only at /models (a bind mount of the folders the development PC
# has in D:\tai-voice-local: models\parakeet-tdt-0.6b-v2-int8, supertonic\v1, and tts\vits-piper-en_US-lessac-medium only if LOCAL_VOICE_TTS_BACKEND=piper). The service fetches nothing at run time and opens
# no outgoing connection; but the pip onnxruntime 1.32.0 it embeds has a Microsoft telemetry client that contacts mobile.events.data.microsoft.com as soon as it is imported (measured 2026-11-14), so the image
# sets ORT_DISABLE_TELEMETRY=1 (the package sets it too) AND the container is meant to run on an `--internal` network, which has no route out and no DNS beyond its own: a library that behaves differently in a
# later version still cannot reach anything. check_egress.sh proves it on a real container.
#
# The process listens on 0.0.0.0 INSIDE the container (the address of the bridge, reachable from the host only): there is no authentication, so never publish its port beyond 127.0.0.1 and never run it with
# `--network host` without setting LOCAL_VOICE_HOST=127.0.0.1 (the service logs a warning when it is bound to anything else).
#
# BASE_IMAGE can name another copy of the same image (Docker Hub limits anonymous pulls per address and the host shares one):
#   docker build --build-arg BASE_IMAGE=mirror.gcr.io/library/python:3.12-slim ...
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE}

LABEL tai-local-voice="1"
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1

# a user that owns nothing: the code is root's (read-only to it) and the models are mounted read-only
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin localvoice

WORKDIR /app
COPY requirements.txt ./
# --no-deps: requirements.txt is a complete lock (see its header for why supertonic must not bring its own dependencies)
RUN pip install --no-deps -r requirements.txt

# the code comes after the packages on purpose: a change to it rebuilds the last two steps, not the install above
COPY server.py keyterms.json ./
COPY localvoice ./localvoice

ENV LOCAL_VOICE_HOST=0.0.0.0 \
    LOCAL_VOICE_PORT=18800 \
    LOCAL_VOICE_ASR_MODEL_DIR=/models/parakeet-tdt-0.6b-v2-int8 \
    LOCAL_VOICE_ST_MODEL_DIR=/models/supertonic/v1 \
    LOCAL_VOICE_PIPER_MODEL_DIR=/models/vits-piper-en_US-lessac-medium \
    HF_HUB_OFFLINE=1 \
    ORT_DISABLE_TELEMETRY=1

USER localvoice
EXPOSE 18800

# green only when both models are loaded and warmed (the port is opened after that: loading takes about ten seconds on a fast CPU)
HEALTHCHECK --interval=15s --timeout=4s --start-period=90s --retries=3 \
    CMD ["python", "-c", "import os, sys, urllib.request; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('LOCAL_VOICE_PORT', '18800'), timeout=3).status == 200 else 1)"]

CMD ["python", "server.py"]
