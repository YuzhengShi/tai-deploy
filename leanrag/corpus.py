"""The corpus the graph is built from: the course's RELEASED material, cut into chunks that keep their page numbers.

The sources are the files the weekly release keeps current in the pages folder (the same folder the live knowledge tool's stand-in is built from,
`tai_live.sh build_corpus`): weeks.json (which week holds which deck and which assignment, and whether the week is released), the decks it names
(materials-fall2026/*.pdf), homework.json (the assignment texts) and syllabus.json. The rules are the ones the stand-in's chunker has
(nora/knowledge.py in the course world), so that the graph and the stand-in know the same things:

  * a week that is not released contributes nothing (its decks and assignments are not read at all);
  * an assignment that is hidden from students, or whose unlock time has not come, is not read;
  * a deck is read only when a released week names it.

What differs from the stand-in is the unit: a slide is ONE chunk with its page number (the stand-in cuts two pages together), because the point of the
graph's evidence is "slide 12 of the Day 4 deck". Nothing is kept that a student could not read: the artifact the build writes is mounted into a container.

Standard library, plus PyMuPDF to read a PDF (the agent image has it; the query path never imports this module).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import html
import json
import re
from dataclasses import dataclass, field
from pathlib import Path

DECKS_FOLDER = "materials-fall2026"
MIN_PAGE_CHARS = 25          # a slide with fewer characters is a picture or a divider: not a chunk (its number is still counted)
MAX_TEXT_CHARS = 1100        # one homework / syllabus chunk
INSTRUCTOR_MARKERS = re.compile(r"REFSOL|INSTRUCTOR NOTES")   # the same words tai_live.sh build_corpus refuses on


class CorpusError(Exception):
    pass


@dataclass(frozen=True)
class Chunk:
    id: str                 # "d03:p012" (deck 3, slide 12), "hw:3486457:0", "syl:0"
    kind: str               # slide | homework | syllabus
    deck: str               # the deck's file name for a slide, "" otherwise
    title: str              # the deck's title, the assignment's name, "Syllabus"
    week: str               # the key in weeks.json ("w4"), or "syllabus"
    page: int               # the slide's number (1 is the first page of the file), 0 for the others
    visible_from: str       # "2026-09-28" (the week's first day) or a UTC time ("2026-10-05T16:00:00Z"): from then on a student may read it
    heading: str            # the slide's first line that is not only a number; "" for the others
    text: str

    def to_dict(self) -> dict:
        return {"id": self.id, "kind": self.kind, "deck": self.deck, "title": self.title, "week": self.week, "page": self.page,
                "visible_from": self.visible_from, "heading": self.heading, "text": self.text}


@dataclass
class Corpus:
    chunks: list[Chunk] = field(default_factory=list)
    decks: list[dict] = field(default_factory=list)          # {"file", "title", "week", "pages", "chunks"}
    warnings: list[str] = field(default_factory=list)
    files: dict = field(default_factory=dict)                 # name -> {"bytes", "sha256"}: what the corpus was read from
    now: str = ""
    page_config: dict = field(default_factory=dict)


# --- text helpers (the rules of nora/knowledge.py) -----------------------------------------------------------------
_BLOCK_END = re.compile(r"</(p|div|li|h[1-6]|tr|ul|ol|table|section)>|<br\s*/?>", re.I)


def strip_html(raw: str) -> str:
    """Canvas page HTML to plain text, one paragraph per line."""
    raw = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", raw, flags=re.S | re.I)
    raw = re.sub(r"<link[^>]*>", " ", raw, flags=re.I)
    text = html.unescape(re.sub(r"<[^>]+>", " ", _BLOCK_END.sub("\n", raw)))
    lines = (re.sub(r"[ \t ]+", " ", line).strip() for line in text.split("\n"))
    return "\n".join(line for line in lines if line)


def split_text(text: str, limit: int = MAX_TEXT_CHARS) -> list[str]:
    """Paragraphs grouped up to `limit` characters; a paragraph longer than that is cut at a sentence end."""
    pieces: list[str] = []
    for para in text.split("\n"):
        while len(para) > limit:
            cut = max(para.rfind(". ", 0, limit), para.rfind("? ", 0, limit), para.rfind("! ", 0, limit))
            cut = cut + 1 if cut > limit // 2 else limit
            pieces.append(para[:cut].strip())
            para = para[cut:].strip()
        if para:
            pieces.append(para)
    chunks: list[str] = []
    current = ""
    for piece in pieces:
        if current and len(current) + 1 + len(piece) > limit:
            chunks.append(current)
            current = ""
        current = f"{current}\n{piece}" if current else piece
    if current:
        chunks.append(current)
    return chunks


def parse_utc(value: str | None) -> dt.datetime | None:
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00")) if value else None
    except ValueError:
        return None
    return parsed.replace(tzinfo=dt.timezone.utc) if parsed and parsed.tzinfo is None else parsed


def slide_heading(text: str) -> str:
    for line in text.split("\n"):
        line = line.strip()
        if line and not line.isdigit():
            return line[:120]
    return ""


def deck_title(item: dict) -> str:
    """The deck's title as the live stand-in and `course-docs canvas` name it: the item's title (or file name) without .pdf, underscores as spaces."""
    return re.sub(r"\.pdf$", "", item.get("title") or item["file"], flags=re.I).replace("_", " ")


def deck_pages(path: Path) -> list[str]:
    """The text of each page of a deck (index 0 is page 1)."""
    try:
        import pymupdf  # noqa: PLC0415  (the one place that needs it)
    except ImportError:
        import fitz as pymupdf  # noqa: PLC0415
    with pymupdf.open(str(path)) as pdf:
        return [re.sub(r"[ \t ]+", " ", page.get_text("text") or "").strip() for page in pdf]


def _sha256(path: Path) -> dict:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return {"bytes": path.stat().st_size, "sha256": h.hexdigest()}


def _json(pages_dir: Path, name: str, required: bool = False):
    path = pages_dir / name
    if not path.is_file():
        if required:
            raise CorpusError(f"{path} is missing: the weekly release has not produced it")
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def week_start_utc(start: str | None) -> str:
    """A week's `start` ("2026-09-28") is what chunks of that week become visible from."""
    return start or ""


def load_corpus(pages_dir: str | Path, now: dt.datetime | None = None, pages_reader=deck_pages) -> Corpus:
    """Read the released material of `pages_dir`. `now` decides which assignments are unlocked (UTC). `pages_reader` is the PDF reader (a test seam)."""
    pages_dir = Path(pages_dir)
    now = (now or dt.datetime.now(dt.timezone.utc)).astimezone(dt.timezone.utc)
    weeks_doc = _json(pages_dir, "weeks.json", required=True)
    homework = _json(pages_dir, "homework.json") or {}
    syllabus = _json(pages_dir, "syllabus.json") or {}
    page_config = _json(pages_dir, "page-config.json") or {}
    corpus = Corpus(now=now.strftime("%Y-%m-%dT%H:%M:%SZ"), page_config={k: page_config.get(k) for k in ("term", "released_weeks", "version") if k in page_config})
    for name in ("weeks.json", "homework.json", "syllabus.json", "page-config.json"):
        if (pages_dir / name).is_file():
            corpus.files[name] = _sha256(pages_dir / name)

    seen_decks: set[str] = set()
    for key, week in (weeks_doc.get("weeks") or {}).items():
        if key == "syllabus" or week.get("released") is False:
            continue
        start = week_start_utc(week.get("start"))
        for item in week.get("items", []):
            if item.get("kind") == "slides" and item.get("file") and item["file"] not in seen_decks:
                seen_decks.add(item["file"])
                _add_deck(corpus, pages_dir, item, key, start, len(seen_decks) - 1, pages_reader)
            elif item.get("kind") == "hw":
                _add_homework(corpus, item, homework.get(str(item.get("id"))), key, start, now)
    for n, part in enumerate(split_text(strip_html(syllabus.get("html", "")))):
        corpus.chunks.append(Chunk(f"syl:{n}", "syllabus", "", syllabus.get("title") or "Syllabus", "syllabus", 0, "", "", part))

    folder = pages_dir / DECKS_FOLDER
    if folder.is_dir():
        for path in sorted(folder.glob("*.pdf")):
            if path.name not in seen_decks:
                corpus.warnings.append(f"deck {path.name} is in {DECKS_FOLDER}/ but no released week names it: not read")
    for chunk in corpus.chunks:
        if INSTRUCTOR_MARKERS.search(chunk.text) or INSTRUCTOR_MARKERS.search(chunk.title):
            raise CorpusError(f"the corpus holds an instructor-notes marker (chunk {chunk.id}): it must not be built from")
    return corpus


def _add_deck(corpus: Corpus, pages_dir: Path, item: dict, week: str, start: str, index: int, pages_reader) -> None:
    path = pages_dir / DECKS_FOLDER / item["file"]
    if not path.is_file():
        corpus.warnings.append(f"deck {item['file']} is named in weeks.json but is not in {path.parent}")
        return
    corpus.files[f"{DECKS_FOLDER}/{item['file']}"] = _sha256(path)
    pages = pages_reader(path)
    title = deck_title(item)
    made = 0
    for number, text in enumerate(pages, 1):
        if len(text) < MIN_PAGE_CHARS:
            continue
        corpus.chunks.append(Chunk(f"d{index:02d}:p{number:03d}", "slide", item["file"], title, week, number, start, slide_heading(text), text))
        made += 1
    corpus.decks.append({"file": item["file"], "title": title, "week": week, "pages": len(pages), "chunks": made})


def _add_homework(corpus: Corpus, item: dict, record: dict | None, week: str, start: str, now: dt.datetime) -> None:
    if not record or record.get("student_visible") is False:
        return
    unlock = parse_utc(record.get("unlock_at"))
    if unlock and unlock > now:
        return
    name = record.get("name") or item.get("title") or "Homework"
    due = record.get("due_at") or item.get("due_at")
    head = f"{name}" + (f" (due {due})" if due else "")
    for n, part in enumerate(split_text(strip_html(record.get("description", ""))) or [""]):
        text = (f"{head}\n" if n == 0 else "") + part
        if text.strip():
            corpus.chunks.append(Chunk(f"hw:{item.get('id')}:{n}", "homework", "", head, week, 0, record.get("unlock_at") or start, "", text.strip()))
