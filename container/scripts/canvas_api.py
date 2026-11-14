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
import unicodedata
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


# ── What a caller may put into a request path (docs/SECURITY.md, "Opening documents, the view and the course library") ────────────────────────────────
#
# Every request below is built from text: api_get(f"/courses/{c}/assignments/{aid}"). `requests` reads that text as a URL, so a value that a model supplies must
# never go into it as it is. The values this script reads into a path are `assignment_id`, `user_id`, `topic_id`, `module_id`, `page_url` and `file_id` (PATH_PARAMS:
# nothing else is read into one; `now` and `budget_seconds` are read but are no part of a path). Probed with requests 2.33.0 and urllib3 2.7.0 (`.prepare()`, which
# sends nothing; test_canvas_api_paths.py repeats the two lines that matter): a `page_url` of `../files/456` goes out as /courses/1/files/456, the metadata of ANY course
# file, a hidden one too, with its download address; an `assignment_id` of `77/submissions/999?` puts another student's submission into the path and the user the host
# bound into the query; `?` starts the query, a lone `.` or `..` is removed, and `%2e%2e/files/456` is sent as the literal /pages/../files/456 (requests decodes %2e AFTER
# it has removed the dot segments), while `%2f` goes out as an encoded slash that a server may decode. Encoding the value (quote with safe='') would not be enough
# either: a bare `..` or `.` has nothing to encode and is removed all the same. So a value is not repaired, it is refused: `path_segment` is the only way into a
# path, a refusal is one plain sentence as the answer (handle()) and no request at all, and `api_get` checks the finished path once more, whatever built it.
#   id    ASCII digits, 1 to 20 (a JSON number is accepted as its digits). Not `\d`, which is every script's digits, and not `$`, which lets a final newline through.
#   slug  the url slug of a Canvas page, as `pages` and `modules` hand it out: 1 to 200 characters, none of / \ ? # %, no `..`, not a lone `.`, and no space, control,
#         format (zero-width, bidi) or other invisible character; and all of that again after NFKC folding, because a fullwidth `／` or `．` (or `‥`, `…`, `？`) is the
#         `/` or `.` it looks like to anything that folds compatibility forms. A percent sign is refused, not decoded: a slug is a name, not an address.

class Refused(Exception):
    """A value the caller supplied that may not become part of a request path, or a path that may not be sent. str() is the one plain sentence the caller is given as
    the answer (handle() turns it into {"error": ...}); nothing was asked of Canvas."""


_ID = re.compile(r'[0-9]{1,20}')          # the one definition of "a Canvas id", for every action
SLUG_MAX = 200
# name -> (rule, what it is: the refusal says "<name> must be <what>")
PATH_PARAMS = {
    'assignment_id': ('id', "a Canvas assignment id (digits, from the 'assignments' action)"),
    'user_id': ('id', "a Canvas user id (digits)"),
    'topic_id': ('id', "a Canvas discussion topic id (digits, from the 'discussions' action)"),
    'module_id': ('id', "a Canvas module id (digits, from the 'modules' action)"),
    'file_id': ('id', "a Canvas file id (digits, from the 'files' action)"),
    'page_url': ('slug', "the url slug of a page as the 'pages' and 'modules' actions give it, one short name such as 'week-8-intro' (no '/', '?', '#', '%', '..' or space)"),
}


def _forms(text):
    """`text` as it is and as NFKC folds it: a fullwidth `／` or `．` (category Po, so no category test sees it) is the `/` or `.` it looks like to anything that folds
    compatibility forms, and is refused as that."""
    return text, unicodedata.normalize('NFKC', text)


def _plain(text):
    """True when no character of `text`, as it is or folded, is one that `requests` or a server may read as more than a letter of a name: none of \\ ? # %, and no
    control, format, separator or unassigned character (a space, a newline, a zero-width or bidi mark)."""
    return not any(ch in '\\?#%' or unicodedata.category(ch)[0] in 'CZ' for form in _forms(text) for ch in form)


def _is_slug(text):
    return 0 < len(text) <= SLUG_MAX and _plain(text) and all('/' not in form and '..' not in form and form != '.' for form in _forms(text))


def path_segment(name, value):
    """`value`, the caller's `name` parameter (a key of PATH_PARAMS), as one segment of a request path; Refused, with the sentence to answer, when it is not what `name`
    is. Every other value this file puts into a path is the course (the operator's setting) or an id that Canvas itself gave."""
    rule, what = PATH_PARAMS[name]
    text = str(value) if isinstance(value, int) and not isinstance(value, bool) else value          # a JSON number is its digits; True, 1.5, a list, an object are no id
    if not isinstance(text, str) or not (_ID.fullmatch(text) if rule == 'id' else _is_slug(text)):
        raise Refused('%s must be %s' % (name, what))
    return text


def checked_endpoint(endpoint):
    """`endpoint` (the path after the API's base address) when it is what the code meant to ask for: no `.` or `..` segment, none of \\ ? # %, no space or control
    character, so that what `requests` sends is the path that was built here, and neither a climb nor a query. The second line behind `path_segment`: Refused otherwise."""
    if (not isinstance(endpoint, str) or not endpoint.startswith('/') or not _plain(endpoint)
            or any(part in ('.', '..') for form in _forms(endpoint) for part in form.split('/'))):
        raise Refused("That Canvas request was not sent: its path holds a '..', a '?', a '#', a '%', a backslash, a space or a control character.")
    return endpoint


# ── Core API helpers ──────────────────────────────────────────────────────────

def api_get(endpoint, params=None):
    """GET with pagination, returns combined list or single object. The endpoint is checked (checked_endpoint); the addresses of the next pages are Canvas's own."""
    url = f"{BASE_URL}{checked_endpoint(endpoint)}"
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
    if not _ID.fullmatch(uid):
        return {"error": "user_id required (the Canvas user id, digits; bound automatically for students)"}
    wanted = str(params.get('assignment_id') or '')
    if wanted and not _ID.fullmatch(wanted):
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
    student = student_view()
    at = utc_ms(now)                                       # the student's rule is judged at the same instant as every date of this answer
    if student:
        listed = [a for a in listed if why_assignment_hidden(a) is None]          # an unpublished assignment is not in the week, not even when the caller names its id
    primary = pick_primary(listed, wanted, now)
    since, until = week_window(primary, now)
    chosen = week_assignments(listed, primary, now)
    answer = {"window": {"since": iso_z(since), "until": iso_z(until)}, "week": None, "assignments": []}
    if primary is None:
        return answer

    primary_id = str(primary.get('id'))
    if not budget.expired():
        try:
            modules = api_get(f"/courses/{c}/modules", {"include[]": "items", "per_page": 50})
            answer["week"] = find_week(student_modules(modules, at) if student else modules, primary_id)      # (no listing of files here: the budget has no request to spare)
        except Exception:
            pass                                          # the week's name is a nicety: the assignments are what the interview needs
    detail = dict(primary)
    if not budget.expired() and not (student and unlock_ahead_ms(primary, at) is not None):         # the detail of an assignment that has not opened is not asked for: its text is not for a student
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
        not_open = student and unlock_ahead_ms(a, at) is not None          # listed, as in Canvas, but its text is not a student's yet: no requirements
        due_iso = (sub or {}).get('cached_due_date') or a.get('due_at')
        answer["assignments"].append({
            "id": aid,
            "name": plain(a.get('name'), 200),
            "primary": is_primary,
            "unlockAt": a.get('unlock_at') or None,
            "dueAt": due_iso or None,
            "due": due_text(due_iso, now),
            "points": a.get('points_possible') if isinstance(a.get('points_possible'), (int, float)) and not isinstance(a.get('points_possible'), bool) else None,
            "requirements": '' if not_open else plain(source.get('description'), PRIMARY_REQUIREMENTS_MAX if is_primary else OTHER_REQUIREMENTS_MAX),
            "status": status,
            "statusLine": plain(line, 300),
            "submission": brief_submission(source, sub, PRIMARY_TEXT_MAX if is_primary else OTHER_TEXT_MAX) if sub is not None else None,
        })
    return answer


def user_contact(c, uid):
    """{name, email, login_id} of one Canvas user, any of them None: the profile first (primary_email, login_id), then the course's user record
    (email), whichever Canvas allows this token to read. It is what the Piazza lookup identifies a student by."""
    if not _ID.fullmatch(str(uid or '')):
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


# ── What a student could open in Canvas: the course's files (docs/SECURITY.md, "Opening documents, the view and the course library") ──────────────
#
# The token this script carries is the instructor's, and the instructor sees every file of the course, those that Canvas hides from students too (hidden,
# locked, not released yet, no longer offered). `files` and `file_content` therefore apply the student's rule themselves, in every call that is not the admin chat's.
# The rule is the one of `whySkipped` in src/docs/canvas-files.ts, which the viewer's Canvas path (src/docs/canvas-source.ts) uses. This script cannot import
# TypeScript, so it is written twice, and test_canvas_api_student_files.py runs this copy on canvas_file_visibility_cases.json, the table the TypeScript one was
# checked on. Only the visibility part is copied: the viewer's own size limits (20 MB, PDF and Office files) are not a student's rule.
#
# Who is held to it: container/agent-runner/src/access.ts decides everything by NANOCLAW_IS_MAIN (the host sets it from the group's folder; only the text "1" is a
# yes). The MCP server hands its environment on to this script, so a student's chat, a task (the host's own patrol and bootstrap included), a voice call's tool host
# and the lookups of start_mock_interview in a student's container all run it as NOT the admin chat. So does a call with no such variable at all: an operator's
# shell, the course-status container (its file is read by every student's agent), a test. The instructor's whole view is asked for, never the default.

STUDENTS_CANNOT_OPEN_FILE = "This file is not available to students."
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
# the ISO 8601 forms Canvas sends ('2026-12-01T08:00:00Z') and the others of that kind that JavaScript's Date.parse reads the same way: a day alone (UTC
# midnight), seconds left out, any number of fraction digits, 'Z' or an offset with its minutes ('-08:00', '+0530'). Node's older parser reads more (a month
# alone, 'Nov 7, 2026', a lower-case t or z, 31 April as 1 May): Canvas sends none of those, and such a date is no limit here.
_CANVAS_INSTANT = re.compile(r'(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?', re.ASCII)


def now_ms():
    """Milliseconds since the epoch, now (the clock the files' release dates are compared with)."""
    return int(time.time() * 1000)


def instant_ms(value):
    """A Canvas date as milliseconds since the epoch, read as JavaScript's Date.parse reads it (the offset counts, a fraction is cut to milliseconds). A datetime
    with no offset is read as UTC (JavaScript says local time; Canvas always sends 'Z', so it does not arise). None when `value` is not a string or does not read
    as a date: such a date is no limit, as in the viewer's rule (`parse_utc` is not used: it throws the offset away)."""
    if not isinstance(value, str):
        return None
    found = _CANVAS_INSTANT.fullmatch(value)
    if not found:
        return None
    year, month, day, hour, minute, second, fraction, zone = found.groups()
    try:
        moment = datetime(int(year), int(month), int(day), int(hour or 0), int(minute or 0), int(second or 0), tzinfo=timezone.utc)
    except ValueError:
        return None
    ms = (moment - _EPOCH) // timedelta(milliseconds=1) + int((fraction or '0')[:3].ljust(3, '0'))
    if zone and zone != 'Z':
        digits = zone[1:].replace(':', '')
        hours, minutes = int(digits[:2]), int(digits[2:])
        if hours > 23 or minutes > 59:
            return None
        ms -= (-1 if zone[0] == '-' else 1) * (hours * 60 + minutes) * 60000
    return ms


def utc_day(ms):
    try:
        return (_EPOCH + timedelta(milliseconds=ms)).strftime('%Y-%m-%d')
    except (OverflowError, ValueError):
        return '?'


def why_not_for_students(item, at_ms=None):
    """Why a student could not open this file in Canvas, in the words of `whySkipped` (src/docs/canvas-files.ts), or None when they could. `item` is a file as
    Canvas describes it (the listing's, or GET /courses/<id>/files/<id>'s): a flag counts only when it is exactly true, a date only when it reads as one, the
    release date is checked before the withdrawal date, and a file that is released at this very moment is open and one that is withdrawn at this very moment is
    not. Anything that is not a record is not a file a student may have. The words are for tests and logs: no answer to a model quotes them."""
    if not isinstance(item, dict):
        return 'not a file record'
    at = now_ms() if at_ms is None else at_ms
    if item.get('hidden') is True or item.get('hidden_for_user') is True or item.get('locked') is True or item.get('locked_for_user') is True:
        return 'hidden or locked for students'
    unlock = instant_ms(item.get('unlock_at'))
    if unlock is not None and unlock > at:
        return 'not released to students yet (unlocks %s)' % utc_day(unlock)
    lock = instant_ms(item.get('lock_at'))
    if lock is not None and lock <= at:
        return 'no longer available to students (locked %s)' % utc_day(lock)
    return None


def students_may_open(item, at_ms=None):
    return why_not_for_students(item, at_ms) is None


def student_view():
    """True unless this call is the admin chat's: NANOCLAW_IS_MAIN is exactly "1" there (access.ts `accessFlagsFromEnv`), and in no other case."""
    return os.environ.get('NANOCLAW_IS_MAIN') != '1'


def get_or_none(endpoint, params=None):
    """api_get, or None when Canvas does not know the thing in this course (404): for a call that asks for ONE thing by an id the caller gave, where "Canvas does not
    know it" and "a student may not have it" are answered in the same words. Any other failure (401, 403, 500, a timeout) is raised, as it always was."""
    try:
        return api_get(endpoint, params)
    except requests.exceptions.HTTPError as err:
        if err.response is not None and err.response.status_code == 404:      # (a response is falsy when its status is an error: compare with None)
            return None
        raise


def student_file_meta(course, file_id):
    """The metadata of one course file as a student could have it, or None: Canvas does not know the file in this course (it is asked of the course, not of
    /files/<id>, which answers for any file the token can read: another course's, a person's own), or it is one Canvas hides from students. Reads the
    metadata and nothing else of the file."""
    meta = get_or_none(f"/courses/{course}/files/{file_id}")
    return meta if students_may_open(meta) else None


# ── What a student could see of the rest of the course: assignments, pages, discussions, announcements, modules (docs/SECURITY.md, "Opening documents, ...") ──────
#
# The instructor's token also sees what Canvas keeps from students: assignments, pages and modules that are not published, an assignment before its unlock date, a topic whose
# posting is delayed, a page or a topic that is only for some students or sections. Every action below that answers with such things applies the student's rule itself, in every
# call that is not the admin chat's (student_view(): the key of `files`), and in the same way: a thing a student could not see is left out of a listing whole (no name, no
# count: a module's item count is worked out from the items that are left), and one asked for by an id answers with ONE plain sentence, the same whether it is hidden or
# Canvas does not know it (404), so that an id says nothing about what is behind it. Only a 404 is "does not know": any other failure is raised, as it always was. The admin
# chat is answered exactly as before (the same requests, the same rows). A flag counts only when it is exactly what the rule says (as for files), and a date only when it reads as
# one. The rule, per kind:
#   assignment  HIDDEN (not listed, not opened by id, not in my_grades or week_status): published is false, or workflow_state is something but 'published', or
#               only_visible_to_overrides is true (it is for some students or sections, and the tool cannot tell whether this one is among them: it is left out for all).
#               LISTED BUT NOT OPENED: unlock_at still ahead. Canvas lists such an assignment (title, dates) and shows no text, and the owner decided (2026-11-08) that a student's
#               TAi has no text either: the listings keep it, assignment_detail answers it WITHOUT its words and with a note (ASSIGNMENT_TEXT_FIELDS: withheld, never an
#               {"error"}, so that the mock interview and the weekly brief go on quietly without the spec), and week_status keeps it in the week (its unlock date has always
#               played no part in which assignment is the week's: test_week_status.py) with no requirements. lock_at passed hides nothing: a student still reads the assignment.
#   page        HIDDEN: published is false, hide_from_students is true, workflow_state is unpublished or deleted, publish_at ahead.
#   topic       (a discussion or an announcement: one endpoint) HIDDEN: published is false, workflow_state is unpublished or deleted, delayed_post_at ahead (or workflow_state
#               post_delayed with no date), is_section_specific is true, or the assignment it carries (a graded discussion) is hidden. `locked` and lock_at hide NOTHING: a
#               closed topic is read-only for a student, not invisible.
#   module      HIDDEN: published is false, workflow_state is unpublished or deleted, unlock_at ahead (Canvas shows a student the locked module's name; this tool does not: it
#               cannot tell its items apart from a student's, so the module goes whole).
#   module item HIDDEN: published is false; a File item whose file a student could not open (`students_may_open`: the rule of `files`, from one listing of the course's files
#               that is asked for only when a File item has to be judged: OpenableFiles).
# `locked_for_user` and the like are computed for the TOKEN's user, the instructor, so they say nothing about a student and are not read (the student's assignment_detail drops
# them: STUDENT_ASSIGNMENT_FIELDS). NOT done here, and said so in docs/SECURITY.md: content that sits in a module Canvas locks for a student (a date, prerequisites, sequential
# progress) but whose own flags say nothing; the sections and overrides a student is in; whether a grade has been posted.

NOT_FOR_STUDENTS = {
    'assignment': "This assignment is not available to students.",
    'page': "This page is not available to students.",
    'discussion': "This discussion or announcement is not available to students.",
    'module': "This module is not available to students.",
}
REPLIES_AFTER_POSTING = "This discussion shows its replies only to students who have posted in it, and this tool cannot tell whether this student has: they can read them in Canvas."
# The fields of an assignment that a student's assignment_detail keeps: Canvas's own object for a student, less what is the instructor's (the grading counters, the download
# address of all submissions, overrides, the visibility list, LTI parameters, moderation settings) and what Canvas computes for the token's user (locked_for_user, lock_info,
# can_submit). Written from Canvas's documentation of the object: a field that is not listed is not passed on. due_pacific, due_local, due_relative and rubric_criteria are
# added by this script afterwards and are not in the list.
STUDENT_ASSIGNMENT_FIELDS = frozenset((
    'id', 'name', 'description', 'created_at', 'updated_at', 'due_at', 'unlock_at', 'lock_at', 'course_id', 'html_url', 'assignment_group_id', 'position', 'published',
    'workflow_state', 'points_possible', 'grading_type', 'grading_standard_id', 'submission_types', 'allowed_extensions', 'allowed_attempts', 'max_name_length',
    'due_date_required', 'omit_from_final_grade', 'hide_in_gradebook', 'peer_reviews', 'automatic_peer_reviews', 'peer_review_count', 'peer_reviews_assign_at',
    'intra_group_peer_reviews', 'anonymous_peer_reviews', 'anonymous_submissions', 'group_category_id', 'grade_group_students_individually', 'is_quiz_assignment', 'quiz_id',
    'discussion_topic', 'external_tool_tag_attributes', 'turnitin_enabled', 'vericite_enabled', 'turnitin_settings', 'use_rubric_for_grading', 'rubric_settings', 'rubric',
    'freeze_on_copy', 'frozen', 'frozen_attributes', 'require_lockdown_browser', 'important_dates',
))


def utc_ms(moment):
    """Milliseconds since the epoch of a naive UTC datetime."""
    return (moment - datetime(1970, 1, 1)) // timedelta(milliseconds=1)


def pacific_of_ms(ms):
    """'Mon Nov 9, 9:00 AM PST' for a moment given in milliseconds since the epoch; None when it is out of range."""
    try:
        return pacific(iso_z((_EPOCH + timedelta(milliseconds=ms)).replace(tzinfo=None)))
    except (OverflowError, ValueError):
        return None


def unlock_ahead_ms(item, at_ms):
    """When `item` opens, in milliseconds, while that is still ahead of `at_ms` (a moment that is exactly now is open: as for files); None when it is open already, has no
    unlock date, or has one that does not read as a date."""
    unlock = instant_ms(item.get('unlock_at'))
    return unlock if unlock is not None and unlock > at_ms else None


def why_assignment_hidden(item):
    """Why a student could not see this assignment in Canvas at all, or None when they could (they may still not be able to open it yet: why_assignment_locked). The words
    are for tests and logs: no answer to a model quotes them."""
    if not isinstance(item, dict):
        return 'not an assignment record'
    state = item.get('workflow_state')
    if item.get('published') is False or (isinstance(state, str) and state != 'published'):
        return 'not published'
    if item.get('only_visible_to_overrides') is True:
        return 'assigned to some students or sections only'
    return None


def why_assignment_locked(item, at_ms):
    """Why a student could see this (visible) assignment in a list but not read it yet, or None."""
    unlock = unlock_ahead_ms(item, at_ms)
    return None if unlock is None else 'not open yet (unlocks %s)' % utc_day(unlock)


def sentence_for_assignment(item):
    """The one sentence a student's call is given for an assignment it asked for by id that a student could not see in Canvas at all: the same for every reason it is not
    there for them and for an id Canvas does not know (`item` None). None when a student could see it (it may not be open yet: not_open_note)."""
    return NOT_FOR_STUDENTS['assignment'] if why_assignment_hidden(item) is not None else None


# What a student is NOT given of an assignment that has not opened yet (`unlock_at` ahead): its words. Canvas lists such an assignment with its dates and shows no text, and the
# owner decided on 2026-11-08 that a student's TAi does not have the text either. It is WITHHELD, not refused: the answer is the assignment without these fields and with a note,
# never an {"error"}, because start_mock_interview prints every {"error"} a lookup answered under "Context errors", and the interview and the weekly brief must go on without the
# spec, quietly (an empty description is a spec that is simply absent: `String(detail.description || '')`, the brief leaves out an empty `requirements`).
ASSIGNMENT_TEXT_FIELDS = ('description', 'rubric', 'rubric_settings', 'discussion_topic', 'external_tool_tag_attributes')


def not_open_note(item, at_ms):
    """The note that goes into the assignment_detail of an assignment that has not opened yet, or None when it has (or has no unlock date that reads as one)."""
    unlock = unlock_ahead_ms(item, at_ms)
    if unlock is None:
        return None
    when = pacific_of_ms(unlock)
    return 'Not open to students yet' + (': it unlocks %s' % when if when else '') + '. Its description and rubric are not shown until then.'


def why_page_hidden(item, at_ms):
    """Why a student could not see this page in Canvas, or None when they could."""
    if not isinstance(item, dict):
        return 'not a page record'
    if item.get('published') is False or item.get('hide_from_students') is True or item.get('workflow_state') in ('unpublished', 'deleted'):
        return 'not published'
    publish = instant_ms(item.get('publish_at'))
    if publish is not None and publish > at_ms:
        return 'to be published %s' % utc_day(publish)
    return None


def why_topic_hidden(item, at_ms):
    """Why a student could not see this discussion topic or announcement in Canvas, or None when they could. A topic that is closed (`locked`, lock_at passed) is NOT
    hidden: a student reads it and cannot reply. `item` is a topic as Canvas describes it (the listing's or GET .../discussion_topics/<id>'s)."""
    if not isinstance(item, dict):
        return 'not a discussion record'
    state = item.get('workflow_state')
    if item.get('published') is False or state in ('unpublished', 'deleted'):
        return 'not published'
    delay = instant_ms(item.get('delayed_post_at'))
    if delay is not None:
        if delay > at_ms:                                   # a date that has passed counts over a state that has not caught up with it yet
            return 'posting is delayed until %s' % utc_day(delay)
    elif state == 'post_delayed':
        return 'posting is delayed'
    if item.get('is_section_specific') is True:
        return 'for some sections only'
    graded = item.get('assignment')
    if isinstance(graded, dict) and why_assignment_hidden(graded) is not None:
        return 'its assignment is not available to students'
    return None


def why_module_hidden(item, at_ms):
    """Why this tool does not show a student this module, or None."""
    if not isinstance(item, dict):
        return 'not a module record'
    if item.get('published') is False or item.get('workflow_state') in ('unpublished', 'deleted'):
        return 'not published'
    unlock = unlock_ahead_ms(item, at_ms)
    return None if unlock is None else 'locked until %s' % utc_day(unlock)


class OpenableFiles:
    """The ids of the course files a student could open (`students_may_open`), from ONE listing of the course's files that is asked for the first time a File item has to
    be judged: a module with no File item costs no request. A listing that is not a list leaves no file open, and a file that is not in the listing (past the last page
    api_get reads, deleted) is not open either: a File item is hidden, never shown on a guess."""

    def __init__(self, course, at_ms):
        self.course, self.at_ms, self.ids = course, at_ms, None

    def __contains__(self, file_id):
        if self.ids is None:
            listing = api_get(f"/courses/{self.course}/files", {"per_page": 100, "sort": "updated_at", "order": "desc"})
            self.ids = {str(f.get('id')) for f in listing if students_may_open(f, self.at_ms)} if isinstance(listing, list) else set()
        return str(file_id) in self.ids


def why_item_hidden(item, files=None):
    """Why this tool does not show a student this module item, or None. `files` (OpenableFiles) judges a File item; without it a File item is judged like any other."""
    if not isinstance(item, dict):
        return 'not an item record'
    if item.get('published') is False:
        return 'not published'
    if files is not None and item.get('type') == 'File' and item.get('content_id') not in files:
        return 'a file a student could not open'
    return None


def student_modules(modules, at_ms, files=None):
    """The modules a student could be shown, as copies: `items` holds only the items a student could see, and `items_count` is their number (None when Canvas left the items
    out of the listing: the count it gives includes the items that are hidden). `files` as for why_item_hidden."""
    shown = []
    for module in modules:
        if why_module_hidden(module, at_ms) is not None:
            continue
        inline = module.get('items')
        if isinstance(inline, list):
            items = [i for i in inline if why_item_hidden(i, files) is None]
            shown.append(dict(module, items=items, items_count=len(items)))
        else:
            shown.append(dict(module, items=[], items_count=None))
    return shown


def visible_to_students(items, why, *args):
    """The items of a listing as the admin chat gets them (all of them); in every other call only those for which why(item, *args) finds nothing to say."""
    return [item for item in items if why(item, *args) is None] if student_view() else items


# ── Action dispatcher ─────────────────────────────────────────────────────────

def handle(req):
    """The answer to one request: what the action returns, or {"error": <one sentence>} for a value that may not go into a request path, whoever asks (the admin chat
    too: nothing was asked of Canvas)."""
    try:
        return _dispatch(req)
    except Refused as refusal:
        return {"error": str(refusal)}


def _dispatch(req):
    action = req.get("action", "")
    params = req.get("params", {})
    c = COURSE_ID

    if action == "assignments":
        data = api_get(f"/courses/{c}/assignments", {"per_page": 50, "order_by": "due_at"})
        data = visible_to_students(data, why_assignment_hidden)           # an unpublished assignment is left out, with no name and no count
        return [fmt_assignment(a) for a in data]

    elif action == "assignment_detail":
        aid = params.get("assignment_id", "")
        if not aid:
            return {"error": "assignment_id required"}
        aid = path_segment("assignment_id", aid)
        if student_view():
            data = get_or_none(f"/courses/{c}/assignments/{aid}", {"include[]": "rubric"})
            at = now_ms()
            sentence = sentence_for_assignment(data)
            if sentence:                                                  # unpublished, for other students, or not in this course: one sentence, and nothing of the assignment
                return {"error": sentence}
            note = not_open_note(data, at)
            data = {key: value for key, value in data.items() if key in STUDENT_ASSIGNMENT_FIELDS}
            if why_topic_hidden(data.get('discussion_topic'), at) is not None:            # a graded discussion carries its topic: it goes when a student could not see that topic
                data.pop('discussion_topic', None)
            if note:                                                      # listed, as in Canvas, but not open: its words are withheld and the answer says so (no error: see ASSIGNMENT_TEXT_FIELDS)
                data = {key: value for key, value in data.items() if key not in ASSIGNMENT_TEXT_FIELDS}
                data['note'] = note
        else:
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
        aid = path_segment("assignment_id", aid)
        data = api_get(f"/courses/{c}/assignments/{aid}/submissions", {"per_page": 50, "include[]": "user"})
        return [fmt_submission(s) for s in data]

    elif action == "student_submission":
        aid = params.get("assignment_id", "")
        uid = params.get("user_id", "")
        if not aid or not uid:
            return {"error": "assignment_id and user_id required"}
        aid, uid = path_segment("assignment_id", aid), path_segment("user_id", uid)      # the host binds user_id, and only a path that is exactly this one keeps it bound
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
        uid = path_segment("user_id", uid)             # before the first request: a refused id must not cost the assignment list, nor turn every row into "Could not fetch"
        # Fetch all submissions for this single student
        subs = api_get(f"/courses/{c}/assignments", {"per_page": 50, "order_by": "due_at"})
        subs = visible_to_students(subs, why_assignment_hidden)           # no row, and no request, for an assignment a student cannot see (its name and due date would be the leak)
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
        data = visible_to_students(data, why_topic_hidden, now_ms())      # one that is not posted yet is not an announcement to a student
        return [{"id": a["id"], "title": a.get("title"), "message": strip_html(a.get("message") or "")[:500], "posted_at": a.get("posted_at")} for a in data]

    elif action == "discussions":
        data = api_get(f"/courses/{c}/discussion_topics", {"per_page": 20})
        data = visible_to_students(data, why_topic_hidden, now_ms())
        return [{"id": d["id"], "title": d.get("title"), "message": strip_html(d.get("message") or "")[:300], "posted_at": d.get("posted_at")} for d in data]

    elif action == "discussion_detail":
        tid = params.get("topic_id", "")
        if not tid:
            return {"error": "topic_id required"}
        tid = path_segment("topic_id", tid)
        if student_view():
            topic = get_or_none(f"/courses/{c}/discussion_topics/{tid}")
            if why_topic_hidden(topic, now_ms()) is not None:             # an announcement is a topic too: by its id it is answered the same way
                return {"error": NOT_FOR_STUDENTS['discussion']}
            return topic
        return api_get(f"/courses/{c}/discussion_topics/{tid}")

    elif action == "upcoming":
        data = api_get(f"/courses/{c}/assignments", {"bucket": "upcoming", "per_page": 20, "order_by": "due_at"})
        data = visible_to_students(data, why_assignment_hidden)
        return [fmt_assignment(a) for a in data]

    elif action == "modules":
        data = api_get(f"/courses/{c}/modules", {"include[]": "items", "per_page": 50})
        if student_view():
            at = now_ms()
            data = student_modules(data, at, OpenableFiles(c, at))        # unpublished and locked modules, unpublished items and files a student cannot open are left out
        return [{"id": m["id"], "name": m.get("name"), "position": m.get("position"), "items_count": m.get("items_count"), "items": [{"title": i.get("title"), "type": i.get("type"), "content_id": i.get("content_id"), "external_url": i.get("external_url"), "html_url": i.get("html_url"), "page_url": i.get("page_url")} for i in (m.get("items") or [])[:20]]} for m in data]

    elif action == "module_items":
        mid = params.get("module_id", "")
        if not mid:
            return {"error": "module_id required"}
        mid = path_segment("module_id", mid)
        if student_view():
            at = now_ms()
            if why_module_hidden(get_or_none(f"/courses/{c}/modules/{mid}"), at) is not None:          # the module is judged first: an unpublished or locked one lists nothing
                return {"error": NOT_FOR_STUDENTS['module']}
            data = api_get(f"/courses/{c}/modules/{mid}/items", {"per_page": 50})
            files = OpenableFiles(c, at)
            data = [i for i in data if why_item_hidden(i, files) is None]
        else:
            data = api_get(f"/courses/{c}/modules/{mid}/items", {"per_page": 50})
        return [{"id": i.get("id"), "title": i.get("title"), "type": i.get("type"), "content_id": i.get("content_id"), "external_url": i.get("external_url"), "html_url": i.get("html_url"), "page_url": i.get("page_url")} for i in data]

    elif action == "users":
        data = api_get(f"/courses/{c}/users", {"enrollment_type": "student", "per_page": 50})
        return [{"id": u["id"], "name": u.get("name"), "sortable_name": u.get("sortable_name"), "email": u.get("email")} for u in data]

    elif action == "pages":
        data = api_get(f"/courses/{c}/pages", {"per_page": 50, "sort": "title"})
        data = visible_to_students(data, why_page_hidden, now_ms())       # an unpublished page is left out, with no title and no count
        return [{"url": p.get("url"), "title": p.get("title"), "updated_at": p.get("updated_at"), "published": p.get("published")} for p in data]

    elif action == "page_detail":
        page_url = params.get("page_url", "")
        if not page_url:
            return {"error": "page_url required (the url slug, not full URL)"}
        page_url = path_segment("page_url", page_url)
        if student_view():
            data = get_or_none(f"/courses/{c}/pages/{page_url}")
            if why_page_hidden(data, now_ms()) is not None:               # hidden, or not in this course: one sentence, and nothing of the page
                return {"error": NOT_FOR_STUDENTS['page']}
        else:
            data = api_get(f"/courses/{c}/pages/{page_url}")
        body_text = strip_html(data.get("body") or "")
        return {"url": data.get("url"), "title": data.get("title"), "body": body_text[:4000], "updated_at": data.get("updated_at")}

    elif action == "syllabus":
        # the same body for everyone who can open the course: nothing in it is kept from a student, so there is no student's rule here (its links are tags, which strip_html drops)
        data = api_get(f"/courses/{c}", {"include[]": "syllabus_body"})
        body_text = strip_html(data.get("syllabus_body") or "")
        return {"course_name": data.get("name"), "syllabus": body_text[:6000]}

    elif action == "files":
        data = api_get(f"/courses/{c}/files", {"per_page": 50, "sort": "updated_at", "order": "desc"})
        if student_view():
            at = now_ms()
            data = [f for f in data if students_may_open(f, at)]          # a file Canvas hides from students is left out whole: not its name, and no count of them
        return [{"id": f.get("id"), "display_name": f.get("display_name"), "filename": f.get("filename"), "size": f.get("size"), "content_type": f.get("content-type"), "updated_at": f.get("updated_at"), "url": f.get("url")} for f in data]

    elif action == "discussion_entries":
        tid = params.get("topic_id", "")
        if not tid:
            return {"error": "topic_id required"}
        tid = path_segment("topic_id", tid)
        anonymous = False
        if student_view():
            topic = get_or_none(f"/courses/{c}/discussion_topics/{tid}")                  # the topic is judged first: its replies are no more visible than it is
            if why_topic_hidden(topic, now_ms()) is not None:
                return {"error": NOT_FOR_STUDENTS['discussion']}
            if topic.get('require_initial_post') is True:                                 # Canvas shows the replies to a student who has posted: the token does not say who that is
                return {"error": REPLIES_AFTER_POSTING}
            anonymous = bool(topic.get('anonymous_state'))                                # the authors of an anonymous discussion are hidden from students
        data = api_get(f"/courses/{c}/discussion_topics/{tid}/entries", {"per_page": 50})
        return [{"id": e.get("id"), "user_id": None if anonymous else e.get("user_id"), "user_name": None if anonymous else (e.get("user") or {}).get("display_name"), "message": strip_html(e.get("message") or "")[:500], "created_at": e.get("created_at")} for e in data]

    elif action == "file_content":
        file_id = params.get("file_id", "")
        if not file_id:
            return {"error": "file_id required (get from 'files' action)"}
        file_id = path_segment("file_id", file_id)                    # for every container, the admin chat's too: a model's text never changes which endpoint is asked
        if student_view():
            # judged on the metadata alone, before the name, the address or a byte of the file is read; one sentence for every reason, and for a file that is not in this course
            file_meta = student_file_meta(c, file_id)
            if file_meta is None:
                return {"error": STUDENTS_CANNOT_OPEN_FILE}
        else:
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
