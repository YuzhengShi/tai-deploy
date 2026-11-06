#!/opt/leanrag/bin/python3
"""ocr_image.py IMAGE_PATH: the text of a picture a student attached, read with the `tesseract` binary. One JSON object on stdout.

  read      {"text", "mean_confidence", "words", "truncated", "warnings"}   exit 0 (a picture with no text is a read with "words": 0)
  refused   {"error": "..."}                                                 exit 1

Standard library plus the binary only, no network. What it will read: a regular file that is, once every link is followed, inside the
student's uploads folder (/workspace/group/uploads; TAI_OCR_UPLOADS_DIR names another one, for the tests), at most 10 MB, a PNG, JPEG, WebP,
GIF, BMP or TIFF by its first bytes (the name counts for nothing), and small enough in pixels: the size is read from the file's own header
here, so that an image that would unpack to gigabytes is refused before tesseract is started. The bytes that were checked are the bytes
tesseract gets (on its stdin): the file is opened once, without following a link, so nothing can be swapped for another between the check and
the read, and no file name reaches a command line.

It reads text, nothing else: not a chart, a diagram, a colour or a layout (indentation and line breaks are kept, columns are not). The
text is data from a picture a student chose to show, and the caller must treat it so (ipc-mcp-stdio.ts frames it). Nothing the picture says
is written to stderr, a log or an error message.
"""
import json
import os
import shutil
import stat
import struct
import subprocess
import sys
import time
import unicodedata

UPLOADS_DIR = '/workspace/group/uploads'
UPLOADS_ENV = 'TAI_OCR_UPLOADS_DIR'
MAX_BYTES = 10 * 1024 * 1024
MAX_PIXELS = 25_000_000
MAX_PATH_CHARS = 500
MAX_TEXT_CHARS = 6000
MAX_INDENT = 40
LOW_CONFIDENCE = 60.0
# tesseract gets 20 s, and the whole script 30 s: the second try (another page layout) only runs when the first finished with almost nothing
TESSERACT_TIMEOUT = 20.0
TOTAL_BUDGET = 30.0
MIN_SECOND_TRY = 5.0
ALMOST_NOTHING = 8        # characters that are not white space: fewer than this and the second layout is tried


class Refused(Exception):
    """Something the caller is told in plain words (never anything the picture said)."""


# --- the file -------------------------------------------------------------------------------------------------------------------------

def _inside(root, path):
    try:
        root_n, path_n = os.path.normcase(root), os.path.normcase(path)
        return path_n != root_n and os.path.commonpath([root_n, path_n]) == root_n
    except ValueError:
        return False


def _shown(name):
    """A file name safe to put in a message: letters, digits and . _ - only."""
    return ''.join(c if (c.isascii() and (c.isalnum() or c in '._-')) else '?' for c in os.path.basename(name))[:80]


def uploads_root():
    return os.environ.get(UPLOADS_ENV) or UPLOADS_DIR


def resolve(raw):
    """The real path of the picture a request names, which must be inside the uploads folder once every link is followed."""
    if not isinstance(raw, str) or not raw.strip() or '\0' in raw or len(raw) > MAX_PATH_CHARS:
        raise Refused('give the path of a picture the student attached (it is in their message)')
    raw = raw.strip()
    root = os.path.realpath(uploads_root())
    group = os.path.dirname(uploads_root().rstrip('/\\'))
    # an absolute path as it is; "uploads/x" from the group folder (the agent's working directory); a bare name from the uploads folder
    if os.path.isabs(raw):
        candidate = raw
    elif raw.replace('\\', '/').startswith('uploads/'):
        candidate = os.path.join(group, raw)
    else:
        candidate = os.path.join(uploads_root(), raw)
    real = os.path.realpath(candidate)
    if not _inside(root, real):         # the same words whether the file is there or not: this is no way to find out what is elsewhere
        raise Refused('only pictures the student attached (the uploads folder) can be read')
    return real, root


def _opened_path(fd):
    """Where the open file really is (Linux), or None where that cannot be asked."""
    try:
        return os.path.realpath(os.readlink('/proc/self/fd/%d' % fd))
    except (OSError, ValueError):
        return None


def load(real, root):
    """The file's bytes: it is opened once, not through a link, and must be a regular file of 1 byte to 10 MB inside the folder."""
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_BINARY', 0)
    try:
        fd = os.open(real, flags)
    except FileNotFoundError:
        raise Refused('no such file among the student\'s uploads: ' + _shown(real))
    except OSError:
        raise Refused('could not open ' + _shown(real) + ' (it is not a plain file of the student\'s uploads)')
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise Refused(_shown(real) + ' is not a file')
        opened = _opened_path(fd)
        if opened is not None and not _inside(root, opened):
            raise Refused('only pictures the student attached (the uploads folder) can be read')
        if info.st_size == 0:
            raise Refused(_shown(real) + ' is empty')
        if info.st_size > MAX_BYTES:
            raise Refused(_shown(real) + ' is larger than %d MB' % (MAX_BYTES // (1024 * 1024)))
        with os.fdopen(fd, 'rb', closefd=False) as handle:
            data = handle.read(MAX_BYTES + 1)
    finally:
        os.close(fd)
    if len(data) > MAX_BYTES:
        raise Refused(_shown(real) + ' is larger than %d MB' % (MAX_BYTES // (1024 * 1024)))
    return data


# --- what kind of picture, and how big, from the file's own header ---------------------------------------------------------------------

def sniff(data):
    """The kind of picture the first bytes say it is, or None."""
    if data.startswith(b'\x89PNG\r\n\x1a\n'):
        return 'png'
    if data.startswith(b'\xff\xd8\xff'):
        return 'jpeg'
    if data[:6] in (b'GIF87a', b'GIF89a'):
        return 'gif'
    if data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        return 'webp'
    if data[:2] == b'BM':
        return 'bmp'
    if data[:4] in (b'II*\x00', b'MM\x00*', b'II+\x00', b'MM\x00+'):
        return 'tiff'
    return None


class _Unreadable(Exception):
    """The header is cut short or does not say what its format must say."""


def _png_size(d):
    if len(d) < 24 or d[12:16] != b'IHDR':
        raise _Unreadable()
    return struct.unpack('>II', d[16:24])


_SOF = frozenset([0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF])


def _jpeg_size(d):
    i, n = 2, len(d)
    while i + 4 <= n:
        if d[i] != 0xFF:
            raise _Unreadable()
        while i < n and d[i] == 0xFF:        # fill bytes
            i += 1
        if i >= n:
            break
        marker = d[i]
        i += 1
        if marker == 0x01 or 0xD0 <= marker <= 0xD8:      # markers without a length
            continue
        if marker in (0x00, 0xD9, 0xDA) or i + 2 > n:      # the picture's data or its end begins, and no frame header came
            break
        length = struct.unpack('>H', d[i:i + 2])[0]
        if length < 2:
            break
        if marker in _SOF:
            if i + 7 > n:
                break
            height, width = struct.unpack('>HH', d[i + 3:i + 7])
            return width, height
        i += length
    raise _Unreadable()


def _skip_blocks(d, i):
    """Past a run of GIF data sub-blocks (each starts with its length; a length of 0 ends the run)."""
    n = len(d)
    while i < n:
        size = d[i]
        i += 1
        if size == 0:
            return i
        i += size
    raise _Unreadable()


def _gif_size(d):
    """The logical screen, and (as `pixels`) the larger of that and the sum of every frame: an animated file is unpacked whole."""
    if len(d) < 13:
        raise _Unreadable()
    width, height = struct.unpack('<HH', d[6:10])
    i = 13
    if d[10] & 0x80:
        i += 3 * (2 << (d[10] & 7))
    frames_total, frames, n = 0, 0, len(d)
    while i < n:
        block = d[i]
        if block == 0x3B:
            break
        if block == 0x21:
            i = _skip_blocks(d, i + 2)
        elif block == 0x2C:
            if i + 10 > n:
                raise _Unreadable()
            frame_w, frame_h = struct.unpack('<HH', d[i + 5:i + 9])
            frames_total += frame_w * frame_h
            frames += 1
            if frames_total > MAX_PIXELS:
                break
            local = d[i + 9]
            i += 10 + (3 * (2 << (local & 7)) if local & 0x80 else 0) + 1
            i = _skip_blocks(d, i)
        else:
            raise _Unreadable()
    if frames == 0:
        raise _Unreadable()
    return width, height, max(width * height, frames_total)


def _webp_size(d):
    if len(d) < 30:
        raise _Unreadable()
    kind = d[12:16]
    if kind == b'VP8 ':
        if d[23:26] != b'\x9d\x01\x2a':
            raise _Unreadable()
        width, height = struct.unpack('<HH', d[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if kind == b'VP8L':
        if d[20] != 0x2F:
            raise _Unreadable()
        bits = struct.unpack('<I', d[21:25])[0]
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if kind == b'VP8X':
        return int.from_bytes(d[24:27], 'little') + 1, int.from_bytes(d[27:30], 'little') + 1
    raise _Unreadable()


def _bmp_size(d):
    if len(d) < 26:
        raise _Unreadable()
    header = struct.unpack('<I', d[14:18])[0]
    if header == 12:
        return struct.unpack('<HH', d[18:22])
    if header in (40, 52, 56, 64, 108, 124):
        width, height = struct.unpack('<ii', d[18:26])
        return abs(width), abs(height)          # a negative height is a picture stored top down
    raise _Unreadable()


def _tiff_size(d):
    order = '<' if d[:2] == b'II' else '>'
    magic = struct.unpack(order + 'H', d[2:4])[0]
    if magic == 43:
        raise Refused('BigTIFF files are not read')
    if magic != 42 or len(d) < 8:
        raise _Unreadable()
    first = struct.unpack(order + 'I', d[4:8])[0]
    if first < 8 or first + 2 > len(d):
        raise _Unreadable()
    count = struct.unpack(order + 'H', d[first:first + 2])[0]
    end = first + 2 + 12 * count
    if count == 0 or end + 4 > len(d):
        raise _Unreadable()
    size = {}
    for k in range(count):
        entry = d[first + 2 + 12 * k:first + 14 + 12 * k]
        tag, kind = struct.unpack(order + 'HH', entry[:4])
        if tag in (256, 257):
            if kind == 3:
                size[tag] = struct.unpack(order + 'H', entry[8:10])[0]
            elif kind == 4:
                size[tag] = struct.unpack(order + 'I', entry[8:12])[0]
            else:
                raise _Unreadable()
    if struct.unpack(order + 'I', d[end:end + 4])[0] != 0:      # tesseract reads every page of a TIFF, and each has a size of its own
        raise Refused('TIFF files with more than one page are not read')
    if 256 not in size or 257 not in size:
        raise _Unreadable()
    return size[256], size[257]


def measure(kind, data):
    """(width, height, pixels) from the header; Refused when it cannot be read or the picture is too large."""
    try:
        if kind == 'gif':
            width, height, pixels = _gif_size(data)
        else:
            width, height = {'png': _png_size, 'jpeg': _jpeg_size, 'webp': _webp_size, 'bmp': _bmp_size, 'tiff': _tiff_size}[kind](data)
            pixels = width * height
    except (_Unreadable, struct.error, IndexError):
        raise Refused('this %s is damaged or cut short: its size could not be read' % kind.upper())
    if width <= 0 or height <= 0:
        raise Refused('this %s says it has no size' % kind.upper())
    if pixels > MAX_PIXELS:
        size = '%d x %d pixels' % (width, height) if pixels == width * height else '%d million pixels in all its frames' % (pixels // 1_000_000)
        raise Refused('the picture is too large to read (%s; the limit is %d million): ask for a crop of the part that matters' % (size, MAX_PIXELS // 1_000_000))
    return width, height, pixels


# --- tesseract ------------------------------------------------------------------------------------------------------------------------

class _TooSlow(Exception):
    pass


def tesseract_path():
    return shutil.which('tesseract')


def run_tesseract(binary, data, layout, seconds):
    """tesseract's TSV for the picture (the page-layout mode `layout`: 6 a block of text, 3 automatic). Success is the exit code, not stderr."""
    env = {k: os.environ[k] for k in ('PATH', 'TESSDATA_PREFIX', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT') if k in os.environ}
    env['OMP_THREAD_LIMIT'] = '1'       # one thread: the container has one CPU, and several threads only wait for each other
    try:
        done = subprocess.run([binary, 'stdin', 'stdout', '-l', 'eng', '--psm', str(layout), 'tsv'], input=data, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, timeout=seconds, env=env)
    except subprocess.TimeoutExpired:
        raise _TooSlow()
    except OSError:
        raise Refused('the text reader could not be started')
    if done.returncode != 0:
        tail = done.stderr.decode('utf-8', 'replace').lower()
        if 'too large' in tail:
            raise Refused('the picture is too large for the text reader: ask for a crop of the part that matters')
        raise Refused('the text reader could not read this picture (it may be damaged, or in a form it does not know); exit %d' % done.returncode)
    return done.stdout.decode('utf-8', 'replace')


def parse_tsv(out):
    """The words of a TSV: (block, paragraph, line, left, top, width, height, confidence, text) for every word row, in reading order. Rows that make no sense are skipped."""
    words = []
    for row in out.split('\n'):
        fields = row.rstrip('\r').split('\t')
        if len(fields) < 12:
            continue
        try:
            level, block, par, line = int(fields[0]), int(fields[2]), int(fields[3]), int(fields[4])
            left, top, width, height, conf = int(fields[6]), int(fields[7]), int(fields[8]), int(fields[9]), float(fields[10])
        except ValueError:
            continue
        text = '\t'.join(fields[11:]).strip()
        if level == 5 and conf >= 0 and text:
            words.append((block, par, line, left, top, width, height, conf, text))
    return words


def layout_text(words):
    """The words as lines: one space between words, each line indented as far (in character widths) as it starts to the right of its block, and a blank
    line where the picture has one. That is read from the gap between two lines (more than 1.7 times the usual distance) and from a new block, not
    from tesseract's paragraph numbers: for the same terminal text it numbered every line as a paragraph of its own in a PNG and none in a JPEG."""
    sizes = sorted(width / len(text) for (_, _, _, _, _, width, _, _, text) in words if len(text) >= 2 and width > 0)
    char_width = sizes[len(sizes) // 2] if sizes else 0
    groups = []
    for block, par, line, left, top, _, _, _, text in words:
        if not groups or groups[-1]['key'] != (block, par, line):
            groups.append({'key': (block, par, line), 'block': block, 'left': left, 'top': top, 'words': []})
        groups[-1]['top'] = min(groups[-1]['top'], top)
        groups[-1]['words'].append(text)
    margin = {}
    for g in groups:
        margin[g['block']] = min(margin.get(g['block'], g['left']), g['left'])
    distances = sorted(b['top'] - a['top'] for a, b in zip(groups, groups[1:]) if a['block'] == b['block'] and b['top'] > a['top'])
    usual = distances[len(distances) // 2] if distances else 0
    lines = []
    for i, g in enumerate(groups):
        if i and (g['block'] != groups[i - 1]['block'] or (usual > 0 and g['top'] - groups[i - 1]['top'] > 1.7 * usual)):
            lines.append('')
        indent = min(MAX_INDENT, int((g['left'] - margin[g['block']]) / char_width + 0.5)) if char_width > 0 else 0
        lines.append(' ' * indent + ' '.join(g['words']))
    return '\n'.join(lines)


def clean(text):
    """No control or invisible characters (a picture's text is shown to a model, and the format characters hide things): line and tab characters stay."""
    out = []
    for ch in text.replace('\r\n', '\n').replace('\r', '\n'):
        if ch in '\n\t':
            out.append(ch)
        elif ch in '  ':
            out.append('\n')
        elif not unicodedata.category(ch).startswith('C'):
            out.append(ch)
    return ''.join(out)


def cap(text):
    """At most MAX_TEXT_CHARS, cut at a line where it can be: (text, whether it was cut)."""
    if len(text) <= MAX_TEXT_CHARS:
        return text, False
    head = text[:MAX_TEXT_CHARS]
    cut = head.rfind('\n')
    return (head[:cut] if cut > MAX_TEXT_CHARS * 0.6 else head), True


def _solid(text):
    return sum(1 for ch in text if not ch.isspace())


def read_image_text(raw_path, clock=time.monotonic):
    """Everything above: the path, the file, the header, tesseract, the words. Raises Refused with a message for the caller."""
    started = clock()
    real, root = resolve(raw_path)
    data = load(real, root)
    kind = sniff(data)
    if kind is None:
        raise Refused(_shown(real) + ' is not a picture this can read (PNG, JPEG, WebP, GIF, BMP or TIFF)')
    measure(kind, data)
    binary = tesseract_path()
    if binary is None:
        raise Refused('text reading is not installed in this container (tesseract is missing)')

    def attempt(layout):
        left = TOTAL_BUDGET - (clock() - started)
        try:
            return parse_tsv(run_tesseract(binary, data, layout, min(TESSERACT_TIMEOUT, max(left, 1.0))))
        except _TooSlow:
            raise Refused('reading the picture took more than %d seconds and was stopped (a very large or detailed picture): '
                          'ask the student for a crop of the part that matters' % TESSERACT_TIMEOUT)

    words = attempt(6)                    # terminal and console screenshots are blocks of text
    text = layout_text(words)
    if _solid(text) < ALMOST_NOTHING and TOTAL_BUDGET - (clock() - started) >= MIN_SECOND_TRY:
        try:
            again = attempt(3)
        except Refused:                   # the second try failing or running out of time leaves the first answer as it was
            again = []
        if _solid(layout_text(again)) > _solid(text):
            words, text = again, layout_text(again)
    text, truncated = cap(clean(text))
    warnings = []
    mean = round(sum(w[7] for w in words) / len(words), 1) if words else None
    if not text.strip():
        text, mean, words = '', None, []
        warnings.append('no text could be read in this picture (it may have none, or the text is too small, too faint or in a style OCR cannot read)')
    elif mean is not None and mean < LOW_CONFIDENCE:
        warnings.append('low confidence (%s of 100): the text may contain misread characters; check anything that matters with the student' % mean)
    if truncated:
        warnings.append('the text was cut at %d characters' % MAX_TEXT_CHARS)
    return {'text': text, 'mean_confidence': mean, 'words': len(words), 'truncated': truncated, 'warnings': warnings}


def main(argv):
    if len(argv) != 2:
        print(json.dumps({'error': 'usage: ocr_image.py IMAGE_PATH'}))
        return 1
    try:
        result = read_image_text(argv[1])
    except Refused as err:
        print(json.dumps({'error': str(err)}))
        return 1
    except Exception as err:       # the type only: a message could carry a path or part of the picture's text
        print(json.dumps({'error': 'the picture could not be read (%s)' % type(err).__name__}))
        return 1
    print(json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
