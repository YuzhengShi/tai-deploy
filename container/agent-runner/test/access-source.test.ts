import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

// ipc-mcp-stdio.ts starts a server when it is imported, so what it does cannot be run in a test. These read its text, for the few lines that decide who gets what, and
// fail when one of them goes back to the shape that was the flaw (docs/SECURITY.md, "Scheduled tasks and access"). They are a guard on wiring, not a proof of behaviour:
// the behaviour is access.test.ts and access-interview.test.ts, which run the same functions these lines call.

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
const read = (file: string) => fs.readFileSync(path.join(SRC, file), 'utf-8');
/** The text of a tool: from its server.tool(name ... to the next server.tool( or the end of the file. */
function toolText(source: string, name: string): string {
  const start = source.indexOf(`server.tool(\n  '${name}'`);
  expect(start, `server.tool for ${name}`).toBeGreaterThan(-1);
  const next = source.indexOf('server.tool(', start + 20);
  return source.slice(start, next === -1 ? source.length : next);
}

describe('where access is decided: data by isMain alone, tool limits by the flags', () => {
  const server = read('ipc-mcp-stdio.ts');

  it('the tool limits are lifted by access.ts from the flags, and a scheduled task alone is never read as access', () => {
    expect(server).toMatch(/const toolLimitsLifted = liftsToolLimits\(accessFlags\);/);
    expect(server).toMatch(/const accessFlags = accessFlagsFromEnv\(process\.env\);/);
    expect(server).not.toMatch(/const isScheduledTask\b/);
    expect(server).not.toMatch(/\|\|\s*isScheduledTask\b|\bisScheduledTask\s*\|\|/);
  });

  it('"full access" is gone from the server: no data gate can lean on a name that once meant the host\'s own tasks read the class', () => {
    expect(server).not.toMatch(/\bhasFullAccess\b|\bgrantsFullAccess\b/);
    expect(read('tool-host.ts')).not.toMatch(/\bgrantsFullAccess\b/);
  });

  it('the tool limits are lifted by toolLimitsLifted and by nothing else (a voice call\'s tool host counts them itself)', () => {
    expect(server).toMatch(/new ToolLimiter\(TOOL_LIMITS, toolLimitsLifted \|\| process\.env\.TAI_MODE === 'tool-host'\)/);
    expect(read('tool-host.ts')).toMatch(/new ToolLimiter\(TOOL_LIMITS, liftsToolLimits\(accessFlagsFromInput\(input\)\), 'voice call'\)/);
    expect(read('tool-host.ts')).not.toMatch(/input\.isScheduledTask === true/);
  });

  it('canvas_query goes through checkCanvasAccess keyed on isMain, and keeps no list of its own', () => {
    const canvas = toolText(server, 'canvas_query');
    expect(canvas).toMatch(/checkCanvasAccess\(args\.action, args\.params, \{ isMain, boundCanvasUserId \}\)/);
    expect(canvas).not.toMatch(/CANVAS_RESTRICTED_ACTIONS|CANVAS_IDENTITY_ACTIONS|toolLimitsLifted/);
    // and the single-student actions are still scoped by isMain, after it (brief-access.ts)
    expect(canvas.indexOf('checkCanvasAccess(')).toBeLessThan(canvas.indexOf('scopeCanvasParams('));
    expect(canvas).toMatch(/scopeCanvasParams\(args\.action, args\.params, \{ isMain, boundCanvasUserId \}\)/);
  });

  it('canvas_query says which actions are the admin chat\'s alone', () => {
    const canvas = toolText(server, 'canvas_query');
    for (const action of ['submissions', 'grades', 'users']) {
      expect(canvas, action).toMatch(new RegExp(`- "${action}": [^\\n]*(ADMIN CHAT ONLY|admin chat only)`));
    }
  });

  it('github_query is keyed on isMain: the host\'s own tasks are held to the bound account and the course organisations too', () => {
    const github = toolText(server, 'github_query');
    expect(github).toMatch(/fullAccess: isMain \}/);
    expect(github).not.toMatch(/toolLimitsLifted/);
  });

  it('set_student_identity is the admin chat\'s alone, and refuses before it writes anything', () => {
    const identity = toolText(server, 'set_student_identity');
    const gate = identity.indexOf('if (!isMain)');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(identity.indexOf('writeIpcFile('));
    expect(identity).not.toMatch(/toolLimitsLifted/);
  });

  it('schedule_task no longer promises a task all tools: it says a task has the access of the conversation that scheduled it', () => {
    const schedule = toolText(server, 'schedule_task');
    expect(schedule).not.toMatch(/access to all tools/);
    expect(schedule).toMatch(/the same access, as this conversation/);
  });
});

describe('the task tools ask the host and say what it said', () => {
  const server = read('ipc-mcp-stdio.ts');

  it('schedule_task holds a student\'s agent to the host\'s limits first, before it asks the student to confirm anything, and answers with the host\'s sentence', () => {
    const schedule = toolText(server, 'schedule_task');
    const limits = schedule.indexOf('checkNewTask(');
    expect(limits).toBeGreaterThan(-1);
    expect(schedule.lastIndexOf('if (!isMain) {', limits)).toBeGreaterThan(schedule.indexOf('async (args) => {'));
    expect(limits).toBeLessThan(schedule.indexOf('Recurring tasks require explicit confirmation'));
    expect(schedule).toMatch(/return askHost\(data, /);
    expect(schedule).not.toMatch(/Task scheduled \(/);
    expect(schedule).not.toMatch(/writeIpcFile\(TASKS_DIR, data\)/);
  });

  it.each(['pause_task', 'resume_task', 'cancel_task'])('%s refuses the system\'s own task before it asks the host, and answers with the host\'s sentence', (name) => {
    const tool = toolText(server, name);
    expect(tool).toMatch(/if \(!isMain && ownTasks\(\)\.some\(\(t\) => t\.id === args\.task_id && t\.origin === 'system'\)\)/);
    expect(tool.indexOf("t.origin === 'system'")).toBeLessThan(tool.indexOf('askHost('));
    expect(tool).not.toMatch(/writeIpcFile\(TASKS_DIR, data\)|requested\./);
  });

  it('the one place that writes a request waits for its answer, with an id of its own and the time the helper gives', () => {
    const start = server.indexOf('async function askHost(');
    expect(start).toBeGreaterThan(-1);
    const askHost = server.slice(start, server.indexOf('\n}\n', start));
    expect(askHost).toMatch(/const requestId = newRequestId\(\);/);
    expect(askHost).toMatch(/writeIpcFile\(TASKS_DIR, \{ \.\.\.data, requestId \}\)/);
    expect(askHost).toMatch(/awaitIpcResult\(RESULTS_DIR, requestId, \{ timeoutMs: RESULT_WAIT_MS \}\)/);
    expect(askHost).toMatch(/if \(!result\) return/);
  });

  it('list_tasks marks the system\'s own tasks for a student\'s agent', () => {
    expect(toolText(server, 'list_tasks')).toContain("[the system's own routine: it cannot be changed from here]");
  });
});

describe('start_mock_interview takes nobody\'s identity from the model, a file or a link', () => {
  const interview = toolText(read('ipc-mcp-stdio.ts'), 'start_mock_interview');

  it('uses the resolver the weekly brief uses, once, before anything is read, and stops on its refusal', () => {
    expect(interview.match(/resolveBriefIdentity\(/g)).toHaveLength(1);
    expect(interview.indexOf('resolveBriefIdentity(')).toBeLessThan(interview.indexOf("fs.readFileSync(path.join(studentDir, 'COMPETENCY.md')"));
    expect(interview).toMatch(/if \(!briefIdentity\.ok\) return/);
    expect(interview).toMatch(/const targetFolder = briefIdentity\.folder;/);
  });

  it('starts from the resolver\'s ids, not from the arguments, COMPETENCY.md or the owner of a link', () => {
    expect(interview).toMatch(/let canvasUserId = briefIdentity\.identity\.canvasUserId;/);
    expect(interview).toMatch(/const githubUsername = briefIdentity\.identity\.githubUsername;/);
    expect(interview).not.toMatch(/args\.canvas_user_id\s*\|\|/);
    expect(interview).not.toMatch(/args\.github_username\s*\|\|/);
    expect(interview).not.toMatch(/boundCanvasUserId\s*\|\||boundGithubUsername\s*\|\|/);
    expect(interview).not.toMatch(/Canvas User ID:/);
    expect(interview).not.toMatch(/GitHub:\\s/);
    expect(interview).not.toMatch(/githubUsername\s*=\s*m\[2\]/);
    expect(interview).not.toMatch(/githubUsername\s*=\s*gm\[1\]/);
  });

  it('searches the users by name only in the admin chat', () => {
    const usersCall = interview.indexOf("action: 'users'");
    expect(usersCall).toBeGreaterThan(-1);
    expect(interview.lastIndexOf('if (isMain && !canvasUserId)', usersCall)).toBeGreaterThan(interview.lastIndexOf('\n', usersCall - 400));
    expect(interview.match(/action: 'users'/g)).toHaveLength(1);
  });

  it('reads the repository a link names only after mayReadLinkedRepo says it is the student\'s, and sets what it read from only then', () => {
    const asked = interview.indexOf('await mayReadLinkedRepo(');
    expect(asked).toBeGreaterThan(-1);
    // the host is the canonical one acceptGithubHost answers with, not the link's spelling (https://GitHub.com/x/y would be taken for an Enterprise host, and sent its token)
    expect(interview).toMatch(/const linkHost = m \? acceptGithubHost\(m\[1\], process\.env\) : '';/);
    expect(interview).toMatch(/login: githubUsername,/);
    expect(interview.indexOf('if (mine) {')).toBeGreaterThan(asked);
    for (const assignment of ['submissionGithubHost = linkHost;', 'submissionRepoOwner = m[2];', 'submissionRepoName = linkedRepo;']) {
      expect(interview.indexOf(assignment), assignment).toBeGreaterThan(interview.indexOf('if (mine) {'));
      expect(interview.match(new RegExp(assignment.replace(/[[\]]/g, '\\$&'), 'g')), assignment).toHaveLength(1);
    }
    // the check asks GitHub through runLegacyPy (not callPy: its errors reach the student), for the student's login as the author
    expect(interview).toMatch(/runLegacyPy\('github_api\.py', \{ action: 'commits', params: \{ owner: m\[2\], repo: linkedRepo, author: login, limit: '1' \} \}/);
  });

  it('says in its arguments that the ids are for the admin channel only', () => {
    expect(interview).toMatch(/canvas_user_id: z\.string\(\)\.optional\(\)\.describe\('Canvas user ID to fetch submissions for\. Admin channel only/);
    expect(interview).toMatch(/github_username: z\.string\(\)\.optional\(\)\.describe\('Student GitHub username\. Admin channel only/);
  });
});
