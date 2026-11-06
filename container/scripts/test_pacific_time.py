"""container/scripts/pacific_time.py. Run: python container/scripts/test_pacific_time.py"""
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
from datetime import datetime, timedelta, timezone, tzinfo  # noqa: E402

from pacific_time import pacific, relative, student_local, student_zone  # noqa: E402


class PacificTime(unittest.TestCase):
    def test_the_deadline_that_was_read_out_as_5_pm(self):
        # 17:00 UTC on 2026-11-02, the day after daylight time ended: 9 in the morning
        self.assertEqual(pacific('2026-11-02T17:00:00Z'), 'Mon Nov 2, 9:00 AM PST')

    def test_daylight_time_in_the_summer_and_standard_time_in_the_winter(self):
        self.assertEqual(pacific('2026-07-15T06:59:00Z'), 'Tue Jul 14, 11:59 PM PDT')
        self.assertEqual(pacific('2026-01-15T07:59:00Z'), 'Wed Jan 14, 11:59 PM PST')

    def test_the_two_changes_of_the_year_2026(self):
        # starts Sunday 2026-03-08 at 2:00 PST (10:00 UTC); ends Sunday 2026-11-01 at 2:00 PDT (09:00 UTC)
        self.assertEqual(pacific('2026-03-08T09:59:00Z'), 'Sun Mar 8, 1:59 AM PST')
        self.assertEqual(pacific('2026-03-08T10:00:00Z'), 'Sun Mar 8, 3:00 AM PDT')
        self.assertEqual(pacific('2026-11-01T08:59:00Z'), 'Sun Nov 1, 1:59 AM PDT')
        self.assertEqual(pacific('2026-11-01T09:00:00Z'), 'Sun Nov 1, 1:00 AM PST')

    def test_noon_and_midnight(self):
        self.assertEqual(pacific('2026-12-01T20:00:00Z'), 'Tue Dec 1, 12:00 PM PST')
        self.assertEqual(pacific('2026-12-01T08:00:00Z'), 'Tue Dec 1, 12:00 AM PST')

    def test_what_is_not_a_timestamp_is_none(self):
        for value in (None, '', 'soon', '2026-13-45T99:00:00Z', 12):
            self.assertIsNone(pacific(value))
            self.assertIsNone(relative(value))

    def test_how_far_away_a_date_is_said_in_words_for_the_past_and_the_future(self):
        now = datetime(2026, 11, 2, 14, 0, 0)
        self.assertEqual(relative('2026-09-14T16:00:00Z', now), 'was due 7 weeks ago')              # the owner's call: "is due Monday September 14"
        self.assertEqual(relative('2026-10-30T14:00:00Z', now), 'was due 3 days ago')
        self.assertEqual(relative('2026-11-02T09:00:00Z', now), 'was due 5 hours ago')
        self.assertEqual(relative('2026-11-02T13:30:00Z', now), 'was due 30 minutes ago')
        self.assertEqual(relative('2026-11-02T14:00:20Z', now), 'due right now')
        self.assertEqual(relative('2026-11-02T17:00:00Z', now), 'due in 3 hours')
        self.assertEqual(relative('2026-11-04T14:00:00Z', now), 'due in 2 days')
        self.assertEqual(relative('2026-12-14T14:00:00Z', now), 'due in 6 weeks')


class FixedZone(tzinfo):
    """A zone with one offset all year and the `key` a zoneinfo zone has. British Columbia as the 2026e data keeps it from 2026-11-01 (UTC-7
    all year), without depending on the time zone data of the machine the test runs on: a PC that reads the pip package tzdata 2025.x has
    Vancouver on UTC-8 in the winter."""

    def __init__(self, key, hours):
        self.key = key
        self._offset = timedelta(hours=hours)

    def utcoffset(self, dt):
        return self._offset

    def dst(self, dt):
        return timedelta(0)

    def tzname(self, dt):
        return self.key


VANCOUVER = FixedZone('America/Vancouver', -7)

# (UTC timestamp, what a student in Vancouver is told next to the Pacific time). Los Angeles falls back at 2026-11-01 09:00 UTC and
# springs forward at 2027-03-14 10:00 UTC; British Columbia does neither.
VANCOUVER_CASES = [
    ('2026-07-15T06:59:00Z', None),                                                # summer: both on PDT, one wall clock: nothing is added
    ('2026-11-01T08:59:00Z', None),                                                # the last minute before Los Angeles falls back
    ('2026-11-01T09:00:00Z', 'Sun Nov 1, 2:00 AM (America/Vancouver, UTC-7)'),     # Los Angeles reads 1:00 AM PST
    ('2026-11-02T17:00:00Z', 'Mon Nov 2, 10:00 AM (America/Vancouver, UTC-7)'),    # the deadline TAi calls "9:00 AM PST"
    ('2027-01-15T07:59:00Z', 'Fri Jan 15, 12:59 AM (America/Vancouver, UTC-7)'),   # the date is not the Pacific one either
    ('2027-03-14T09:59:00Z', 'Sun Mar 14, 2:59 AM (America/Vancouver, UTC-7)'),    # the last minute before Los Angeles springs forward
    ('2027-03-14T10:00:00Z', None),                                                # both read 3:00 AM
    ('2027-07-15T06:59:00Z', None),
]


def needs_zone(test, name):
    zone = student_zone(name)
    if zone is None:
        test.skipTest('no time zone data for %s on this machine' % name)
    return zone


def vancouver_stays_on_utc_minus_7():
    """Is the time zone data of this machine 2026e or later (British Columbia on UTC-7 all year)? The agent image has it."""
    zone = student_zone('America/Vancouver')
    return zone is not None and datetime(2026, 12, 1, 20, tzinfo=timezone.utc).astimezone(zone).utcoffset() == timedelta(hours=-7)


class StudentLocalTime(unittest.TestCase):
    def test_vancouver_against_los_angeles_across_the_two_changes(self):
        for iso, expected in VANCOUVER_CASES:
            self.assertEqual(student_local(iso, VANCOUVER), expected, iso)

    @unittest.skipUnless(vancouver_stays_on_utc_minus_7(), 'needs the time zone data of 2026e or later (British Columbia on UTC-7 all year): the agent image has it, a PC that reads the pip package tzdata 2025.x does not')
    def test_the_real_vancouver_of_the_2026e_data_says_the_same(self):
        for iso, expected in VANCOUVER_CASES:
            self.assertEqual(student_local(iso, student_zone('America/Vancouver')), expected, iso)
            with mock.patch.dict(os.environ, {'TAI_STUDENT_TZ': 'America/Vancouver'}):
                self.assertEqual(student_local(iso), expected, iso)

    def test_a_student_on_the_clock_of_los_angeles_is_told_nothing_more(self):
        # this is also the check that the hand-written US rule of pacific() and the zone data agree across the changes
        for name in ('America/Los_Angeles', 'US/Pacific', 'America/Tijuana'):
            zone = needs_zone(self, name)
            for iso in ('2026-03-08T09:59:00Z', '2026-03-08T10:00:00Z', '2026-07-15T06:59:00Z', '2026-11-01T08:59:00Z', '2026-11-01T09:00:00Z',
                        '2026-11-02T17:00:00Z', '2027-01-15T07:59:00Z', '2027-03-14T09:59:00Z', '2027-03-14T10:00:00Z'):
                self.assertIsNone(student_local(iso, zone), '%s %s' % (name, iso))

    def test_a_zone_that_changes_the_date(self):
        zone = needs_zone(self, 'Pacific/Auckland')
        # NZDT (UTC+13) in November: Monday 9:00 AM Pacific is Tuesday morning there
        self.assertEqual(student_local('2026-11-02T17:00:00Z', zone), 'Tue Nov 3, 6:00 AM (Pacific/Auckland, UTC+13)')
        # NZST (UTC+12) in July: the same instant of Tuesday 11:59 PM Pacific is Wednesday evening
        self.assertEqual(student_local('2026-07-15T06:59:00Z', zone), 'Wed Jul 15, 6:59 PM (Pacific/Auckland, UTC+12)')

    def test_offsets_with_minutes_and_a_zero_one(self):
        self.assertEqual(student_local('2026-11-02T17:00:00Z', needs_zone(self, 'Asia/Kolkata')), 'Mon Nov 2, 10:30 PM (Asia/Kolkata, UTC+5:30)')
        self.assertEqual(student_local('2026-12-01T20:00:00Z', needs_zone(self, 'Europe/London')), 'Tue Dec 1, 8:00 PM (Europe/London, UTC+0)')
        self.assertEqual(student_local('2026-11-02T17:00:00Z', FixedZone('Asia/Kathmandu', 5.75)), 'Mon Nov 2, 10:45 PM (Asia/Kathmandu, UTC+5:45)')
        self.assertEqual(student_local('2026-11-02T17:00:00Z', FixedZone('America/St_Johns', -3.5)), 'Mon Nov 2, 1:30 PM (America/St_Johns, UTC-3:30)')

    def test_the_zone_comes_from_the_variable_the_orchestrator_sets(self):
        zone = needs_zone(self, 'Pacific/Auckland')
        with mock.patch.dict(os.environ, {'TAI_STUDENT_TZ': 'Pacific/Auckland'}):
            self.assertEqual(student_local('2026-11-02T17:00:00Z'), student_local('2026-11-02T17:00:00Z', zone))
            self.assertEqual(student_zone().key, 'Pacific/Auckland')
        with mock.patch.dict(os.environ, {'TAI_STUDENT_TZ': ' Pacific/Auckland\n'}):
            self.assertEqual(student_zone().key, 'Pacific/Auckland')
        with mock.patch.dict(os.environ):
            os.environ.pop('TAI_STUDENT_TZ', None)
            self.assertIsNone(student_zone())
            self.assertIsNone(student_local('2026-11-02T17:00:00Z'))

    def test_a_value_that_is_no_zone_adds_nothing_and_is_never_an_exception(self):
        # well formed but not found, an offset, a directory of the zone data, and what could be a path or a command
        for value in ('', '   ', 'Not/AZone', 'UTC+8', 'America', '../../etc/passwd', '/etc/localtime', 'America/Vancouver\nINJECT',
                      'A' * 65, 'America/Vancouver; rm -rf /', 'Europe/Paris\x00', '..', 'a b'):
            self.assertIsNone(student_zone(value), repr(value))
            if '\x00' in value:
                continue                                                  # no process environment can hold a NUL: only the direct call is possible
            with mock.patch.dict(os.environ, {'TAI_STUDENT_TZ': value}):
                self.assertIsNone(student_local('2026-11-02T17:00:00Z'), repr(value))

    def test_a_python_without_zoneinfo_or_without_time_zone_data_adds_nothing(self):
        needs_zone(self, 'Pacific/Auckland')
        with mock.patch.dict(sys.modules, {'zoneinfo': None}):          # `from zoneinfo import ZoneInfo` raises ImportError
            self.assertIsNone(student_zone('Pacific/Auckland'))
            with mock.patch.dict(os.environ, {'TAI_STUDENT_TZ': 'Pacific/Auckland'}):
                self.assertIsNone(student_local('2026-11-02T17:00:00Z'))
        import zoneinfo
        with mock.patch.object(zoneinfo, 'ZoneInfo', side_effect=zoneinfo.ZoneInfoNotFoundError('no data')):
            self.assertIsNone(student_zone('Pacific/Auckland'))

    def test_what_is_not_a_timestamp_is_none_with_a_zone_too(self):
        for value in (None, '', 'soon', '2026-13-45T99:00:00Z', 12):
            self.assertIsNone(student_local(value, VANCOUVER))

    def test_a_zone_that_fails_is_no_student_time(self):
        class Broken(tzinfo):
            def utcoffset(self, dt):
                raise RuntimeError('broken zone')

            def dst(self, dt):
                return None

            def tzname(self, dt):
                return 'x'

        self.assertIsNone(student_local('2026-11-02T17:00:00Z', Broken()))
        # the edge of the calendar: ahead of UTC, the last hour of the year 9999 overflows
        self.assertIsNone(student_local('9999-12-31T23:00:00Z', FixedZone('Pacific/Auckland', 13)))


if __name__ == '__main__':
    unittest.main()
