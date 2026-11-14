import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GRAPH_CONTAINER_PATH, GRAPH_MAX_BYTES, leanragGraphMount } from './leanrag-graph.js';

// The host's side of the course knowledge graph's switch (docs/LEANRAG.md). The switch is TAI_LEANRAG=1, off unless it is exactly that; a folder is mounted only when it is what the
// build wrote. With the switch off the answer is "no mount" whatever is on the disk, which is what keeps a deploy from changing anything.

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'leanrag-graph-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeGraph(dir: string, manifest: object | string = { format: 1, synthetic: false }): string {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'graph.json'), '{}');
  fs.writeFileSync(path.join(dir, 'chunks.jsonl'), '');
  return dir;
}
const current = () => path.join(tmp, 'leanrag', 'current');

describe('the switch', () => {
  it('is off unless TAI_LEANRAG is exactly 1, whatever is on the disk', () => {
    writeGraph(current());
    for (const flag of [undefined, '', '0', 'true', 'yes', ' 1', '1 ', '01', 'on']) {
      expect(leanragGraphMount({ TAI_LEANRAG: flag }, tmp), JSON.stringify(flag)).toEqual({ on: false, mount: null, reason: '' });
    }
  });

  it('mounts the graph read-only at /workspace/leanrag-graph when it is on and the build wrote the folder', () => {
    writeGraph(current());
    const d = leanragGraphMount({ TAI_LEANRAG: '1' }, tmp);
    expect(d.on).toBe(true);
    expect(d.mount).toEqual({ hostPath: fs.realpathSync(current()), containerPath: GRAPH_CONTAINER_PATH, readonly: true });
    expect(d.reason).toBe('');
    expect(GRAPH_CONTAINER_PATH).toBe('/workspace/leanrag-graph');
  });

  it('takes another folder when TAI_LEANRAG_DIR names one', () => {
    const other = writeGraph(path.join(tmp, 'elsewhere'));
    const d = leanragGraphMount({ TAI_LEANRAG: '1', TAI_LEANRAG_DIR: other }, tmp);
    expect(d.mount?.hostPath).toBe(fs.realpathSync(other));
  });
});

describe('what is mounted', () => {
  it('says "no graph" in words when the folder is not there', () => {
    const d = leanragGraphMount({ TAI_LEANRAG: '1' }, tmp);
    expect(d).toMatchObject({ on: true, mount: null });
    expect(d.reason).toContain('no graph folder');
  });

  it('refuses a folder that lacks one of the three files', () => {
    for (const missing of ['manifest.json', 'graph.json', 'chunks.jsonl']) {
      fs.rmSync(current(), { recursive: true, force: true });
      writeGraph(current());
      fs.rmSync(path.join(current(), missing));
      const d = leanragGraphMount({ TAI_LEANRAG: '1' }, tmp);
      expect(d.mount, missing).toBeNull();
      expect(d.reason, missing).toContain(`${missing} is missing`);
    }
  });

  it('refuses a manifest that is not JSON, not format 1, or marked synthetic (a dry run)', () => {
    const cases: Array<[object | string, string]> = [['not json', 'not JSON'], [{ format: 2 }, 'not format 1'], [{ format: 1, synthetic: true }, 'synthetic'], ['null', 'not format 1']];
    for (const [manifest, word] of cases) {
      fs.rmSync(current(), { recursive: true, force: true });
      writeGraph(current(), manifest);
      const d = leanragGraphMount({ TAI_LEANRAG: '1' }, tmp);
      expect(d.mount, String(word)).toBeNull();
      expect(d.reason).toContain(word);
    }
  });

  it('refuses a link in place of the folder', () => {
    const real = writeGraph(path.join(tmp, 'real'));
    fs.mkdirSync(path.dirname(current()), { recursive: true });
    try {
      fs.symlinkSync(real, current(), 'junction');
    } catch {
      return; // (no right to make a link here: the rule is the same, there is nothing to test)
    }
    const d = leanragGraphMount({ TAI_LEANRAG: '1' }, tmp);
    expect(d.mount).toBeNull();
    expect(d.reason).toContain('not a real directory');
  });

  it('refuses a file where the folder should be', () => {
    fs.mkdirSync(path.dirname(current()), { recursive: true });
    fs.writeFileSync(current(), 'x');
    expect(leanragGraphMount({ TAI_LEANRAG: '1' }, tmp).mount).toBeNull();
  });

  it('refuses a folder larger than a graph of this course can be', () => {
    writeGraph(current());
    const big = { ...fs, lstatSync: (p: fs.PathLike) => { const s = fs.lstatSync(p); return String(p).endsWith('chunks.jsonl') ? Object.assign(Object.create(Object.getPrototypeOf(s)), s, { size: GRAPH_MAX_BYTES + 1 }) : s; } };
    const d = leanragGraphMount({ TAI_LEANRAG: '1' }, tmp, big as unknown as typeof fs);
    expect(d.mount).toBeNull();
    expect(d.reason).toContain('limit');
  });

  it('never throws, whatever the file system does', () => {
    const hostile = { lstatSync: () => { throw new Error('boom'); }, readFileSync: () => { throw new Error('boom'); }, realpathSync: () => { throw new Error('boom'); }, statSync: () => { throw new Error('boom'); } };
    expect(leanragGraphMount({ TAI_LEANRAG: '1' }, tmp, hostile as unknown as typeof fs).mount).toBeNull();
    writeGraph(current());
    const noReal = { ...fs, realpathSync: () => { throw new Error('boom'); } };
    expect(leanragGraphMount({ TAI_LEANRAG: '1' }, tmp, noReal as unknown as typeof fs).mount).toBeNull();
  });
});
