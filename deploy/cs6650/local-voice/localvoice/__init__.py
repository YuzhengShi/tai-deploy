"""The local-voice service: a stand-in for LabGPU's recognizer (`/v1/listen`, a Deepgram-compatible websocket) and synthesizer (`POST /tts`) on one loopback port, backed by models that run on our own CPU
(docs/LOCAL_VOICE.md). Nothing in this package calls out to the network, and nothing in it ever writes a transcript, the text of a synthesis request or audio to a log, an error message or a file."""

SERVICE = 'tai-local-voice'
VERSION = '1.0.0'
