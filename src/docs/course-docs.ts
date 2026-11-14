/**
 * The entry of the `course-docs` commands (docs/COURSE_DOCS.md): `node dist/docs/course-docs.js <command> --store DIR --data DIR [...]`, run on the host by tai_live.sh from the live tree. It builds the
 * real renderer (the operator's own: its containers are labelled apart, so that the running service's reaper never takes a long conversion for a leftover) and the real store, and hands them to the
 * commands (src/docs/course-docs-cli.ts). The library is the directory `<store>/course-docs`; the renderer's run directories are `<data>` (not the service's own: data/docs).
 *
 *   --store DIR    the orchestrator's store directory (default ./store)
 *   --data DIR     where the renderer makes its run directories (default ./data/docs-operator)
 *   --image NAME   the renderer image (default tai-doc:live)
 *
 * The Canvas address, course and token are read from CANVAS_BASE_URL, CANVAS_COURSE_ID and CANVAS_API_TOKEN of the environment (never from the command line).
 */
import path from 'node:path';

import { runCourseDocs } from './course-docs-cli.js';
import { DOC_IMAGE, createRenderer } from './render.js';
import { DocStore } from './store.js';

function take(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  if (at === -1) return undefined;
  const value = args[at + 1];
  args.splice(at, value === undefined ? 1 : 2);
  return value;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const storeDir = path.resolve(take(args, '--store') ?? 'store');
  const dataDir = path.resolve(take(args, '--data') ?? path.join('data', 'docs-operator'));
  const image = take(args, '--image') ?? DOC_IMAGE;
  const quiet = { info: () => undefined, warn: (f: Record<string, unknown>, m: string) => console.error(`warning: ${m} ${JSON.stringify(f).slice(0, 300)}`), debug: () => undefined };
  const store = new DocStore(storeDir, { log: quiet });
  const renderer = createRenderer({ dir: dataDir, log: quiet, image, operator: true });
  // containers of the operator's own that an earlier run left behind (older than two minutes)
  await renderer.reap();
  return runCourseDocs(args, { store, renderer, env: process.env, fetchImpl: fetch, out: (l) => console.log(l), err: (l) => console.error(l) });
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`course-docs failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  },
);
