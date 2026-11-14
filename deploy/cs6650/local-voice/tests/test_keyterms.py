"""The key-term layer: the frozen rules (spoken_forms.py), the format-preserving replacement, and the files that must not drift."""
import json
import os
import random
import unittest
import warnings

from tests.helpers import REPO, ROOT
from localvoice.keyterms import KeytermLayer, clean_terms, layer_for, load_keyterms
from localvoice.spoken_forms import apply_layer, read_keyterms, spoken_forms, variants_map, words_of

SETTINGS = os.path.join(REPO, 'src', 'voice', 'settings.ts')
EVAL_COPY = os.path.join(REPO, 'eval', 'voice-local', 'spoken_forms.py')
RECOGNITION2 = os.path.join(REPO, 'eval', 'voice-lab', 'recognition2.json')

TERMS = load_keyterms(os.path.join(ROOT, 'keyterms.json'))


class FilesTests(unittest.TestCase):
    @unittest.skipUnless(os.path.isfile(SETTINGS), 'src/voice/settings.ts is not next to this folder (a Docker build context)')
    def test_keyterms_json_is_what_settings_ts_says(self):
        with open(os.path.join(ROOT, 'keyterms.json'), encoding='utf-8') as f:
            have = json.load(f)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', ResourceWarning)      # read_keyterms (a verbatim copy) leaves its file to the garbage collector
            want = read_keyterms(SETTINGS)
        self.assertEqual(have, want, 'keyterms.json is out of date: run regenerate_keyterms.py')

    @unittest.skipUnless(os.path.isfile(EVAL_COPY), 'eval/voice-local/spoken_forms.py is not next to this folder')
    def test_spoken_forms_is_a_verbatim_copy_of_the_frozen_rules(self):
        with open(EVAL_COPY, 'rb') as a, open(os.path.join(ROOT, 'localvoice', 'spoken_forms.py'), 'rb') as b:
            self.assertEqual(a.read(), b.read(), 'localvoice/spoken_forms.py differs from eval/voice-local/spoken_forms.py (amendment A13a froze those rules)')


class LayerTests(unittest.TestCase):
    layer = KeytermLayer(tuple(TERMS))

    def test_course_words_written_in_pieces_come_back_as_the_terms(self):
        cases = {
            'we read the map reduce paper': 'we read the MapReduce paper',
            'run it on ec two': 'run it on EC2',
            'a wait group counts goroutines': 'a WaitGroup counts goroutines',
            'it is the c a p theorem': 'it is the CAP theorem',
            'it is the cap theorem': 'it is the cap theorem',      # the model's own words are already the term's words: left alone (the frozen rules add nothing)
            'messages go to s q s': 'messages go to SQS',
            'use a load balancer': 'use a load balancer',
            'dynamo db and kafka': 'DynamoDB and kafka',      # a plain word is not re-cased (the model writes "Kafka" itself)
            'g r p c is fast': 'gRPC is fast',
        }
        for raw, want in cases.items():
            self.assertEqual(self.layer.apply(raw), want, raw)

    def test_case_and_punctuation_stay(self):
        for text in ('Can you explain what a mutex is?', 'Well, that depends.', 'Raft, Paxos... and then?', 'Mm-hmm; "quoted" - dash', ''):
            self.assertEqual(self.layer.apply(text), text)
        self.assertEqual(self.layer.apply('Map reduce, then Wait group!'), 'MapReduce, then WaitGroup!')
        self.assertEqual(self.layer.apply('Is it ec two?'), 'Is it EC2?')
        self.assertEqual(self.layer.apply('I like (map reduce).'), 'I like (MapReduce).')

    def test_a_plain_lower_case_term_takes_the_capital_of_the_words_it_replaces(self):
        self.assertEqual(self.layer.apply('Consistenthashing is neat'), 'Consistent hashing is neat')
        self.assertEqual(self.layer.apply('consistenthashing is neat'), 'consistent hashing is neat')
        self.assertEqual(self.layer.apply('Map reduce first'), 'MapReduce first')           # a mixed-case term is left as written

    def test_the_words_are_those_of_the_frozen_layer_on_many_sentences(self):
        """Nobody tunes the replacement: wherever `apply_layer` (lower case words, A13a) puts a term, so does this one."""
        mapping = variants_map(TERMS)
        rng = random.Random(7)
        sentences = []
        if os.path.isfile(RECOGNITION2):
            with open(RECOGNITION2, encoding='utf-8-sig') as f:
                sentences = [s['text'] for s in json.load(f)['recognition']]
        sentences += ['What is a mutex?', 'Tell me about consistent hashing and the cap theorem.', 'I use ec two, s q s, and the load balancer.']
        checked = 0
        for text in sentences:
            variants = [text]
            for term in TERMS:
                for words in spoken_forms(term):
                    spoken = ' '.join(words)
                    if term.lower() in text.lower() or len(words) > 1:
                        variants.append(text.replace(term, spoken))
                        variants.append(text.lower().replace(term.lower(), spoken))
            for v in rng.sample(variants, min(len(variants), 12)):
                shouty = ' '.join(w.upper() if rng.random() < 0.2 else w for w in v.split(' '))
                for candidate in (v, shouty, v.replace(' ', ',  ', 1)):
                    self.assertEqual(words_of(self.layer.apply(candidate)), words_of(apply_layer(candidate, mapping)), candidate)
                    checked += 1
        self.assertGreater(checked, 200)

    def test_the_longest_spoken_form_wins(self):
        terms = ['Raft', 'Raft log', 'RaftLog']
        layer = KeytermLayer(tuple(terms))
        for text in ('the raftlog is long', 'the raft log is long', 'the Raft Log is long'):
            self.assertEqual(words_of(layer.apply(text)), words_of(apply_layer(text, variants_map(terms))), text)
        self.assertEqual(layer.apply('the raftlog is long'), 'the Raft log is long')

    def test_no_terms_means_no_change(self):
        layer = KeytermLayer(())
        self.assertFalse(layer)
        self.assertEqual(layer.apply('map reduce'), 'map reduce')

    def test_terms_that_match_nothing_cannot_break_a_sentence(self):
        layer = KeytermLayer(('C++', 'A', 'x', "don't"))
        self.assertEqual(layer.apply("I don't know C++ at all, A or x?"), "I don't know C++ at all, A or x?")


class TermListTests(unittest.TestCase):
    def test_clean_terms(self):
        out = clean_terms(['  Raft  ', 'Raft', 'load   balancer', '', '   ', 7, None, 'x' * 65, '!!!', 'EC2'])
        self.assertEqual(out, ['Raft', 'load balancer', 'EC2'])
        self.assertEqual(len(clean_terms(['t%d' % i for i in range(500)])), 200)

    def test_load_keyterms_wants_a_list_of_strings(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'k.json')
            for bad in ('{"a": 1}', '[1, 2]', 'not json'):
                with open(path, 'w') as f:
                    f.write(bad)
                with self.assertRaises(ValueError):
                    load_keyterms(path)

    def test_extra_terms_of_a_connection_are_merged(self):
        layer = KeytermLayer(tuple(clean_terms([*TERMS, 'OpenTelemetry'])))
        self.assertEqual(layer.apply('we use open telemetry and map reduce'), 'we use OpenTelemetry and MapReduce')
        self.assertEqual(KeytermLayer(tuple(TERMS)).apply('we use open telemetry'), 'we use open telemetry')

    def test_one_layer_per_list(self):
        self.assertIs(layer_for(('A1', 'B1')), layer_for(('A1', 'B1')))
        self.assertIsNot(layer_for(('A1', 'B1')), layer_for(('A1',)))


if __name__ == '__main__':
    unittest.main()
