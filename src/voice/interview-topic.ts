/**
 * Did the student say what to practice? In the owner's first real call the model started a mock interview on "service discovery" after
 * "let's do a mock interview", a topic it had picked up from its own earlier lines: the student was then asked about something they had not
 * chosen. start_interview now has to be backed by the student's own words (or by their yes to an offer): this is the check.
 */

export interface TranscriptLine {
  role: 'student' | 'tai';
  text: string;
}

const NUMBERS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  first: '1', second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6', seventh: '7', eighth: '8', ninth: '9', tenth: '10',
};
// words that say nothing about WHAT is practiced ("homework" alone matches every homework: its number or its name must)
const FILLER = new Set([
  'the', 'and', 'for', 'about', 'with', 'that', 'this', 'these', 'those', 'from', 'into', 'onto', 'mock', 'interview', 'interviews', 'interviewer',
  'practice', 'practise', 'practicing', 'practising', 'assignment', 'assignments', 'homework', 'hw', 'part', 'question', 'questions', 'topic', 'topics',
  'please', 'let', 'lets', 'want', 'like', 'can', 'could', 'would', 'you', 'your', 'our', 'are', 'was', 'have', 'has', 'not', 'but', 'just', 'okay',
  'yeah', 'sure', 'yes', 'all', 'any', 'some', 'what', 'which', 'how', 'where', 'why', 'when', 'who', 'start', 'begin', 'do', 'doing', 'try', 'go',
]);
const YES = /^\s*(yes|yeah|yep|yup|sure|okay|ok|alright|all right|please|go ahead|sounds good|that works|let'?s do it|do it)\b/i;

/** The words of a text that name something: lower case, number words as digits ("six" is "6", "1a" is also "1"), no filler. */
export function significantWords(text: string): string[] {
  const out: string[] = [];
  for (const chunk of text.toLowerCase().replace(/['’]/g, '').split(/[^a-z0-9]+/)) {
    if (!chunk) continue;
    // "HW3" is "hw" and "3"; "1a" stays whole (and is also "1", below)
    for (const raw of /^\d+[a-z]$/.test(chunk) ? [chunk] : (chunk.match(/\d+|[a-z]+/g) ?? [])) {
      const word = NUMBERS[raw] ?? raw;
      if (FILLER.has(word)) continue;
      if (word.length < 3 && !/^\d/.test(word)) continue;
      out.push(word);
      const lead = /^(\d+)[a-z]$/.exec(word);
      if (lead) out.push(lead[1]);
    }
  }
  return out;
}

/** Do a topic and a name share a word that names something ("homework three" and "Homework 3: Scalability" share "3")? */
export function sharesWord(topic: string, name: string): boolean {
  const wanted = new Set(significantWords(topic));
  return significantWords(name).some((w) => wanted.has(w));
}

/**
 * The assignment of Canvas's list that a topic the student named means: the one with the most words in common with it, and of those
 * the one whose due date is nearest to now (so "the midterm" is this week's, not last month's). Null when no assignment shares a word.
 */
export function pickAssignment(topic: string, assignments: ReadonlyArray<Record<string, unknown>>, now: number): { id: string; name: string } | null {
  const wanted = new Set(significantWords(topic));
  if (wanted.size === 0) return null;
  const homework = /\b(homework|hw)\b/i;
  let best: { id: string; name: string; score: number; gap: number } | null = null;
  for (const a of assignments) {
    if (!a || typeof a !== 'object') continue;
    const id = typeof a.id === 'number' || typeof a.id === 'string' ? String(a.id) : '';
    const name = typeof a.name === 'string' ? a.name : '';
    if (!/^\d{1,15}$/.test(id) || !name) continue;
    const overlap = new Set(significantWords(name).filter((w) => wanted.has(w))).size;
    if (overlap === 0) continue;
    // "homework" says nothing alone, but "the first homework" is not "Midterm Mastery Part 1": the kind breaks a tie by a little
    const score = overlap + (homework.test(topic) && homework.test(name) ? 0.5 : 0);
    const due = typeof a.due_at === 'string' ? Date.parse(a.due_at) : NaN;
    const gap = Number.isFinite(due) ? Math.abs(due - now) : Infinity;
    if (!best || score > best.score || (score === best.score && gap < best.gap)) best = { id, name: name.slice(0, 160), score, gap };
  }
  return best ? { id: best.id, name: best.name } : null;
}

/**
 * True when a word of `topic` is in what the student said in their last few turns, or when TAi's last lines named it and the student's
 * last turn was a yes. False for a topic with nothing in it ("mock interview") or one the student never mentioned.
 */
export function topicEvidenced(topic: string, transcript: readonly TranscriptLine[]): boolean {
  const wanted = new Set(significantWords(topic));
  if (wanted.size === 0) return false;
  const recent = transcript.slice(-12);
  const said = new Set(recent.filter((t) => t.role === 'student').slice(-6).flatMap((t) => significantWords(t.text)));
  if ([...wanted].some((w) => said.has(w))) return true;
  const lastStudent = [...recent].reverse().findIndex((t) => t.role === 'student');
  if (lastStudent === -1) return false;
  const at = recent.length - 1 - lastStudent;
  if (!YES.test(recent[at].text)) return false;
  const offered = new Set(recent.slice(Math.max(0, at - 3), at).filter((t) => t.role === 'tai').flatMap((t) => significantWords(t.text)));
  return [...wanted].some((w) => offered.has(w));
}
