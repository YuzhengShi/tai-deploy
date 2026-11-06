/**
 * NanoClaw Agent Runner, pi edition.
 *
 * The same container protocol as index.ts (protocol.ts), the conversation run by pi (@earendil-works/pi-coding-agent) instead of Claude
 * Code: pi speaks the OpenAI chat-completions API to the gateway, which Cerebras speaks itself, where Claude Code spoke Anthropic's and
 * went through the gateway's translation (the merged parallel tool calls, the replayed thinking blocks of eval/RESULTS.md); and its
 * own prompt and tool declarations are about 6 KB where Claude Code's are 73 KB.
 *
 * What the model sees: the persona (groups/global/CLAUDE.md) and one static note as the system prompt, the same bytes for every student
 * and every session so Cerebras's prefix cache serves them (prompt.ts); the date, and what the host remembers of the student, in
 * front of the first message of a run. Tools: pi's read, write, edit, bash, grep, find, a web_fetch of our own, and the MCP tools
 * (nanoclaw, leanrag) declared directly, named mcp__<server>__<tool> as in Claude Code.
 *
 * Nothing the model can write is configuration: /workspace/group is pi's working directory, and the model writes there, so pi is
 * started with no discovery (no extensions, skills, prompt templates, themes or context files from the working directory or the home
 * directory, settings and MCP servers in memory, a temporary agent directory) and is given exactly what is listed below. The
 * credentials the host hands over live in this process's memory: the model's key goes to pi's runtime, the others to the MCP server that
 * needs them; the shell commands the agent runs get the container's environment without anything named like a credential.
 *
 * Messages are answered in the order they arrive, one prompt at a time; a message that comes in while one is being answered waits its
 * turn (index.ts piped it into the running query, which answered it after the current turn: the same order).
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createBashToolDefinition,
  createMcpExtension,
  defineTool,
  type AgentSession,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import { Type } from '@earendil-works/pi-ai';
import { classifyProviderError, type ApiFailureKind } from './api-errors.js';
import { newTurnCounters, secretEnvNames, type TurnCounters } from './guards.js';
import { buildMcpServers } from './mcp-servers.js';
import { createPiGuard, type PiGuard } from './pi-guards.js';
import { ProgressReporter } from './progress.js';
import { EMPTY_REPLY_NUDGE, bashEnv, findSessionFile, llmConfig, mcpEntries, stripEchoedHumanTurn, summarizeRun, type LlmConfig } from './pi-support.js';
import { piSystemPrompt, runContext, withRunContext } from './prompt.js';
import { StdinReader, envWithSecrets, failureOutput, idleOutput, log, sessionLimits, writeOutput, type ContainerInput, type SessionState } from './protocol.js';
import { appendInteraction, messageTexts, visibleText } from './session-log.js';
import { fetchPage } from './web-fetch.js';

const WORKSPACE = process.env['TAI_WORKSPACE_ROOT'] || '/workspace';
const HOME_DIR = process.env['TAI_HOME'] || os.homedir();
const GROUP_DIR = path.join(WORKSPACE, 'group');
const SESSION_DIR = path.join(HOME_DIR, '.claude', 'pi-sessions'); // the host keeps this directory for the group (it is the .claude mount)
const PROVIDER = 'tai';
const DATE_REFRESH_MS = 5 * 60_000;
const MAX_INSTRUCTION_BYTES = 40_000;

/** The tools the model is given: pi's own, ours, and the MCP servers' (a pattern: only these MCP tools are kept). */
const TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'web_fetch', 'mcp__nanoclaw__*', 'mcp__leanrag__*'];

function readIfPresent(file: string, maxBytes = MAX_INSTRUCTION_BYTES): string | undefined {
  try {
    const text = fs.readFileSync(file, 'utf-8');
    return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n[... cut]` : text;
  } catch {
    return undefined;
  }
}

/**
 * The files of instructions the container has beside the persona: those of the extra mounts (the host decides what is mounted) and,
 * for the admin chat only, the group's own CLAUDE.md. The host never writes one for a student's group, so a CLAUDE.md there is what
 * the model wrote itself, and the model writes in that folder at the bidding of whoever is talking to it: text it saved there would
 * come back as instructions in every later session. (Claude Code loaded it, from settingSources 'project'.)
 */
function instructionFiles(isMain: boolean): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];
  const own = isMain ? readIfPresent(path.join(GROUP_DIR, 'CLAUDE.md')) : undefined;
  if (own?.trim()) files.push({ path: path.join(GROUP_DIR, 'CLAUDE.md'), content: own });
  const extraBase = path.join(WORKSPACE, 'extra');
  try {
    for (const entry of fs.readdirSync(extraBase).sort()) {
      const file = path.join(extraBase, entry, 'CLAUDE.md');
      const text = readIfPresent(file);
      if (text?.trim()) files.push({ path: file, content: text });
    }
  } catch {
    // no extra mounts
  }
  return files;
}

/** The web page tool pi does not have. Restricted (a student's agent) it stays out of the container's own network. */
function webFetchTool(restricted: boolean) {
  return defineTool({
    name: 'web_fetch',
    label: 'Web fetch',
    description:
      'Fetch a public web page (http or https) and return its text. Pages that are not text (PDF, images) are not shown. ' +
      'Pass max_chars to read more of a long page (default 12000, at most 30000).',
    parameters: Type.Object({
      url: Type.String({ description: 'The http(s) address of the page' }),
      max_chars: Type.Optional(Type.Number({ description: 'How many characters of the page to return' })),
    }),
    async execute(_toolCallId, params, signal) {
      const page = await fetchPage(params.url, { restricted, maxChars: params.max_chars, signal });
      const head = `${page.url} (${page.status}${page.contentType ? `, ${page.contentType}` : ''})`;
      return { content: [{ type: 'text' as const, text: `${head}\n\n${page.text}` }], details: { url: page.url, status: page.status, truncated: page.truncated } };
    },
  });
}

/**
 * What the runner adds to pi: the guards on every tool call, a shell without credentials in its environment, web_fetch, and the progress
 * the student's page shows (progress.ts). pi awaits an extension's handler inside its own event loop, so the three below only observe: they
 * return nothing, change nothing and cannot fail (the reporter swallows its own errors).
 */
function taiExtension(guard: PiGuard, restricted: boolean, reporter: ProgressReporter, stream: boolean) {
  return (pi: ExtensionAPI) => {
    pi.on('tool_call', async (event) => {
      return (await guard(event.toolName, event.input as Record<string, unknown>)) ?? undefined;
    });
    pi.on('turn_start', () => {
      reporter.thinking();
    });
    // The words of the reply as they are written (docs/STREAMING.md). Registered only when the host asked for them (TAI_PORTAL_STREAM=1): without it
    // pi has no handler for these events at all. They too only observe: a delta is appended to a string and, at most every 150 ms, written to stdout.
    if (stream) {
      pi.on('message_start', (event) => {
        if ((event.message as { role?: string }).role === 'assistant') reporter.messageStart();
      });
      pi.on('message_update', (event) => {
        const update = event.assistantMessageEvent;
        if (update.type === 'text_delta') reporter.textDelta(update.delta);
        else if (update.type === 'toolcall_start') reporter.toolCallStart();
      });
      pi.on('message_end', () => {
        reporter.messageEnd();
      });
    }
    // a call another tool made (pi's codemode, which is off here) is part of the call that made it
    pi.on('tool_execution_start', (event) => {
      if (!event.parentToolCallId) reporter.toolStart(event.toolCallId, event.toolName, event.args);
    });
    pi.on('tool_execution_end', (event) => {
      if (!event.parentToolCallId) reporter.toolEnd(event.toolCallId, event.result, event.isError);
    });
    // a tool of the same name replaces the built-in one: bash, without the PI_* variables that name the session file and model, and
    // without anything that looks like a credential
    pi.registerTool(
      createBashToolDefinition(GROUP_DIR, {
        exposeSessionEnvironment: false,
        spawnHook: (ctx) => ({ ...ctx, env: bashEnv(ctx.env as Record<string, string | undefined>) }),
      }) as never,
    );
    pi.registerTool(webFetchTool(restricted) as never);
  };
}

class PiRunner {
  private session: AgentSession | null = null;
  private sessionId: string | undefined;
  private resumed = false;
  private memoryInjected = false;
  private lastDateAt: number | null = null;
  private readonly state: SessionState = { turns: 0, contextTokens: 0 };
  private readonly queue: string[] = [];
  private eof = false;
  /** How many follow-up messages the host has sent that this runner has taken in (ContainerOutput.received): the host compares it with what it piped. */
  private received = 0;
  private readonly reporter: ProgressReporter;
  /** The host asked for the reply's words as they are written (TAI_PORTAL_STREAM=1; never for the admin chat or a scheduled task). */
  private readonly stream: boolean;
  private readonly counters: TurnCounters = newTurnCounters();
  private readonly limits: { maxTurns: number; maxContextTokens: number };
  private readonly secretNames: string[];
  private readonly llm: LlmConfig;
  private readonly timeZone = process.env['TZ'] || 'UTC';
  private modelRuntime!: ModelRuntime;
  private resourceLoader!: DefaultResourceLoader;
  private settingsManager!: SettingsManager;
  private agentDir!: string;

  constructor(
    private readonly input: ContainerInput,
    private readonly env: Record<string, string | undefined>,
    private readonly stdin: StdinReader,
  ) {
    this.limits = sessionLimits(env);
    this.secretNames = secretEnvNames(input.secrets, env);
    this.llm = llmConfig(env);
    this.sessionId = input.sessionId;
    // a scheduled task has no student looking at it: it says nothing about what it does
    this.stream = env['TAI_PORTAL_STREAM'] === '1' && !input.isMain && !input.isScheduledTask;
    this.reporter = new ProgressReporter({ enabled: !input.isScheduledTask, workspace: WORKSPACE, stream: this.stream });
  }

  /** Messages the host piped before this runner was started are folded into the first prompt (main()): they count as received. */
  noteReceived(count: number): void {
    this.received += count;
  }

  // --- set-up, once per container ---------------------------------------------------------------------------------------------

  async init(): Promise<void> {
    // pi's own state (settings, credentials, MCP log) goes to a directory of its own, not to anything the model can write
    this.agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-agent-'));
    process.env['PI_CODING_AGENT_DIR'] = this.agentDir;
    process.env['PI_OFFLINE'] = '1';
    process.env['PI_SKIP_VERSION_CHECK'] = '1';
    process.env['PI_TELEMETRY'] = '0';

    this.settingsManager = SettingsManager.inMemory(
      {
        compaction: { enabled: false }, // the session cap retires a session long before its window is full
        retry: { enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60_000, provider: { timeoutMs: 120_000, maxRetries: 0 } },
        httpIdleTimeoutMs: 120_000,
        cacheWarming: 'off',
        enableInstallTelemetry: false,
        transport: 'sse',
        images: { blockImages: true },
      },
      { projectTrusted: false },
    );

    this.modelRuntime = await ModelRuntime.create({
      authPath: path.join(this.agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    this.modelRuntime.registerProvider(PROVIDER, {
      name: 'TAi gateway',
      baseUrl: this.llm.baseUrl,
      api: this.llm.api,
      models: [
        {
          id: this.llm.modelId,
          name: this.llm.modelId,
          reasoning: false,
          input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: this.llm.contextWindow,
          maxTokens: this.llm.maxTokens,
          ...(this.llm.api === 'openai-completions'
            ? {
                compat: {
                  supportsStore: false,
                  supportsDeveloperRole: false,
                  supportsReasoningEffort: false,
                  supportsUsageInStreaming: true,
                  supportsStrictMode: false,
                  maxTokensField: 'max_tokens' as const,
                  sendSessionAffinityHeaders: false,
                },
              }
            : {}),
        },
      ],
    });
    await this.modelRuntime.setRuntimeApiKey(PROVIDER, this.llm.apiKey);

    const persona = this.readPersona();
    const here = path.dirname(fileURLToPath(import.meta.url));
    const servers = buildMcpServers(process.env['TAI_MCP_SERVER_PATH'] || path.join(here, 'ipc-mcp-stdio.js'), this.input, this.env);
    const entries = mcpEntries(servers);
    const guard = createPiGuard({ isMain: this.input.isMain, secretNames: this.secretNames, counters: this.counters, cwd: GROUP_DIR });

    this.resourceLoader = new DefaultResourceLoader({
      cwd: GROUP_DIR,
      agentDir: this.agentDir,
      settingsManager: this.settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [
        createMcpExtension({
          loadConfig: () => ({ servers: entries as never, errors: [], autoEnableCodemode: false }),
          logPath: path.join(this.agentDir, 'mcp.log'),
          updateConfig: () => undefined,
          startupWaitMs: 30_000, // the first message waits for the servers to connect: the model should see their tools in its first request
        }),
        taiExtension(guard, !this.input.isMain, this.reporter, this.stream),
      ],
      systemPromptOverride: () => piSystemPrompt(persona),
      appendSystemPromptOverride: () => [],
      agentsFilesOverride: () => ({ agentsFiles: instructionFiles(this.input.isMain) }),
    });
    await this.resourceLoader.reload();
  }

  private readPersona(): string | undefined {
    // Main also loads the persona, so the admin can test the teaching persona in the same DM.
    const file = this.input.isMain ? path.join(WORKSPACE, 'project', 'groups', 'global', 'CLAUDE.md') : path.join(WORKSPACE, 'global', 'CLAUDE.md');
    return readIfPresent(file, 200_000);
  }

  // --- the session ---------------------------------------------------------------------------------------------------------------

  private async openSession(): Promise<void> {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
    let sessionManager: SessionManager | undefined;
    this.resumed = false;
    const file = findSessionFile(SESSION_DIR, this.sessionId);
    if (file) {
      try {
        sessionManager = SessionManager.open(file, SESSION_DIR, GROUP_DIR);
        this.resumed = true;
      } catch (err) {
        log(`Could not open session ${this.sessionId}: ${err instanceof Error ? err.message : String(err)}; starting a new one`);
      }
    } else if (this.sessionId) {
      log(`No pi session ${this.sessionId} here (another harness's id, or lost): starting a new one`);
    }
    sessionManager ??= SessionManager.create(GROUP_DIR, SESSION_DIR);

    const model = this.modelRuntime.getModel(PROVIDER, this.llm.modelId);
    if (!model) throw new Error(`model ${PROVIDER}/${this.llm.modelId} is not registered`);
    const { session } = await createAgentSession({
      cwd: GROUP_DIR,
      agentDir: this.agentDir,
      modelRuntime: this.modelRuntime,
      model,
      thinkingLevel: 'off',
      tools: TOOLS,
      resourceLoader: this.resourceLoader,
      sessionManager,
      settingsManager: this.settingsManager,
    });
    await session.bindExtensions({});
    this.session = session;
    this.sessionId = session.sessionId;
    this.memoryInjected = false;
    this.state.turns = session.getSessionStats().userMessages;
    this.state.contextTokens = 0;

    // A session that has already had its turns is not resumed (the container that answered last may have been stopped before it said so)
    if (this.resumed && this.state.turns >= this.limits.maxTurns) {
      log(`Session ${this.sessionId} already had ${this.state.turns} answers: starting a new one`);
      await this.retire(false);
      this.sessionId = undefined;
      return this.openSession();
    }
    // "Session initialized" is what eval/harness/sched.py looks for, as index.ts logs it
    log(`Session initialized: ${this.sessionId} (${this.resumed ? `resumed, ${this.state.turns} messages so far` : 'new'}), tools: ${session.getActiveToolNames().join(', ')}`);
  }

  /** Let go of the session; the host forgets it too when told to (the next message then starts a new one). */
  private async retire(tellHost: boolean): Promise<void> {
    const session = this.session;
    this.session = null;
    this.resumed = false;
    this.state.turns = 0;
    this.state.contextTokens = 0;
    this.memoryInjected = false;
    try {
      session?.dispose();
    } catch (err) {
      log(`Could not dispose the session: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (tellHost) {
      this.sessionId = undefined;
      writeOutput({ status: 'success', result: null, resetSession: true });
    }
  }

  // --- one message ----------------------------------------------------------------------------------------------------------------

  /** What goes in front of this message: the date every few minutes, the student's memory once per session. */
  private withContext(prompt: string): string {
    const now = new Date();
    const needDate = this.lastDateAt === null || now.getTime() - this.lastDateAt >= DATE_REFRESH_MS;
    const needMemory = !this.memoryInjected;
    if (!needDate && !needMemory) return prompt;
    this.lastDateAt = now.getTime();
    this.memoryInjected = true;
    const memory = needMemory ? readIfPresent(path.join(GROUP_DIR, 'memory_context.md')) : undefined;
    return withRunContext(runContext({ now, timeZone: this.timeZone, memory, resumed: this.resumed }), prompt);
  }

  private recordExchange(student: string, reply: string | null): void {
    if (this.input.isMain || this.input.isScheduledTask || !reply || !student) return;
    const shown = visibleText(reply);
    if (!shown) return;
    try {
      appendInteraction(GROUP_DIR, new Date(), student, shown);
    } catch (err) {
      log(`Could not record the exchange: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Answer one message. Returns false when the container should stop. */
  private async answer(prompt: string): Promise<boolean> {
    const student = messageTexts(prompt).filter((t) => !t.startsWith('[SYSTEM]')).join(' / ');
    if (!this.session) await this.openSession();
    const session = this.session!;
    const before = session.messages.length;
    this.counters.webFetch = 0;
    this.reporter.beginTurn();

    const started = Date.now();
    try {
      await session.prompt(this.withContext(prompt), { expandPromptTemplates: false, source: 'rpc' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (this.stdin.isClosed) {
        log(`The run was cut short by shutdown: ${message}`);
        return false;
      }
      if (!this.resumed && this.state.turns === 0) {
        log(`Agent error on a fresh session: ${message}`);
        writeOutput({ status: 'error', result: null, newSessionId: this.sessionId, error: message });
        process.exit(1);
      }
      const failure = classifyProviderError(message) ?? { kind: 'other' as const, status: null };
      log(`The run failed (${failure.kind}): ${message.slice(0, 300)}`);
      await this.tellFailure(failure.kind);
      return true;
    }

    let run = summarizeRun(session.messages.slice(before));

    // A turn can end with nothing for the student in it: an empty message, "...", a note like "response already sent above" (qwen writes
    // these when it answered next to a tool call and then thinks it is done). Ask once more for the reply, unless the model spoke through
    // send_message, or this is a scheduled task, which may well end without a word.
    if (!run.failure && !run.text && !run.sentViaTool && !this.input.isScheduledTask) {
      log('The turn ended with nothing for the student in it: asking once more for the reply');
      try {
        await session.prompt(EMPTY_REPLY_NUDGE, { expandPromptTemplates: false, source: 'rpc' });
      } catch (err) {
        log(`The second ask failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      run = summarizeRun(session.messages.slice(before));
    }

    for (const call of run.calls) {
      log(`[usage] input=${call.input} cacheRead=${call.cacheRead} cacheWrite=${call.cacheWrite} output=${call.output}`);
    }
    log(`Run done in ${((Date.now() - started) / 1000).toFixed(1)} s, ${run.calls.length} model call(s), context ${run.contextTokens ?? 'unknown'} tokens`);

    // A failed model request (after pi's own retries): tell the student something human. Only an overflow clears the session; a busy
    // provider or a 500 does not (upstream called every 500 "memory too full").
    if (run.failure) {
      log(`Model API failure (${run.failure.kind}${run.failure.status ? ' ' + run.failure.status : ''})`);
      await this.tellFailure(run.failure.kind);
      return true;
    }

    this.state.turns = session.getSessionStats().userMessages;
    if (run.contextTokens !== null) this.state.contextTokens = run.contextTokens;
    const text = stripEchoedHumanTurn(run.text);
    this.recordExchange(student, text);
    writeOutput({ status: 'success', result: text || null, newSessionId: this.sessionId });
    return true;
  }

  private async tellFailure(kind: ApiFailureKind): Promise<void> {
    if (kind === 'overflow') {
      await this.retire(false);
      this.sessionId = undefined;
    }
    // the apology is the student's answer, so the status stays "success"; apiFailure tells the host's scheduler that a task did nothing
    writeOutput(failureOutput(kind, this.sessionId));
  }

  // --- the loop --------------------------------------------------------------------------------------------------------------------

  /** Move what arrived on stdin while a message was being answered into the queue. */
  private pump(): void {
    for (const line of this.stdin.drainBuffered()) this.take(line);
    if (this.stdin.isClosed) this.eof = true;
  }

  private take(line: string): void {
    try {
      const msg = JSON.parse(line);
      if (msg.type === 'message' && msg.text) {
        log(`Message queued (${msg.text.length} chars)`);
        this.queue.push(msg.text);
        this.received++;
      } else {
        log(`Unknown stdin message type: ${msg.type}, skipping`);
      }
    } catch (err) {
      log(`Failed to parse stdin line: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async run(firstPrompt: string): Promise<void> {
    let prompt: string | null = firstPrompt;
    while (prompt !== null) {
      const pumping = setInterval(() => this.pump(), 100);
      let carryOn: boolean;
      try {
        carryOn = await this.answer(prompt);
      } finally {
        clearInterval(pumping);
      }
      this.pump();
      if (!carryOn) break;

      // The session has had its turns (or its context is full): the next message starts a new one.
      if (this.session && (this.state.turns >= this.limits.maxTurns || this.state.contextTokens >= this.limits.maxContextTokens)) {
        log(`Session retired after ${this.state.turns} answers and ${this.state.contextTokens} context tokens`);
        await this.retire(true);
      }

      prompt = this.queue.shift() ?? null;
      if (prompt !== null) continue;
      // The turn is over and nothing more is queued: say so. The host starts its idle timer on it (for a scheduled task a few seconds, however
      // empty the answer was) and a task that never says it is done counts as one that did not finish. So it is said whatever happened in the
      // turn: also when the session was retired in it (the session cap, an overflow: no session id then, which the host ignores) and when the
      // host has already closed our stdin. `received` lets the host see whether a message it piped after the last one is still on its way here.
      writeOutput(idleOutput(this.sessionId, this.received));
      if (this.eof) {
        log('EOF consumed during the run, exiting');
        break;
      }
      // Wait for the next message or EOF.
      while (prompt === null) {
        const line = await this.stdin.nextLine();
        if (line === null) {
          log('EOF received, exiting');
          await this.close();
          return;
        }
        this.take(line);
        prompt = this.queue.shift() ?? null;
      }
    }
    await this.close();
  }

  private async close(): Promise<void> {
    try {
      this.session?.dispose();
    } catch {
      // exiting anyway
    }
    this.session = null;
    try {
      fs.rmSync(this.agentDir, { recursive: true, force: true });
    } catch {
      // a temporary directory
    }
  }
}

async function main(): Promise<void> {
  const stdinReader = new StdinReader();
  let containerInput: ContainerInput;

  try {
    const firstLine = await stdinReader.nextLine();
    if (firstLine === null) {
      writeOutput({ status: 'error', result: null, error: 'Empty stdin (no input received)' });
      process.exit(1);
    }
    containerInput = JSON.parse(firstLine);
    log(`Received input for group: ${containerInput.groupFolder} (pi)`);
  } catch (err) {
    writeOutput({ status: 'error', result: null, error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}` });
    process.exit(1);
  }

  // The settings the host handed over, for this runner's own use. They never touch process.env, which the shell commands the agent
  // runs inherit (and which the MCP servers inherit a part of).
  const env = envWithSecrets(containerInput);

  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = stdinReader.drainBuffered();
  let folded = 0;
  if (pending.length > 0) {
    log(`Draining ${pending.length} buffered stdin messages into initial prompt`);
    const texts: string[] = [];
    for (const line of pending) {
      try {
        const msg = JSON.parse(line);
        if (msg.type === 'message' && msg.text) texts.push(msg.text);
      } catch {
        /* skip malformed lines */
      }
    }
    if (texts.length > 0) prompt += '\n' + texts.join('\n');
    folded = texts.length;
  }

  const runner = new PiRunner(containerInput, env, stdinReader);
  runner.noteReceived(folded);
  try {
    await runner.init();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Could not start pi: ${message}`);
    writeOutput({ status: 'error', result: null, error: `Could not start the agent: ${message}` });
    process.exit(1);
  }
  await runner.run(prompt);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    const message = err instanceof Error ? err.stack || err.message : String(err);
    log(`Fatal: ${message}`);
    writeOutput({ status: 'error', result: null, error: message });
    process.exit(1);
  });
