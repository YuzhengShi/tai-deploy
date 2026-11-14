"""The local-voice service: a stand-in for LabGPU's recognizer (`/v1/listen`, a Deepgram-compatible websocket) and synthesizer (`POST /tts`) on one loopback port, backed by models that run on our own CPU
(docs/LOCAL_VOICE.md). This package opens no outgoing connection; the one library it uses that would (the pip onnxruntime 1.32.0 carries a Microsoft OneCollector telemetry client) is switched off below. Nothing in
it ever writes a transcript, the text of a synthesis request or audio to a log, an error message or a file."""
import os

# MUST stay above every import of onnxruntime (the speech package imports it). Measured on 2026-11-14 with a DNS sinkhole on an internal Docker network: `import onnxruntime` alone asks for
# mobile.events.data.microsoft.com (Microsoft's telemetry collector) and asks again 5 s later, `onnxruntime.disable_telemetry_events()` after the import does not stop that first attempt, and with this variable
# set the import and a model load ask for nothing. Assigned, not defaulted: an operator's stray `=0` must not turn it back on. The image sets it too (Dockerfile), and the container is meant to run on an
# internal network with no route out (README.md), so that a future library version that behaves differently still cannot reach anything.
os.environ['ORT_DISABLE_TELEMETRY'] = '1'

SERVICE = 'tai-local-voice'
VERSION = '1.0.0'
