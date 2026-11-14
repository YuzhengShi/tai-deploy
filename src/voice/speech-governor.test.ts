import { describe, expect, it } from 'vitest';

import { chatSentThisTurn } from './chat-claim.js';
import { LISTENER_FEEDBACK, LISTENER_NUDGE, SpeechGovernor } from './speech-governor.js';

/** The whole answer through the governor, in one piece or as small chunks. */
function said(answer: string, opts: ConstructorParameters<typeof SpeechGovernor>[0] = {}, chunk = 0): { text: string; gov: SpeechGovernor } {
  const gov = new SpeechGovernor(opts, new Set(['query_canvas', 'send_to_chat', 'query_piazza']));
  let text = '';
  if (chunk > 0) for (let i = 0; i < answer.length; i += chunk) text += gov.push(answer.slice(i, i + chunk));
  else text = gov.push(answer);
  text += gov.end();
  return { text, gov };
}

describe('what the governor lets through', () => {
  it('leaves a short answer as it is', () => {
    expect(said('Midterm Mastery Part 2 is due in about an hour.').text).toBe('Midterm Mastery Part 2 is due in about an hour.');
    expect(said('Sure. Which question are you stuck on?').text).toBe('Sure. Which question are you stuck on?');
  });

  it('gives the same answer however the stream is cut into chunks', () => {
    const answer = 'Okay, a Raft server times out and becomes a candidate. It asks the others for votes. Want a diagram of that?';
    const whole = said(answer).text;
    for (const n of [1, 2, 3, 7, 20]) expect(said(answer, {}, n).text).toBe(whole);
  });

  it('lets a short question that closes the answer go past the word limit, and not a long one or a statement', () => {
    const first = 'CS 6650 is about building services in Go that keep working when many machines are involved, starting with a small REST server and working up to caching.';
    expect(said(`${first} Want to start with how one server handles many requests at once?`).text.trim()).toBe(`${first} Want to start with how one server handles many requests at once?`);
    expect(said(`${first} Do you want to begin with how one server handles many requests at once, or would you rather look at replication and consensus first?`).text.trim()).toBe(first);
    expect(said(`${first} That is the whole idea of it and everything else in the course builds on those same few ideas.`).text.trim()).toBe(first);
  });

  it('does not count a short acknowledgment in front of the answer as a sentence of it', () => {
    expect(said('Nice. Right, exactly. Walk me through how the election starts and who can win it?').text.trim()).toBe('Nice. Right, exactly. Walk me through how the election starts and who can win it?');
    expect(said('Okay. Good. Fine. So a candidate asks for votes. Then it wins.').text.trim()).toBe('Okay. Good. Fine. So a candidate asks for votes.'); // two openers; the third short one is a sentence, and one more fits
    expect(said('Yes. A leader needs a majority. It then sends heartbeats. And more.').text.trim()).toBe('Yes. A leader needs a majority. It then sends heartbeats.');
  });

  it('stops after the first question: what the model went on to say after it was never an answer (the owner\'s call)', () => {
    // the answer, "Great, ..." as if the student had replied, a question, a diagram offer, a claim: one completion
    const monologue = 'Okay, a Raft server times out, becomes candidate, asks others for votes, and if most say yes, it becomes leader—clear?Great, what part of that step feels confusing to you?Want to try a quick diagram of the election flow?I put a diagram in the chat, take a look—does this visual help clarify the process?';
    const { text, gov } = said(monologue);
    expect(text).toBe('Okay, a Raft server times out, becomes candidate, asks others for votes, and if most say yes, it becomes leader—clear?');
    expect(gov.dropped).toHaveLength(3);
  });

  it('does not take "Honestly?" for the question that hands the turn over: what follows it is spoken (the owner heard "Honestly?" and had to say yes)', () => {
    expect(said('Honestly? It looks like a lot of ground to cover.').text.trim()).toBe('Honestly? It looks like a lot of ground to cover.');
    expect(said('Right? And that is why consensus is tricky. Want me to quiz you on it?').text.trim()).toBe('Right? And that is why consensus is tricky. Want me to quiz you on it?');
    expect(said('You know what? A leader needs a majority. Which is why ties matter. Does that make sense?').text.trim()).toBe('You know what? A leader needs a majority. Which is why ties matter.');   // still two sentences of the answer, the interjection not counted
    expect(said('Honestly?').text.trim()).toBe('Honestly?');
    // a real question still closes the answer, whatever else was said
    expect(said('Want to start with caching? We could also do Raft.').text.trim()).toBe('Want to start with caching?');
    expect(said('Okay, so what do you think happens next? The leader steps down.').text.trim()).toBe('Okay, so what do you think happens next?');
  });

  it('does not read out an e-mail or a post it was asked to write: what comes before "Subject:" is said, the draft is not (the owner heard "Subject: Final Project Presentation Format Hi Professor Coady,")', () => {
    const draft = "Here's a draft email for Professor Coady: Subject: Final Project Presentation Format Hi Professor Coady, I hope you're doing well. I was reviewing the assignment and have a question. Is there a target length?";
    const out = said(draft, { maxSentences: 5, maxWords: 85 });
    expect(out.text.trim()).toBe("Here's a draft email for Professor Coady.");
    expect(out.gov.dropped.join(' ')).toContain('Subject: Final Project Presentation Format');
    expect(said('Hi Professor Coady, I hope you are well. I have a question.').text.trim()).toBe('');
    expect(said('Sure. Subject: Presentation Format. Hello Professor Coady, thanks.').text.trim()).toBe('Sure.');
    expect(said('The subject of the course is scalability, and that is all.').text.trim()).toBe('The subject of the course is scalability, and that is all.');     // the word itself is no marker
  });

  it('takes a link out of a sentence with the little word in front of it, so that nothing dangles', () => {
    expect(said('The first step is signing in at https://awsacademy.example/login and making sure you are in the right region.').text.trim()).toBe('The first step is signing in and making sure you are in the right region.');
    expect(said('The details are on the course page (https://canvas.example/x), so have a look.').text.trim()).toBe('The details are on the course page, so have a look.');
    expect(said('Open https://canvas.example/z.').text.trim()).toBe('Open.');
    expect(said('The page is https://canvas.example/a?b=1&c=2, and the rest is in the chat.').text.trim()).toBe('The page is, and the rest is in the chat.');
  });

  it('speaks at most two sentences and about forty words', () => {
    const three = 'A leader is chosen by votes. It then sends heartbeats to the followers. If they stop, a new election starts.';
    expect(said(three).text.trim()).toBe('A leader is chosen by votes. It then sends heartbeats to the followers.');
    const long = 'Here is a short one. ' + 'word '.repeat(45).trim() + '.';
    expect(said(long).text.trim()).toBe('Here is a short one.');
    expect(said(long, { maxWords: 100 }).text).toContain('word word');
  });

  it('speaks a first sentence whole, but ends one that never ends', () => {
    const run = 'Raft ' + 'elects a leader by votes and heartbeats '.repeat(12) + 'that is it.';
    const out = said(run).text.trim();
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(41);
    expect(out.endsWith('.')).toBe(true);
    const clause = 'Raft elects a leader when a candidate gets a majority of the votes in a term, ' + 'and then the leader sends heartbeats to every follower so they stay followers '.repeat(2).trim();
    expect(said(clause, { firstSentenceWords: 20 }).text).toMatch(/^Raft elects a leader when a candidate gets a majority of the votes in a term\.\s*$/);
  });

  it('does not take the thinking of the model for speech (the owner\'s call: "We need to call query piazza.")', () => {
    for (const thought of [
      'We need to call query piazza.',
      "We'll try searching Piazza for “Raft slides”.",
      'We already have pages list, but not all.',
      "There's no search.",
      'Now send to chat.',
      "Let's list pages.",
      'Probably no.',
      "Just say can't.",
      'Could search Piazza?',
      'We need to query_canvas with action pages and maybe filter?',
      'I will call query_piazza now.',
      'The user wants the slides.',
      'I think I will send link to Week 7 maybe.',
      'I will call look_at_week to see Canvas.', // the interviewer's look at Canvas, GitHub and Piazza (functions.ts)
      'Now look_at_week.',
      'I will call run_code on their repo.', // the function that runs their Go code (functions.ts, run-code.ts)
      'Okay, run_code.',
      'We should use RUN_CODE here.',
    ]) {
      expect(said(thought).text, thought).toBe('');
    }
    // the answer in front of them is spoken, and the thinking after it is not
    const out = said("I can't open the PDF from here, but I can look for the page. We need to send the PDF? There's no PDF listed. Probably no.");
    expect(out.text.trim()).toBe("I can't open the PDF from here, but I can look for the page.");
  });

  it('does not take what a TA says for thinking', () => {
    expect(said('We need to think about what happens when the leader crashes.').text).toContain('what happens when the leader crashes');
    expect(said("We'll look at your code together.").text).toContain("We'll look at your code together.");
    expect(said("Let's start with leader election.").text).toContain("Let's start with leader election.");
  });

  it('drops what has no words in it, and a sentence said twice', () => {
    expect(said('[]').text).toBe('');
    expect(said('[] No open PRs in those repos either.').text.trim()).toBe('No open PRs in those repos either.');
    expect(said('Nothing is due this week. Nothing is due this week.').text.trim()).toBe('Nothing is due this week.');
  });

  it('is not fooled by an empty "[]" between two sentences, nor by the dots of a link that is still being written', () => {
    // the owner's call: a tool's empty answer repeated between the question and the made-up rest
    const out = said('are you looking for another repository, or should we review a branch?[]No open PRs in those repos either. Let me check the merged ones.');
    expect(out.text.trim()).toBe('are you looking for another repository, or should we review a branch?');
    const link = said('The slides are at https://northeastern.instructure.com/files/4455/download?download_frd=1 and that is all', {}, 3);
    expect(link.text.trim()).toBe('The slides are and that is all');
  });

  it('never reads a link out', () => {
    expect(said('The slides are at https://northeastern.instructure.com/courses/1/files/2/download and the rest is in the module.').text).toBe('The slides are and the rest is in the module.');
    expect(said('Here is the link: https://example.com/a?b=c').text.trim()).toBe('Here is the link.');
    expect(said('https://example.com/only').text).toBe('');
  });

  it('splits sentences the model glued together, and not at an abbreviation or a number', () => {
    expect(said('It is due today.I put it in the chat.', { chatClaimsAllowed: false }).text.trim()).toBe('It is due today.');
    expect(said('Use a mutex, e.g. sync.Mutex, to guard it. Version 1.2 is out. Third sentence here.').text.trim()).toBe('Use a mutex, e.g. sync.Mutex, to guard it. Version 1.2 is out.');
  });

  it('splits sentences the model glued together in lowercase too (it talks in lowercase), and leaves the query string of a link, and code, alone', () => {
    expect(said('you have a 95 on Homework 1a and an 88 on Homework 2.what are you working on right now?').text).toBe('you have a 95 on Homework 1a and an 88 on Homework 2. what are you working on right now?');
    expect(said('a candidate times out, asks peers, majority wins, sends heartbeats.does that help you picture it? and then more.').text.trim()).toBe('a candidate times out, asks peers, majority wins, sends heartbeats. does that help you picture it?');
    expect(said('see https://example.com/a?b=c for it').text).toBe('see for it');
    expect(said('call time.now and os.args to start').text).toBe('call time.now and os.args to start');
  });

  it('keeps a claim that something is in the chat only when something went there', () => {
    const claim = 'The deadline is Friday. I put it in the chat.';
    const without = said(claim, { chatClaimsAllowed: false });
    expect(without.text.trim()).toBe('The deadline is Friday.');
    expect(without.gov.claims).toBe(1);
    const sent = said(claim, { chatClaimsAllowed: true });
    expect(sent.text.trim()).toBe(claim);
    expect(sent.gov.claims).toBe(0);
    // another way to say it
    expect(said("It's in the chat now. Want me to explain it?", { chatClaimsAllowed: false }).text.trim()).toBe('Want me to explain it?');
    // an offer is not a claim
    expect(said("I'll put it in the chat if you want.", { chatClaimsAllowed: false }).text.trim()).toBe("I'll put it in the chat if you want.");
  });
});

describe('the limits of a talk-it-through', () => {
  it('keeps a nudge a nudge: a few words stay, a speech is cut to a few', () => {
    expect(said('Mm-hm. Go on.', LISTENER_NUDGE).text.trim()).toBe('Mm-hm. Go on.');
    expect(said('Right, and then?', LISTENER_NUDGE).text.trim()).toBe('Right, and then?');
    const speech = 'So what you are saying is that the follower waits for a heartbeat, and when none comes it times out and asks everyone else in the cluster for votes.';
    const nudge = said(speech, LISTENER_NUDGE).text.trim();
    expect(nudge.split(/\s+/).length).toBeLessThanOrEqual(14);
    expect(nudge.endsWith('.')).toBe(true);
    // the same speech is what the usual limits let through in one piece
    expect(said(speech).text.trim()).toBe(speech);
    // a second sentence over the words of a nudge is not said
    expect(said('Okay, so the leader sends heartbeats. And the followers wait for them until a timer runs out, then become candidates.', LISTENER_NUDGE).text.trim()).toBe('Okay, so the leader sends heartbeats.');
  });

  it('lets the feedback be a strong thing and a question, or two sentences of wrap-up, and no more', () => {
    const feedback = 'You got the part about randomised timeouts exactly right, which is what stops split votes. What happens if two candidates still tie?';
    expect(said(feedback, LISTENER_FEEDBACK).text.trim()).toBe(feedback);
    expect(said(feedback, LISTENER_NUDGE).text.trim()).not.toBe(feedback);
    const wrapUp = 'The election timer restarts every time a heartbeat arrives. A leader only commits an entry once a majority has it. And one more thing.';
    expect(said(wrapUp, LISTENER_FEEDBACK).text.trim()).toBe(wrapUp);
    const four = 'The timer restarts on every heartbeat. A leader commits once a majority has the entry. A candidate needs votes from most servers. And a fourth thing that is too much.';
    const three = said(four, LISTENER_FEEDBACK).text.trim();
    expect(three).toContain('most servers.');
    expect(three).not.toContain('fourth');
  });

  it('cuts a first sentence at the limit of its mode, not at forty words', () => {
    const run = 'the follower waits for a heartbeat from the leader and when none arrives before its timer runs out it becomes a candidate and asks for votes from everybody';
    const out = said(run, { ...LISTENER_NUDGE }).text.trim();
    expect(out.split(/\s+/).length).toBeLessThanOrEqual(14);
    expect(said(run, {}).text.trim().split(/\s+/).length).toBeGreaterThan(14); // the usual limits would have let it run
  });
});

describe('has something gone to the chat in this turn', () => {
  const note = '[System note, not from the student: you just said something is in the chat, but send_to_chat was never called]';
  it('looks at the function results after the student\'s last words', () => {
    expect(chatSentThisTurn([{ role: 'user', content: 'put it in the chat' }])).toBe(false);
    expect(
      chatSentThisTurn([
        { role: 'user', content: 'put it in the chat' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'a' }] },
        { role: 'tool', content: 'It is in the chat now.' },
      ]),
    ).toBe(true);
    // an earlier turn's send does not count for this one
    expect(
      chatSentThisTurn([
        { role: 'user', content: 'put it in the chat' },
        { role: 'tool', content: 'It is in the chat now.' },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'and what is the deadline?' },
      ]),
    ).toBe(false);
  });

  it('is not fooled by the note this side sends, and lets the model confirm an earlier send when asked', () => {
    expect(
      chatSentThisTurn([
        { role: 'user', content: 'send me the steps' },
        { role: 'user', content: note },
        { role: 'tool', content: 'The diagram is in the chat now.' },
      ]),
    ).toBe(true);
    expect(chatSentThisTurn([{ role: 'user', content: 'send me the steps' }, { role: 'user', content: note }])).toBe(false);
    expect(
      chatSentThisTurn([
        { role: 'user', content: 'put it in the chat' },
        { role: 'tool', content: 'It is in the chat now.' },
        { role: 'assistant', content: 'done' },
        { role: 'user', content: 'did you put it in the chat?' },
      ]),
    ).toBe(true);
    expect(chatSentThisTurn('nonsense')).toBe(false);
  });
});
