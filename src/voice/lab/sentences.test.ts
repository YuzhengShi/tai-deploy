import { describe, expect, it } from 'vitest';

import { SentenceCutter } from './sentences.js';

/** A seeded generator, so a failing split can be repeated. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** What the cutter returns for these pieces, then `end()`. */
function run(pieces: string[]): string[] {
  const cutter = new SentenceCutter();
  const out: string[] = [];
  for (const piece of pieces) out.push(...cutter.push(piece));
  out.push(...cutter.end());
  return out;
}

const whole = (text: string): string[] => run([text]);
const oneByOne = (text: string): string[] => run(text.split(''));
function randomly(text: string, seed: number, maxPiece = 12): string[] {
  const rand = mulberry32(seed);
  const pieces: string[] = [];
  for (let at = 0; at < text.length; ) {
    const size = 1 + Math.floor(rand() * maxPiece);
    pieces.push(text.slice(at, at + size));
    at += size;
  }
  return pieces;
}

/** Realistic spoken answers, each with the sentences the mouth should get. */
const FIXTURES: Array<{ name: string; text: string; sentences: string[] }> = [
  {
    name: 'plain sentences',
    text: 'A mutex protects shared state. Only one goroutine can hold it at a time. Everyone else waits.',
    sentences: ['A mutex protects shared state.', 'Only one goroutine can hold it at a time.', 'Everyone else waits.'],
  },
  {
    name: 'e.g. and an identifier',
    text: 'Use a lock, e.g. sync.Mutex, when two goroutines write to the same map. That avoids a data race.',
    sentences: ['Use a lock, e.g. sync.Mutex, when two goroutines write to the same map.', 'That avoids a data race.'],
  },
  {
    name: 'vs. and i.e.',
    text: 'Paxos vs. Raft is a classic comparison, i.e. leader election and log replication. Which one do you prefer?',
    sentences: ['Paxos vs. Raft is a classic comparison, i.e. leader election and log replication.', 'Which one do you prefer?'],
  },
  {
    name: 'titles, Fig. and etc.',
    text: 'Dr. Coady said Prof. Smith and Mr. Jones wrote Fig. 3 in the paper. Mrs. Lee and Ms. Park agree, etc. They all do.',
    sentences: ['Dr. Coady said Prof. Smith and Mr. Jones wrote Fig. 3 in the paper.', 'Mrs. Lee and Ms. Park agree, etc. They all do.'],
  },
  {
    name: 'versions, file names and function names',
    text: 'Version 1.2 is out. The v1.9.1 tag fixes it. Run main.go with fmt.Println and check HW7.',
    sentences: ['Version 1.2 is out.', 'The v1.9.1 tag fixes it.', 'Run main.go with fmt.Println and check HW7.'],
  },
  {
    name: 'initials',
    text: 'J. Smith wrote it, and J. R. R. Tolkien read it. The U.S. team agreed.',
    sentences: ['J. Smith wrote it, and J. R. R. Tolkien read it.', 'The U.S. team agreed.'],
  },
  {
    name: 'ellipses',
    text: 'Well... I think the answer is yes. Hmm, wait... that depends on the load. Let me think... Actually no, it does not.',
    sentences: ['Well... I think the answer is yes.', 'Hmm, wait... that depends on the load.', 'Let me think...', 'Actually no, it does not.'],
  },
  {
    name: 'the ellipsis character',
    text: 'It depends… but not much. That depends… Maybe not at all. Then we go.',
    sentences: ['It depends… but not much.', 'That depends… Maybe not at all.', 'Then we go.'],
  },
  {
    name: 'an ellipsis before a quotation',
    text: 'He trailed off... "I do not know."',
    sentences: ['He trailed off...', '"I do not know."'],
  },
  {
    name: '?! runs stay with their sentence',
    text: 'Is it up?! Check it now!! Really?! That works? Yes!! It does!',
    sentences: ['Is it up?!', 'Check it now!!', 'Really?! That works?', 'Yes!! It does!'],
  },
  {
    name: 'closing quotes and brackets',
    text: 'She said "use a lock." Then she left. (It was late.) Nobody argued.',
    sentences: ['She said "use a lock."', 'Then she left.', '(It was late.)', 'Nobody argued.'],
  },
  {
    name: 'closing marks of Markdown emphasis',
    text: '**Note that this is key.** Then we move on.',
    sentences: ['**Note that this is key.**', 'Then we move on.'],
  },
  {
    name: 'short sentences are joined to the next one',
    text: "Okay. Let's begin the demo now. Right. Good.",
    sentences: ["Okay. Let's begin the demo now.", 'Right. Good.'],
  },
  {
    name: 'No. before a number or an answer',
    text: 'Call No. 5 now. No. I mean the other one.',
    sentences: ['Call No. 5 now.', 'No. I mean the other one.'],
  },
  {
    name: 'et al.',
    text: 'Ongaro et al. proposed Raft in 2014. It is easier to teach than Paxos.',
    sentences: ['Ongaro et al. proposed Raft in 2014.', 'It is easier to teach than Paxos.'],
  },
  {
    name: 'approx. and decimals',
    text: 'It takes approx. 3 ms per request. The ratio is 3.14 or about 0.5. Then we scale it.',
    sentences: ['It takes approx. 3 ms per request.', 'The ratio is 3.14 or about 0.5.', 'Then we scale it.'],
  },
  {
    name: 'a domain name with no space after the dot',
    text: 'Visit golang.org for docs. Or see go.dev/doc.',
    sentences: ['Visit golang.org for docs.', 'Or see go.dev/doc.'],
  },
  {
    name: 'line breaks',
    text: 'First point.\nSecond point is longer than that.\n\nThird.',
    sentences: ['First point.\nSecond point is longer than that.', 'Third.'],
  },
  {
    name: 'blank space around',
    text: '  Hello there my friend.   How are you?  ',
    sentences: ['Hello there my friend.', 'How are you?'],
  },
  {
    name: 'a list with no full stops waits for the end',
    text: 'Three things:\n- locks\n- channels\n- atomics',
    sentences: ['Three things:\n- locks\n- channels\n- atomics'],
  },
  {
    name: 'a longer answer',
    text:
      'Great question. A load balancer sits in front of your servers and spreads requests across them. With round robin, each server gets the next request in turn. ' +
      'With least connections, the balancer picks the server that is doing the least work right now. Which one fits HW7? That depends on how long your requests take, ' +
      'e.g. a 5 ms lookup versus a 2 s report. Does that make sense?',
    sentences: [
      'Great question. A load balancer sits in front of your servers and spreads requests across them.',
      'With round robin, each server gets the next request in turn.',
      'With least connections, the balancer picks the server that is doing the least work right now.',
      'Which one fits HW7?',
      'That depends on how long your requests take, e.g. a 5 ms lookup versus a 2 s report.',
      'Does that make sense?',
    ],
  },
];

describe('SentenceCutter: where it cuts', () => {
  for (const f of FIXTURES) {
    it(`${f.name}`, () => {
      expect(whole(f.text)).toEqual(f.sentences);
    });
  }
});

describe('SentenceCutter: the same sentences however the text arrives', () => {
  for (const f of FIXTURES) {
    it(`${f.name}: a character at a time, and in random pieces`, () => {
      expect(oneByOne(f.text)).toEqual(f.sentences);
      for (let seed = 1; seed <= 25; seed++) expect(run(randomly(f.text, seed, 1 + (seed % 17))), `seed ${seed}`).toEqual(f.sentences);
    });
  }

  it('gives the same sentences for all of them joined into one long answer', () => {
    const text = FIXTURES.map((f) => f.text.trim()).join(' ');
    const expected = whole(text);
    expect(expected.length).toBeGreaterThan(30);
    expect(oneByOne(text)).toEqual(expected);
    for (let seed = 100; seed < 140; seed++) expect(run(randomly(text, seed, 1 + (seed % 40))), `seed ${seed}`).toEqual(expected);
  });

  it('returns each sentence as soon as the space after it has arrived, not before', () => {
    const c = new SentenceCutter();
    expect(c.push('Hello there my friend')).toEqual([]);
    expect(c.push('.')).toEqual([]);
    expect(c.push(' How')).toEqual(['Hello there my friend.']);
    expect(c.push(' are you?')).toEqual([]);
    expect(c.push(' ')).toEqual(['How are you?']);
    expect(c.end()).toEqual([]);
  });

  it('keeps a terminator that may still grow ("..", "?!") until it has seen what follows', () => {
    const c = new SentenceCutter();
    expect(c.push('Is the server really up?')).toEqual([]);
    expect(c.push('!')).toEqual([]);
    expect(c.push(' Check it')).toEqual(['Is the server really up?!']);
    expect(c.end()).toEqual(['Check it']);
  });

  it('waits to see whether a digit follows "No." and whether a capital follows an ellipsis', () => {
    const c = new SentenceCutter();
    expect(c.push('Please call us at No. ')).toEqual([]);
    expect(c.push('5 now. ')).toEqual(['Please call us at No. 5 now.']);
    expect(c.push('I was thinking about it for a while... ')).toEqual([]);
    expect(c.push('Then')).toEqual(['I was thinking about it for a while...']);
    expect(c.end()).toEqual(['Then']);

    const d = new SentenceCutter();
    expect(d.push('I was thinking about it for a while... ')).toEqual([]);
    expect(d.push('then we went on. ')).toEqual(['I was thinking about it for a while... then we went on.']);
  });

  it('waits across any amount of white space for the character that decides', () => {
    const c = new SentenceCutter();
    expect(c.push('I was thinking about it for a while...')).toEqual([]);
    expect(c.push('   \n  ')).toEqual([]);
    expect(c.push('Then it came to me.  ')).toEqual(['I was thinking about it for a while...', 'Then it came to me.']);
  });
});

describe('SentenceCutter: the end of the stream', () => {
  it('returns what is left as one last sentence', () => {
    expect(run(['Hello there my friend.'])).toEqual(['Hello there my friend.']);
    expect(run(['One two three. Four five six'])).toEqual(['One two three.', 'Four five six']);
  });

  it('returns a short sentence alone when nothing follows it', () => {
    const c = new SentenceCutter();
    expect(c.push('Right. ')).toEqual([]);
    expect(c.end()).toEqual(['Right.']);
    expect(run(['Okay.'])).toEqual(['Okay.']);
  });

  it('joins a held short sentence to the unfinished text after it', () => {
    expect(run(["Okay. Let's go"])).toEqual(["Okay. Let's go"]);
    expect(run(['Okay. Right. Fine'])).toEqual(['Okay. Right. Fine']);
    expect(run(['Okay. Right. '])).toEqual(['Okay. Right.']);
  });

  it('returns nothing for white space, or for marks with no letter or digit in them', () => {
    expect(run([''])).toEqual([]);
    expect(run(['   \n '])).toEqual([]);
    expect(run(['...'])).toEqual([]);
    expect(run(['?!'])).toEqual([]);
    expect(run(['"..." ?!'])).toEqual([]);
  });

  it('returns a leftover of digits', () => {
    expect(run(['42'])).toEqual(['42']);
  });

  it('resolves a decision that was waiting for more text as if nothing more will come', () => {
    expect(run(['Yes indeed it is... '])).toEqual(['Yes indeed it is...']);
    expect(run(['Please call us at No. '])).toEqual(['Please call us at No.']);
  });

  it('is ready for a new stream afterwards', () => {
    const c = new SentenceCutter();
    c.push('Left over from the first stream');
    expect(c.end()).toEqual(['Left over from the first stream']);
    expect(c.push('A fresh start for this one. ')).toEqual(['A fresh start for this one.']);
    expect(c.end()).toEqual([]);
  });

  it('ignores an empty piece', () => {
    const c = new SentenceCutter();
    expect(c.push('')).toEqual([]);
    expect(c.end()).toEqual([]);
  });
});

describe('SentenceCutter: what it does not cut', () => {
  const cases: Array<[string, string]> = [
    ['an abbreviation', 'Ask Dr. Who about it later today'],
    ['e.g.', 'Pick one, e.g. a mutex or a channel, and explain it'],
    ['i.e.', 'It is stateless, i.e. any server can answer it'],
    ['etc.', 'Locks, queues, etc. all have a cost'],
    ['vs.', 'Throughput vs. latency is the trade'],
    ['Prof.', 'Ask Prof. Coady about the paper'],
    ['Fig.', 'See Fig. 4 for the whole picture here'],
    ['approx.', 'That is approx. ten milliseconds each'],
    ['a capital initial', 'It was written by J. Smith in the spring'],
    ['a decimal', 'The p99 is 1.2 seconds on this box'],
    ['a version', 'Pin it to v1.9.1 until the fix lands'],
    ['a file name', 'Open main.go and read the handler'],
    ['a qualified name', 'Call sync.Mutex.Lock before you touch the map'],
    ['a function call', 'Print it with fmt.Println and see'],
    ['an ellipsis that goes on in lower case', 'I think... maybe not, but we can try it'],
    ['an ellipsis character that goes on in lower case', 'I think… maybe not, but we can try it'],
    ['No. before a digit', 'Read chapter No. 7 before the quiz'],
  ];
  for (const [name, text] of cases) {
    it(`inside ${name}`, () => {
      const out = run([`${text}. `]);
      expect(out).toEqual([`${text}.`]);
      expect(run(randomly(`${text}. `, 5, 4))).toEqual(out);
    });
  }
});
