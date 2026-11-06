/**
 * `node dist/humanness/cli.js [--days 7] [--split ISO] [--judge N] [--judge-model M] [--store DIR] [--groups DIR] [--dump FILE] [--include-main] [--out FILE]`
 * Read-only: reads the page's histories, the call transcripts and the relay dump, prints the report (and writes it to --out). The judge
 * (--judge N: N exchanges) needs the gateway: TAI_VOICE_LLM_URL (default http://127.0.0.1:4010) and TAI_VOICE_LLM_KEY in the environment.
 * Run on the host with `tai_live.sh humanness`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { judge, type JudgeScore } from './judge.js';
import { buildReport, samplePairs } from './report.js';
import { readSources } from './sources.js';

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const days = Number(flag(argv, '--days') ?? 7);
  const now = new Date();
  const src = readSources({
    store: path.resolve(flag(argv, '--store') ?? 'store'),
    groups: path.resolve(flag(argv, '--groups') ?? 'groups'),
    dump: flag(argv, '--dump'),
    includeMain: argv.includes('--include-main'),
  });
  let judged: JudgeScore[] | undefined;
  const n = Number(flag(argv, '--judge') ?? 0);
  if (n > 0) {
    const key = process.env.TAI_VOICE_LLM_KEY ?? '';
    const from = new Date(now.getTime() - days * 86400000).toISOString();
    judged = key
      ? await judge(samplePairs(src, from, n), { url: process.env.TAI_VOICE_LLM_URL ?? 'http://127.0.0.1:4010', key, model: flag(argv, '--judge-model') ?? 'gpt-oss' })
      : [];
  }
  const report = buildReport(src, { now, days, split: flag(argv, '--split'), judged });
  process.stdout.write(report);
  const out = flag(argv, '--out');
  if (out) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, report);
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
}
