# Documentation

These are TAi's design documents. Most of them record:

- what was asked for;
- what was built;
- what was measured, and on what;
- what was not checked.

The dates are in 2026. The [main README](../README.md) gives the overview, and the thesis gives the argument.

## The student page and the conversation

| Document | What it covers |
|---|---|
| [PORTAL.md](PORTAL.md) | The student page: its server, Google sign-in against the roster, the page itself, and its tests |
| [PROGRESS.md](PROGRESS.md) | What a student sees while TAi works, and the "Looked at" line under a reply |
| [STREAMING.md](STREAMING.md) | Showing the reply as it is written (`TAI_PORTAL_STREAM`) |
| [HIGHLIGHT.md](HIGHLIGHT.md) | Code highlighting in replies |
| [COURSE_TIME.md](COURSE_TIME.md) | Deadlines in Pacific time and in the student's own time zone |
| [NOTIFICATIONS.md](NOTIFICATIONS.md) | Notifications that reach a closed page (Web Push and e-mail) |
| [HUMANNESS.md](HUMANNESS.md) | Measuring how much TAi's replies and calls read like a bot |

## Voice calls and practice interviews

| Document | What it covers |
|---|---|
| [VOICE.md](VOICE.md) | Voice calls and the practice interview on Deepgram's voice agent: the relay, the assessment tool, call limits, and what real calls showed |
| [WEEKLY_BRIEF.md](WEEKLY_BRIEF.md) | The weekly brief that interviews are built from: the week's requirements, Canvas, GitHub and Piazza |
| [VOICE_SELFBUILT.md](VOICE_SELFBUILT.md) | The voice lab: TAi's call on a self-built voice chain, with criteria written before each measurement |
| [LOCAL_VOICE.md](LOCAL_VOICE.md) | The local voice service on the host: recognition and synthesis on the CPU, measurements and blind listening tests |

## Remembering students and reaching out

| Document | What it covers |
|---|---|
| [STUDENT_MODEL.md](STUDENT_MODEL.md) | The student record, written by host code after each answer |
| [STUDENT_STATE.md](STUDENT_STATE.md) | The student state: repository, where the student stopped, one concrete problem |
| [PATROL.md](PATROL.md) | The weekday patrol and the gate that decides whether to call the model |
| [TEAM_VIEW.md](TEAM_VIEW.md) | The teaching-team page, and how to look at it with a synthetic class |

## Running code and showing material

| Document | What it covers |
|---|---|
| [GO_SANDBOX.md](GO_SANDBOX.md) | Running a student's Go code in a single-use container |
| [CHAT_OBJECTS.md](CHAT_OBJECTS.md) | Overview of the things TAi puts in the chat, the viewer, and the student's view |
| [RUN_CARDS.md](RUN_CARDS.md) | Run cards, "Ask TAi about this", pictures in a call, archives |
| [CARDS.md](CARDS.md) | Chart and sequence cards |
| [PREDICT.md](PREDICT.md) | Prediction cards: guess first, then run |
| [DOCUMENTS.md](DOCUMENTS.md) | The document viewer, host side: preparing PDFs in single-use containers |
| [VIEWER.md](VIEWER.md) | The document viewer, page side |
| [VIEWER_VOICE.md](VIEWER_VOICE.md) | The viewer in voice calls and text chat: showing and pointing at a page |
| [COURSE_DOCS.md](COURSE_DOCS.md) | Office files, the course library, and finding a slide by its content |
| [OCR.md](OCR.md) | Reading the text of a picture (`read_image_text`) |
| [VISION.md](VISION.md) | Looking at a chart or diagram (`look_at_image`, off unless `TAI_VISION=1`) |

## Course-material search

| Document | What it covers |
|---|---|
| [LEANRAG.md](LEANRAG.md) | The course knowledge graph: what the spring prototype was, what was rebuilt, and the test against BM25 under rules written in advance |

## Settings, security and operations

| Document | What it covers |
|---|---|
| [SETTINGS.md](SETTINGS.md) | Every setting this fork adds, with defaults |
| [SECURITY.md](SECURITY.md) | The security model: NanoClaw's container isolation plus this fork's IPC rules, tool guards and student page |
| [COMMIT_MAP.md](COMMIT_MAP.md) | Commit ids cited in documents, before and after the history was prepared for publication |
| [DEBUG_CHECKLIST.md](DEBUG_CHECKLIST.md) | NanoClaw's debugging checklist |

## Evaluation

| Where | What it covers |
|---|---|
| [../eval/RESULTS.md](../eval/RESULTS.md) | The fall evaluation: guard hooks, resume, scheduling, the models on TAi's own flow, and the switch to pi |
| [../eval/weak-model/](../eval/weak-model/) | The weak-model experiment: criteria frozen before the runs, two rounds, all records |
| [../eval/leanrag/](../eval/leanrag/) | The retrieval test's question sets, scripts and results |
| [../eval/voice-lab/](../eval/voice-lab/), [../eval/voice-local/](../eval/voice-local/) | The voice lab's and the local voice service's test sets, protocols, scripts and results |

## From NanoClaw

These documents come from upstream [NanoClaw](https://github.com/gavrielc/nanoclaw) and describe the framework TAi is built on:

- [SPEC.md](SPEC.md)
- [REQUIREMENTS.md](REQUIREMENTS.md)
- [SDK_DEEP_DIVE.md](SDK_DEEP_DIVE.md)
- [nanoclaw-architecture-final.md](nanoclaw-architecture-final.md)
- [nanorepo-architecture.md](nanorepo-architecture.md)
