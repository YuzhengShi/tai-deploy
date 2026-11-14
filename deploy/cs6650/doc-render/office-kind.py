#!/usr/bin/env python3
"""Which kind of Office file a zip is, decided from the names of its entries alone (docs/COURSE_DOCS.md).

    python3 -I office-kind.py <file>

Prints `pptx`, `docx` or `xlsx` and exits 0, or prints nothing and exits with a number that doc-render turns into one fixed sentence:

    3  not an Office file: a zip with no [Content_Types].xml, with the parts of none of the three kinds (an OpenDocument file, a plain archive) or of more than one
    4  too many parts: more than MAX_ENTRIES entries, or a central directory that is far larger than that many entries need
    5  too big unpacked: an entry that declares more than MAX_ENTRY_BYTES, or all of them more than MAX_TOTAL_BYTES
    6  macros: a VBA project or an Excel 4 macro sheet is part of the package
    7  unreadable: not a zip at all, an empty file, a file cut off, a package whose main part is missing
    8  protected: an entry is encrypted

The file comes from somebody who is not trusted, and the host never opens it: only the end-of-central-directory record and the central directory (names and the sizes the entries declare) are read,
never the content of an entry, and nothing is extracted or written. A file whose end record claims a large directory is refused before the zipfile module reads it. The sizes entries declare can lie;
what this checks is a first line, and the container's own limits (memory, time, processes, file size) are the others. It prints nothing but the kind: everything doc-render says of a file is its own fixed
sentence for the number returned here.
"""
import struct
import sys
import zipfile

MAX_ENTRIES = 3000
MAX_ENTRY_BYTES = 200 * 1024 * 1024
MAX_TOTAL_BYTES = 400 * 1024 * 1024
# a record of the central directory is 46 bytes and a name: 512 bytes for each entry the limit allows is more than any real package needs
MAX_DIRECTORY_BYTES = MAX_ENTRIES * 512

NOT_OFFICE, TOO_MANY, TOO_BIG, MACROS, UNREADABLE, PROTECTED = 3, 4, 5, 6, 7, 8

# the main part each kind must have, and the folder its parts are in
KINDS = (
    ('pptx', 'ppt/', 'ppt/presentation.xml'),
    ('docx', 'word/', 'word/document.xml'),
    ('xlsx', 'xl/', 'xl/workbook.xml'),
)


def end_record(handle, size):
    """(entries, directory bytes) as the end-of-central-directory record claims them, or None when there is none in the last 64 KB."""
    tail = min(size, 22 + 65535)
    handle.seek(size - tail)
    data = handle.read(tail)
    at = data.rfind(b'PK\x05\x06')
    if at < 0 or at + 22 > len(data):
        return None
    entries = struct.unpack('<H', data[at + 10:at + 12])[0]
    directory = struct.unpack('<I', data[at + 12:at + 16])[0]
    return entries, directory


def kind_of(path):
    """(exit code, kind): 0 and the kind, or the number of the refusal."""
    try:
        with open(path, 'rb') as handle:
            handle.seek(0, 2)
            size = handle.tell()
            if size < 22:
                return UNREADABLE, ''
            record = end_record(handle, size)
        if record is None:
            return UNREADABLE, ''
        entries, directory = record
        # (0xFFFF says the real number is in a zip64 record: far more than the limit, as is anything above it)
        if entries >= MAX_ENTRIES or directory > MAX_DIRECTORY_BYTES:
            return TOO_MANY, ''
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
    except (zipfile.BadZipFile, zipfile.LargeZipFile, OSError, ValueError, OverflowError, EOFError, RuntimeError, NotImplementedError, struct.error):
        return UNREADABLE, ''
    if len(infos) > MAX_ENTRIES:
        return TOO_MANY, ''
    names = set()
    total = 0
    for info in infos:
        if info.flag_bits & 0x1:
            return PROTECTED, ''
        if info.file_size > MAX_ENTRY_BYTES:
            return TOO_BIG, ''
        total += info.file_size
        if total > MAX_TOTAL_BYTES:
            return TOO_BIG, ''
        names.add(info.filename)
    if '[Content_Types].xml' not in names:
        return NOT_OFFICE, ''
    if any(name.lower().endswith('vbaproject.bin') or '/macrosheets/' in name.lower() for name in names):
        return MACROS, ''
    found = [(kind, main) for kind, folder, main in KINDS if any(name.startswith(folder) for name in names)]
    if len(found) != 1:
        return NOT_OFFICE, ''
    kind, main = found[0]
    # the parts of a deck with no presentation part (or of a document with no body) are a damaged package, not another kind of file
    return (0, kind) if main in names else (UNREADABLE, '')


def main(argv):
    if len(argv) != 2:
        return NOT_OFFICE
    code, kind = kind_of(argv[1])
    if code == 0:
        print(kind)
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv))
