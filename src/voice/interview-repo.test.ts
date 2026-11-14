import { describe, expect, it } from 'vitest';

import { MAX_LISTED_FILES, RememberedRepo, assignmentLabelOf, codeFiles, compactFile, compactRepos, compactTree, homeworkOf, lookUpRemembered, lookUpRepo, pickRepo, readFileAnswer, repoMismatch, repoNameOk } from './interview-repo.js';
import { FakeToolHost } from './tool-host.js';

describe('which homework a name is about', () => {
  it('is the number straight after hw, homework or assignment, with its letter, in an assignment\'s title or a repository\'s name', () => {
    expect(homeworkOf('Homework 7: Cost savings?!')).toEqual({ n: 7, letter: '' });
    expect(homeworkOf('HW3 Concurrency')).toEqual({ n: 3, letter: '' });
    expect(homeworkOf('homework three')).toEqual({ n: 3, letter: '' });
    expect(homeworkOf("Homework 1a: Let's Get Going")).toEqual({ n: 1, letter: 'a' });
    expect(homeworkOf('cs6650-hw3')).toEqual({ n: 3, letter: '' });
    expect(homeworkOf('CS6650_Homework1')).toEqual({ n: 1, letter: '' });
    expect(homeworkOf('assignment_03')).toEqual({ n: 3, letter: '' });
    expect(homeworkOf('hw12-final')).toEqual({ n: 12, letter: '' });
  });

  it('is nothing for a name that is not a homework: a midterm, a notes repository, the course number', () => {
    for (const name of ['Midterm Mastery Part 2', 'cs6650-notes', 'homework', 'hw', 'distributed-systems', 'cs6650', 'hw-final', 'hw1234']) expect(homeworkOf(name), name).toBeNull();
  });
});

describe('which repository is the assignment\'s', () => {
  const repo = (name: string, updated = '2026-10-01T00:00:00Z') => ({ name, full_name: `ana-gh/${name}`, private: false, updated_at: updated });

  it('is the one with the same homework number, even when others are newer', () => {
    const repos = [repo('cs6650-notes', '2026-11-04T00:00:00Z'), repo('hw4-kafka', '2026-11-03T00:00:00Z'), repo('hw3-concurrency', '2026-10-20T00:00:00Z')];
    expect(pickRepo('HW3 Concurrency', repos)).toBe('hw3-concurrency');
    expect(pickRepo('homework three', repos)).toBe('hw3-concurrency');
    expect(pickRepo('Homework 4: Kafka', repos)).toBe('hw4-kafka');
  });

  it('is not the first repository that happens to contain the number: "6" is in "cs6650-notes" (the container\'s own matcher would take it)', () => {
    expect(pickRepo('Homework 6: Scalability', [repo('cs6650-notes'), repo('project-66')])).toBeNull();
    expect(pickRepo('Homework 5', [repo('hw15'), repo('hw50')])).toBeNull();
  });

  it('is never the newest repository for want of a match', () => {
    expect(pickRepo('Homework 8: Tradeoffs', [repo('cs6650-notes', '2026-11-04T00:00:00Z'), repo('dotfiles')])).toBeNull();
    expect(pickRepo('Midterm Mastery Part 2', [repo('hw2'), repo('mastery-notes')])).toBeNull();
    expect(pickRepo('', [repo('hw2')])).toBeNull();
  });

  it('is not one for another homework, whatever else the names share', () => {
    expect(pickRepo('Homework 3: Cost savings', [repo('hw4-cost-savings')])).toBeNull();
    expect(pickRepo('Homework 1a: Let\'s Get Going', [repo('hw1b'), repo('hw2a')])).toBeNull();
  });

  it('takes a letter that agrees or is missing on one side', () => {
    expect(pickRepo("Homework 1a: Let's Get Going", [repo('hw1a')])).toBe('hw1a');
    expect(pickRepo("Homework 1a: Let's Get Going", [repo('CS6650_Homework1')])).toBe('CS6650_Homework1');
    expect(pickRepo('Homework 1: Intro', [repo('hw1a')])).toBe('hw1a');
  });

  it('is a repository with two words of the title when the names carry no number', () => {
    expect(pickRepo('Homework 7: Cost savings?!', [repo('cost-savings-lab'), repo('savings')])).toBe('cost-savings-lab');
    expect(pickRepo('Homework 7: Cost savings?!', [repo('savings'), repo('cost')])).toBeNull(); // one word is not enough
    expect(pickRepo('Load testing with Locust', [repo('locust-load-testing')])).toBe('locust-load-testing');
  });

  it('is the one updated last among those that fit equally', () => {
    expect(pickRepo('HW3 Concurrency', [repo('hw3-old', '2026-09-01T00:00:00Z'), repo('hw3-new', '2026-10-30T00:00:00Z'), repo('hw3-mid', '2026-10-01T00:00:00Z')])).toBe('hw3-new');
  });

  it('puts a number match before a match of words', () => {
    expect(pickRepo('HW3 Concurrency Patterns', [repo('concurrency-patterns-notes', '2026-11-04T00:00:00Z'), repo('hw3', '2026-09-01T00:00:00Z')])).toBe('hw3');
  });

  it('ignores what is not a repository: a name that is not a name, a non-object, a non-list', () => {
    expect(pickRepo('HW3', [null, 'hw3', 7, { name: 'a/b' }, { name: 42 }, { name: '../hw3' }, {}, repo('hw3')])).toBe('hw3');
    expect(pickRepo('HW3', 'nothing')).toBeNull();
    expect(pickRepo('HW3', { error: 'rate limited' })).toBeNull();
  });
});

describe('which of its files are named to the interviewer', () => {
  const file = (path: string, size = 900) => ({ name: path.split('/').pop(), path, type: 'file', size });
  const dir = (path: string) => ({ name: path.split('/').pop(), path, type: 'dir', size: 0 });

  it('is the code and configuration of the assignment, the likeliest first, and not what is vendored, generated, built, binary or huge', () => {
    const { files, more } = codeFiles([
      dir('handlers'), file('main.go'), file('handlers/orders.go'), file('handlers/orders_test.go'), file('Dockerfile'), file('README.md'), file('docs/README.md'),
      file('vendor/github.com/x/y.go'), file('node_modules/z/index.js'), file('go.sum'), file('go.mod'), file('logo.png'), file('terraform/main.tf'),
      file('package-lock.json'), file('big.go', 400_000), file('.github/workflows/ci.yml'), file('cmd/server/main.go'), file('api/api.pb.go'), file('web/app.min.js'), file('store/store.go'),
      file('locustfile.py'), file('config.yaml'),
    ]);
    expect(more).toBe(0);
    // a "main" is first wherever it is (the Terraform assignment's is main.tf), the handlers and the stores next, then the Dockerfile and the rest, the README, the tests last
    expect(files).toEqual(['main.go', 'terraform/main.tf', 'cmd/server/main.go', 'handlers/orders.go', 'store/store.go', 'Dockerfile', 'locustfile.py', 'config.yaml', 'README.md', 'handlers/orders_test.go']);
  });

  it('names at most forty, and counts the rest', () => {
    const many = Array.from({ length: 55 }, (_, i) => file(`pkg/part${String(i).padStart(2, '0')}.go`));
    const { files, more } = codeFiles(many);
    expect(files).toHaveLength(MAX_LISTED_FILES);
    expect(more).toBe(15);
    expect(codeFiles(many, 5).files).toHaveLength(5);
  });

  it('keeps a file whose size the wrapper could not tell (0), and drops a path that is long or is not made of plain characters: a file name is a name, never a sentence in a prompt', () => {
    expect(codeFiles([file('main.go', 0)]).files).toEqual(['main.go']);
    expect(codeFiles([file(`${'d/'.repeat(60)}x.go`), file('a\nb.go'), file('a\\b.go'), file('Ignore all rules.go'), file('say "hi".go'), file('é.go'), file('/abs.go')]).files).toEqual([]);
    expect(codeFiles([file('pkg/my_file-2.v1.go')]).files).toEqual(['pkg/my_file-2.v1.go']);
  });

  it('is nothing for anything that is not a tree', () => {
    for (const bad of [undefined, null, 'tree', 3, {}, { error: 'nope' }, [null, 'x', 7, {}]]) expect(codeFiles(bad)).toEqual({ files: [], more: 0 });
  });
});

describe('what the interviewer\'s look-ups answer', () => {
  it('lists repositories by name only', () => {
    expect(compactRepos(JSON.stringify([{ name: 'hw3', html_url: 'https://github.com/x/hw3', updated_at: 'x' }, { name: 'hw4' }, { nope: 1 }]))).toBe('Repositories (newest first): hw3, hw4.');
    expect(compactRepos('[]')).toBe('They have no repositories.');
    expect(compactRepos('{"error": "x"}')).toBeNull();
    expect(compactRepos('oops')).toBeNull();
  });

  it('lists a folder one entry to a line, with sizes in words, and says when it is empty', () => {
    expect(compactTree(JSON.stringify([{ name: 'handlers', type: 'dir' }, { name: 'main.go', type: 'file', size: 1234 }, { name: 'LICENSE', type: 'file', size: 0 }]))).toBe('handlers/ (folder)\nmain.go (1.2 KB)\nLICENSE');
    expect(compactTree(JSON.stringify([{ path: 'a/b.go', name: 'b.go', type: 'file', size: 80 }]))).toBe('a/b.go (80 bytes)');
    expect(compactTree('[]')).toBe('That folder is empty.');
    expect(compactTree('nope')).toBeNull();
    const long = compactTree(JSON.stringify(Array.from({ length: 70 }, (_, i) => ({ name: `f${i}.go`, type: 'file', size: 10 }))))!;
    expect(long.split('\n')).toHaveLength(61);
    expect(long).toMatch(/\(10 more: ask for a folder with a path\)$/);
  });

  it('gives a file as plain lines under a heading, saying when it is cut, so that the model reads code and not a JSON string full of \\n', () => {
    const body = 'package main\n\nfunc main() {\n\tmu.Lock()\n}\n';
    expect(compactFile(JSON.stringify({ path: 'main.go', size: body.length, content: body }))).toBe(`File main.go (${body.length} bytes):\n${body}`);
    expect(compactFile(JSON.stringify({ path: 'big.go', size: 20_000, content: body }))).toBe(`File big.go (19.5 KB, the first ${body.length} characters shown):\n${body}`);
    expect(compactFile('{"error": "not found"}')).toBeNull();
    expect(compactFile('plain')).toBeNull();
    expect(readFileAnswer(JSON.stringify({ path: 'x', content: 'a\nb' }))).toEqual({ path: 'x', size: 3, content: 'a\nb' });
  });
});

describe('the look-up of the student\'s repository for an interview', () => {
  const REPOS = JSON.stringify([
    { name: 'cs6650-notes', updated_at: '2026-11-04T00:00:00Z' },
    { name: 'hw3-concurrency', updated_at: '2026-10-20T00:00:00Z' },
  ]);
  const TREE = JSON.stringify([
    { name: 'main.go', path: 'main.go', type: 'file', size: 2000 },
    { name: 'orders.go', path: 'handlers/orders.go', type: 'file', size: 3000 },
    { name: 'handlers', path: 'handlers', type: 'dir', size: 0 },
    { name: 'x.go', path: 'vendor/x.go', type: 'file', size: 10 },
  ]);

  async function hostWith(handlers: FakeToolHost['handlers']): Promise<FakeToolHost> {
    const host = new FakeToolHost(handlers);
    await host.start();
    return host;
  }

  it('finds the repository and names its code files, asking GitHub twice, as the student\'s own account', async () => {
    const host = await hostWith({
      github_query: (args) => ((args as { action: string }).action === 'list_repos' ? { ok: true, text: REPOS } : { ok: true, text: TREE }),
    });
    const found = await lookUpRepo(host, 'ana-gh', 'HW3 Concurrency');
    expect(found).toEqual({ found: true, repo: 'hw3-concurrency', files: ['main.go', 'handlers/orders.go'], more: 0 });
    expect(host.calls.map((c) => [c.server, c.tool, c.args])).toEqual([
      ['nanoclaw', 'github_query', { action: 'list_repos', params: { user: 'ana-gh' } }],
      ['nanoclaw', 'github_query', { action: 'repo_tree', params: { owner: 'ana-gh', repo: 'hw3-concurrency', recursive: 'true' } }],
    ]);
  });

  it('says there is no repository to name when none matches, without asking for a tree', async () => {
    const host = await hostWith({ github_query: () => ({ ok: true, text: REPOS }) });
    expect(await lookUpRepo(host, 'ana-gh', 'Homework 9: Something else')).toEqual({ found: false, why: 'no-match' });
    expect(host.calls).toHaveLength(1);
  });

  it('says the account is not linked, and asks nothing, when the host has bound none (or one that is not a name)', async () => {
    const host = await hostWith({ github_query: () => ({ ok: true, text: REPOS }) });
    for (const username of [undefined, '', 'a/b', '../x']) expect(await lookUpRepo(host, username, 'HW3'), String(username)).toEqual({ found: false, why: 'unlinked' });
    expect(host.calls).toHaveLength(0);
  });

  it('says GitHub could not be reached for a tool that failed, an answer that is not a list, and a throw', async () => {
    for (const handler of [() => ({ ok: false, text: 'timeout' }), () => ({ ok: true, text: '{"error": "GitHub API error: 403"}' }), () => ({ ok: true, text: 'not json' })]) {
      const host = await hostWith({ github_query: handler });
      expect(await lookUpRepo(host, 'ana-gh', 'HW3')).toEqual({ found: false, why: 'unavailable' });
    }
    const throwing = await hostWith({ github_query: () => { throw new Error('boom'); } });
    expect(await lookUpRepo(throwing, 'ana-gh', 'HW3')).toEqual({ found: false, why: 'unavailable' });
  });

  it('still names the repository when its tree cannot be had: the interviewer can browse it itself', async () => {
    const host = await hostWith({ github_query: (args) => ((args as { action: string }).action === 'list_repos' ? { ok: true, text: REPOS } : { ok: false, text: 'timeout' }) });
    expect(await lookUpRepo(host, 'ana-gh', 'HW3 Concurrency')).toEqual({ found: true, repo: 'hw3-concurrency', files: [], more: 0 });
  });
});

describe('the repository an earlier interview remembered (docs/STUDENT_STATE.md)', () => {
  const TREE = JSON.stringify([
    { name: 'main.go', path: 'main.go', type: 'file', size: 2000 },
    { name: 'orders.go', path: 'handlers/orders.go', type: 'file', size: 3000 },
    { name: 'x.go', path: 'vendor/x.go', type: 'file', size: 10 },
  ]);
  /** What the container answers for a repository that does not exist: the tool's error wrapped by the server (ipc-mcp-stdio.ts) around github_api.py's own. */
  const NOT_FOUND = `GitHub query failed: ${JSON.stringify({ error: `GitHub API error: 404 ${JSON.stringify({ message: 'Not Found' })}` })}`;
  const mem = (repo: string, key = 'repo:hw3'): RememberedRepo => ({ key, repo, text: `Their code for HW3 is in their repository ${repo}.` });
  const hostWith = async (handlers: FakeToolHost['handlers']): Promise<FakeToolHost> => {
    const host = new FakeToolHost(handlers);
    await host.start();
    return host;
  };

  it('lists the remembered repository directly, as the account the host bound, with the call lookUpRepo makes for one it chose and no other', async () => {
    const host = await hostWith({ github_query: () => ({ ok: true, text: TREE }) });
    const found = await lookUpRemembered(host, 'ana-gh', 'HW3 Concurrency', [mem('hw3-concurrency')]);
    expect(found).toEqual({ lookup: { found: true, repo: 'hw3-concurrency', files: ['main.go', 'handlers/orders.go'], more: 0 }, used: mem('hw3-concurrency'), gone: [] });
    expect(host.calls.map((c) => [c.server, c.tool, c.args, c.timeoutMs])).toEqual([['nanoclaw', 'github_query', { action: 'repo_tree', params: { owner: 'ana-gh', repo: 'hw3-concurrency', recursive: 'true' } }, 25_000]]);
  });

  it('asks nothing when nothing was remembered', async () => {
    const host = await hostWith({ github_query: () => ({ ok: true, text: TREE }) });
    expect(await lookUpRemembered(host, 'ana-gh', 'HW3', [])).toEqual({ lookup: null, used: null, gone: [] });
    expect(host.calls).toHaveLength(0);
  });

  it('says a repository GitHub says does not exist is gone, and tries the next one the assignment was remembered under', async () => {
    const answers = [{ ok: false, text: NOT_FOUND }, { ok: true, text: TREE }];
    const host = await hostWith({ github_query: () => answers.shift()! });
    const found = await lookUpRemembered(host, 'ana-gh', 'HW3', [mem('old-name', 'repo:hw3'), mem('hw3-concurrency', 'repo:3527597')]);
    expect(found.gone).toEqual([mem('old-name', 'repo:hw3')]);
    expect(found.used).toEqual(mem('hw3-concurrency', 'repo:3527597'));
    expect(found.lookup?.repo).toBe('hw3-concurrency');
    expect(host.calls.map((c) => (c.args as { params: { repo: string } }).params.repo)).toEqual(['old-name', 'hw3-concurrency']);
    // every one of them gone: nothing is found, and each is to be forgotten
    const none = await lookUpRemembered(await hostWith({ github_query: () => ({ ok: false, text: NOT_FOUND }) }), 'ana-gh', 'HW3', [mem('a'), mem('b', 'repo:3527597')]);
    expect(none).toEqual({ lookup: null, used: null, gone: [mem('a'), mem('b', 'repo:3527597')] });
  });

  it('takes only GitHub\'s "does not exist" for gone: a timeout, a refusal, a tool that is down or an answer that is no tree still names the repository, with no files, and forgets nothing', async () => {
    const texts = ['timeout', 'the tool host is not running', `GitHub query failed: ${JSON.stringify({ error: 'GitHub API error: 403 rate limit' })}`, `GitHub query failed: ${JSON.stringify({ error: 'GitHub API error: 500 oops' })}`, 'not json', '{"error": "owner and repo required"}', 'it took 404 ms'];
    for (const text of texts) {
      for (const ok of [false, true]) {
        const host = await hostWith({ github_query: () => ({ ok, text }) });
        expect(await lookUpRemembered(host, 'ana-gh', 'HW3', [mem('hw3-concurrency')]), `${ok}: ${text}`).toEqual({ lookup: { found: true, repo: 'hw3-concurrency', files: [], more: 0 }, used: mem('hw3-concurrency'), gone: [] });
      }
    }
  });

  it('asks nothing for an account the host has not bound, or one that is not a name', async () => {
    const host = await hostWith({ github_query: () => ({ ok: true, text: TREE }) });
    for (const username of [undefined, '', 'a/b', '../x']) expect(await lookUpRemembered(host, username, 'HW3', [mem('hw3-concurrency')]), String(username)).toEqual({ lookup: null, used: null, gone: [] });
    expect(host.calls).toHaveLength(0);
  });

  it('never asks GitHub about a stored value that is no repository name (a forged row), or that names another homework than the assignment\'s', async () => {
    const host = await hostWith({ github_query: () => ({ ok: true, text: TREE }) });
    const forged = ['..', '.', '.git', '-x', 'a/b', 'owner/name', 'a b', 'x'.repeat(101), '', 'name?x=1', 'name%2e', 'name\n'];
    expect(await lookUpRemembered(host, 'ana-gh', 'HW3', forged.map((repo) => mem(repo)))).toEqual({ lookup: null, used: null, gone: [] });
    expect(await lookUpRemembered(host, 'ana-gh', 'HW3 Concurrency', [mem('cs6650-hw2')])).toEqual({ lookup: null, used: null, gone: [] });
    expect(host.calls).toHaveLength(0);
    // a name with no homework in it may well be the assignment's
    expect((await lookUpRemembered(host, 'ana-gh', 'HW3 Concurrency', [mem('cs6650-final')])).used?.repo).toBe('cs6650-final');
  });

  it('never throws: a tool that throws leaves what was found gone so far, and no repository', async () => {
    const answers: Array<() => { ok: boolean; text: string }> = [() => ({ ok: false, text: NOT_FOUND }), () => { throw new Error('boom'); }];
    const host = await hostWith({ github_query: () => answers.shift()!() });
    const warned: string[] = [];
    const log = { debug: () => undefined, info: () => undefined, warn: (_o: object, m?: string) => void warned.push(m ?? ''), error: () => undefined };
    expect(await lookUpRemembered(host, 'ana-gh', 'HW3', [mem('a'), mem('b', 'repo:3527597')], log)).toEqual({ lookup: null, used: null, gone: [mem('a')] });
    expect(warned).toEqual(['voice: a remembered repository could not be looked up']);
  });
});

describe('what may be asked about, and which homework a repository is', () => {
  it('takes a repository name GitHub could have that starts with a letter or a digit, and nothing else', () => {
    for (const ok of ['hw3', 'cs6650-hw3', 'a', 'A.b_c-d', '3d', 'x'.repeat(100)]) expect(repoNameOk(ok), ok).toBe(true);
    for (const bad of ['', '.', '..', '.git', '-x', '_x', 'a/b', 'a b', 'x'.repeat(101), 'a?b', 'a%b', 'a\nb', 'é', undefined, null, 5, {}]) expect(repoNameOk(bad), String(bad)).toBe(false);
  });

  it('says two names are two homeworks only when both name one and the number (or the letter, when both have one) differs', () => {
    expect(repoMismatch('Homework 3: Concurrency', 'cs6650-hw2')).toBe(true);
    expect(repoMismatch('HW3 Concurrency', 'hw3-concurrency')).toBe(false);
    expect(repoMismatch('Homework 1a: Getting going', 'hw1b')).toBe(true);
    expect(repoMismatch('Homework 1a: Getting going', 'hw1')).toBe(false);
    expect(repoMismatch('Homework 1: Getting going', 'hw1b')).toBe(false);
    // an assignment that is no homework, or a repository that names none, is no clear mismatch
    expect(repoMismatch('Midterm Mastery Part 2', 'hw2')).toBe(false);
    expect(repoMismatch('Homework 3', 'cs6650-notes')).toBe(false);
    expect(repoMismatch('', 'hw2')).toBe(false);
  });

  it('calls an interview\'s assignment by its name, else by the topic the student gave', () => {
    expect(assignmentLabelOf({ assignmentName: 'HW3 Concurrency', topic: 'homework three' })).toBe('HW3 Concurrency');
    expect(assignmentLabelOf({ assignmentName: '', topic: 'homework three' })).toBe('homework three');
    expect(assignmentLabelOf({ assignmentName: '', topic: '' })).toBe('');
  });
});
