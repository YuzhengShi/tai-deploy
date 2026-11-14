import { getDb } from './db.js';
import { REPO_NAME, WORK_CAPS, WORK_CATEGORIES, WORK_NOTE, boundWorkText, isWorkCategory, isWorkKey, pickWork, workFactOf } from './work-facts.js';
import type { StoredWorkFact, WorkFact } from './work-facts.js';

export interface MemoryFact {
  text: string;
  category?: string;
  entity?: string;
  key?: string;
  value?: string;
}

type DecayClass = 'permanent' | 'stable' | 'active' | 'session' | 'checkpoint';

const DECAY_TTL_MS: Record<DecayClass, number | null> = {
  permanent: null,
  stable:     90 * 24 * 60 * 60 * 1000,
  active:     14 * 24 * 60 * 60 * 1000,
  session:     1 * 24 * 60 * 60 * 1000,
  checkpoint:  4 * 60 * 60 * 1000,
};

const CATEGORY_DECAY: Record<string, DecayClass> = {
  student_preference: 'permanent',
  decision:           'permanent',
  identity:           'permanent',
  misconception:      'stable',
  breakthrough:       'stable',
  concept:            'active',
  homework:           'active',
  session:            'session',
  checkpoint:         'checkpoint',
  other:              'stable',
  // the facts about a student's work, written by the host (docs/STUDENT_STATE.md): a repository and a problem for 90 days, where a session stopped for 14
  repo:               'stable',
  issue:              'stable',
  thread:             'active',
};

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'it', 'in', 'on', 'at', 'to', 'for', 'of',
  'and', 'or', 'but', 'not', 'with', 'this', 'that', 'was', 'are', 'be',
  'have', 'has', 'had', 'do', 'did', 'will', 'can', 'how', 'what', 'when',
]);

export function storeMemory(studentFolder: string, fact: MemoryFact): void {
  const db = getDb();
  const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const category = fact.category || 'other';
  const decayClass: DecayClass = (CATEGORY_DECAY[category] as DecayClass) || 'stable';
  const ttl = DECAY_TTL_MS[decayClass];
  const createdAt = Date.now();
  const expiresAt = ttl ? createdAt + ttl : null;

  db.prepare(`
    INSERT INTO memories (id, student_folder, text, category, entity, key, value, source, created_at, decay_class, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'agent', ?, ?, ?)
  `).run(
    id, studentFolder, fact.text, category,
    fact.entity ?? null, fact.key ?? null, fact.value ?? null,
    createdAt, decayClass, expiresAt,
  );
}

const STUDENT_FOLDER = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Keeps one fact about a student's work (a repository, where a session stopped, a problem: src/work-facts.ts, docs/STUDENT_STATE.md). A row of the same student, kind and key is REPLACED
 * (and its time renewed: a repository that is used again does not expire), and past the cap of the kind the oldest rows go. Written by the host only (`source` is 'host'); the shape is checked
 * again here, whoever calls: false when the fact is not a well-formed one (nothing is written).
 */
export function upsertWorkFact(studentFolder: string, fact: WorkFact, now = Date.now()): boolean {
  if (!STUDENT_FOLDER.test(studentFolder) || !fact || !isWorkCategory(fact.category) || !isWorkKey(fact.category, fact.key)) return false;
  const text = boundWorkText(fact.text);
  if (!text) return false;
  let value: string | null = null;
  if (fact.category === 'repo') {
    if (typeof fact.value !== 'string' || !REPO_NAME.test(fact.value)) return false;
    value = fact.value;
  }
  const db = getDb();
  const decayClass: DecayClass = CATEGORY_DECAY[fact.category] as DecayClass;
  const ttl = DECAY_TTL_MS[decayClass];
  const id = `mem-${now}-${Math.random().toString(36).slice(2, 8)}`;
  db.transaction(() => {
    db.prepare(`DELETE FROM memories WHERE student_folder = ? AND category = ? AND key = ?`).run(studentFolder, fact.category, fact.key);
    db.prepare(`
      INSERT INTO memories (id, student_folder, text, category, entity, key, value, source, created_at, decay_class, expires_at)
      VALUES (?, ?, ?, ?, NULL, ?, ?, 'host', ?, ?, ?)
    `).run(id, studentFolder, text, fact.category, fact.key, value, now, decayClass, ttl ? now + ttl : null);
    // the cap of the kind: the newest rows stay
    db.prepare(`
      DELETE FROM memories WHERE id IN (
        SELECT id FROM memories WHERE student_folder = ? AND category = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?
      )
    `).run(studentFolder, fact.category, WORK_CAPS[fact.category]);
  })();
  return true;
}

/** Takes one fact about a student's work back by its key (a repository that no longer exists). Only the three kinds: never a note of another kind. True when a row went. */
export function deleteWorkFact(studentFolder: string, key: string): boolean {
  if (!STUDENT_FOLDER.test(studentFolder) || typeof key !== 'string') return false;
  const result = getDb()
    .prepare(`DELETE FROM memories WHERE student_folder = ? AND key = ? AND category IN (${WORK_CATEGORIES.map(() => '?').join(', ')})`)
    .run(studentFolder, key, ...WORK_CATEGORIES);
  return result.changes > 0;
}

/** The facts about a student's work that have not expired, newest first (whatever else the table holds is not here; a row that is not a well-formed fact is skipped). */
export function listWorkFacts(studentFolder: string, now = Date.now()): StoredWorkFact[] {
  if (!STUDENT_FOLDER.test(studentFolder)) return [];
  const rows = getDb()
    .prepare(`
      SELECT text, category, key, value, created_at FROM memories
      WHERE student_folder = ? AND category IN (${WORK_CATEGORIES.map(() => '?').join(', ')}) AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC, rowid DESC
    `)
    .all(studentFolder, ...WORK_CATEGORIES, now) as Array<Record<string, unknown>>;
  return rows.map((r) => workFactOf(r)).filter((f): f is StoredWorkFact => f !== null);
}

interface MemoryRow {
  text: string;
  category: string;
  entity: string | null;
  key: string | null;
  value: string | null;
  created_at: number;
}

export function recallMemories(studentFolder: string, query: string, limit = 5): MemoryRow[] {
  const db = getDb();
  const now = Date.now();

  const keywords = query.toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));

  if (keywords.length > 0) {
    const ftsQuery = keywords.join(' OR ');
    try {
      const rows = db.prepare(`
        SELECT m.text, m.category, m.entity, m.key, m.value, m.created_at
        FROM memories m
        WHERE m.rowid IN (
          SELECT rowid FROM memories_fts WHERE memories_fts MATCH ?
        )
        AND m.student_folder = ?
        AND (m.expires_at IS NULL OR m.expires_at > ?)
        ORDER BY m.created_at DESC
        LIMIT ?
      `).all(ftsQuery, studentFolder, now, limit) as MemoryRow[];
      if (rows.length > 0) return rows;
    } catch {
      /* FTS5 not available, fall through to recency-based recall */
    }
  }

  return db.prepare(`
    SELECT text, category, entity, key, value, created_at
    FROM memories
    WHERE student_folder = ? AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC
    LIMIT ?
  `).all(studentFolder, now, limit) as MemoryRow[];
}

interface MessageRow {
  sender_name: string;
  content: string;
  timestamp: string;
  is_bot_message: number;
}

function recallMessages(chatJid: string, limit = 20): MessageRow[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT sender_name, content, timestamp, is_bot_message
    FROM messages
    WHERE chat_jid = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(chatJid, limit) as MessageRow[];
  return rows.reverse();
}

export function buildMemoryContext(chatJid: string, studentFolder: string, prompt: string): string {
  let memories = recallMemories(studentFolder, prompt, 6);
  // The three kinds of fact about their work (a repository, where a session stopped, a problem: docs/STUDENT_STATE.md) have a section of their own below, always there, so none is in this
  // list twice. recallMemories is asked as it always was; only when a row of those kinds is among the six is it asked again, for room to leave them out (at most 35 rows exist), and
  // when the words of the prompt matched nothing but those rows, the newest memories take the place the search would have had without them.
  if (memories.some((m) => isWorkCategory(m.category))) {
    const room = 6 + Object.values(WORK_CAPS).reduce((a, b) => a + b, 0);
    const others = (rows: MemoryRow[]) => rows.filter((m) => !isWorkCategory(m.category));
    memories = others(recallMemories(studentFolder, prompt, room)).slice(0, 6);
    if (memories.length === 0) memories = others(recallMemories(studentFolder, '', room)).slice(0, 6);
  }
  const messages = recallMessages(chatJid, 20);
  let work: StoredWorkFact[] = [];
  try {
    work = pickWork(listWorkFacts(studentFolder), { max: 6 });
  } catch {
    /* a context without them is still a context */
  }

  const parts: string[] = ['<memory_context>'];

  if (memories.length > 0) {
    parts.push('## Stored memories (from past sessions)');
    for (const m of memories) {
      const kv = m.key && m.value ? ` [${m.key}=${m.value}]` : '';
      parts.push(`- [${m.category}]${kv} ${m.text}`);
    }
  }

  // Always there, whatever the prompt says (the memories above are searched by its words): where their code is, where the last session stopped, a problem they ran into. It comes before the
  // chat history, which a resumed session leaves out (container/agent-runner/src/prompt.ts storedMemoriesOnly keeps what comes before that heading).
  if (work.length > 0) {
    parts.push('## Their work, from earlier sessions');
    for (const f of work) parts.push(`- ${f.text}`);
    parts.push(WORK_NOTE);
  }

  if (messages.length > 0) {
    parts.push('## Recent conversation history');
    for (const msg of messages) {
      const role = msg.is_bot_message ? 'TAi' : (msg.sender_name || 'Student');
      const ts = msg.timestamp ? msg.timestamp.slice(0, 10) : '';
      const content = msg.content.length > 250
        ? msg.content.slice(0, 250) + '...'
        : msg.content;
      parts.push(`[${ts}] ${role}: ${content}`);
    }
  }

  if (parts.length === 1) return '';

  parts.push('</memory_context>');
  return parts.join('\n');
}

export interface MemoryExport {
  memories: MemoryRow[];
  messages: MessageRow[];
}

export function buildMemoryExport(studentFolder: string, chatJid: string): MemoryExport {
  const db = getDb();
  const memories = db.prepare(`
    SELECT text, category, entity, key, value, created_at
    FROM memories
    WHERE student_folder = ? AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at DESC
  `).all(studentFolder, Date.now()) as MemoryRow[];

  // Include last 100 messages for searchable history
  const messages = (db.prepare(`
    SELECT sender_name, content, timestamp, is_bot_message
    FROM messages
    WHERE chat_jid = ?
    ORDER BY timestamp DESC
    LIMIT 100
  `).all(chatJid) as MessageRow[]).reverse();

  return { memories, messages };
}

export function pruneExpiredMemories(): number {
  const db = getDb();
  const result = db.prepare(
    `DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at < ?`,
  ).run(Date.now());
  return result.changes;
}
