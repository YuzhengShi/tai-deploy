"""Canvas LMS API helper — reads JSON request from stdin, returns JSON to stdout."""
import json
import re
import sys
import os
import html as html_lib
import io
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from pacific_time import pacific, relative, student_local  # Canvas gives UTC; the course keeps Pacific time: every due date carries both, how far away it is, and the student's own clock when that reads differently

try:
    import requests
except ImportError:
    print(json.dumps({"error": "requests library not installed"}))
    sys.exit(1)

TOKEN = os.environ.get('CANVAS_API_TOKEN', '')
BASE_URL = os.environ.get('CANVAS_BASE_URL', '').rstrip('/')
COURSE_ID = os.environ.get('CANVAS_COURSE_ID', '')
MAX_PAGES = 5
TIMEOUT = 15

# ── P0: strip raw control chars that break JSON.parse in Node.js ──────────────
_CTRL_RE = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]')

def safe_json(text):
    return json.loads(_CTRL_RE.sub('', text))


# ── HTML / text helpers ───────────────────────────────────────────────────────

def strip_html(html):
    text = re.sub(r'<[^>]+>', ' ', html or '')
    text = html_lib.unescape(text)
    return re.sub(r'\s+', ' ', text).strip()


# What week_status and the comments of student_submission hand out is written by students and teachers and ends in a model's prompt: plain text,
# one line, no control character (C0, DEL, C1) and no bidi override (they hide what a line says), never longer than the caller's limit.
_BAD_CHARS = re.compile('[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069\ufeff]')


def clip(text, limit):
    """`text` cut to at most `limit` characters, at a space when one is near the end, with an ellipsis that counts toward the limit."""
    if len(text) <= limit:
        return text
    cut = text[:max(limit - 1, 0)]
    space = cut.rfind(' ')
    if space > limit * 0.8:
        cut = cut[:space]
    return cut.rstrip() + '…'


def plain(value, limit):
    """Plain single-line text of an HTML fragment or string, at most `limit` characters (clip)."""
    text = strip_html(value if isinstance(value, str) else ('' if value is None else str(value)))
    return clip(re.sub(r'\s+', ' ', _BAD_CHARS.sub('', text)).strip(), limit)

def extract_github_urls(text):
    """Return unique GitHub repo root URLs found in text (github.com and GitHub Enterprise).
    Excludes CDN/asset paths like user-attachments, assets, raw, releases, etc.
    """
    _NON_REPO_OWNERS = {'user-attachments', 'assets', 'raw', 'releases', 'gist', 'orgs', 'users', 'topics'}
    raw = re.findall(r'https?://github[^/\s]*/[\w.\-]+/[\w.\-]+', text or '')
    filtered = [u for u in raw if u.split('/')[-2].lower() not in _NON_REPO_OWNERS]
    return list(dict.fromkeys(filtered))  # dedup, preserve order

def extract_google_docs_urls(text):
    """Extract Google Docs/Sheets/Slides URLs from text (or raw HTML)."""
    raw = re.findall(r'https?://docs\.google\.com/\w+/d/[a-zA-Z0-9_-]+', text or '')
    return list(dict.fromkeys(raw))

MAX_IMAGES_PER_SUBMISSION = 3

def describe_image(image_bytes, filename):
    """Use Bedrock Claude Haiku to describe a screenshot of student work."""
    try:
        import boto3
        import base64

        region = os.environ.get('AWS_REGION', 'us-east-1')
        client = boto3.client('bedrock-runtime', region_name=region)

        ext = filename.rsplit('.', 1)[-1].lower()
        media_type = {
            'png': 'image/png', 'jpg': 'image/jpeg', 'jpeg': 'image/jpeg',
            'gif': 'image/gif', 'webp': 'image/webp',
        }.get(ext, 'image/png')

        b64 = base64.b64encode(image_bytes).decode()

        resp = client.invoke_model(
            modelId='us.anthropic.claude-haiku-4-5-20251001',
            body=json.dumps({
                "anthropic_version": "bedrock-2023-05-31",
                "max_tokens": 400,
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
                        {"type": "text", "text": "Describe what this screenshot shows about a CS student's work. Focus on architecture, code, test results, deployment output, or system design. 2-3 sentences."}
                    ]
                }]
            })
        )
        body = json.loads(resp['body'].read())
        return body['content'][0]['text']
    except Exception as e:
        return f"[Image analysis unavailable: {e}]"


# ── Attachment download + text extraction ─────────────────────────────────────

_TEXT_EXTS = {
    'md', 'tf', 'tfvars', 'go', 'py', 'java', 'js', 'ts', 'jsx', 'tsx',
    'yaml', 'yml', 'toml', 'sh', 'bash', 'txt', 'csv', 'html', 'htm',
    'json', 'xml', 'dockerfile', 'makefile', 'rb', 'rs', 'cpp', 'c', 'h',
}
_SKIP_EXTS = {'mov', 'mp4', 'avi', 'mkv', 'mp3', 'wav'}
_ARCHIVE_EXTS = {'zip', 'tar', 'gz', 'tgz'}
_IMAGE_EXTS = {'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff'}
MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024  # 50 MB hard cap


def extract_archive(raw, filename):
    """Extract text files from a zip/tar/gz archive. Returns (text, error_note)."""
    import zipfile
    import tarfile

    ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    parts = []
    skipped = []
    total_text = 0
    MAX_EXTRACTED_TEXT = 500_000  # 500 KB total text budget

    def _should_read(member_name):
        """Check if an archive member is a text file we should read."""
        m_ext = member_name.rsplit('.', 1)[-1].lower() if '.' in member_name else ''
        m_lower = member_name.rsplit('/', 1)[-1].lower() if '/' in member_name else member_name.lower()
        if m_ext in _SKIP_EXTS or m_ext in _IMAGE_EXTS or m_ext in _ARCHIVE_EXTS:
            return False
        if m_ext in _TEXT_EXTS or m_lower in ('dockerfile', 'makefile', 'procfile'):
            return True
        if m_ext == 'pdf':
            return True
        return False

    try:
        if ext == 'zip':
            with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                for info in sorted(zf.infolist(), key=lambda i: i.filename):
                    if info.is_dir() or info.file_size == 0:
                        continue
                    if info.file_size > 5 * 1024 * 1024:
                        skipped.append(f"{info.filename} (>5MB)")
                        continue
                    if not _should_read(info.filename):
                        skipped.append(info.filename)
                        continue
                    if total_text >= MAX_EXTRACTED_TEXT:
                        skipped.append(f"{info.filename} (text budget exceeded)")
                        continue
                    try:
                        content = zf.read(info.filename)
                        text = content.decode('utf-8', errors='replace')
                        chunk = text[:4000]
                        parts.append(f"=== {info.filename} ===\n{chunk}")
                        total_text += len(chunk)
                    except Exception:
                        skipped.append(f"{info.filename} (read error)")

        elif ext in ('tar', 'gz', 'tgz'):
            mode = 'r:gz' if ext in ('gz', 'tgz') else 'r:'
            with tarfile.open(fileobj=io.BytesIO(raw), mode=mode) as tf:
                for member in sorted(tf.getmembers(), key=lambda m: m.name):
                    if not member.isfile() or member.size == 0:
                        continue
                    if member.size > 5 * 1024 * 1024:
                        skipped.append(f"{member.name} (>5MB)")
                        continue
                    if not _should_read(member.name):
                        skipped.append(member.name)
                        continue
                    if total_text >= MAX_EXTRACTED_TEXT:
                        skipped.append(f"{member.name} (text budget exceeded)")
                        continue
                    try:
                        f = tf.extractfile(member)
                        if f is None:
                            continue
                        content = f.read()
                        text = content.decode('utf-8', errors='replace')
                        chunk = text[:4000]
                        parts.append(f"=== {member.name} ===\n{chunk}")
                        total_text += len(chunk)
                    except Exception:
                        skipped.append(f"{member.name} (read error)")
        else:
            return None, f"[{filename}: unsupported archive format]"

    except (zipfile.BadZipFile, tarfile.TarError) as e:
        return None, f"[{filename}: corrupt archive — {e}]"
    except Exception as e:
        return None, f"[{filename}: archive extraction failed — {e}]"

    if not parts:
        note = f"[{filename}: no readable text files found]"
        if skipped:
            note += f" Skipped: {', '.join(skipped[:10])}"
        return None, note

    text = "\n\n".join(parts)
    note = None
    if skipped:
        note = f"[Skipped {len(skipped)} non-text files in {filename}]"
    return text, note


def download_file(url):
    """Download from Canvas URL. Try with auth first (for Canvas file URLs),
    then without (for pre-signed S3 URLs)."""
    try:
        resp = requests.get(url, headers={"Authorization": f"Bearer {TOKEN}"}, timeout=30)
        if resp.status_code == 403:
            # Pre-signed URL — no auth header
            resp = requests.get(url, timeout=30)
        resp.raise_for_status()
        return resp.content
    except Exception as e:
        raise RuntimeError(f"Download failed: {e}")


def read_attachment(url, filename, content_type, size=0):
    """Download and extract text from a Canvas attachment.
    Returns (text_or_None, error_note_or_None)."""
    if not url:
        return None, f"No URL for {filename}"

    ct = (content_type or '').lower()
    ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    fname_lower = filename.lower()

    # Skip large / media files before downloading
    if size > MAX_ATTACHMENT_SIZE:
        return None, f"[SKIPPED: {filename} too large ({size // 1024 // 1024} MB)]"
    if ext in _SKIP_EXTS:
        return None, f"[SKIPPED: {filename} (binary/media)]"
    if ext in _ARCHIVE_EXTS:
        try:
            raw = download_file(url)
        except RuntimeError as e:
            return None, str(e)
        return extract_archive(raw, filename)
    if ext in _IMAGE_EXTS:
        if not os.environ.get('AWS_ACCESS_KEY_ID'):
            return None, f"[IMAGE: {filename} — no AWS credentials for vision]"
        if size > 5 * 1024 * 1024:
            return None, f"[IMAGE: {filename} — too large for vision]"
        try:
            raw = download_file(url)
            desc = describe_image(raw, filename)
            return f"[Screenshot: {filename}]\n{desc}", None
        except Exception as e:
            return None, f"[IMAGE: {filename} — {e}]"

    try:
        raw = download_file(url)
    except RuntimeError as e:
        return None, str(e)

    # ── PDF ──────────────────────────────────────────────────────────────────
    if 'pdf' in ct or ext == 'pdf':
        with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as tmp:
            tmp.write(raw)
            tmp_path = tmp.name
        try:
            result = subprocess.run(
                ['pdftotext', '-layout', tmp_path, '-'],
                capture_output=True, text=True, timeout=30
            )
            text = result.stdout.strip()
            return (text if text else None,
                    None if text else f"[PDF {filename}: image-based, no extractable text]")
        except Exception as e:
            return None, f"[PDF {filename}: pdftotext failed — {e}]"
        finally:
            try: os.unlink(tmp_path)
            except: pass

    # ── DOCX ─────────────────────────────────────────────────────────────────
    if ext == 'docx' or 'wordprocessingml' in ct:
        try:
            from docx import Document
            doc = Document(io.BytesIO(raw))
            parts = []
            for para in doc.paragraphs:
                t = para.text.strip()
                if t:
                    parts.append(t)
            # Also grab table cells
            for table in doc.tables:
                for row in table.rows:
                    row_texts = [cell.text.strip() for cell in row.cells if cell.text.strip()]
                    if row_texts:
                        parts.append(' | '.join(row_texts))
            text = '\n'.join(parts)
            return (text if text else None,
                    None if text else f"[DOCX {filename}: no text content]")
        except ImportError:
            return None, f"[DOCX {filename}: python-docx not installed]"
        except Exception as e:
            return None, f"[DOCX {filename}: parse error — {e}]"

    # ── Plain text variants ───────────────────────────────────────────────────
    is_text_ct = any(ct.startswith(p) for p in ('text/', 'application/json', 'application/xml'))
    is_text_ext = ext in _TEXT_EXTS or fname_lower in ('dockerfile', 'makefile', 'procfile')
    if is_text_ct or is_text_ext or 'octet-stream' in ct:
        # octet-stream is used for .tf / .tfvars — try to decode as text
        try:
            return raw.decode('utf-8', errors='replace'), None
        except Exception as e:
            return None, f"[{filename}: decode error — {e}]"

    return None, f"[{filename} ({ct}): unsupported format]"


# ── Core API helpers ──────────────────────────────────────────────────────────

def api_get(endpoint, params=None):
    """GET with pagination, returns combined list or single object."""
    url = f"{BASE_URL}{endpoint}"
    headers = {"Authorization": f"Bearer {TOKEN}"}
    all_results = []
    pages = 0

    while url and pages < MAX_PAGES:
        resp = requests.get(url, headers=headers, params=params, timeout=TIMEOUT)
        resp.raise_for_status()
        data = safe_json(resp.text)          # P0: use safe_json
        if isinstance(data, list):
            all_results.extend(data)
        else:
            return data
        url = None
        params = None
        link = resp.headers.get('Link', '')
        for part in link.split(','):
            if 'rel="next"' in part:
                url = part.split('<')[1].split('>')[0]
        pages += 1

    return all_results


def due_fields(iso, now=None):
    """due_pacific, due_local and due_relative of a UTC due date, in that order, to be spread into the answer. due_local (the student's own
    clock: pacific_time.student_local) is there only when the student's zone is known (TAI_STUDENT_TZ) and reads differently from the Pacific
    time: otherwise the key is absent, not null, and the answer is what it always was. `now` (naive UTC) is for week_status, which counts every
    date of one answer from the same instant, and for tests; every other caller leaves it out."""
    fields = {"due_pacific": pacific(iso)}
    local = student_local(iso)
    if local:
        fields["due_local"] = local
    fields["due_relative"] = relative(iso, now)
    return fields


def fmt_assignment(a):
    return {
        "id": a.get("id"),
        "name": a.get("name"),
        "due_at": a.get("due_at"),
        **due_fields(a.get("due_at")),
        "points_possible": a.get("points_possible"),
        "submission_types": a.get("submission_types"),
        "html_url": a.get("html_url"),
        "published": a.get("published"),
    }


def fmt_submission(s):
    user = s.get("user", {}) or {}
    return {
        "user_id": s.get("user_id"),
        "user_name": user.get("name") or user.get("sortable_name"),
        "submitted_at": s.get("submitted_at"),
        "late": s.get("late"),
        "missing": s.get("missing"),
        "score": s.get("score"),
        "grade": s.get("grade"),
        "workflow_state": s.get("workflow_state"),
    }


# ── P1: rich student submission content extraction ────────────────────────────

def submission_comments(sub, keep=10, text_limit=500):
    """The comments on a submission as [{at, role, text}], oldest first, the newest `keep` of them. role: 'student' when the author is the
    student whose submission it is, 'teacher' for anybody else with an author id (graders are who writes on a submission), 'other' when
    Canvas names no author. Author names are not passed on: a comment is the student's own business, and a teacher's name adds nothing."""
    owner = str(sub.get('user_id') or '')
    found = []
    for comment in (sub.get('submission_comments') or []):
        if not isinstance(comment, dict):
            continue
        text = plain(comment.get('comment'), text_limit)
        if not text:
            continue
        author = str(comment.get('author_id') or (comment.get('author') or {}).get('id') or '')
        role = 'other' if not author else ('student' if owner and author == owner else 'teacher')
        found.append({"at": str(comment.get('created_at') or ''), "role": role, "text": text})
    found.sort(key=lambda c: c["at"])                     # Canvas lists them oldest first already; a sort that is stable keeps that
    return found[-keep:] if keep else []


def extract_submission_content(sub):
    """Extract readable text from a Canvas submission object.

    Returns a dict with:
      submission_type, full_text, github_urls, attachment_notes, and: missing, workflow_state, attempt, comments
    """
    submission_type = sub.get("submission_type", "") or ""
    full_text = ""
    github_urls = []
    google_docs_urls = []
    attachment_notes = []

    if submission_type == "online_text_entry":
        body_html = sub.get("body", "") or ""
        github_urls = extract_github_urls(body_html)        # raw HTML catches href URLs
        google_docs_urls = extract_google_docs_urls(body_html)
        full_text = strip_html(body_html)

    elif submission_type == "online_upload":
        attachments = sub.get("attachments", []) or []
        parts = []
        images_analyzed = 0
        for att in attachments:
            filename = att.get("filename") or att.get("display_name") or "unknown"
            content_type = att.get("content-type") or att.get("mime_class") or ""
            size = att.get("size") or 0
            url = att.get("url") or att.get("download_url") or ""
            ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''

            # Cap image vision calls per submission
            if ext in _IMAGE_EXTS and images_analyzed >= MAX_IMAGES_PER_SUBMISSION:
                attachment_notes.append(f"[SKIPPED: {filename} — image limit ({MAX_IMAGES_PER_SUBMISSION})]")
                continue

            text, note = read_attachment(url, filename, content_type, size)
            if text:
                if ext in _IMAGE_EXTS:
                    images_analyzed += 1
                github_urls.extend(extract_github_urls(text))
                parts.append(f"=== {filename} ===\n{text[:4000]}")
            if note:
                attachment_notes.append(note)

        full_text = "\n\n".join(parts)
        github_urls = list(dict.fromkeys(github_urls))  # dedup
        google_docs_urls = extract_google_docs_urls(full_text)

    elif submission_type in ("online_url", "basic_lti_launch"):
        url = sub.get("url") or ""
        full_text = f"Submission URL: {url}"
        github_urls = extract_github_urls(url)

    return {
        "submission_type": submission_type,
        "submitted_at": sub.get("submitted_at"),
        "score": sub.get("score"),
        "grade": sub.get("grade"),
        "late": sub.get("late"),
        "missing": sub.get("missing"),
        "workflow_state": sub.get("workflow_state"),
        "attempt": sub.get("attempt"),
        "comments": submission_comments(sub),
        "full_text": full_text,
        "github_urls": github_urls,
        "google_docs_urls": google_docs_urls,
        "attachment_notes": attachment_notes,
    }


# ── The weekly interview brief: week_status and user_contact (docs/WEEKLY_BRIEF.md) ─────────────────────────────────────────────────────────────
#
# week_status answers, in one call, what a mock interview about "this week" needs from Canvas: the week's assignments with their requirements,
# and where the student stands on each. It makes at most 7 requests (the assignment list, the modules, the primary assignment's detail, a
# submission per assignment, four at most), never downloads an attachment (the interview's other half, start_mock_interview, already reads the
# primary submission's files; a download here would double the time and the vision calls) and stops itself after WEEK_BUDGET_SECONDS, so that
# the caller's 15 s limit never kills it with nothing to show: what it could not read is "unknown", not missing.

WEEK_DAYS = 7                      # how far back "this week" reaches from now, and how long an assignment with no unlock date is taken to run
WEEK_LOOKBACK_MAX_DAYS = 21        # the window never starts earlier than this, whatever the primary assignment's unlock date says
WEEK_MAX_ASSIGNMENTS = 4
WEEK_BUDGET_SECONDS = 11.0
WEEK_REQUEST_TIMEOUT = 6
PRIMARY_REQUIREMENTS_MAX = 2500    # characters of the primary assignment's description; the others' are cut at 600
OTHER_REQUIREMENTS_MAX = 600
PRIMARY_TEXT_MAX = 1500            # characters of a submission's text (the others' are cut at 600)
OTHER_TEXT_MAX = 600
COMMENT_TEXT_MAX = 300
BRIEF_COMMENTS_MAX = 5
BRIEF_RUBRIC_MAX = 8
BRIEF_LINKS_MAX = 5
_DIGITS = re.compile(r'\d{1,20}')


def utc_now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def parse_utc(iso):
    """A Canvas timestamp as a naive UTC datetime (the first 19 characters: 'Z', offsets and fractions are not read: Canvas always sends Z); None when it is not one."""
    if not iso:
        return None
    try:
        return datetime.strptime(str(iso)[:19], '%Y-%m-%dT%H:%M:%S')
    except ValueError:
        return None


def iso_z(moment):
    return moment.strftime('%Y-%m-%dT%H:%M:%SZ')


def is_published(assignment):
    return assignment.get('published') is not False       # a token that is not a teacher's may not say; unpublished is only what Canvas says is


def pick_primary(assignments, assignment_id, now):
    """The primary assignment: the one the caller named; else the published one with the earliest due date at or after now; else the published one most
    recently due; one with no due date or not published is never picked by the rule. None when nothing is left. The same rule as pickPrimaryAssignment
    in container/agent-runner/src/weekly-brief.ts (which the interview's lookups and the brief use: the unlock date plays no part in it, because the
    `assignments` list that code reads has none); test/weekly-brief.test.ts runs both on the same cases."""
    if assignment_id:
        for a in assignments:
            if str(a.get('id')) == str(assignment_id):
                return a
    published = [a for a in assignments if is_published(a)]
    dated = [(parse_utc(a.get('due_at')), a) for a in published]
    dated = [(due, a) for due, a in dated if due is not None]
    open_ones = [(due, a) for due, a in dated if due >= now]
    if open_ones:
        return min(open_ones, key=lambda pair: pair[0])[1]
    past = [(due, a) for due, a in dated if due < now]
    return max(past, key=lambda pair: pair[0])[1] if past else None


def week_window(primary, now):
    """(since, until): from the earlier of a week ago and the primary assignment's unlock date, but never more than 21 days back; until is now."""
    since = now - timedelta(days=WEEK_DAYS)
    unlock = parse_utc(primary.get('unlock_at')) if primary else None
    if unlock is not None and unlock < since:
        since = unlock
    return max(since, now - timedelta(days=WEEK_LOOKBACK_MAX_DAYS)), now


def week_assignments(assignments, primary, now):
    """The primary assignment and the other published ones that are running this week (started, and due no longer ago than a week; an assignment
    with no unlock date is taken to have started a week before it is due), at most four in all, the others being the ones due closest to the primary,
    ordered by due date."""
    chosen = []
    pid = str(primary.get('id')) if primary else None
    for a in assignments:
        if not is_published(a) or str(a.get('id')) == pid:
            continue
        due = parse_utc(a.get('due_at'))
        if due is None:
            continue
        start = parse_utc(a.get('unlock_at')) or (due - timedelta(days=WEEK_DAYS))
        if start <= now and due >= now - timedelta(days=WEEK_DAYS):
            chosen.append((due, a))
    anchor = (parse_utc(primary.get('due_at')) if primary else None) or now
    chosen.sort(key=lambda pair: abs((pair[0] - anchor).total_seconds()))
    picked = [a for _, a in chosen[:WEEK_MAX_ASSIGNMENTS - (1 if primary else 0)]]
    if primary:
        picked.append(primary)
    picked.sort(key=lambda a: (parse_utc(a.get('due_at')) is None, parse_utc(a.get('due_at')) or datetime.max))
    return picked


def find_week(modules, assignment_id):
    """{'number', 'title'} of the Canvas module that holds the assignment ('Week 8! We are over half way!' is week 8); None when no module does."""
    for module in modules or []:
        for item in (module.get('items') or []):
            if item.get('type') == 'Assignment' and str(item.get('content_id')) == str(assignment_id):
                title = plain(module.get('name'), 120)
                found = re.search(r'\bweek\s*(\d+)', title, re.I)
                return {"number": int(found.group(1)) if found else None, "title": title}
    return None


def due_text(iso, now):
    """'Mon Nov 2, 9:00 AM PST (in 4 days)': the Pacific time (due_fields: the course keeps Pacific time) and how far away it is, plus the student's own
    clock when their zone is known and reads differently; 'no due date' when there is none."""
    if not parse_utc(iso):
        return "no due date"
    fields = due_fields(iso, now)
    away = re.sub(r'^(was )?due ', '', fields.get("due_relative") or '')
    if fields.get("due_local"):
        away = '%s; on your clock: %s' % (away, fields["due_local"]) if away else 'on your clock: %s' % fields["due_local"]
    return '%s (%s)' % (fields["due_pacific"], away) if away else fields["due_pacific"]


def fmt_points(value):
    return ('%.2f' % value).rstrip('0').rstrip('.')


def submission_status(a, sub, now):
    """(status, one plain sentence) for the student's submission of assignment `a` (None for a submission Canvas would not give). Status is one of
    graded, submitted, late, missing, not_submitted, unknown. The student's own due date (Canvas's cached_due_date: an extension is one) counts
    over the assignment's. Every time in a sentence is Pacific, the course's clock (pacific_time)."""
    if sub is None:
        return 'unknown', "Status unknown: Canvas did not return this student's submission"
    due_iso = sub.get('cached_due_date') or a.get('due_at')
    due = parse_utc(due_iso)
    types = [t for t in (a.get('submission_types') or []) if t]
    online = any(t not in ('none', 'on_paper', 'not_graded') for t in types)
    score, grade, points = sub.get('score'), sub.get('grade'), a.get('points_possible')
    when = pacific(sub.get('submitted_at')) if sub.get('submitted_at') else None
    late = bool(sub.get('late'))
    attempt = sub.get('attempt')
    tries = ' (attempt %d)' % attempt if isinstance(attempt, int) and attempt > 1 else ''
    if sub.get('excused'):
        return 'graded', 'Excused: the instructor excused this assignment'
    if sub.get('workflow_state') == 'graded' and (score is not None or grade not in (None, '')):
        if score is not None:
            result = '%s of %s' % (fmt_points(score), fmt_points(points)) if isinstance(points, (int, float)) and points else fmt_points(score)
        else:
            result = str(grade)
        first = 'Submitted %s%s, %s' % (when, tries, 'late' if late else 'on time') if when else 'No submission is on record'
        return 'graded', '%s; graded %s' % (first, result)
    if when:
        if late:
            overdue = ' (it was due %s)' % pacific(due_iso) if due else ''
            return 'late', 'Submitted %s%s, late%s; not graded yet' % (when, tries, overdue)
        waiting = 'waiting for review' if sub.get('workflow_state') == 'pending_review' else 'not graded yet'
        return 'submitted', 'Submitted %s%s%s; %s' % (when, tries, ', on time' if due else '', waiting)
    if not online:
        return 'unknown', 'No online submission is expected for this assignment'
    if sub.get('missing') or (due is not None and due < now):
        if due is None:
            return 'missing', 'Missing: Canvas marks it missing and nothing was submitted'
        return 'missing', 'Missing: it was due %s and nothing was submitted' % due_text(due_iso, now)
    return 'not_submitted', 'Not submitted yet; due %s' % due_text(due_iso, now) if due else 'Not submitted yet (no due date)'


def submission_text_and_links(sub, limit):
    """(text, links) of what the student handed in, without downloading anything: the body of a text entry, the address of a URL submission,
    the names (never the download addresses, which carry Canvas's access key) of uploaded files. Links are the submission's own address and
    any GitHub or Google Docs address in the body or the comments."""
    kind = sub.get('submission_type') or ''
    links, text = [], ''
    if kind == 'online_text_entry':
        body = sub.get('body') or ''
        text = plain(body, limit)
        links = extract_github_urls(body) + extract_google_docs_urls(body)
    elif kind in ('online_url', 'basic_lti_launch'):
        url = str(sub.get('url') or '')
        text = plain('Submission URL: %s' % url, limit) if url else ''
        links = ([url] if re.match(r'https?://', url) else []) + extract_github_urls(url)
    elif kind == 'online_upload':
        names = [plain(att.get('display_name') or att.get('filename') or 'file', 80) for att in (sub.get('attachments') or []) if isinstance(att, dict)]
        text = plain('Uploaded files: %s' % ', '.join(names[:8]), limit) if names else ''
    for comment in (sub.get('submission_comments') or []):
        if isinstance(comment, dict):
            links += extract_github_urls(comment.get('comment') or '')
    return text, [plain(link, 300) for link in dict.fromkeys(links) if _BAD_CHARS.search(link) is None][:BRIEF_LINKS_MAX]


def rubric_lines(a, sub):
    """'Criterion: 8/10 - comment' for each rubric criterion the teacher scored on this submission (those the assignment's rubric describes), at most eight."""
    assessment = sub.get('rubric_assessment')
    criteria = {str(c.get('id')): c for c in (a.get('rubric') or []) if isinstance(c, dict)}
    lines = []
    if isinstance(assessment, dict):
        for cid, given in assessment.items():
            criterion = criteria.get(str(cid))
            if not criterion or not isinstance(given, dict) or given.get('points') is None:
                continue
            line = '%s: %s/%s' % (plain(criterion.get('description'), 80), fmt_points(given['points']), fmt_points(criterion.get('points') or 0))
            note = plain(given.get('comments'), 120)
            lines.append('%s - %s' % (line, note) if note else line)
    return lines[:BRIEF_RUBRIC_MAX]


def brief_submission(a, sub, text_limit):
    """The `submission` object of one assignment of the brief: what Canvas says and what the student and the teachers wrote, as plain text."""
    text, links = submission_text_and_links(sub, text_limit)
    comments = [{"at": c["at"], "from": c["role"], "text": clip(c["text"], COMMENT_TEXT_MAX)} for c in submission_comments(sub, BRIEF_COMMENTS_MAX, COMMENT_TEXT_MAX)]
    score, attempt = sub.get('score'), sub.get('attempt')
    return {
        "submittedAt": sub.get('submitted_at') or None,
        "late": sub.get('late') if isinstance(sub.get('late'), bool) else None,
        "missing": sub.get('missing') if isinstance(sub.get('missing'), bool) else None,
        "score": score if isinstance(score, (int, float)) and not isinstance(score, bool) else None,
        "grade": plain(sub.get('grade'), 40) if sub.get('grade') not in (None, '') else None,
        "attempt": attempt if isinstance(attempt, int) and not isinstance(attempt, bool) else None,
        "type": plain(sub.get('submission_type'), 40),
        "links": links,
        "text": text,
        "comments": comments,
        "rubric": rubric_lines(a, sub),
    }


class Budget:
    """A deadline for one call of this script: week_status stops fetching when it has passed and says what it did not read."""

    def __init__(self, seconds, clock=time.monotonic):
        self.clock = clock
        self.end = clock() + seconds

    def left(self):
        return self.end - self.clock()

    def expired(self):
        return self.left() <= 0


def week_status(c, params):
    """The window, the week and the week's assignments with the student's status on each (see the block comment above for what it costs)."""
    global TIMEOUT
    uid = str(params.get('user_id') or '')
    if not _DIGITS.fullmatch(uid):
        return {"error": "user_id required (the Canvas user id, digits; bound automatically for students)"}
    wanted = str(params.get('assignment_id') or '')
    if wanted and not _DIGITS.fullmatch(wanted):
        return {"error": "assignment_id must be a Canvas assignment id (digits)"}
    now = parse_utc(params.get('now')) or utc_now()
    try:
        seconds = float(params.get('budget_seconds') or WEEK_BUDGET_SECONDS)        # only the tests ask for another
    except (TypeError, ValueError):
        seconds = WEEK_BUDGET_SECONDS
    budget = Budget(max(0.2, min(seconds, WEEK_BUDGET_SECONDS)))
    TIMEOUT = min(TIMEOUT, WEEK_REQUEST_TIMEOUT)          # one slow request must not use the whole budget

    listed = api_get(f"/courses/{c}/assignments", {"per_page": 100, "order_by": "due_at"})
    listed = [a for a in listed if isinstance(a, dict)] if isinstance(listed, list) else []
    primary = pick_primary(listed, wanted, now)
    since, until = week_window(primary, now)
    chosen = week_assignments(listed, primary, now)
    answer = {"window": {"since": iso_z(since), "until": iso_z(until)}, "week": None, "assignments": []}
    if primary is None:
        return answer

    primary_id = str(primary.get('id'))
    if not budget.expired():
        try:
            answer["week"] = find_week(api_get(f"/courses/{c}/modules", {"include[]": "items", "per_page": 50}), primary_id)
        except Exception:
            pass                                          # the week's name is a nicety: the assignments are what the interview needs
    detail = dict(primary)
    if not budget.expired():
        try:
            fetched = api_get(f"/courses/{c}/assignments/{primary_id}", {"include[]": "rubric"})
            if isinstance(fetched, dict):
                detail.update({k: v for k, v in fetched.items() if v is not None})
        except Exception:
            pass                                          # the list's copy of the description is used

    for a in chosen:
        aid = str(a.get('id'))
        is_primary = aid == primary_id
        source = detail if is_primary else a
        sub = None
        if not budget.expired():
            try:
                fetched = api_get(f"/courses/{c}/assignments/{aid}/submissions/{uid}", {"include[]": ["submission_comments", "rubric_assessment"]})
                sub = fetched if isinstance(fetched, dict) and 'errors' not in fetched else None
            except Exception:
                sub = None
        status, line = submission_status(source, sub, now)
        due_iso = (sub or {}).get('cached_due_date') or a.get('due_at')
        answer["assignments"].append({
            "id": aid,
            "name": plain(a.get('name'), 200),
            "primary": is_primary,
            "unlockAt": a.get('unlock_at') or None,
            "dueAt": due_iso or None,
            "due": due_text(due_iso, now),
            "points": a.get('points_possible') if isinstance(a.get('points_possible'), (int, float)) and not isinstance(a.get('points_possible'), bool) else None,
            "requirements": plain(source.get('description'), PRIMARY_REQUIREMENTS_MAX if is_primary else OTHER_REQUIREMENTS_MAX),
            "status": status,
            "statusLine": plain(line, 300),
            "submission": brief_submission(source, sub, PRIMARY_TEXT_MAX if is_primary else OTHER_TEXT_MAX) if sub is not None else None,
        })
    return answer


def user_contact(c, uid):
    """{name, email, login_id} of one Canvas user, any of them None: the profile first (primary_email, login_id), then the course's user record
    (email), whichever Canvas allows this token to read. It is what the Piazza lookup identifies a student by."""
    if not _DIGITS.fullmatch(str(uid or '')):
        return {"error": "user_id required (the Canvas user id, digits; bound automatically for students)"}
    name = email = login = None
    try:
        profile = api_get(f"/users/{uid}/profile")
        if isinstance(profile, dict):
            name, email, login = profile.get('name'), profile.get('primary_email'), profile.get('login_id')
    except Exception:
        pass
    if not (name and email):
        try:
            record = api_get(f"/courses/{c}/users/{uid}", {"include[]": "email"})
            if isinstance(record, dict) and 'errors' not in record:
                name, email, login = name or record.get('name'), email or record.get('email'), login or record.get('login_id')
        except Exception:
            pass
    clean = lambda value, limit: plain(value, limit) if value not in (None, '') else None
    return {"name": clean(name, 120), "email": clean(email, 200), "login_id": clean(login, 200)}


# ── Action dispatcher ─────────────────────────────────────────────────────────

def handle(req):
    action = req.get("action", "")
    params = req.get("params", {})
    c = COURSE_ID

    if action == "assignments":
        data = api_get(f"/courses/{c}/assignments", {"per_page": 50, "order_by": "due_at"})
        return [fmt_assignment(a) for a in data]

    elif action == "assignment_detail":
        aid = params.get("assignment_id", "")
        if not aid:
            return {"error": "assignment_id required"}
        data = api_get(f"/courses/{c}/assignments/{aid}", {"include[]": "rubric"})
        # Canvas's object has only the UTC due date, which a model reads as "5 pm" for a deadline at 9 in the morning: it gets the fields every list has
        data.update(due_fields(data.get("due_at")))
        # Extract rubric if present, attach as top-level fields
        if data.get("rubric"):
            data["rubric_criteria"] = [
                {
                    "id": cr.get("id"),
                    "description": cr.get("description"),
                    "long_description": cr.get("long_description"),
                    "points": cr.get("points"),
                    "ratings": [{"description": r.get("description"), "points": r.get("points")} for r in (cr.get("ratings") or [])],
                }
                for cr in data["rubric"]
            ]
        return data

    elif action == "submissions":
        aid = params.get("assignment_id", "")
        if not aid:
            return {"error": "assignment_id required"}
        data = api_get(f"/courses/{c}/assignments/{aid}/submissions", {"per_page": 50, "include[]": "user"})
        return [fmt_submission(s) for s in data]

    elif action == "student_submission":
        aid = params.get("assignment_id", "")
        uid = params.get("user_id", "")
        if not aid or not uid:
            return {"error": "assignment_id and user_id required"}
        sub = api_get(f"/courses/{c}/assignments/{aid}/submissions/{uid}",
                      {"include[]": ["submission_history", "submission_comments", "rubric_assessment"]})
        result = extract_submission_content(sub)
        # Also scan submission comments for GitHub URLs (students often paste repo link in comments)
        for comment in (sub.get("submission_comments") or []):
            comment_text = comment.get("comment") or ""
            for url in extract_github_urls(comment_text):
                if url not in result["github_urls"]:
                    result["github_urls"].append(url)
        result["rubric_assessment"] = sub.get("rubric_assessment") or {}
        return result

    elif action == "week_status":
        return week_status(c, params)

    elif action == "user_contact":
        return user_contact(c, params.get("user_id", ""))

    elif action == "grades":
        data = api_get(f"/courses/{c}/students/submissions", {"per_page": 50, "student_ids[]": "all"})
        return data

    elif action == "my_grades":
        uid = params.get("user_id", "")
        if not uid:
            return {"error": "user_id required (bound automatically for students)"}
        # Fetch all submissions for this single student
        subs = api_get(f"/courses/{c}/assignments", {"per_page": 50, "order_by": "due_at"})
        results = []
        for a in subs:
            aid = a.get("id")
            try:
                sub = api_get(f"/courses/{c}/assignments/{aid}/submissions/{uid}")
                results.append({
                    "assignment": a.get("name"),
                    "due_at": a.get("due_at"),
                    **due_fields(a.get("due_at")),
                    "points_possible": a.get("points_possible"),
                    "score": sub.get("score"),
                    "grade": sub.get("grade"),
                    "late": sub.get("late"),
                    "missing": sub.get("missing"),
                    "submitted_at": sub.get("submitted_at"),
                })
            except Exception:
                results.append({
                    "assignment": a.get("name"),
                    "due_at": a.get("due_at"),
                    **due_fields(a.get("due_at")),
                    "points_possible": a.get("points_possible"),
                    "score": None,
                    "grade": None,
                    "error": "Could not fetch submission",
                })
        return results

    elif action == "announcements":
        data = api_get(f"/courses/{c}/discussion_topics", {"only_announcements": "true", "per_page": 20})
        return [{"id": a["id"], "title": a.get("title"), "message": strip_html(a.get("message") or "")[:500], "posted_at": a.get("posted_at")} for a in data]

    elif action == "discussions":
        data = api_get(f"/courses/{c}/discussion_topics", {"per_page": 20})
        return [{"id": d["id"], "title": d.get("title"), "message": strip_html(d.get("message") or "")[:300], "posted_at": d.get("posted_at")} for d in data]

    elif action == "discussion_detail":
        tid = params.get("topic_id", "")
        if not tid:
            return {"error": "topic_id required"}
        return api_get(f"/courses/{c}/discussion_topics/{tid}")

    elif action == "upcoming":
        data = api_get(f"/courses/{c}/assignments", {"bucket": "upcoming", "per_page": 20, "order_by": "due_at"})
        return [fmt_assignment(a) for a in data]

    elif action == "modules":
        data = api_get(f"/courses/{c}/modules", {"include[]": "items", "per_page": 50})
        return [{"id": m["id"], "name": m.get("name"), "position": m.get("position"), "items_count": m.get("items_count"), "items": [{"title": i.get("title"), "type": i.get("type"), "content_id": i.get("content_id"), "external_url": i.get("external_url"), "html_url": i.get("html_url"), "page_url": i.get("page_url")} for i in (m.get("items") or [])[:20]]} for m in data]

    elif action == "module_items":
        mid = params.get("module_id", "")
        if not mid:
            return {"error": "module_id required"}
        data = api_get(f"/courses/{c}/modules/{mid}/items", {"per_page": 50})
        return [{"id": i.get("id"), "title": i.get("title"), "type": i.get("type"), "content_id": i.get("content_id"), "external_url": i.get("external_url"), "html_url": i.get("html_url"), "page_url": i.get("page_url")} for i in data]

    elif action == "users":
        data = api_get(f"/courses/{c}/users", {"enrollment_type": "student", "per_page": 50})
        return [{"id": u["id"], "name": u.get("name"), "sortable_name": u.get("sortable_name"), "email": u.get("email")} for u in data]

    elif action == "pages":
        data = api_get(f"/courses/{c}/pages", {"per_page": 50, "sort": "title"})
        return [{"url": p.get("url"), "title": p.get("title"), "updated_at": p.get("updated_at"), "published": p.get("published")} for p in data]

    elif action == "page_detail":
        page_url = params.get("page_url", "")
        if not page_url:
            return {"error": "page_url required (the url slug, not full URL)"}
        data = api_get(f"/courses/{c}/pages/{page_url}")
        body_text = strip_html(data.get("body") or "")
        return {"url": data.get("url"), "title": data.get("title"), "body": body_text[:4000], "updated_at": data.get("updated_at")}

    elif action == "syllabus":
        data = api_get(f"/courses/{c}", {"include[]": "syllabus_body"})
        body_text = strip_html(data.get("syllabus_body") or "")
        return {"course_name": data.get("name"), "syllabus": body_text[:6000]}

    elif action == "files":
        data = api_get(f"/courses/{c}/files", {"per_page": 50, "sort": "updated_at", "order": "desc"})
        return [{"id": f.get("id"), "display_name": f.get("display_name"), "filename": f.get("filename"), "size": f.get("size"), "content_type": f.get("content-type"), "updated_at": f.get("updated_at"), "url": f.get("url")} for f in data]

    elif action == "discussion_entries":
        tid = params.get("topic_id", "")
        if not tid:
            return {"error": "topic_id required"}
        data = api_get(f"/courses/{c}/discussion_topics/{tid}/entries", {"per_page": 50})
        return [{"id": e.get("id"), "user_id": e.get("user_id"), "user_name": (e.get("user") or {}).get("display_name"), "message": strip_html(e.get("message") or "")[:500], "created_at": e.get("created_at")} for e in data]

    elif action == "file_content":
        file_id = params.get("file_id", "")
        if not file_id:
            return {"error": "file_id required (get from 'files' action)"}
        file_meta = api_get(f"/files/{file_id}")
        display_name = file_meta.get("display_name", "")
        content_type = file_meta.get("content-type", "")
        size = file_meta.get("size", 0)
        download_url = file_meta.get("url")
        if not download_url:
            return {"error": "No download URL available for this file"}
        text, note = read_attachment(download_url, display_name, content_type, size)
        if text:
            return {"display_name": display_name, "content_type": content_type, "content": text[:6000], "truncated": len(text) > 6000}
        return {"display_name": display_name, "content_type": content_type, "error": note or "Could not extract text"}

    else:
        return {"error": f"Unknown action: {action}", "available": ["assignments", "assignment_detail", "submissions", "student_submission", "grades", "my_grades", "announcements", "discussions", "discussion_detail", "discussion_entries", "upcoming", "modules", "module_items", "pages", "page_detail", "syllabus", "files", "file_content", "users", "week_status", "user_contact"]}


def main():
    # A function, so that the tests can import this file and call handle() against a fake HTTP layer; run as a script it does what it always did
    try:
        raw = sys.stdin.read().strip()
        if not raw:
            print(json.dumps({"error": "No input provided"}))
            sys.exit(1)
        if not TOKEN:
            print(json.dumps({"error": "CANVAS_API_TOKEN not set. Add it to .env"}))
            sys.exit(1)
        if not BASE_URL:
            print(json.dumps({"error": "CANVAS_BASE_URL not set. Add it to .env"}))
            sys.exit(1)
        if not COURSE_ID:
            print(json.dumps({"error": "CANVAS_COURSE_ID not set. Add it to .env"}))
            sys.exit(1)

        req = json.loads(raw)
        result = handle(req)
        print(json.dumps(result, indent=2, default=str))
    except requests.exceptions.HTTPError as e:
        print(json.dumps({"error": f"Canvas API error: {e.response.status_code} {e.response.text[:500]}"}))
        sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)


if __name__ == '__main__':
    main()
