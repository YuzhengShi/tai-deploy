import { describe, expect, it } from 'vitest';

import { spokenText } from './spoken.js';

describe('Nora\'s symbol rules', () => {
  it('says a prime sign after 3 or 5 as "prime", the case that once sent a whole sentence to ElevenLabs', () => {
    expect(spokenText('5′ and 3′')).toBe('5 prime and 3 prime');
    expect(spokenText('Read the 5′ end, then the 3′ end.')).toBe('Read the 5 prime end, then the 3 prime end.');
    expect(spokenText('5 ′ with a space')).toBe('5 prime with a space');
  });

  it('keeps her quirk on purpose: any number that ends in 3 or 5 reads as prime ("15′" is "15 prime")', () => {
    expect(spokenText('15′')).toBe('15 prime');
  });

  it('says other primes as minutes or seconds, and a prime with no number as a word', () => {
    expect(spokenText('incubate 30′ then 10″')).toBe('incubate 30 minutes then 10 seconds');
    expect(spokenText('a′ and b″')).toBe('a prime and b double prime');
    expect(spokenText('7 ″')).toBe('7 seconds');
  });

  it('turns typographic dashes, quotes and the ellipsis into ASCII', () => {
    expect(spokenText('“smart” quotes — and dashes…')).toBe('"smart" quotes - and dashes...');
    expect(spokenText('it’s a ‘test’ – really‑fast')).toBe("it's a 'test' - really-fast");
    expect(spokenText('„low“ quote')).toBe('"low" quote');
  });

  it('turns space variants into a plain space and drops zero-width characters', () => {
    expect(spokenText('a b c d e f')).toBe('a b c d e f');
    expect(spokenText('sy​nc﻿.Mu‌tex‍')).toBe('sync.Mutex');
  });

  it('also drops the other invisible format characters (soft hyphen, bidi marks)', () => {
    expect(spokenText('co­operate ‎left‏')).toBe('cooperate left');
  });
});

describe('what the engine cannot say', () => {
  it('drops emoji and pictographs, however they are joined', () => {
    expect(spokenText('Nice work 👍')).toBe('Nice work');
    expect(spokenText('Nice 🎉 work 👍🏽 team!')).toBe('Nice work team!');
    expect(spokenText('Good 👨‍💻 job')).toBe('Good job');
    expect(spokenText('Ship it 🚀✅')).toBe('Ship it');
    expect(spokenText('From 🇨🇦 with love ❤️')).toBe('From with love');
    expect(spokenText('Press 1️⃣ for yes')).toBe('Press 1 for yes');
  });

  it('puts a space where an emoji sat between two words', () => {
    expect(spokenText('great👍job')).toBe('great job');
  });

  it('drops Chinese characters and keeps the words around them', () => {
    expect(spokenText('The 并发 model')).toBe('The model');
    expect(spokenText('锁')).toBe('');
    expect(spokenText('Use a mutex（互斥锁） here')).toBe('Use a mutex( ) here'); // fullwidth brackets become ASCII ones, the characters between them go
  });

  it('replaces Markdown and code marks, brackets and other symbols with a space', () => {
    expect(spokenText('snake_case and **bold** and `code`')).toBe('snake case and bold and code');
    expect(spokenText('a [link] {x} <y> | z ~ ^ \\ *')).toBe('a link x y z');
    expect(spokenText('3 × 4 → 12 ° ')).toBe('3 4 12');
  });

  it('keeps the punctuation of an ordinary sentence', () => {
    const s = 'Wait, really? Yes! (Say 50% + 2 = 52; cost $4, mail a@b.com #1 & "quote" it\'s 3/4 - ok): done.';
    expect(spokenText(s)).toBe(s);
  });

  it('keeps identifiers, file names and codes the way they are written', () => {
    expect(spokenText('sync.Mutex')).toBe('sync.Mutex');
    expect(spokenText('HW7')).toBe('HW7');
    expect(spokenText('Open main.go and run fmt.Println on v1.9.1 for HW7.')).toBe('Open main.go and run fmt.Println on v1.9.1 for HW7.');
  });

  it('folds the vulgar fractions and the minus sign the way a person would write them', () => {
    expect(spokenText('½ a cup, −5 degrees')).toBe('1/2 a cup, -5 degrees');
  });
});

describe('letters', () => {
  it('keeps the accented letters of Latin-1', () => {
    expect(spokenText('Zoë ate a café croissant, señor Müller, naïve façade, Ångström, Søren, straße')).toBe(
      'Zoë ate a café croissant, señor Müller, naïve façade, Ångström, Søren, straße',
    );
  });

  it('joins decomposed accents, then keeps them', () => {
    expect(spokenText('café')).toBe('café');
  });

  it('folds Latin letters beyond Latin-1 to plain letters, so a name is still said', () => {
    expect(spokenText('Nguyễn Văn')).toBe('Nguyen Van');
    expect(spokenText('Łukasz Đorđe Şahin')).toBe('Lukasz Dorde Sahin');
  });

  it('turns fullwidth letters and ligatures into plain ones', () => {
    expect(spokenText('ＨＷ７ is ﬁne')).toBe('HW7 is fine');
  });

  it('does not take other scripts as letters', () => {
    expect(spokenText('Привет world')).toBe('world');
    expect(spokenText('αβγ λ=3')).toBe('=3');
  });

  it('keeps ASCII digits only', () => {
    expect(spokenText('room 1524 or ٣')).toBe('room 1524 or');
  });
});

describe('the result', () => {
  it('collapses whitespace of every kind and trims', () => {
    expect(spokenText('  a \n\t b\r\n\r\nc   ')).toBe('a b c');
  });

  it('is empty when nothing speakable is left', () => {
    for (const s of ['', '   ', '...', '…', '?!', '( )', '"', '— —', '👍', '🇨🇦', '​', '$%&', '- - -', ',']) {
      expect(spokenText(s), JSON.stringify(s)).toBe('');
    }
  });

  it('is empty for something that is not text', () => {
    expect(spokenText(undefined as unknown as string)).toBe('');
    expect(spokenText(42 as unknown as string)).toBe('');
  });

  it('is idempotent: a clean sentence stays as it is', () => {
    const samples = [
      '5′ and 3′',
      '“smart” quotes — and dashes…',
      'Nguyễn said “use a mutex” 👍 (sync.Mutex) at 5′ for HW7.',
      'ＨＷ７ ½ −5 Привет 并发',
    ];
    for (const s of samples) {
      const once = spokenText(s);
      expect(spokenText(once), s).toBe(once);
    }
  });

  it('never leaves a character outside the engine\'s set, whatever it is given', () => {
    const allowed = /^[A-Za-z0-9À-ÖØ-öø-ÿ.,;:!?'"\-()/%&+=@#$ ]*$/;
    // every BMP code point once, and some astral ones, each inside a word
    let chunk = '';
    for (let cp = 0x20; cp < 0x30000; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      chunk += `a${String.fromCodePoint(cp)}b `;
      if (chunk.length > 4000) {
        expect(spokenText(chunk)).toMatch(allowed);
        chunk = '';
      }
    }
    expect(spokenText(chunk)).toMatch(allowed);
  });
});
