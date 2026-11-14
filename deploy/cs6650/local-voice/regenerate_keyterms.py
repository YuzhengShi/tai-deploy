#!/usr/bin/env python3
"""Regenerates keyterms.json from the live key terms (KEYTERMS in src/voice/settings.ts), read from the file so that nothing is copied by hand.

    python regenerate_keyterms.py [path/to/settings.ts]
"""
import json
import os
import sys

here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, here)
from localvoice.spoken_forms import read_keyterms  # noqa: E402

settings = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, '..', '..', '..', 'src', 'voice', 'settings.ts')
terms = read_keyterms(settings)
with open(os.path.join(here, 'keyterms.json'), 'w', encoding='utf-8', newline='\n') as f:
    json.dump(terms, f, indent=2)
    f.write('\n')
print('keyterms.json: %d terms from %s' % (len(terms), os.path.normpath(settings)))
