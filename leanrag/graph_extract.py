"""Entity and relation extraction for the graph build: cut the corpus into units, ask a model once per unit, check what it says against the text.

A unit is a few consecutive slides of one deck (or one assignment / syllabus chunk), with `[Slide N]` markers. The model is told to use only what the
text says and to cite the slides a fact comes from. What comes back is CHECKED, not trusted:

  * an entity whose name has fewer than half of its words in the unit's text is dropped (a model naming "Paxos" because it knows Paxos, not because the
    slide says it);
  * a relation needs both ends among the unit's kept entities;
  * a cited slide that is not in the unit is replaced by all of the unit's slides.

Every raw answer is appended to a cache file (one JSON line each, keyed by the model, the prompt version and the unit's text), so a run that stops is
resumed without paying again, and the cache is the audit trail of what the model said. Nothing is written but that cache, and nothing here reads a key.
"""
from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from .corpus import Chunk
from .llm import BudgetExceeded, Completion, FatalLlmError, LlmError, Usage
from .text import normalize, stem, terms

PROMPT_VERSION = "extract-v1"
ENTITY_TYPES = ("concept", "technique", "protocol", "tool", "pattern", "metric", "problem", "assignment", "other")
RELATION_TYPES = ("USES", "REQUIRES", "PART_OF", "IMPLEMENTS", "FOLLOWS", "COMPARED_WITH", "PREREQUISITE_OF", "EXAMPLE_OF", "CAUSES", "SOLVES", "ENABLES", "RELATED_TO")
MAX_ENTITIES = 15
MAX_RELATIONS = 15
MAX_ANSWER_TOKENS = 2200      # 15 entities and 15 relations with descriptions come to about 1,600 tokens: an answer cut off mid-JSON would not parse
MAX_NAME_CHARS = 80
MAX_DESC_CHARS = 220
API_FAILURES_STOP = 5         # units in a row that the API did not answer at all, and the run stops (what is done stays in the cache)

SYSTEM_PROMPT = f"""TASK: extract-graph ({PROMPT_VERSION})
You read text taken from a university course, CS6650 Building Scalable Distributed Systems (lecture slides, assignment texts, the syllabus), and you extract a small knowledge graph from it as JSON.

Rules:
- Use ONLY what the text says. Do not add anything from your own knowledge, even when you are sure it is true. If the text only names something, its description is "".
- Entities are the course's concepts, techniques, protocols, tools, patterns, metrics, problems and assignments. A name is a short canonical noun phrase ("two-phase commit", "circuit breaker", "Go channel"), not a sentence and not a slide title like "Summary".
- Relations connect two entities you listed. Relation types: {", ".join(RELATION_TYPES)}.
- "slides" lists the numbers of the [Slide N] markers a fact comes from. For text without markers use [].
- At most {MAX_ENTITIES} entities and {MAX_RELATIONS} relations. If the text has nothing to extract, return {{"entities": [], "relations": []}}.

Reply with one JSON object and nothing else:
{{"entities": [{{"name": str, "type": one of {list(ENTITY_TYPES)}, "description": str (at most 25 words), "slides": [int]}}],
  "relations": [{{"head": str, "relation": str, "tail": str, "slides": [int]}}]}}"""


@dataclass
class Unit:
    id: str
    kind: str                      # slide | homework | syllabus
    title: str
    chunk_ids: list[str]
    pages: list[int]               # slide numbers (empty for the others)
    page_chunk: dict[int, str]     # slide number -> chunk id
    text: str                      # as the model sees it (with the markers)
    plain: str                     # the same without the markers: what an entity name is checked against


def make_units(chunks: list[Chunk], max_chars: int = 900, max_pages: int = 4) -> list[Unit]:
    """Group consecutive slides of one deck up to `max_chars` / `max_pages`; every other chunk is a unit of its own."""
    units: list[Unit] = []
    run: list[Chunk] = []

    def flush() -> None:
        if not run:
            return
        blocks = [f"[Slide {c.page}]\n{c.text}" for c in run]
        units.append(Unit(id=f"u:{run[0].id}", kind="slide", title=run[0].title, chunk_ids=[c.id for c in run], pages=[c.page for c in run],
                          page_chunk={c.page: c.id for c in run}, text="\n\n".join(blocks), plain="\n".join(c.text for c in run)))
        run.clear()

    for chunk in chunks:
        if chunk.kind == "slide":
            if run and (run[0].deck != chunk.deck or len(run) >= max_pages or sum(len(c.text) for c in run) + len(chunk.text) > max_chars):
                flush()
            run.append(chunk)
            continue
        flush()
        label = "Syllabus" if chunk.kind == "syllabus" else f"Assignment text: {chunk.title}"
        units.append(Unit(id=f"u:{chunk.id}", kind=chunk.kind, title=chunk.title, chunk_ids=[chunk.id], pages=[], page_chunk={},
                          text=f"[{label}]\n{chunk.text}", plain=chunk.text))
    flush()
    return units


def build_prompt(unit: Unit) -> tuple[str, str]:
    return SYSTEM_PROMPT, f"Text (from \"{unit.title}\"):\n<<<\n{unit.text}\n>>>\nReply with the JSON object only."


def name_key(name: str) -> str:
    """What two names must share to be one entity: their stems, without stop words ("circuit breakers" and "the circuit breaker" meet)."""
    return " ".join(terms(name))


def _clean_name(value: object) -> str:
    name = re.sub(r"\s+", " ", str(value or "")).strip(" \t\r\n\"'`*")
    return name[:MAX_NAME_CHARS]


def _slides(value: object, unit: Unit, notes: dict | None = None) -> list[str]:
    """The chunk ids a fact is from: the cited slides that are in the unit, else all of the unit's chunks (and `notes` counts how often that happened)."""
    if unit.pages and isinstance(value, list):
        cited = [unit.page_chunk[int(p)] for p in value if isinstance(p, (int, float, str)) and str(p).lstrip("-").isdigit() and int(p) in unit.page_chunk]
        if cited:
            return list(dict.fromkeys(cited))
        if notes is not None:
            notes["slides_replaced" if value else "slides_uncited"] += 1
    elif unit.pages and notes is not None:
        notes["slides_uncited"] += 1
    return list(unit.chunk_ids)


@dataclass
class Parsed:
    entities: list[dict] = field(default_factory=list)       # {"name", "key", "type", "description", "chunks"}
    relations: list[dict] = field(default_factory=list)      # {"head", "relation", "tail", "chunks"} (head and tail are keys)
    dropped: dict = field(default_factory=lambda: {"ungrounded": 0, "no_endpoint": 0, "over_limit": 0, "bad_shape": 0})
    # how often a fact's slides were not usable and all of the unit's slides stood in: cited outside the unit, or not cited (a unit of several slides only)
    notes: dict = field(default_factory=lambda: {"slides_replaced": 0, "slides_uncited": 0})


def parse_response(raw: str, unit: Unit) -> Parsed | None:
    """The kept entities and relations of a model's answer, or None when the answer is not the JSON object asked for."""
    text = raw.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        data = json.loads(text[start:end + 1])
    except ValueError:
        return None
    if not isinstance(data, dict) or not isinstance(data.get("entities", []), list) or not isinstance(data.get("relations", []), list):
        return None
    out = Parsed()
    unit_stems = set(terms(unit.plain, drop_stop=False))
    by_key: dict[str, dict] = {}
    for raw_entity in data.get("entities", []):
        if not isinstance(raw_entity, dict):
            out.dropped["bad_shape"] += 1
            continue
        name = _clean_name(raw_entity.get("name"))
        need = terms(name)
        key = " ".join(need)
        if not key:
            out.dropped["bad_shape"] += 1
            continue
        if sum(1 for s in need if s in unit_stems) * 2 < len(need) or not any(s in unit_stems for s in need):
            out.dropped["ungrounded"] += 1
            continue
        kind = str(raw_entity.get("type") or "other").strip().lower()
        description = re.sub(r"\s+", " ", str(raw_entity.get("description") or "")).strip()[:MAX_DESC_CHARS]
        chunks = _slides(raw_entity.get("slides"), unit, out.notes)
        if key in by_key:
            kept = by_key[key]
            kept["chunks"] = list(dict.fromkeys(kept["chunks"] + chunks))
            if not kept["description"] and description:
                kept["description"] = description
            continue
        if len(by_key) >= MAX_ENTITIES:
            out.dropped["over_limit"] += 1
            continue
        by_key[key] = {"name": name, "key": key, "type": kind if kind in ENTITY_TYPES else "other", "description": description, "chunks": chunks}
    out.entities = list(by_key.values())
    seen: set[tuple[str, str, str]] = set()
    for raw_relation in data.get("relations", []):
        if not isinstance(raw_relation, dict):
            out.dropped["bad_shape"] += 1
            continue
        head, tail = name_key(_clean_name(raw_relation.get("head"))), name_key(_clean_name(raw_relation.get("tail")))
        if head not in by_key or tail not in by_key or head == tail:
            out.dropped["no_endpoint"] += 1
            continue
        kind = re.sub(r"[\s-]+", "_", str(raw_relation.get("relation") or "").strip().upper())
        kind = kind if kind in RELATION_TYPES else "RELATED_TO"
        if (head, kind, tail) in seen:
            continue
        if len(seen) >= MAX_RELATIONS:
            out.dropped["over_limit"] += 1
            continue
        seen.add((head, kind, tail))
        out.relations.append({"head": head, "relation": kind, "tail": tail, "chunks": _slides(raw_relation.get("slides"), unit, out.notes)})
    return out


@dataclass
class UnitResult:
    unit: Unit
    parsed: Parsed | None
    model: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cached: bool = False
    error: str = ""
    attempts: int = 1              # requests the answer took (a reply that was not JSON is asked for once more)
    cache_hit_tokens: int = 0


@dataclass
class RunReport:
    results: list[UnitResult] = field(default_factory=list)
    complete: bool = True
    stopped_because: str = ""

    def records(self) -> list[dict]:
        """What each unit's answer cost (the numbers the cache keeps), for llm.sum_usage: the same whether the answer was fresh or came from the cache."""
        return [{"model": r.model, "prompt_tokens": r.prompt_tokens, "completion_tokens": r.completion_tokens, "cache_hit_tokens": r.cache_hit_tokens,
                 "attempts": r.attempts} for r in self.results]

    def counts(self) -> dict:
        ok = [r for r in self.results if r.parsed is not None]
        dropped: dict = {}
        notes: dict = {}
        for r in ok:
            for k, v in r.parsed.dropped.items():
                dropped[k] = dropped.get(k, 0) + v
            for k, v in r.parsed.notes.items():
                notes[k] = notes.get(k, 0) + v
        return {"units": len(self.results), "ok": len(ok), "failed": len(self.results) - len(ok), "from_cache": sum(1 for r in self.results if r.cached),
                "entities_kept": sum(len(r.parsed.entities) for r in ok), "relations_kept": sum(len(r.parsed.relations) for r in ok), "dropped": dropped, "notes": notes,
                "completion_tokens": sum(r.completion_tokens for r in self.results)}


def cache_key(model: str, unit: Unit) -> str:
    system, user = build_prompt(unit)
    return hashlib.sha256("\x1f".join((PROMPT_VERSION, model, system, user)).encode("utf-8")).hexdigest()


def load_cache(path: Path) -> dict[str, dict]:
    cache: dict[str, dict] = {}
    if path.is_file():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                record = json.loads(line)
                cache[record["key"]] = record
            except (ValueError, KeyError):
                continue          # a half-written last line after a crash: that unit is asked again
    return cache


def run_extraction(units: list[Unit], client, cache_path: Path, workers: int = 4, progress=None, retry_failed: bool = False) -> RunReport:
    """Extract every unit (from the cache where it is there). Stops at once on a budget or a fatal refusal, with what is done kept in the cache."""
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    cache = load_cache(cache_path)
    lock = threading.Lock()
    stop = threading.Event()
    report = RunReport()
    started = time.monotonic()
    done = [0]
    api_failures = [0]            # units in a row whose request got no answer at all (an outage, a quota): a run that is paid for in time stops instead of waiting out every unit
    model = getattr(client, "model", "unknown")

    def save(record: dict) -> None:
        with lock:
            cache[record["key"]] = record
            with open(cache_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def work(unit: Unit) -> UnitResult | None:
        key = cache_key(model, unit)
        record = cache.get(key)
        if record is not None:
            # a cached answer is read again every time, a failed one too: a parser that now accepts what an earlier one did not recovers the unit with no request
            parsed = parse_response(record.get("raw", ""), unit) if record.get("raw") else None
            if parsed is not None or not (record.get("failed") and retry_failed):
                return UnitResult(unit, parsed, record.get("model", ""), int(record.get("prompt_tokens", 0)), int(record.get("completion_tokens", 0)), True,
                                  "" if parsed is not None else str(record.get("error") or "the cached answer does not parse"),
                                  int(record.get("attempts") or 1), int(record.get("cache_hit_tokens") or 0))
        if stop.is_set():
            return None
        system, user = build_prompt(unit)
        completion: Completion | None = None
        parsed: Parsed | None = None
        error = ""
        attempts = tokens_in = tokens_out = tokens_hit = 0          # over the requests that got an answer: what this unit's answer cost
        for attempt in range(2):
            try:
                completion = client.complete_json(system, user if attempt == 0 else user + "\nYour previous reply was not the JSON object asked for. Reply with that JSON object only.", MAX_ANSWER_TOKENS)
            except BudgetExceeded as exc:
                stop.set()
                report.stopped_because = str(exc)
                return None
            except FatalLlmError as exc:
                stop.set()
                report.stopped_because = str(exc)
                return None
            except LlmError as exc:
                error = str(exc)
                with lock:
                    api_failures[0] += 1
                    if api_failures[0] >= API_FAILURES_STOP and not stop.is_set():
                        stop.set()
                        report.stopped_because = f"{API_FAILURES_STOP} requests in a row failed at the API (the last: {error})"
                break
            with lock:
                api_failures[0] = 0
            attempts += 1
            tokens_in += completion.prompt_tokens
            tokens_out += completion.completion_tokens
            tokens_hit += completion.cache_hit_tokens
            parsed = parse_response(completion.text, unit)
            if parsed is not None:
                break
            error = "the answer was not the JSON object asked for"
        if attempts == 0:
            # the API never answered: nothing is cached, so the next run asks this unit again (a reply that did arrive but is not JSON is cached: that is the model's answer)
            return UnitResult(unit, None, "", 0, 0, False, error, 0, 0)
        record = {"key": key, "unit": unit.id, "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "model": completion.model if completion else "",
                  "prompt_tokens": tokens_in, "completion_tokens": tokens_out, "cache_hit_tokens": tokens_hit, "attempts": attempts}
        if parsed is not None and completion is not None:
            record["raw"] = completion.text
        else:
            record.update({"failed": True, "error": error, "raw": completion.text if completion else ""})       # the whole answer: a later parser may read it
        save(record)
        return UnitResult(unit, parsed, record["model"], tokens_in, tokens_out, False, "" if parsed is not None else error, attempts, tokens_hit)

    def tick(result: UnitResult | None) -> None:
        if result is None:
            return
        with lock:
            done[0] += 1
            n = done[0]
        if progress and (n % 10 == 0 or n == len(units)):
            used = getattr(client, "usage", None)
            tokens = f"{used.prompt_tokens} in / {used.completion_tokens} out" if isinstance(used, Usage) else ""
            progress(f"extracted {n}/{len(units)} units ({int(time.monotonic() - started)} s) {tokens}")

    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        for result in pool.map(work, units):
            if result is not None:
                report.results.append(result)
                tick(result)
    if stop.is_set():
        report.complete = False
    elif len(report.results) != len(units):
        report.complete = False
    return report


# --- a stand-in model, for the dry run and the tests: no network, no key, no meaning -----------------------------------
class HeuristicClient:
    """Answers the build's three prompts from the text alone (a heading becomes an entity, its bullets become entities that are PART_OF it).
    A graph made with it is marked synthetic and is never mounted: it only proves the pipeline runs end to end."""

    model = "heuristic-fake"

    def __init__(self) -> None:
        self.usage = Usage()
        self._lock = threading.Lock()

    def complete_json(self, system: str, user: str, max_tokens: int = 1500) -> Completion:
        task = system.split("\n", 1)[0]
        if "extract-graph" in task:
            text = self._extract(user)
        elif "name-cluster" in task:
            text = self._cluster(user)
        else:
            text = json.dumps({"relation": "RELATED_TO"})
        with self._lock:
            self.usage.calls += 1
            self.usage.models[self.model] = self.usage.models.get(self.model, 0) + 1
        return Completion(text=text, model=self.model)

    @staticmethod
    def _extract(user: str) -> str:
        body = user.split("<<<\n", 1)[-1].split("\n>>>", 1)[0]
        entities: list[dict] = []
        relations: list[dict] = []
        for block in re.split(r"\n(?=\[(?:Slide \d+|Assignment text[^\]]*|Syllabus)\])", body):
            m = re.match(r"\[Slide (\d+)\]", block)
            page = [int(m.group(1))] if m else []
            lines = [re.sub(r"^[•\-•➢\s]+", "", ln).strip() for ln in block.split("\n")[1:]]
            lines = [ln for ln in lines if len(ln) > 3 and not ln.isdigit()]
            if not lines:
                continue
            head = re.sub(r"[^A-Za-z0-9 \-]", "", lines[0])[:60].strip()
            if not head:
                continue
            entities.append({"name": head, "type": "concept", "description": lines[1][:120] if len(lines) > 1 else "", "slides": page})
            for ln in lines[1:4]:
                name = re.sub(r"[^A-Za-z0-9 \-]", "", ln)[:50].strip()
                if name and name != head:
                    entities.append({"name": name, "type": "other", "description": "", "slides": page})
                    relations.append({"head": name, "relation": "PART_OF", "tail": head, "slides": page})
        return json.dumps({"entities": entities[:MAX_ENTITIES], "relations": relations[:MAX_RELATIONS]})

    @staticmethod
    def _cluster(user: str) -> str:
        names = re.findall(r"^- ([^:\n]+)", user, flags=re.M)[:3]
        return json.dumps({"name": " / ".join(names) or "cluster", "description": "Synthetic cluster (dry run): " + "; ".join(names)})
