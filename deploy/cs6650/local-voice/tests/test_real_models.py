"""The service with the REAL models: Parakeet for the ears, Supertonic (and Piper) for the mouth. Skipped, test by test, when a model folder or the audio is not found.

Where things are looked for (the development PC's places are the defaults; set these in the environment elsewhere):
  LOCAL_VOICE_TEST_ASR_DIR     the Parakeet folder          D:\\tai-voice-local\\models\\parakeet-tdt-0.6b-v2-int8
  LOCAL_VOICE_TEST_ST_DIR      the Supertonic folder        D:\\tai-voice-local\\supertonic\\v1
  LOCAL_VOICE_TEST_PIPER_DIR   the Piper folder             D:\\tai-voice-local\\tts\\vits-piper-en_US-lessac-medium
  LOCAL_VOICE_TEST_AUDIO       a folder of 16 kHz mono 16-bit WAVs with a manifest.json ("voice|text" -> file name), the clips of the second recognition set
  LOCAL_VOICE_TEST_SET         the sentences those clips say (default eval/voice-lab/recognition2.json of the repository)
The clips are synthetic voices (Windows' David and Zira), not people.
"""
import json
import os
import sys
import time
import unittest
import wave
from dataclasses import replace

import numpy as np

from tests.helpers import REPO, ROOT, RunningServer, StubRecognizer, collect, finals, make_config, make_services, raw_request, send_audio, silence, transcript, tts_request, ws_connect
from localvoice.services import build_services
from localvoice.spoken_forms import words_of
from localvoice.tts import PiperBackend, resample

ASR_DIR = os.environ.get('LOCAL_VOICE_TEST_ASR_DIR', r'D:\tai-voice-local\models\parakeet-tdt-0.6b-v2-int8')
ST_DIR = os.environ.get('LOCAL_VOICE_TEST_ST_DIR', r'D:\tai-voice-local\supertonic\v1')
PIPER_DIR = os.environ.get('LOCAL_VOICE_TEST_PIPER_DIR', r'D:\tai-voice-local\tts\vits-piper-en_US-lessac-medium')
AUDIO_DIR = os.environ.get('LOCAL_VOICE_TEST_AUDIO', r'D:\tai-voice-local\audio-r2')
SET_FILE = os.environ.get('LOCAL_VOICE_TEST_SET', os.path.join(REPO, 'eval', 'voice-lab', 'recognition2.json'))

HAVE_ASR = os.path.isfile(os.path.join(ASR_DIR, 'encoder.int8.onnx'))
HAVE_ST = os.path.isfile(os.path.join(ST_DIR, 'onnx', 'vector_estimator.onnx'))
HAVE_PIPER = os.path.isfile(os.path.join(PIPER_DIR, 'en_US-lessac-medium.onnx'))
HAVE_AUDIO = os.path.isfile(os.path.join(AUDIO_DIR, 'manifest.json')) and os.path.isfile(SET_FILE)

SENTENCES = [
    "Sure, let's start with what you already know about leader election.",
    "Walk me through what your goroutine does when the channel is full.",
    "In Raft, the leader sends heartbeats to the followers, and if a follower stops hearing them, it starts a new election after a random timeout.",
]


def edit_distance(ref, hyp):
    prev = list(range(len(hyp) + 1))
    for i in range(1, len(ref) + 1):
        cur = [i]
        for j in range(1, len(hyp) + 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (0 if ref[i - 1] == hyp[j - 1] else 1)))
        prev = cur
    return prev[len(hyp)]


def wer(reference, hypothesis):
    ref, hyp = words_of(reference), words_of(hypothesis)
    return edit_distance(ref, hyp) / len(ref)


def read_wav(path):
    with wave.open(path) as w:
        assert (w.getnchannels(), w.getsampwidth(), w.getframerate()) == (1, 2, 16000)
        return w.readframes(w.getnframes())


def clips(n=2):
    """The first sentence of the second set, in each of the two voices: [(sentence, pcm)]."""
    with open(os.path.join(AUDIO_DIR, 'manifest.json'), encoding='utf-8-sig') as f:
        manifest = json.load(f)
    with open(SET_FILE, encoding='utf-8-sig') as f:
        data = json.load(f)
    out = []
    for voice in data['voices'][:n]:
        sentence = data['recognition'][0]['text']
        out.append((sentence, read_wav(os.path.join(AUDIO_DIR, manifest['%s|%s' % (voice, sentence)]))))
    return out


def recognize(port, pcm):
    """The final text of one utterance streamed as fast as the socket takes it, with 1.5 s of silence after it."""
    with ws_connect(port) as ws:
        send_audio(ws, pcm + silence(1.5))
        msgs = collect(ws, lambda m: any(x.get('type') == 'UtteranceEnd' for x in m), timeout=30)
    done = finals(msgs)
    return ' '.join(transcript(m) for m in done)


def audio_seconds(resp):
    return len(resp.body) / 2 / 24000.0


@unittest.skipUnless(HAVE_ASR and HAVE_ST, 'the Parakeet and Supertonic folders were not found (see the top of this file)')
class RealServiceTests(unittest.TestCase):
    """Both real engines in ONE process, as in production (two ONNX Runtimes, sherpa-onnx's own and the pip package's, side by side)."""

    @classmethod
    def setUpClass(cls):
        cls.cfg = make_config(asr_model_dir=ASR_DIR, st_model_dir=ST_DIR, tts_backend='supertonic', tts_workers=2, asr_workers=2)
        cls.services = build_services(cls.cfg)
        cls.srv = RunningServer(cls.services, cls.cfg)
        cls.srv.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.srv.__exit__(None, None, None)

    @unittest.skipUnless(HAVE_AUDIO, 'the audio of the second recognition set was not found (LOCAL_VOICE_TEST_AUDIO)')
    def test_two_clips_of_the_second_set_are_recognized_with_a_word_error_rate_under_15_percent(self):
        for sentence, pcm in clips(2):
            text = recognize(self.srv.port, pcm)
            self.assertLess(wer(sentence, text), 0.15, (sentence, text))
            self.assertRegex(text, r'[.,?]', 'the model\'s own punctuation should reach the client')

    def test_the_service_hears_its_own_voice(self):
        """Round trip: what /tts says is what /v1/listen hears (24 kHz down to 16 kHz in between)."""
        for sentence in SENTENCES[:2]:
            speech = tts_request(self.srv.port, sentence, 'F1')
            self.assertEqual(speech.status, 200)
            pcm16 = (np.clip(resample(np.frombuffer(speech.body, dtype='<i2').astype(np.float32) / 32768.0, 24000, 16000), -1, 1) * 32767).astype('<i2').tobytes()
            text = recognize(self.srv.port, pcm16)
            self.assertLess(wer(sentence, text), 0.2, (sentence, text))

    def test_supertonic_speaks_at_a_natural_pace_and_F1_is_the_default_voice(self):
        lengths = {}
        for sentence in SENTENCES:
            words = len(sentence.split())
            for voice in ('F1', 'default', 'af_bella', 'af_heart'):
                resp = tts_request(self.srv.port, sentence, voice)
                self.assertEqual(resp.status, 200, voice)
                lengths[(sentence, voice)] = audio_seconds(resp)
            seconds = lengths[(sentence, 'F1')]
            self.assertTrue(2.5 <= words / seconds <= 4.0, '%d words in %.2f s is %.2f words a second' % (words, seconds, words / seconds))
            for voice in ('default', 'af_bella', 'af_heart'):
                self.assertAlmostEqual(lengths[(sentence, voice)], seconds, delta=0.05 * seconds, msg=voice)
        resp = tts_request(self.srv.port, SENTENCES[1], 'default')
        x = np.frombuffer(resp.body, dtype='<i2').astype(np.float64)
        self.assertGreater(float(np.sqrt(np.mean(x ** 2))), 500)                  # it is sound, not silence
        self.assertEqual(len(resp.body) % 2, 0)
        self.assertNotIn('x-tts-fallback', resp.headers)
        self.assertEqual(resp.headers['content-type'], 'application/octet-stream')
        self.assertEqual(len(resp.chunks) >= 3, True)

    def test_a_male_style_is_a_different_voice_of_similar_length(self):
        f1 = audio_seconds(tts_request(self.srv.port, SENTENCES[1], 'F1'))
        m1 = audio_seconds(tts_request(self.srv.port, SENTENCES[1], 'M1'))
        self.assertAlmostEqual(m1, f1, delta=0.2 * f1)

    def test_speed_is_a_multiplier_on_the_natural_pace(self):
        base = audio_seconds(tts_request(self.srv.port, SENTENCES[0], 'F1'))
        slow = audio_seconds(tts_request(self.srv.port, SENTENCES[0], 'F1', speed=0.75))
        fast = audio_seconds(tts_request(self.srv.port, SENTENCES[0], 'F1', speed=1.5))
        self.assertGreater(slow, base * 1.15)
        self.assertLess(fast, base * 0.85)
        self.assertLess(fast, slow * 0.7)

    def test_text_the_lab_cleaner_passes_is_said_and_text_the_engine_cannot_say_is_refused(self):
        for text in ('if x = 5 then stop', 'voil\u00e0, Z\u00fcrich and \u00c6sir', 'Smile \U0001f600 please', 'It costs $5 & 10% more @ noon.', 'c++ or go? (maybe) 3/4; ok!'):
            self.assertEqual(tts_request(self.srv.port, text, 'F1').status, 200, text)
        for text in ('\u4e16\u754c', 'hello \u4e16\u754c', '~~~', '{ } ^'):
            resp = tts_request(self.srv.port, text, 'F1')
            self.assertEqual(resp.status, 400, text)
            self.assertNotIn(text.encode('utf-8'), resp.body)
        self.assertEqual(tts_request(self.srv.port, 'still fine after that', 'F1').status, 200)

    def test_three_things_at_once_give_the_answers_they_give_alone(self):
        import threading
        alone = recognize(self.srv.port, clips(1)[0][1]) if HAVE_AUDIO else None
        results, errors = {}, []

        def listen(k, pcm):
            try:
                results[k] = recognize(self.srv.port, pcm)
            except Exception as exc:        # noqa: BLE001
                errors.append(exc)

        def speak():
            results['tts'] = tts_request(self.srv.port, SENTENCES[2], 'F1').status

        threads = []
        if HAVE_AUDIO:
            pcm = clips(1)[0][1]
            threads += [threading.Thread(target=listen, args=(i, pcm)) for i in range(2)]
        threads.append(threading.Thread(target=speak))
        t0 = time.perf_counter()
        [t.start() for t in threads]
        [t.join(60) for t in threads]
        self.assertEqual(errors, [])
        self.assertEqual(results['tts'], 200)
        if HAVE_AUDIO:
            self.assertEqual([results[0], results[1]], [alone, alone])
        self.assertLess(time.perf_counter() - t0, 30)


@unittest.skipUnless(HAVE_PIPER, 'the Piper folder was not found (see the top of this file)')
class RealPiperTests(unittest.TestCase):
    """The optional backend (Piper through sherpa-onnx), with a stand-in recognizer: only the mouth is real here."""

    @classmethod
    def setUpClass(cls):
        tts = PiperBackend(PIPER_DIR, threads=2, instances=1)
        tts.warm_up()
        cls.srv = RunningServer(make_services(StubRecognizer(), tts, tts_workers=1), make_config(tts_workers=1))
        cls.srv.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.srv.__exit__(None, None, None)

    def test_piper_speaks_its_three_voice_names_and_not_the_supertonic_ones(self):
        for voice in ('default', 'af_bella', 'lessac'):
            resp = tts_request(self.srv.port, SENTENCES[1], voice)
            self.assertEqual(resp.status, 200, voice)
            words = len(SENTENCES[1].split())
            self.assertTrue(2.5 <= words / audio_seconds(resp) <= 5.0, voice)
            self.assertNotIn('x-tts-fallback', resp.headers)
        self.assertEqual(tts_request(self.srv.port, SENTENCES[1], 'F1').status, 400)

    def test_speed_works_on_piper_too(self):
        slow = audio_seconds(tts_request(self.srv.port, SENTENCES[1], 'default', speed=0.7))
        fast = audio_seconds(tts_request(self.srv.port, SENTENCES[1], 'default', speed=1.6))
        self.assertLess(fast, slow * 0.8)                                  # a loose bound: the voice's own duration varies by about 6 % from run to run


if __name__ == '__main__':
    unittest.main()
