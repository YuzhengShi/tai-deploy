/**
 * A second reader for what counts cannot see: whether a sharp, friendly human TA would have said it. The model scores a sample of
 * exchanges (student words, TA reply) against a short rubric and names what gives the reply away. A rough instrument (a model grading a
 * model, 1-5): good for a trend and for the list of tells, not for a verdict on one reply.
 */
export interface JudgePair {
  kind: 'text' | 'voice';
  student: string;
  reply: string;
}

export interface JudgeScore {
  kind: 'text' | 'voice';
  /** 1-5: sounds like a person, not an assistant. */
  human: number;
  /** 1-5: as short as the question deserved. */
  brief: number;
  /** 1-5: claims nothing it could not know; says so when it cannot do something. */
  honest: number;
  tells: string[];
}

const RUBRIC =
  'You grade the replies of a teaching assistant for a university course on distributed systems. For each numbered exchange (what the ' +
  'student said, what the TA answered) judge whether a sharp, friendly human TA, texting or talking, would have said it. Score 1-5 each: ' +
  '"human" (sounds like a person, not an assistant), "brief" (as short as the question deserved), "honest" (claims nothing it could not ' +
  'know, says so when it cannot do something). "tells": up to three short phrases (2-5 words) that give the bot away, such as "closing ' +
  'offer", "bullet list", "restates the question", "lecture for a short question"; an empty list when there are none. Answer with only a ' +
  'JSON array with one object per exchange, in order: [{"human":4,"brief":5,"honest":5,"tells":[]}]';

const clip = (s: string, max = 700) => (s.length > max ? s.slice(0, max) + ' ...' : s);

export function judgePrompt(pairs: JudgePair[]): string {
  const body = pairs
    .map((p, i) => `#${i + 1} (${p.kind === 'voice' ? 'spoken aloud' : 'typed in a chat'})\nStudent: ${clip(p.student)}\nTA: ${clip(p.reply)}`)
    .join('\n\n');
  return `${RUBRIC}\n\n${body}`;
}

const clamp5 = (x: unknown) => {
  const n = Math.round(Number(x));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 3;
};

/** The model's answer as scores, or null when it is not an array of exactly `n` objects. */
export function parseJudge(text: string, n: number): Array<Omit<JudgeScore, 'kind'>> | null {
  const m = /\[[\s\S]*\]/.exec(text);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr) || arr.length !== n) return null;
    return arr.map((x) => ({
      human: clamp5(x?.human),
      brief: clamp5(x?.brief),
      honest: clamp5(x?.honest),
      tells: Array.isArray(x?.tells) ? x.tells.map(String).slice(0, 3) : [],
    }));
  } catch {
    return null;
  }
}

export interface JudgeConfig {
  /** The gateway: its /v1/chat/completions. */
  url: string;
  key: string;
  model: string;
  fetchImpl?: typeof fetch;
}

/** Scores the pairs in batches; a batch the model did not answer in the asked shape is left out rather than guessed. */
export async function judge(pairs: JudgePair[], cfg: JudgeConfig, batch = 8): Promise<JudgeScore[]> {
  const out: JudgeScore[] = [];
  const doFetch = cfg.fetchImpl ?? fetch;
  for (let i = 0; i < pairs.length; i += batch) {
    const chunk = pairs.slice(i, i + batch);
    try {
      const res = await doFetch(`${cfg.url.replace(/\/$/, '')}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
        body: JSON.stringify({ model: cfg.model, temperature: 0, max_tokens: 1200, messages: [{ role: 'user', content: judgePrompt(chunk) }] }),
      });
      if (!res.ok) continue;
      const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const parsed = parseJudge(String(j.choices?.[0]?.message?.content ?? ''), chunk.length);
      if (parsed) parsed.forEach((s, k) => out.push({ kind: chunk[k].kind, ...s }));
    } catch {
      /* the gateway being away is not the report's problem */
    }
  }
  return out;
}
