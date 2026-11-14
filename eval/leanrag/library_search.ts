/**
 * The course library's own search (src/docs/library-search.ts, docs/COURSE_DOCS.md), run over a set of questions: the BASELINE of the LeanRAG retrieval
 * evaluation (docs/LEANRAG.md). It is the real code (`buildIndex`, `searchLibrary`), not a copy: only the decks come from somewhere else (the text of each
 * page is read from the PDFs by eval/leanrag/evaluate.py, since the host's renderer is not run here).
 *
 * Run: tsx eval/leanrag/library_search.ts <decks.json> <questions.json> <out.json>
 *   decks.json: [{ "id": "<deck file>", "title": "...", "week": 4, "pages": ["text of page 1", ...] }]
 */
import fs from 'fs';

import { buildIndex, searchLibrary } from '../../src/docs/library-search.js';

const [decksPath, questionsPath, outPath] = process.argv.slice(2);
if (!decksPath || !questionsPath || !outPath) {
  console.error('usage: tsx eval/leanrag/library_search.ts <decks.json> <questions.json> <out.json>');
  process.exit(2);
}
const decks = JSON.parse(fs.readFileSync(decksPath, 'utf8'));
const questions = JSON.parse(fs.readFileSync(questionsPath, 'utf8')).questions as Array<{ id: string; q: string }>;
const index = buildIndex(decks);
const results: Record<string, Array<{ id: string; title: string; page: number }>> = {};
for (const q of questions) results[q.id] = searchLibrary(index, q.q).map((h) => ({ id: h.id, title: h.title, page: h.page }));
fs.writeFileSync(outPath, JSON.stringify({ system: 'library', pages: index.pageCount, decks: index.decks.length, results }, null, 2));
console.log(`library search: ${questions.length} questions over ${index.decks.length} decks / ${index.pageCount} pages -> ${outPath}`);
