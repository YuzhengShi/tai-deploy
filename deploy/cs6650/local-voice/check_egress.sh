#!/usr/bin/env bash
# Does anything in the local-voice image try to reach the network? (README.md, "Why an internal network"; docs/LOCAL_VOICE.md section 9.) Run it on a machine with Docker, after `docker build`.
#
# It makes a docker network with NO route out and a DNS sinkhole on it that logs every name asked (and answers NXDOMAIN), then runs the image there. Nothing can leave, and every attempt to leave shows up
# as a question the sinkhole was asked.
#   check_egress.sh control    the pip onnxruntime with the opt-out variable REMOVED, importing and loading a model: it is expected to ask for mobile.events.data.microsoft.com (that is the finding)
#   check_egress.sh shipped    the same as the image is shipped (variable set), and sherpa-onnx's own runtime loading the recognizer: must ask for nothing
#   check_egress.sh service    the whole service as the README runs it, while smoke.py streams clips and calls /tts: must ask for nothing
#   check_egress.sh all        the three in this order; exit status 1 when the control did not ask (the test could not have seen anything) or the others asked
#   check_egress.sh clean      remove the sinkhole and the network
# Settings (environment): IMAGE (tai-local-voice:latest), ASR_DIR and ST_DIR (the two model folders on this machine), NET (tai-lv-egress-net), SUBNET (172.29.99.0/24; its .2 is the service, .3 the sinkhole).
# The probes load models and the smoke streams the synthetic clips the service itself makes: no person's audio or text is involved.
set -u
IMAGE="${IMAGE:-tai-local-voice:latest}"
ASR_DIR="${ASR_DIR:-$HOME/voice-local/models/parakeet-tdt-0.6b-v2-int8}"
ST_DIR="${ST_DIR:-$HOME/voice-local/supertonic/v1}"
NET="${NET:-tai-lv-egress-net}"
SUBNET="${SUBNET:-172.29.99.0/24}"
BASE="${SUBNET%.*/*}"                    # 172.29.99
SINK_IP="$BASE.3"
SVC_IP="$BASE.2"
SINK=tai-lv-egress-sink
SVC=tai-lv-egress-svc
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

setup() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create --internal --subnet "$SUBNET" "$NET" >/dev/null || exit 2
  cat > "$TMP/dns_sink.py" <<'PY'
import socket, struct, time
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.bind(('0.0.0.0', 53))
print('sinkhole up', flush=True)
while True:
    data, addr = s.recvfrom(512)
    try:
        i, parts = 12, []
        while data[i]:
            n = data[i]
            parts.append(data[i + 1:i + 1 + n].decode('ascii', 'replace'))
            i += 1 + n
        end = i + 1
        name = '.'.join(parts)
        qtype = struct.unpack('!H', data[end:end + 2])[0]
    except Exception:
        name, qtype, end = '?', 0, len(data) - 4
    print(time.strftime('%H:%M:%S'), 'asked', name, 'type', qtype, flush=True)
    s.sendto(data[:2] + b'\x81\x83' + data[4:6] + b'\x00\x00\x00\x00\x00\x00' + data[12:end + 4], addr)
PY
  cat > "$TMP/probe.py" <<'PY'
import sys, time
what = sys.argv[1]
if what == 'ort':
    import onnxruntime
    print('imported onnxruntime', onnxruntime.__version__, flush=True)
    onnxruntime.InferenceSession('/models/supertonic/v1/onnx/vocoder.onnx', providers=['CPUExecutionProvider'])
    print('model loaded', flush=True)
else:
    import sherpa_onnx
    d = '/models/parakeet-tdt-0.6b-v2-int8/'
    sherpa_onnx.OfflineRecognizer.from_transducer(encoder=d + 'encoder.int8.onnx', decoder=d + 'decoder.int8.onnx', joiner=d + 'joiner.int8.onnx', tokens=d + 'tokens.txt', num_threads=2,
                                                  sample_rate=16000, feature_dim=80, decoding_method='greedy_search', model_type='nemo_transducer')
    print('sherpa-onnx recognizer created', flush=True)
time.sleep(20)          # the library's first attempt came about 0 s after the import and the second 5 s later
PY
  docker rm -f "$SINK" >/dev/null 2>&1
  docker run -d --name "$SINK" --network "$NET" --ip "$SINK_IP" -v "$TMP/dns_sink.py:/dns.py:ro" python:3.12-slim python -u /dns.py >/dev/null || exit 2
  sleep 2
}

asked_since() {                          # asked_since N : the questions the sinkhole was asked after its first N log lines
  docker logs "$SINK" 2>&1 | tail -n +$(($1 + 1)) | grep ' asked ' || true
}
sink_lines() { docker logs "$SINK" 2>&1 | wc -l; }

PROBE=(docker run --rm --network "$NET" --dns "$SINK_IP" --read-only --tmpfs /tmp:rw,size=16m -e HOME=/tmp --cap-drop ALL --security-opt no-new-privileges --user 10001:10001
       -v "$ST_DIR:/models/supertonic/v1:ro" -v "$ASR_DIR:/models/parakeet-tdt-0.6b-v2-int8:ro")

control() {
  local before; before=$(sink_lines)
  echo "== control: onnxruntime with the opt-out variable removed"
  "${PROBE[@]}" -v "$TMP/probe.py:/probe.py:ro" --entrypoint env "$IMAGE" -u ORT_DISABLE_TELEMETRY python /probe.py ort 2>&1 | cut -c1-160
  sleep 3
  local seen; seen=$(asked_since "$before")
  if [ -n "$seen" ]; then echo "$seen" | sort | uniq -c | sed 's/^/   /'; echo "   -> asked, as expected: the library does try to reach out when the variable is not set"; return 0
  else echo "   -> asked NOTHING: this probe could not have seen the telemetry (a newer library, or the sinkhole is not the resolver): the other results mean nothing"; return 1; fi
}

shipped() {
  local before rc=0 out1 out2; before=$(sink_lines)
  echo "== shipped: onnxruntime as the image has it, then sherpa-onnx"
  out1=$("${PROBE[@]}" -v "$TMP/probe.py:/probe.py:ro" --entrypoint python "$IMAGE" /probe.py ort 2>&1 | cut -c1-160)
  out2=$("${PROBE[@]}" -v "$TMP/probe.py:/probe.py:ro" --entrypoint python "$IMAGE" /probe.py sherpa 2>&1 | cut -c1-160)
  echo "$out1"; echo "$out2"
  if ! echo "$out1" | grep -q 'model loaded' || ! echo "$out2" | grep -q 'recognizer created'; then
    echo "   a probe did not complete (are ASR_DIR and ST_DIR right?), so this check saw nothing (a check that did not run is not a pass)"; return 2
  fi
  sleep 3
  local seen; seen=$(asked_since "$before")
  if [ -n "$seen" ]; then echo "$seen" | sort | uniq -c | sed 's/^/   /'; echo "   -> ASKED: something in the image tries to reach out"; rc=1; else echo "   -> asked nothing"; fi
  return $rc
}

service() {
  local before rc=0; before=$(sink_lines)
  echo "== service: the container as the README runs it, under smoke.py (clips in real time, /tts)"
  docker rm -f "$SVC" >/dev/null 2>&1
  docker run -d --name "$SVC" --network "$NET" --ip "$SVC_IP" --dns "$SINK_IP" --cpus 4 --memory 4g --pids-limit 256 --read-only --tmpfs /tmp:rw,size=64m -e HOME=/tmp --cap-drop ALL \
    --security-opt no-new-privileges -v "$ST_DIR:/models/supertonic/v1:ro" -v "$ASR_DIR:/models/parakeet-tdt-0.6b-v2-int8:ro" "$IMAGE" >/dev/null || return 2
  local up=0
  for i in $(seq 1 120); do
    if docker run --rm --network "$NET" --entrypoint python "$IMAGE" -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://$SVC_IP:18800/health', timeout=3).status == 200 else 1)" >/dev/null 2>&1; then up=1; break; fi
    sleep 1
  done
  [ "$up" = 1 ] || { echo "   the service did not come up:"; docker logs --tail 20 "$SVC" 2>&1; docker rm -f "$SVC" >/dev/null 2>&1; return 2; }
  # smoke.py talks to 127.0.0.1:<port of --url>, so it runs in the service's own network namespace (it needs no name lookup of its own)
  local smoke_out
  smoke_out=$(docker run --rm --network "container:$SVC" --user 10001:10001 -e HOME=/tmp -e PYTHONDONTWRITEBYTECODE=1 -v "$HERE:/lv:ro" -w /lv --entrypoint python "$IMAGE" -B smoke.py --url "http://127.0.0.1:18800" \
                --clips 3 --concurrent 3 2>&1)
  if ! echo "$smoke_out" | grep -q '^final (speech_final)'; then
    echo "   the smoke run did not complete, so this check saw nothing (a check that did not run is not a pass):"; echo "$smoke_out" | tail -15 | cut -c1-200
    docker rm -f "$SVC" >/dev/null 2>&1; return 2
  fi
  echo "$smoke_out" | grep -E "^(first partial|covering|final|/tts, 3)" | cut -c1-200
  sleep 3
  local seen; seen=$(asked_since "$before")
  docker rm -f "$SVC" >/dev/null 2>&1
  if [ -n "$seen" ]; then echo "$seen" | sort | uniq -c | sed 's/^/   /'; echo "   -> ASKED: the running service tries to reach out"; rc=1; else echo "   -> asked nothing"; fi
  return $rc
}

case "${1:-}" in
  control) setup; control ;;
  shipped) setup; shipped ;;
  service) setup; service ;;
  all)     setup; rc=0; control || rc=1; shipped || rc=1; service || rc=1; echo; [ $rc = 0 ] && echo "PASS: the control asked, the shipped image and the running service did not" || echo "FAIL (see above)"; exit $rc ;;
  clean)   docker rm -f "$SINK" "$SVC" >/dev/null 2>&1; docker network rm "$NET" 2>&1 | tail -1 ;;
  *) echo "usage: check_egress.sh control|shipped|service|all|clean" >&2; exit 2 ;;
esac
