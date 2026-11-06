"""container/scripts/pacific_time.py: Canvas gives UTC, the course keeps Pacific time, and the student has a clock of their own.

pacific('2026-11-02T17:00:00Z') is 'Mon Nov 2, 9:00 AM PST'. A model that is handed "17:00 UTC" and told the course runs on Pacific time
says "5 pm" (found in a live voice call: the deadline was at 9 in the morning), so every due date a tool returns carries its Pacific
time next to the UTC one and the model reads that instead of converting.

The US rule, in plain code (the image may have no time zone database): daylight time runs from the second Sunday in March, 2:00 local,
to the first Sunday in November, 2:00 local. Run the tests: python container/scripts/test_pacific_time.py

The app's "Pacific" is America/Los_Angeles, and a student's wall clock is not always that: the time zone data of 2026 (tzdata 2026e, the
image's) keeps British Columbia on UTC-7 all year from 2026-11-01, so a deadline that TAi calls "9:00 AM PST" is 10:00 AM for a student in
Vancouver. What Canvas itself shows that student depends on their Canvas profile or the course's zone, which nobody has checked, so TAi
neither replaces the Pacific time nor claims that either one is "the" time: student_local() adds the student's own clock next to it, and only
when it reads differently. The orchestrator hands the student's zone to their container as TAI_STUDENT_TZ (src/student-tz.ts).
"""
import os
import re
from datetime import datetime, timedelta, timezone


def relative(iso, now=None):
    """How far a UTC timestamp is from now, as text ('was due 52 days ago', 'due in 5 hours'); None when it is not a timestamp.

    A model given only a date says "is due Monday September 14" about an assignment that was due seven weeks ago: this puts the past
    and the future in words next to the date. `now` is for tests (naive UTC)."""
    if not iso:
        return None
    try:
        due = datetime.strptime(str(iso)[:19], '%Y-%m-%dT%H:%M:%S')
    except ValueError:
        return None
    seconds = int(((due - (now or datetime.utcnow())).total_seconds()))
    span = abs(seconds)
    if span < 90:
        text = 'right now'
    elif span < 3600 * 2:
        text = '%d minutes' % round(span / 60)
    elif span < 86400 * 2:
        text = '%d hours' % round(span / 3600)
    elif span < 86400 * 14:
        text = '%d days' % round(span / 86400)
    else:
        text = '%d weeks' % round(span / (86400 * 7))
    if text == 'right now':
        return 'due right now'
    return 'was due %s ago' % text if seconds < 0 else 'due in %s' % text


def _sunday(year, month, nth):
    """The day of the month of the nth Sunday."""
    first = datetime(year, month, 1)
    return 1 + (6 - first.weekday()) % 7 + 7 * (nth - 1)


def _utc(iso):
    """A Canvas timestamp as a naive UTC datetime; None when it is not one."""
    if not iso:
        return None
    try:
        return datetime.strptime(str(iso)[:19], '%Y-%m-%dT%H:%M:%S')
    except ValueError:
        return None


def _pacific_wall(utc):
    """(the Pacific wall-clock time as a naive datetime, whether daylight time is on) for a naive UTC datetime."""
    starts = datetime(utc.year, 3, _sunday(utc.year, 3, 2), 10)      # 2:00 PST is 10:00 UTC
    ends = datetime(utc.year, 11, _sunday(utc.year, 11, 1), 9)       # 2:00 PDT is 9:00 UTC
    daylight = starts <= utc < ends
    return utc - timedelta(hours=7 if daylight else 8), daylight


def _clock(wall):
    """'Mon Nov 2, 9:00 AM' for a naive wall-clock datetime (the weekday and month names are the C locale's: English)."""
    return '%s %s %d, %d:%02d %s' % (wall.strftime('%a'), wall.strftime('%b'), wall.day, wall.hour % 12 or 12, wall.minute, 'AM' if wall.hour < 12 else 'PM')


def pacific(iso):
    """The Pacific wall-clock time of a UTC timestamp, as text; None when it is not a timestamp."""
    utc = _utc(iso)
    if utc is None:
        return None
    wall, daylight = _pacific_wall(utc)
    return '%s %s' % (_clock(wall), 'PDT' if daylight else 'PST')


# What src/portal/prefs.ts validTimeZone lets through: an IANA name, not an offset or a path. Checked here too, so that a value that did not
# come from the orchestrator (a test, a hand-run script) can never be a path for zoneinfo to open.
_ZONE_NAME = re.compile(r'[A-Za-z][A-Za-z0-9_+\-/]{0,63}')


def student_zone(name=None):
    """The student's own time zone as a zoneinfo object: `name`, or TAI_STUDENT_TZ when it is not given. None when there is no zone, it is not
    an IANA name, or this Python cannot find it (no zoneinfo before Python 3.9, no time zone data on the system, a name that is no zone): the
    callers then add nothing, and the answer is the one it always was."""
    if name is None:
        name = os.environ.get('TAI_STUDENT_TZ')
    name = str(name or '').strip()
    if not _ZONE_NAME.fullmatch(name):
        return None
    try:
        from zoneinfo import ZoneInfo        # the stdlib; the data is the system's (Debian's tzdata in the image), no package to install
        return ZoneInfo(name)
    except Exception:                        # ImportError, ZoneInfoNotFoundError (a KeyError), ValueError, OSError: all mean "no such zone here"
        return None


def _offset_text(delta):
    """'UTC-7', 'UTC+5:30', 'UTC+0'."""
    minutes = int(round(delta.total_seconds() / 60))
    hours, rest = divmod(abs(minutes), 60)
    return 'UTC%s%d%s' % ('-' if minutes < 0 else '+', hours, ':%02d' % rest if rest else '')


def student_local(iso, zone=None):
    """The student's own wall-clock time of a UTC timestamp, as text with the zone's name and offset ('Fri Nov 6, 10:00 AM (America/Vancouver,
    UTC-7)'), ONLY when it reads differently from the Pacific one (another hour or another day). None when it reads the same (the text a
    student gets is then exactly what it was), when no zone is known (student_zone), or when the timestamp is not one: never an exception.
    `zone` is a tzinfo, for tests; the default is the student's (TAI_STUDENT_TZ). The name is the IANA one the student's page sent, not
    tzname(): abbreviations such as 'PST' are the Pacific zone's, and many zones only have '+13'."""
    utc = _utc(iso)
    if utc is None:
        return None
    if zone is None:
        zone = student_zone()
        if zone is None:
            return None
    try:
        aware = utc.replace(tzinfo=timezone.utc).astimezone(zone)
        wall = aware.replace(tzinfo=None)
        if wall == _pacific_wall(utc)[0]:
            return None
        return '%s (%s, %s)' % (_clock(wall), getattr(zone, 'key', None) or str(zone), _offset_text(aware.utcoffset()))
    except Exception:                        # a zone that cannot convert this instant (the edge of the calendar): no student time, not a failed lookup
        return None
