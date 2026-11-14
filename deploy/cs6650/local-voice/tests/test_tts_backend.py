"""The audio plumbing and the engines' wrappers, without a model: the resampler, the PCM conversion, the chunking, and the Supertonic backend over stand-in engine objects."""
import threading
import unittest
from types import SimpleNamespace
from unittest import mock

import numpy as np

from localvoice.tts import (OUT_RATE, PIPER_ALIASES, ST_ALIASES, ST_STYLES, SupertonicBackend, UnsupportedText, chunk_pcm, pcm16_24k, resample)

SUPPORTED = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:!?'\"-()/%&+@#$") | set('áéíóúýÁÉïñçü')


class FakeProcessor:
    """What the real text processor answers, roughly: the characters of the engine's index (ASCII without `<=>^{}~`, the acute-accented letters and a few more) are fine."""

    def validate_text(self, text):
        bad = sorted({c for c in text if c not in SUPPORTED})
        return (not bad, bad)


class FakeEngine:
    sample_rate = 44100

    def __init__(self, styles=('F1', 'F2', 'M1'), gate=None):
        self.voice_style_names = list(styles)
        self.model = SimpleNamespace(text_processor=FakeProcessor())
        self.calls = []
        self._gate = gate

    def get_voice_style(self, name):
        return ('style', name)

    def synthesize(self, text, voice_style, total_steps, speed):
        self.calls.append({'text': text, 'style': voice_style, 'steps': total_steps, 'speed': speed})
        if self._gate:
            self._gate()
        if 'RAISE' in text:
            raise ValueError('a message that holds the text: %s' % text)
        return np.full((1, 4410), 0.1, dtype=np.float32), np.array([0.1])


def backend(**kw):
    """A Supertonic backend over FakeEngine objects, and the list of (folder, threads, engine) it asked for."""
    made = []

    def factory(model_dir, threads):
        e = FakeEngine()
        made.append((model_dir, threads, e))
        return e

    return SupertonicBackend('/models/st', engine_factory=factory, **kw), made


class ResampleTests(unittest.TestCase):
    def tone(self, hz, rate, seconds=1.0):
        t = np.arange(int(rate * seconds)) / rate
        return (0.5 * np.sin(2 * np.pi * hz * t)).astype(np.float32)

    def test_lengths(self):
        for rate in (44100, 22050, 16000, 24000):
            self.assertAlmostEqual(len(resample(self.tone(440, rate), rate)), OUT_RATE, delta=2)

    def test_a_tone_keeps_its_pitch_and_level(self):
        for rate in (44100, 22050):
            y = resample(self.tone(1000, rate), rate)
            mid = y[2000:-2000]
            self.assertAlmostEqual(float(np.abs(mid).max()), 0.5, delta=0.03)
            crossings = int(np.sum(np.diff(np.signbit(mid).astype(np.int8)) != 0))
            self.assertAlmostEqual(crossings / (len(mid) / OUT_RATE) / 2, 1000, delta=15)

    def test_what_the_new_rate_cannot_hold_is_filtered_out_not_folded_in(self):
        y = resample(self.tone(15000, 44100), 44100)         # above the 12 kHz Nyquist of 24 kHz
        self.assertLess(float(np.abs(y[2000:-2000]).max()), 0.05)

    def test_the_same_rate_is_a_copy(self):
        x = self.tone(300, 24000)
        y = resample(x, 24000)
        self.assertTrue(np.array_equal(x, y))
        self.assertIsNot(x, y)


class PcmTests(unittest.TestCase):
    def test_pcm16_24k_is_little_endian_whole_samples_and_clipped(self):
        pcm = pcm16_24k(np.array([0.0, 0.5, -0.5, 2.0, -2.0] * 10, dtype=np.float32), 24000)
        self.assertEqual(len(pcm), 100)
        x = np.frombuffer(pcm, dtype='<i2')
        self.assertEqual(int(x[1]), 16383)
        self.assertEqual(int(x[3]), 32767)
        self.assertEqual(int(x[4]), -32767)

    def test_a_body_never_starts_with_riff(self):
        # two samples that are the letters R I F F: the client would take the body for a WAV header
        x = np.array([0x4952, 0x4646] + [100] * 20, dtype=np.float64) / 32767.0 + 1e-6
        pcm = pcm16_24k(x.astype(np.float32), 24000)
        self.assertNotEqual(pcm[:4], b'RIFF')
        self.assertEqual(len(pcm), 44)

    def test_chunks(self):
        pcm = bytes(144000)
        chunks = chunk_pcm(pcm)
        self.assertEqual(len(chunks), 10)
        self.assertEqual(b''.join(chunks), pcm)
        self.assertTrue(all(len(c) % 2 == 0 for c in chunks))
        self.assertEqual(len(chunk_pcm(bytes(2000))), 1)                               # a very short sentence is one piece
        self.assertEqual(len(chunk_pcm(bytes(20000))), 5)                              # pieces are at least 100 ms
        big = chunk_pcm(bytes(6_000_000))
        self.assertTrue(all(len(c) <= 65536 for c in big))
        self.assertEqual(sum(len(c) for c in big), 6_000_000)
        self.assertEqual(chunk_pcm(b''), [])


class SupertonicBackendTests(unittest.TestCase):
    def test_voices_the_names_a_request_may_use(self):
        self.assertEqual({k for k, v in ST_ALIASES.items() if v == 'F1'}, {'default', 'af_bella', 'af_heart', 'F1'})
        self.assertEqual(set(ST_ALIASES) - {'default', 'af_bella', 'af_heart'}, set(ST_STYLES))
        self.assertEqual(set(PIPER_ALIASES), {'default', 'af_bella', 'lessac'})

    def test_speed_is_a_multiplier_on_the_natural_pace(self):
        b, made = backend(steps=3, threads=2, instances=1)
        engine = made[0][2]
        for asked, want in ((1.0, 1.05), (1.2, 1.26), (0.5, 0.7), (2.0, 2.0), (1.9, 1.995)):
            b.synthesize('hello there', asked, 'F1')
            self.assertAlmostEqual(engine.calls[-1]['speed'], want, places=6, msg=str(asked))
        self.assertEqual(engine.calls[-1]['steps'], 3)

    def test_the_engine_is_built_from_the_folder_and_threads_given_and_returns_float32_at_its_rate(self):
        b, made = backend(threads=5, instances=2)
        self.assertEqual([(d, t) for d, t, _ in made], [('/models/st', 5), ('/models/st', 5)])
        samples = b.synthesize('hello there', 1.0, 'F2')
        self.assertEqual(samples.dtype, np.float32)
        self.assertEqual(samples.shape, (4410,))
        self.assertEqual(b.sample_rate, 44100)
        self.assertEqual(made[0][2].calls[-1]['style'], ('style', 'F2'))

    def test_a_style_the_folder_lacks_is_not_a_voice(self):
        b, _ = backend(instances=1)
        with self.assertRaises(ValueError):
            b.synthesize('hello', 1.0, 'M5')

    def test_a_folder_without_F1_stops_the_start(self):
        with self.assertRaises(RuntimeError):
            SupertonicBackend('/m', engine_factory=lambda d, t: FakeEngine(styles=('M1',)), instances=1)

    def test_what_the_lab_text_cleaner_lets_through_but_the_engine_cannot_say_is_put_into_words(self):
        b, made = backend(instances=1)
        said = lambda text: (b.synthesize(text, 1.0, 'F1'), made[0][2].calls[-1]['text'])[1]
        self.assertEqual(said('if x = 5 then'), 'if x  equals  5 then')
        self.assertEqual(said('a < b and b > c'), 'a  less than  b and b  greater than  c')
        self.assertEqual(said('voilà'), 'voila')                 # a grave accent: the engine has the acute only
        self.assertEqual(said('Æsir and Straße'), 'AEsir and Strasse')
        self.assertEqual(said('naïve café'), 'naïve café')   # supported: untouched
        self.assertEqual(said('a ~ b {c}'), 'a   b  c ')

    def test_text_that_stays_unsayable_is_refused_without_its_characters(self):
        b, made = backend(instances=1)
        for text in ('世界', 'hello 世', '~~~', '{ }'):
            with self.assertRaises(UnsupportedText, msg=text) as cm:
                b.synthesize(text, 1.0, 'F1')
            self.assertEqual(cm.exception.args, ())
        self.assertEqual(made[0][2].calls, [])                          # the engine was never asked

    def test_the_engines_own_refusal_is_not_passed_on(self):
        b, _ = backend(instances=1)
        with self.assertRaises(UnsupportedText) as cm:
            b.synthesize('please RAISE now', 1.0, 'F1')
        self.assertEqual(cm.exception.args, ())
        self.assertIsNone(cm.exception.__cause__)
        self.assertTrue(cm.exception.__suppress_context__)
        self.assertNotIn('RAISE', repr(cm.exception))

    def test_two_threads_never_share_an_engine(self):
        barrier = threading.Barrier(2, timeout=5)
        made = []

        def factory(model_dir, threads):
            e = FakeEngine(gate=barrier.wait)
            made.append(e)
            return e

        b = SupertonicBackend('/m', engine_factory=factory, instances=2)
        out = []
        threads = [threading.Thread(target=lambda: out.append(b.synthesize('hello there', 1.0, 'F1'))) for _ in range(2)]
        [t.start() for t in threads]
        [t.join(10) for t in threads]
        self.assertEqual(len(out), 2)
        self.assertEqual([len(e.calls) for e in made], [1, 1])           # both were inside synthesize at once (the barrier), each in its own engine

    def test_the_real_engine_is_never_allowed_to_download(self):
        try:
            import supertonic  # noqa: F401
        except ImportError:
            self.skipTest('the supertonic package is not installed')
        with mock.patch('supertonic.TTS') as tts:
            tts.return_value = FakeEngine()
            SupertonicBackend('/m/st', threads=3, instances=1)
        tts.assert_called_once_with(model_dir='/m/st', auto_download=False, intra_op_num_threads=3)


if __name__ == '__main__':
    unittest.main()
