"""The VAD and the segmenter on synthetic audio: no model, no asyncio, no clock (the segmenter decides on audio time, so a minute of audio is fed in milliseconds)."""
import time
import unittest

import numpy as np

from tests.helpers import RATE, frames_of, silence, speech
from localvoice.segmenter import Interim, Segment, Segmenter, SegmenterConfig, UtteranceEnd
from localvoice.vad import EnergyVad, EnergyVadConfig, SileroFrameVad, silero_factory


def run(seg, pcm, size=640):
    events = []
    for piece in frames_of(pcm, size):
        events += seg.feed(piece)
    return events


def make(**kw):
    """A segmenter with the defaults of the service, except `interim_ms` (off unless a test asks) and what the test overrides."""
    kw.setdefault('interim_ms', 0)
    return Segmenter(EnergyVad(), SegmenterConfig(**kw))


def kinds(events):
    return [type(e).__name__ for e in events]


def frame(level, n=320, seed=0):
    rng = np.random.default_rng(seed)
    return np.clip(rng.normal(0, level, n), -32768, 32767).astype('<i2')


def rms(x):
    return float(np.sqrt(np.mean(x.astype(np.float32) ** 2)))


class EnergyVadTests(unittest.TestCase):
    def feed(self, vad, level, n_frames, seed=0):
        out = []
        for i in range(n_frames):
            f = frame(level, seed=seed + i)
            out.append(vad.process(f, rms(f)))
        return out

    def test_silence_is_not_speech_and_loud_is(self):
        vad = EnergyVad()
        self.assertFalse(any(self.feed(vad, 0, 10)))
        self.assertTrue(all(self.feed(vad, 3000, 10)))

    def test_a_stream_that_starts_with_speech_is_heard(self):
        # no history yet: the threshold is the absolute minimum, not three times the first frames
        self.assertTrue(all(self.feed(EnergyVad(), 3000, 5)))

    def test_the_floor_follows_a_steady_noise(self):
        vad = EnergyVad()
        first = self.feed(vad, 500, 25)            # before the history is long enough the minimum (350) rules: noise at 500 passes
        self.assertTrue(any(first))
        later = self.feed(vad, 500, 60, seed=100)  # now the floor is about 500, the threshold three times that
        self.assertFalse(any(later))
        self.assertAlmostEqual(vad.floor, 500, delta=60)
        self.assertTrue(all(self.feed(vad, 3000, 5, seed=200)))   # speech still gets through

    def test_a_quiet_room_leaves_the_absolute_minimum_in_charge(self):
        vad = EnergyVad()
        self.feed(vad, 20, 60)
        self.assertFalse(any(self.feed(vad, 200, 5)))      # louder than the room, below 350
        self.assertTrue(all(self.feed(vad, 600, 5)))

    def test_config_is_checked(self):
        with self.assertRaises(ValueError):
            EnergyVad(EnergyVadConfig(rms_min=0))
        with self.assertRaises(ValueError):
            EnergyVad(EnergyVadConfig(ratio=0.5))


class SileroAdapterTests(unittest.TestCase):
    """No Silero model is on the development PC: the adapter's wiring is tested with a stand-in detector."""

    class Fake:
        def __init__(self):
            self.fed = []
            self.speech = False

        def accept_waveform(self, samples):
            self.fed.append(samples)

        def is_speech_detected(self):
            return self.speech

    def test_samples_are_float32_in_unit_range_and_the_answer_is_a_bool(self):
        fake = self.Fake()
        vad = SileroFrameVad(fake)
        f = frame(3000)
        self.assertIs(vad.process(f, rms(f)), False)
        fake.speech = True
        self.assertIs(vad.process(f, rms(f)), True)
        self.assertEqual(fake.fed[0].dtype, np.float32)
        self.assertEqual(len(fake.fed[0]), 320)
        self.assertLessEqual(float(np.abs(fake.fed[0]).max()), 1.0)

    def test_a_missing_model_file_stops_the_start(self):
        with self.assertRaises(FileNotFoundError):
            silero_factory('/no/such/silero_vad.onnx')

    def test_the_segmenter_accepts_any_frame_vad(self):
        fake = self.Fake()
        fake.speech = True
        seg = Segmenter(SileroFrameVad(fake), SegmenterConfig(interim_ms=0))
        events = run(seg, bytes(RATE * 2))                    # silent audio, but the "detector" says speech throughout
        events += seg.finalize()
        self.assertIn('Segment', kinds(events))


class SegmenterTests(unittest.TestCase):
    def test_onset_preroll_trailing_silence_and_the_end_of_the_utterance(self):
        seg = make()
        events = run(seg, silence(1.0) + speech(1.0) + silence(1.0))
        self.assertEqual(kinds(events), ['Segment', 'UtteranceEnd'])
        segment, end = events
        self.assertEqual(segment.speech_ms, 900)                            # the test speech has a quiet frame in every ten: 45 of its 50 frames are speech
        self.assertAlmostEqual(segment.start_s, 0.8, delta=0.04)            # 200 ms before the onset at 1.0 s
        self.assertAlmostEqual(segment.end_s, 2.2, delta=0.04)              # the silence after the speech cut back to 200 ms
        self.assertEqual(len(segment.samples), round((segment.end_s - segment.start_s) * RATE))
        self.assertEqual(segment.samples.dtype, np.float32)
        self.assertLessEqual(float(np.abs(segment.samples).max()), 1.0)
        self.assertFalse(segment.cut)
        self.assertEqual(end.reason, 'pause')
        self.assertAlmostEqual(end.at_s, 2.6, delta=0.05)                   # 600 ms after the last speech
        self.assertFalse(seg.in_utterance)

    def test_a_pause_of_350_ms_closes_the_segment_and_the_utterance_goes_on(self):
        # (pauses in these tests are whole numbers of 20 ms frames, so that the quiet frame of every ten in the next stretch of speech stays one frame)
        seg = make()
        events = run(seg, speech(1.0) + silence(0.46) + speech(1.0) + silence(1.0))
        self.assertEqual(kinds(events), ['Segment', 'Segment', 'UtteranceEnd'])
        self.assertEqual(seg.stats.utterances, 1)
        a, b, _ = events
        self.assertLess(a.end_s, b.start_s + 0.001)
        self.assertEqual(a.speech_ms, 900)
        self.assertEqual(b.speech_ms, 900)

    def test_a_shorter_pause_does_not_split(self):
        seg = make()
        events = run(seg, speech(1.0) + silence(0.30) + speech(1.0) + silence(1.0))
        self.assertEqual(kinds(events), ['Segment', 'UtteranceEnd'])
        self.assertAlmostEqual(events[0].end_s - events[0].start_s, 0.0 + 1.0 + 0.3 + 1.0 + 0.2, delta=0.1)

    def test_the_utterance_ends_after_600_ms_and_not_before(self):
        seg = make()
        events = run(seg, speech(1.0) + silence(0.56))
        self.assertEqual(kinds(events), ['Segment'])
        self.assertTrue(seg.in_utterance)
        events = run(seg, silence(0.1))
        self.assertEqual(kinds(events), ['UtteranceEnd'])
        self.assertFalse(seg.in_utterance)

    def test_two_utterances(self):
        seg = make()
        events = run(seg, speech(0.8) + silence(1.0) + speech(0.8) + silence(1.0))
        self.assertEqual(kinds(events), ['Segment', 'UtteranceEnd', 'Segment', 'UtteranceEnd'])
        self.assertEqual(seg.stats.utterances, 2)

    def test_a_blip_shorter_than_200_ms_is_dropped_and_a_click_is_not_even_an_onset(self):
        seg = make()
        events = run(seg, silence(0.5) + speech(0.1) + silence(1.5))
        self.assertEqual([e for e in events if isinstance(e, Segment)], [])
        self.assertEqual(seg.stats.blips, 1)
        seg = make()
        events = run(seg, silence(0.5) + speech(0.04) + silence(1.5))     # two frames: below the three the onset needs
        self.assertEqual(events, [])
        self.assertFalse(seg.in_utterance)
        self.assertEqual(seg.stats.blips, 0)

    def test_a_blip_in_a_pause_does_not_extend_the_utterance(self):
        seg = make()
        events = run(seg, speech(1.0) + silence(0.4) + speech(0.04) + silence(0.5))
        # the segment closed at 350 ms; two loud frames are no onset; the utterance still ends 600 ms after the real speech (plus the two frames' worth)
        self.assertEqual(kinds(events), ['Segment', 'UtteranceEnd'])

    def test_finalize_closes_the_open_segment_and_always_answers(self):
        seg = make()
        events = run(seg, speech(1.0))
        self.assertEqual(events, [])
        events = seg.finalize()
        self.assertEqual(kinds(events), ['Segment', 'UtteranceEnd'])
        self.assertEqual(events[-1].reason, 'finalize')
        self.assertEqual(kinds(seg.finalize()), ['UtteranceEnd'])            # nothing pending: still an answer
        self.assertEqual(kinds(seg.finalize('close')), ['UtteranceEnd'])
        self.assertEqual(seg.finalize('idle'), [])                            # the idle backstop only fires for an open utterance

    def test_idle_finalize_ends_an_open_utterance(self):
        seg = make()
        run(seg, speech(0.8))
        events = seg.finalize('idle')
        self.assertEqual(kinds(events), ['Segment', 'UtteranceEnd'])
        self.assertEqual(events[-1].reason, 'idle')

    def test_pieces_of_any_size_give_the_same_events(self):
        pcm = silence(0.5) + speech(1.0) + silence(0.46) + speech(0.7) + silence(1.0)
        reference = run(make(), pcm, 640)
        for size in (1, 7, 333, 641, 1280, 4097):
            got = run(make(), pcm, size)
            self.assertEqual(kinds(got), kinds(reference), size)
            for a, b in zip(got, reference):
                if isinstance(a, Segment):
                    self.assertEqual(a.start_s, b.start_s)
                    self.assertTrue(np.array_equal(a.samples, b.samples), size)

    def test_finalize_uses_the_audio_waiting_in_a_partial_frame(self):
        seg = make()
        run(seg, speech(0.5))
        seg.feed(speech(0.01)[:300])                                          # 300 bytes: less than a frame
        before = seg.audio_s
        seg.finalize()
        self.assertAlmostEqual(seg.audio_s - before, 0.02, places=6)

    def test_the_hard_cap_ends_the_utterance_and_loses_no_audio(self):
        seg = make(max_utterance_ms=2000)
        events = run(seg, speech(3.0) + silence(1.0))
        segments = [e for e in events if isinstance(e, Segment)]
        ends = [e for e in events if isinstance(e, UtteranceEnd)]
        self.assertEqual([e.reason for e in ends], ['cap', 'pause'])
        self.assertEqual(len(segments), 2)
        self.assertAlmostEqual(segments[0].end_s - segments[0].start_s, 2.0, delta=0.05)
        self.assertAlmostEqual(segments[1].start_s, segments[0].end_s, delta=0.001)     # the next utterance begins where the last stopped

    def test_audio_time_decides_not_the_wall_clock(self):
        pcm = b''.join(speech(1.0, seed=i) + silence(1.0) for i in range(15))             # 30 s of audio
        t0 = time.perf_counter()
        events = run(make(), pcm)
        took = time.perf_counter() - t0
        self.assertEqual(kinds(events).count('Segment'), 15)
        self.assertEqual(kinds(events).count('UtteranceEnd'), 15)
        self.assertLess(took, 5.0)

    def test_silence_ms_counts_the_quiet_since_the_last_speech(self):
        seg = make()
        self.assertEqual(seg.silence_ms, 0)
        run(seg, speech(0.5))
        self.assertEqual(seg.silence_ms, 0)
        run(seg, silence(0.3))
        self.assertEqual(seg.silence_ms, 300)
        run(seg, speech(0.2, dip_every=0))
        self.assertEqual(seg.silence_ms, 0)

    def test_a_little_noise_in_the_pauses_changes_nothing(self):
        seg = make()
        events = run(seg, silence(1.0, level=20) + speech(1.0) + silence(1.0, level=20))
        self.assertEqual(kinds(events), ['Segment', 'UtteranceEnd'])

    def test_the_settings_are_checked(self):
        for bad in ({'seg_pause_ms': 50}, {'end_pause_ms': 50}, {'max_utterance_ms': 100}, {'onset_ms': 5}, {'interim_ms': 500}, {'max_segment_ms': 500},
                    {'max_segment_ms': 1500, 'cut_window_ms': 900}):
            with self.assertRaises(ValueError, msg=str(bad)):
                SegmenterConfig(**bad).validate()
        SegmenterConfig(interim_ms=0, max_segment_ms=0).validate()


class InterimTests(unittest.TestCase):
    def test_a_long_unbroken_stretch_offers_interims_with_a_growing_buffer_and_keeps_its_segment(self):
        seg = make(interim_ms=3000)
        events = run(seg, speech(7.5) + silence(1.0))
        self.assertEqual(kinds(events), ['Interim', 'Interim', 'Segment', 'UtteranceEnd'])
        first, second, segment, _ = events
        self.assertAlmostEqual(first.end_s, 3.0, delta=0.04)
        self.assertAlmostEqual(second.end_s, 6.0, delta=0.04)
        self.assertEqual(first.start_s, second.start_s)
        self.assertGreater(len(second.samples), len(first.samples))
        self.assertGreater(len(segment.samples), len(second.samples))
        self.assertFalse(segment.cut)
        self.assertEqual(seg.stats.interims, 2)

    def test_a_short_segment_offers_none(self):
        events = run(make(interim_ms=3000), speech(2.5) + silence(1.0))
        self.assertEqual(kinds(events), ['Segment', 'UtteranceEnd'])

    def test_the_interim_clock_restarts_with_each_segment(self):
        events = run(make(interim_ms=3000), speech(2.0) + silence(0.5) + speech(2.0) + silence(0.5) + speech(3.5) + silence(1.0))
        self.assertEqual(kinds(events), ['Segment', 'Segment', 'Interim', 'Segment', 'UtteranceEnd'])

    def test_interims_can_be_switched_off(self):
        events = run(make(interim_ms=0), speech(7.5) + silence(1.0))
        self.assertEqual(kinds(events), ['Segment', 'UtteranceEnd'])


class SoftCutTests(unittest.TestCase):
    def test_off_by_default(self):
        events = run(Segmenter(EnergyVad(), SegmenterConfig(interim_ms=0)), speech(7.5) + silence(1.0))
        self.assertEqual([e.cut for e in events if isinstance(e, Segment)], [False])

    def test_the_cut_falls_at_the_quietest_spot_of_the_last_400_ms(self):
        # 3 s of speech, with a dip (still speech to the VAD, but the quietest) 1.75 s in; the cut comes when the segment reaches 2 s
        pcm = speech(1.75, 3000, seed=1) + speech(0.1, 500, seed=2) + speech(1.15, 3000, seed=3) + silence(1.0)
        events = run(make(max_segment_ms=2000), pcm)
        segments = [e for e in events if isinstance(e, Segment)]
        self.assertGreaterEqual(len(segments), 2)
        self.assertTrue(segments[0].cut)
        self.assertAlmostEqual(segments[0].end_s, 1.80, delta=0.06)
        self.assertAlmostEqual(segments[1].start_s, segments[0].end_s, delta=0.001)       # nothing between the pieces is lost
        self.assertEqual(seg_count_ends(events), 1)

    def test_what_is_left_after_a_cut_in_a_pause_is_only_silence_and_is_dropped_like_any_blip(self):
        # the segment reaches 2 s while the speaker is in a pause of 300 ms (not yet the 350 ms that would close it): the cut falls in the silence, the remainder is nothing but silence
        pcm = speech(1.7, 3000, seed=1) + silence(0.3) + silence(1.0)
        seg = make(max_segment_ms=2000)
        events = run(seg, pcm)
        self.assertEqual(kinds(events), ['Segment', 'UtteranceEnd'])
        self.assertTrue(events[0].cut)
        self.assertAlmostEqual(events[0].end_s, 2.0, delta=0.05)
        self.assertEqual(seg.stats.blips, 1)


def seg_count_ends(events):
    return len([e for e in events if isinstance(e, UtteranceEnd)])


if __name__ == '__main__':
    unittest.main()
