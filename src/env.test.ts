import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readEnvFile } from './env.js';

// deploy/cs6650/tai_credentials.sh writes KEY="value" and nothing else escaped; this is the reader that has to give the value back.
describe('readEnvFile reads what tai_credentials.sh writes', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function envWith(text: string): void {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tai-env-'));
    dirs.push(dir);
    fs.writeFileSync(path.join(dir, '.env'), text);
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
  }

  const hostile: Record<string, string> = {
    CANVAS_API_TOKEN: '1~a$b"c\'d#e!f\\g`h$(id)${HOME}=x',
    PIAZZA_PASSWORD: '  p"a ss\'$x\\y`z  ',
    GITHUB_TOKEN: "'starts and ends with single quotes'",
    GITHUB_TOKEN_PUBLIC: '"starts and ends with double quotes"',
    GITHUB_ALLOWED_ORGS: '#not-a-comment',
    PIAZZA_EMAIL: 'a=b@example.com',
  };

  it('gives back every value exactly, whatever characters it holds', () => {
    envWith('# written by tai_credentials.sh\n' + Object.entries(hostile).map(([k, v]) => `${k}="${v}"\n`).join(''));
    expect(readEnvFile(Object.keys(hostile))).toEqual(hostile);
  });

  it('is not confused by the lines around a value', () => {
    envWith('ASSISTANT_NAME=TAi\n\nANTHROPIC_BASE_URL=http://tai-live-litellm:4000\r\nCANVAS_API_TOKEN="tok=en"\nTHIRD=\n');
    expect(readEnvFile(['ASSISTANT_NAME', 'ANTHROPIC_BASE_URL', 'CANVAS_API_TOKEN', 'THIRD', 'MISSING'])).toEqual({
      ASSISTANT_NAME: 'TAi',
      ANTHROPIC_BASE_URL: 'http://tai-live-litellm:4000',
      CANVAS_API_TOKEN: 'tok=en',
    });
  });
});
