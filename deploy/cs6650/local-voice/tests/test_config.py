"""The settings: defaults, overrides, the two names the brief used without the prefix, and refusals that name the variable."""
import unittest

from localvoice.config import Config, ConfigError


class ConfigTests(unittest.TestCase):
    def test_defaults(self):
        c = Config.from_env({})
        self.assertEqual((c.host, c.port), ('127.0.0.1', 18800))
        self.assertEqual(c.tts_backend, 'supertonic')
        self.assertEqual((c.asr_workers, c.asr_threads, c.tts_workers, c.tts_threads, c.max_connections), (3, 4, 3, 2, 4))
        self.assertEqual(c.st_steps, 5)
        self.assertEqual((c.segmenter.seg_pause_ms, c.segmenter.end_pause_ms, c.segmenter.max_utterance_ms), (350, 600, 30000))
        self.assertEqual((c.segmenter.min_speech_ms, c.segmenter.preroll_ms, c.segmenter.interim_ms, c.segmenter.max_segment_ms), (200, 200, 3000, 0))
        self.assertEqual((c.vad.rms_min, c.vad.ratio, c.vad.floor_window_ms), (350.0, 3.0, 2000))
        self.assertEqual((c.idle_commit_ms, c.max_pending_segments, c.stale_silence_ms, c.ws_ping_s, c.ws_ping_timeout_s, c.max_tts_pending), (3000, 6, 200, 20.0, 20.0, 16))
        self.assertEqual(c.silero_model, '')
        self.assertTrue(c.keyterms_file.endswith('keyterms.json'))
        self.assertEqual(c.log_level, 'INFO')

    def test_overrides(self):
        c = Config.from_env({
            'LOCAL_VOICE_HOST': '0.0.0.0', 'LOCAL_VOICE_PORT': '0', 'LOCAL_VOICE_TTS_BACKEND': 'Piper', 'LOCAL_VOICE_ST_STEPS': '2', 'LOCAL_VOICE_ASR_WORKERS': '2',
            'LOCAL_VOICE_TTS_THREADS': '1', 'LOCAL_VOICE_MAX_CONNECTIONS': '9', 'LOCAL_VOICE_SEG_PAUSE_MS': '300', 'LOCAL_VOICE_END_PAUSE_MS': '500',
            'LOCAL_VOICE_MAX_UTTERANCE_MS': '10000', 'LOCAL_VOICE_INTERIM_MS': '0', 'LOCAL_VOICE_MAX_SEGMENT_MS': '6000', 'LOCAL_VOICE_VAD_RMS_MIN': '500.5',
            'LOCAL_VOICE_LOG_LEVEL': 'debug', 'LOCAL_VOICE_SILERO_MODEL': '/m/silero.onnx', 'LOCAL_VOICE_KEYTERMS_FILE': '/k.json'})
        self.assertEqual((c.host, c.port, c.tts_backend, c.st_steps, c.asr_workers, c.tts_threads, c.max_connections), ('0.0.0.0', 0, 'piper', 2, 2, 1, 9))
        self.assertEqual((c.segmenter.seg_pause_ms, c.segmenter.end_pause_ms, c.segmenter.max_utterance_ms, c.segmenter.interim_ms, c.segmenter.max_segment_ms), (300, 500, 10000, 0, 6000))
        self.assertEqual((c.vad.rms_min, c.log_level, c.silero_model, c.keyterms_file), (500.5, 'DEBUG', '/m/silero.onnx', '/k.json'))

    def test_the_two_names_the_brief_used_work_without_the_prefix_and_the_prefixed_name_wins(self):
        c = Config.from_env({'SEG_PAUSE_MS': '320', 'END_PAUSE_MS': '640'})
        self.assertEqual((c.segmenter.seg_pause_ms, c.segmenter.end_pause_ms), (320, 640))
        c = Config.from_env({'SEG_PAUSE_MS': '320', 'LOCAL_VOICE_SEG_PAUSE_MS': '400'})
        self.assertEqual(c.segmenter.seg_pause_ms, 400)

    def test_blank_values_are_ignored(self):
        self.assertEqual(Config.from_env({'LOCAL_VOICE_PORT': '  ', 'LOCAL_VOICE_HOST': ''}).port, 18800)

    def test_a_bad_value_is_refused_and_names_its_variable(self):
        bad = {
            'LOCAL_VOICE_PORT': 'abc', 'LOCAL_VOICE_PORT ': '70000', 'LOCAL_VOICE_TTS_BACKEND': 'nope', 'LOCAL_VOICE_ST_STEPS': '0', 'LOCAL_VOICE_VAD_RMS_MIN': 'nan',
            'LOCAL_VOICE_WS_PING_S': '-1', 'LOCAL_VOICE_MAX_CONNECTIONS': '0', 'LOCAL_VOICE_LOG_LEVEL': 'loud',
        }
        for key, value in bad.items():
            with self.assertRaises(ConfigError, msg=key) as cm:
                Config.from_env({key.strip(): value})
            self.assertIn(key.strip(), str(cm.exception))

    def test_segmentation_settings_out_of_range_or_not_fitting_together_are_refused(self):
        with self.assertRaises(ConfigError) as cm:
            Config.from_env({'LOCAL_VOICE_SEG_PAUSE_MS': '50'})
        self.assertIn('LOCAL_VOICE_SEG_PAUSE_MS', str(cm.exception))
        for env in ({'LOCAL_VOICE_INTERIM_MS': '500'}, {'LOCAL_VOICE_MAX_SEGMENT_MS': '1500', 'LOCAL_VOICE_CUT_WINDOW_MS': '900'}):
            with self.assertRaises(ConfigError, msg=str(env)) as cm:
                Config.from_env(env)
            self.assertIn('segmentation settings', str(cm.exception))


if __name__ == '__main__':
    unittest.main()
