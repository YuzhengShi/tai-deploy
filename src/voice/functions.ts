/**
 * The functions the voice agent may call (docs/VOICE.md, "The functions the Think step may call"): sixteen in the conversational mode,
 * six in the interviewer mode, six in the listener mode of a talk-it-through. Their descriptions are training documents in the design's sense: WHEN TO CALL, CORRECT and WRONG
 * PATTERN, because a model that hears a student says more and calls tools less reliably than one that reads a chat.
 *
 * The interviewer reads the student's own code (query_github: their account, three actions) and puts a short excerpt of the file under discussion on
 * their screen (send_to_chat); the guard on that (checkExcerpt) lets through only lines of a file this call has read, the way a link goes to the chat
 * only if a look-up in this call returned it.
 *
 * Most of them are a tool of the student's agent container, reached through the call's tool host, so each keeps its own access control
 * and identity binding (Canvas and GitHub answer for THIS student only). read_competency and update_competency are host code on the group
 * folder. start_interview, end_interview, start_talk_through, end_talk_through, end_session and evaluate_answer change the call itself
 * and live in session.ts.
 *
 * When the tool host is down, the functions that only drop a file for the orchestrator's IPC watcher (save_memory, send_to_chat,
 * schedule_task) write that file themselves (data/ipc/<folder>/...): the watcher authorizes by the directory, exactly as for the container.
 */
import fs from 'fs';
import path from 'path';

import { CompetencyGuard, competencyForTopic, readText, summarizeCompetency } from './competency.js';
import { compactAssignmentDetail, compactFiles, compactModules, findInCourse, matchAssignment, seenUrl, urlsIn } from './canvas-text.js';
import { memoriesFromStore } from './context-builder.js';
import { newRequestId } from './ipc-answer.js';
import { compactFile, compactRepos, compactTree, readFileAnswer } from './interview-repo.js';
import type { ToolHost, ToolResult } from './tool-host.js';
import type { AgentMode, VoiceLog } from './types.js';

export interface FunctionDef {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
  /** Deepgram: hold the call until the student's turn is confirmed (side effects must not fire on a speculative end of turn). */
  defer_until_eot?: boolean;
}

export const RESULT_CAP = 6000;

const MEMORY_CATEGORIES = ['student_preference', 'decision', 'breakthrough', 'misconception', 'concept', 'homework', 'identity', 'other'];
const CANVAS_ACTIONS = ['upcoming', 'assignments', 'assignment_detail', 'my_grades', 'student_submission', 'find', 'files', 'file_content', 'modules', 'module_items', 'pages', 'page_detail', 'syllabus', 'announcements', 'discussions', 'discussion_detail', 'discussion_entries'];
const GITHUB_ACTIONS = ['list_repos', 'repo_tree', 'file_content', 'commits', 'commit_detail', 'pull_requests', 'pr_detail', 'check_runs'];
/** What the interviewer may ask of GitHub: their repositories, a folder, a file. Commits and pull requests are for the conversation. */
const INTERVIEW_GITHUB_ACTIONS = ['list_repos', 'repo_tree', 'file_content'];
const PIAZZA_ACTIONS = ['search', 'recent_posts', 'get_post', 'get_pinned', 'get_by_tag', 'list_tags', 'stats'];

const queryKnowledge: FunctionDef = {
  name: 'query_knowledge',
  description:
    "Search the CS6650 course knowledge base (Professor Coady's lectures, readings and assignments) for grounded information.\n\n" +
    'WHEN TO CALL:\n- BEFORE you explain or ask about any technical concept, so what you say matches the course, not general knowledge\n- When the student asks how something works in the course (Raft, consistent hashing, Kafka, Little\'s Law...)\n\n' +
    'CORRECT PATTERN:\n1. Student asks about a concept\n2. Call query_knowledge with their question\n3. Answer in one or two sentences grounded in the result, then ask one question\n\n' +
    'WRONG PATTERN:\n- Saying "let me look that up" and then calling it (the pause is short, just call it)\n- Reading the result aloud',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: "The topic or question to search for (e.g. 'How does Raft handle leader failure?')" },
      difficulty: { type: 'string', enum: ['entity', 'cluster', 'theme'], description: "'entity' for a specific fact, 'cluster' for a topic, 'theme' for broad connections" },
    },
    required: ['question'],
  },
};

const readCompetency: FunctionDef = {
  name: 'read_competency',
  description:
    "Read the student's competency model: mastery per concept (confidence, stability, scope), verbal gaps and active misconceptions. The summary is already in your history from the start of the call.\n\n" +
    'WHEN TO CALL:\n- To check one topic in detail before teaching or quizzing it (pass the topic)\n- In an interview, to pick a weak spot to probe\n\n' +
    'WRONG PATTERN:\n- Telling the student their scores',
  parameters: {
    type: 'object',
    properties: { topic: { type: 'string', description: "Optional: one topic (e.g. 'Raft consensus'); omit for the whole summary" } },
  },
};

/** In both modes: what a student should see or keep, and the one place a model may say it has put something in the chat. */
const sendToChat: FunctionDef = {
  name: 'send_to_chat',
  description:
    'Put text in the chat on this page: a code snippet, a link, steps, a short written summary, anything the student should SEE or keep.\n\n' +
    'WHEN TO CALL:\n- Code, commands, URLs, lists: never speak those, send them\n- The student asks you to write something down\n\n' +
    'CORRECT PATTERN:\n1. Call send_to_chat with the content (markdown is fine)\n2. Once it has returned, tell them it is in the chat (it has not gone before that)\n\n' +
    'WRONG PATTERN:\n- Sending your spoken sentence again\n- Sending what you can say in one sentence (a deadline, a grade, a yes or a no) instead of saying it\n- Long essays: keep it to what they need',
  parameters: { type: 'object', properties: { message: { type: 'string', description: 'The text to show (markdown and ```code``` blocks work)' } }, required: ['message'] },
  defer_until_eot: true,
};

const conversational: FunctionDef[] = [
  queryKnowledge,
  {
    name: 'recall_memory',
    description:
      'Search what you remember about this student (preferences, breakthroughs, what worked before) and your past conversations with them.\n\n' +
      'WHEN TO CALL:\n- The student refers to something from before ("like last time", "that thing with Docker")\n- You want to personalize an explanation\n\n' +
      'WRONG PATTERN:\n- Calling it every turn: the most useful memories are already in your history',
    parameters: { type: 'object', properties: { query: { type: 'string', description: "Keywords (e.g. 'learning style', 'Docker misconception')" } }, required: ['query'] },
  },
  {
    name: 'save_memory',
    description:
      'Remember one fact about this student for future conversations.\n\n' +
      'WHEN TO CALL:\n- A breakthrough ("it clicked when we compared Raft to an election")\n- A preference or approach that works or fails for them\n- Important context they share (goals, constraints)\n\n' +
      'WRONG PATTERN:\n- Routine facts, or what is already remembered\n- Telling the student you are saving it',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The fact, in one or two specific sentences' },
        category: { type: 'string', enum: MEMORY_CATEGORIES, description: 'What kind of fact it is (decides how long it is kept)' },
      },
      required: ['content'],
    },
    defer_until_eot: true,
  },
  readCompetency,
  {
    name: 'update_competency',
    description:
      "Record what the student just demonstrated about ONE concept.\n\n" +
      'WHEN TO CALL:\n- They explained a concept correctly in their own words (positive confidence_delta, about +0.1 to +0.2)\n- They were confused or wrong (small negative delta)\n- You found a misconception they genuinely hold\n\n' +
      'CORRECT PATTERN:\n1. Student explains election timeouts correctly\n2. Call update_competency(concept "Raft leader election", confidence_delta 0.15, notes "explained timeouts in own words")\n3. Continue the conversation without mentioning it\n\n' +
      'WRONG PATTERN:\n- Calling it for small talk or a single "yes"\n- Several concepts in one call (one call per concept)\n- Telling the student you recorded anything',
    parameters: {
      type: 'object',
      properties: {
        concept: { type: 'string', description: "The concept (e.g. 'Raft leader election')" },
        confidence_delta: { type: 'number', description: 'Change in confidence, -0.3 to +0.3. Positive = demonstrated understanding.' },
        new_scope: { type: 'string', enum: ['theoretical', 'implementation', 'debugging', 'verbal'], description: 'A new way they demonstrated it, if any' },
        misconception: { type: 'string', description: 'A wrong belief they genuinely hold, if you found one' },
        notes: { type: 'string', description: "Brief note (e.g. 'explained Raft timeout clearly in own words')" },
      },
      required: ['concept'],
    },
    defer_until_eot: true,
  },
  {
    name: 'query_canvas',
    description:
      "Look up the course on Canvas for THIS student: deadlines, assignments and what each one asks, their own grades and submissions, announcements, modules, pages, the syllabus, and the course files. You CAN read slides, PDFs and pages.\n\n" +
      'WHEN TO CALL:\n- Deadlines ("when is HW5 due?"): upcoming (the nearest ones) or assignments (all)\n- What an assignment is about or asks: assignment_detail with assignment_id (the number, or its name); say only what the description says\n- Their grades: my_grades; their submission for one assignment: student_submission with assignment_id\n- Slides, readings, a page, "do you have the Raft PDF?": find with query ("raft"; the course names its PDFs by day or week, like "Day1 lecture ONLINE 2026", so for any slides find "lecture" or the day), then file_content with the file_id (or page_detail with the page_url) to READ it, then answer from what it says\n\n' +
      'CORRECT PATTERN:\n1. find, query "raft slides"\n2. file_content, file_id from the answer\n3. One or two sentences from what the slides say, then one question\n\n' +
      'WRONG PATTERN:\n- Describing an assignment or a deck you have not read, from its name\n- Making up a link or an id: use what a lookup returned\n- Reading long lists aloud: say the one thing that matters',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: CANVAS_ACTIONS, description: 'What to look up (find searches the files, modules and pages for words)' },
        assignment_id: { type: 'string', description: 'An assignment, for assignment_detail and student_submission: its number from an assignments lookup, or its name' },
        query: { type: 'string', description: 'Words from the title of what to look for, for find (e.g. "raft slides", "week 7 reading")' },
        file_id: { type: 'string', description: 'A file, for file_content (from files, find or modules)' },
        page_url: { type: 'string', description: 'A page, for page_detail (its short name from pages, find or modules)' },
        module_id: { type: 'string', description: 'A module, for module_items (from modules)' },
        topic_id: { type: 'string', description: 'A discussion, for discussion_detail and discussion_entries (from discussions)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'query_github',
    description:
      "Look at the student's GitHub repositories: list them, browse a repo, read a file, see commits and pull requests. It answers for this student's own account and the course organisations only.\n\n" +
      'WHEN TO CALL:\n- The student talks about their code ("my server keeps crashing")\n- Before discussing an implementation decision\n\n' +
      'CORRECT PATTERN:\n1. list_repos to find the repo, if you do not know it\n2. repo_tree, then file_content of the relevant file\n3. Ask about one specific line or decision\n\n' +
      'WRONG PATTERN:\n- Reading code aloud: talk about it, or put a snippet in the chat with send_to_chat',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: GITHUB_ACTIONS, description: 'What to look up' },
        repo: { type: 'string', description: 'Repository name only (no owner), for everything but list_repos' },
        path: { type: 'string', description: 'File or folder path inside the repo (file_content, repo_tree)' },
        owner: { type: 'string', description: "Optional: the account or course organisation; omit for the student's own" },
        sha: { type: 'string', description: 'Commit sha, for commit_detail' },
        number: { type: 'string', description: 'Pull request number, for pr_detail' },
      },
      required: ['action'],
    },
  },
  {
    name: 'query_piazza',
    description:
      'Search the course Piazza forum: questions other students asked, instructor answers, pinned posts.\n\n' +
      'WHEN TO CALL:\n- Class-wide confusion about a topic, or "did anyone ask about X?"\n- Before a mock interview, to find what the student posted for the assignment\n\n' +
      'WRONG PATTERN:\n- Quoting a whole post: say what it means in one sentence',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: PIAZZA_ACTIONS, description: 'search (with query), recent_posts, get_post (with post_id), get_pinned, get_by_tag (with tag), list_tags, stats' },
        query: { type: 'string', description: 'Search words, for search' },
        post_id: { type: 'string', description: 'Post number, for get_post' },
        tag: { type: 'string', description: 'A tag, for get_by_tag' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browse_url',
    description:
      'Fetch a public web page and get its text: documentation, a paper, a tutorial the student or the course mentions.\n\n' +
      'WHEN TO CALL:\n- The student gives or names a URL and wants to talk about it\n\n' +
      'WRONG PATTERN:\n- Internal or private addresses (refused)\n- Reading the page aloud: summarize the one point that matters',
    parameters: { type: 'object', properties: { url: { type: 'string', description: 'The http(s) URL' } }, required: ['url'] },
  },
  {
    name: 'read_file',
    description:
      'Read a file the student attached in the chat (PDF, Word, Excel, PowerPoint, code or text): you CAN read all of these. The injected chat message names it; text files also arrive with their beginning. (A file of the course on Canvas is read with query_canvas file_content.)\n\n' +
      'WHEN TO CALL:\n- To read the whole of an attached file, or a document that arrived without its text\n\n' +
      'WRONG PATTERN:\n- Guessing file names that were never attached',
    parameters: { type: 'object', properties: { path: { type: 'string', description: "The file name as the chat message gave it (e.g. 'main.go' or '/workspace/group/uploads/main.go')" } }, required: ['path'] },
  },
  {
    name: 'render_diagram',
    description:
      'Draw a technical diagram from Mermaid syntax and put it in the chat on this page.\n\n' +
      'WHEN TO CALL:\n- A sequence, a state machine, an architecture or a flow is easier to see than to hear\n\n' +
      'CORRECT PATTERN:\n1. Call render_diagram with valid Mermaid and a short caption\n2. Once it has returned, tell them it is in the chat, in a few words\n3. Ask one question about it\n\n' +
      'WRONG PATTERN:\n- Describing the diagram line by line in voice',
    parameters: {
      type: 'object',
      properties: {
        mermaid_code: { type: 'string', description: 'Valid Mermaid diagram syntax (sequenceDiagram, flowchart, stateDiagram, ...)' },
        caption: { type: 'string', description: 'A short caption shown with the diagram in the chat' },
      },
      required: ['mermaid_code'],
    },
    defer_until_eot: true,
  },
  sendToChat,
  {
    name: 'schedule_task',
    description:
      'Schedule ONE follow-up message to this student at a later time (a reminder, a check-in on a concept, practice before a deadline).\n\n' +
      'WHEN TO CALL:\n- The student asks for a reminder\n- You agree to check back on something\n\n' +
      'CORRECT PATTERN:\n1. Agree on the time with the student\n2. Call schedule_task with what to do and when\n\n' +
      'WRONG PATTERN:\n- Scheduling without the student agreeing\n- Recurring schedules (one time only)',
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: "What the follow-up should do (e.g. 'Ask whether they practised explaining Raft log replication')" },
        when: { type: 'string', description: "Local time like '2026-05-21T09:00', or 'in 2 hours', 'tomorrow 9am', 'tonight'" },
      },
      required: ['description', 'when'],
    },
    defer_until_eot: true,
  },
  {
    name: 'start_interview',
    description:
      'Switch this call into mock interview mode (a different voice and an interviewer persona; the conversation so far is kept).\n\n' +
      'WHEN TO CALL:\n- The student has said which assignment or topic they want to practice (or said yes to the one you offered)\n- NEVER without the student agreeing, and NEVER with an assignment or topic you chose yourself\n\n' +
      'CORRECT PATTERN:\n1. Student: "let\'s do a mock interview"\n2. You: offer THIS WEEK\'s assignment by name in one short question (no list of options); only when you cannot tell which it is, ask which one\n3. WAIT for the answer\n4. Student: "yes" (or they name another assignment: "homework six")\n5. IMMEDIATELY call start_interview with the name you offered (or what they named), without saying anything else\n\n' +
      'WRONG PATTERN:\n- Calling it before the student has named the assignment or topic\n- Calling it mid-explanation without asking\n- Saying "let me switch to interview mode" and then calling it\n- Saying anything after calling it: the interviewer takes over',
    parameters: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: "The assignment or topic the STUDENT named, in their words (e.g. 'homework six', 'Raft consensus')" },
        assignment_id: { type: 'string', description: 'Optional: the Canvas assignment id, if you know it' },
      },
      required: ['topic'],
    },
    defer_until_eot: true,
  },
  {
    name: 'start_talk_through',
    description:
      'Switch this call into talk-it-through mode: the student explains something out loud and you only listen, then give your feedback (the conversation so far is kept).\n\n' +
      'WHEN TO CALL:\n- The student says they want to explain something, talk it through, practice explaining it, or think out loud about it\n- They said yes to your offer of it\n- NEVER because you decided they should, and never in the middle of your own explanation\n\n' +
      'CORRECT PATTERN:\n1. Student: "let me try explaining the CAP theorem to you"\n2. IMMEDIATELY call start_talk_through with their topic, without saying anything else\n(If they have not said what they want to explain, ask in one short question first, then call it with their answer.)\n\n' +
      'WRONG PATTERN:\n- Calling it for an ordinary question, or when they ask YOU to explain something\n- Saying "okay, I\'ll just listen" and then calling it: the listener takes over\n- Saying anything after calling it',
    parameters: {
      type: 'object',
      properties: { topic: { type: 'string', description: "What the STUDENT wants to explain, in their words (e.g. 'the CAP theorem', 'how Raft elects a leader')" } },
      required: ['topic'],
    },
    defer_until_eot: true,
  },
  {
    name: 'end_session',
    description:
      'End the voice call. The system writes a summary into the chat and updates the student\'s records.\n\n' +
      'WHEN TO CALL:\n- The student says goodbye, says they\'re done, or the conversation has naturally ended\n\n' +
      'CORRECT PATTERN:\n1. Say a short goodbye ("nice work today, talk soon!")\n2. Call end_session with a short note of what you covered\n\n' +
      'WRONG PATTERN:\n- Ending while the student is still asking something\n- Calling it before you said goodbye',
    parameters: { type: 'object', properties: { summary_note: { type: 'string', description: 'What was covered, in a sentence' } }, required: ['summary_note'] },
    defer_until_eot: true,
  },
];

/**
 * The interviewer's look at the student's own code, for the code walkthrough (prompts.ts): their repositories, the folders of one, a file. Three
 * actions and no `owner`: whatever the model passes, the account is the one the host bound to the student (dispatch), and the container checks it again.
 */
const interviewerGithub: FunctionDef = {
  name: 'query_github',
  description:
    "Read the student's OWN code for the code walkthrough: their repositories, the folders of one, a file. Only their own GitHub account answers: you cannot look at anyone else's.\n\n" +
    'WHEN TO CALL:\n- The walkthrough: after you picked a file from THEIR REPOSITORY in your prompt, read it (file_content, with that repo and that path) BEFORE you ask about it\n- repo_tree with a path, to see what is inside a folder when the list shows only the folder, or when the student names a repository that your prompt does not have\n- list_repos only when your prompt has no repository and the student says which one it is\n\n' +
    'CORRECT PATTERN:\n1. Pick one file from the list in your prompt\n2. Call query_github file_content with its repo and path, saying nothing\n3. Put a short excerpt of it in the chat (send_to_chat), then ask them to walk you through that part\n\n' +
    'WRONG PATTERN:\n- Reading code aloud: say a function name or one short line, nothing more\n- Guessing a repository or a path that nobody gave you\n- Reading a file and then telling them what is wrong with it or how to fix it\n- Reading more than two files: one or two are enough for an interview',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: INTERVIEW_GITHUB_ACTIONS, description: 'file_content reads a file, repo_tree lists a folder, list_repos lists their repositories' },
      repo: { type: 'string', description: 'Repository name only (no owner), from your prompt, for repo_tree and file_content' },
      path: { type: 'string', description: 'File or folder path inside the repo, exactly as your prompt or a folder listing gave it' },
    },
    required: ['action'],
  },
};

/**
 * In the interview, send_to_chat is how the page shows the file under discussion: a short fenced excerpt of what query_github returned, once for each
 * file. (Or, when the student asks to see the question written down, that one question.) The guard is checkExcerpt.
 */
const interviewerSendToChat: FunctionDef = {
  name: 'send_to_chat',
  description:
    "Put on the student's screen the part of THEIR file you are about to ask about: a short fenced excerpt, copied exactly from what query_github returned. (Only if they ask to see your question written down: that one question, in a short line.)\n\n" +
    'WHEN TO CALL:\n- Right after you read the file you picked, once for that file, before you ask them to walk you through it\n\n' +
    "CORRECT PATTERN:\n1. Read the file with query_github file_content\n2. Call send_to_chat with the file's name on the first line and at most 25 lines of it in a fenced block, copied exactly\n3. Once it has returned, say it is in the chat, in a few words, and ask your question\n\n" +
    'WRONG PATTERN:\n- More than 25 lines, or the whole file\n- Code you wrote, changed, fixed or shortened yourself: the chat refuses anything that is not in a file you read\n- Sending the same file twice\n- Answers, hints, explanations or the evaluation',
  parameters: {
    type: 'object',
    properties: { message: { type: 'string', description: "The excerpt: the file's name on the first line, then the lines in a ``` fenced block, copied exactly" } },
    required: ['message'],
  },
  defer_until_eot: true,
};

const interviewer: FunctionDef[] = [
  {
    name: 'evaluate_answer',
    description:
      "Score the student's answer to your last question, silently.\n\n" +
      'WHEN TO CALL:\n- After each substantive answer to one of your interview questions\n\n' +
      'CORRECT PATTERN:\n1. Student answers\n2. Call evaluate_answer, saying nothing\n3. Use the result to choose your next question (easier, harder, or a missed concept)\n\n' +
      'WRONG PATTERN:\n- Speaking the scores or "you missed X"\n- Calling it for small talk',
    parameters: {
      type: 'object',
      properties: {
        question_asked: { type: 'string', description: 'The question you just asked' },
        student_answer_summary: { type: 'string', description: 'A faithful summary of what the student said' },
        topic: { type: 'string', description: 'The CS6650 topic being tested' },
      },
      required: ['question_asked', 'student_answer_summary', 'topic'],
    },
    // with eager end-of-turn the model starts answering before the turn is confirmed: an evaluation of half an answer must not be scored
    defer_until_eot: true,
  },
  queryKnowledge,
  readCompetency,
  interviewerGithub,
  interviewerSendToChat,
  {
    name: 'end_interview',
    description:
      'End the mock interview and go back to the normal conversation (the results are recorded).\n\n' +
      'WHEN TO CALL:\n- You asked 8 to 10 questions and covered enough\n- The student wants to stop\n- You were told time is almost up\n\n' +
      'CORRECT PATTERN:\n1. Say one brief closing remark: something they did well and one thing to work on\n2. Call end_interview\n\n' +
      'WRONG PATTERN:\n- Ending without the closing remark\n- Reading out scores',
    parameters: {
      type: 'object',
      properties: {
        topics_covered: { type: 'string', description: 'Comma-separated topics you covered' },
        overall_impression: { type: 'string', description: 'A brief assessment for the record' },
      },
      required: ['topics_covered', 'overall_impression'],
    },
    defer_until_eot: true,
  },
];

const inTheTalk = (name: string): FunctionDef => conversational.find((f) => f.name === name)!;

/** The listener of a talk-it-through: it checks facts silently, credits what the student explained, remembers, and hands the call back. */
const listener: FunctionDef[] = [
  queryKnowledge,
  readCompetency,
  inTheTalk('update_competency'),
  inTheTalk('save_memory'),
  {
    name: 'end_talk_through',
    description:
      'End the talk-it-through and go back to the normal conversation (the notes are kept).\n\n' +
      'WHEN TO CALL:\n- After your feedback, their answer to your question and your two-sentence wrap-up\n- The student wants to stop, or you were told time is almost up\n\n' +
      'CORRECT PATTERN:\n1. Say the wrap-up (two plain sentences)\n2. Call update_competency for each concept they explained, and save_memory if something is worth keeping\n3. Call end_talk_through with a one-sentence summary\n\n' +
      'WRONG PATTERN:\n- Ending before your feedback\n- Telling them you recorded anything\n- Saying anything after calling it',
    parameters: {
      type: 'object',
      properties: { summary: { type: 'string', description: 'What they explained, what was strong and what to firm up, in one or two sentences' } },
      required: ['summary'],
    },
    defer_until_eot: true,
  },
  inTheTalk('end_session'),
];

export const CONVERSATIONAL_FUNCTIONS: readonly FunctionDef[] = conversational;
export const INTERVIEWER_FUNCTIONS: readonly FunctionDef[] = interviewer;
export const LISTENER_FUNCTIONS: readonly FunctionDef[] = listener;

export function functionsFor(mode: AgentMode): FunctionDef[] {
  return (mode === 'interviewer' ? interviewer : mode === 'listener' ? listener : conversational).map((f) => ({ ...f }));
}

/**
 * Functions that take seconds whatever they are asked, so that a short spoken filler goes out as soon as they are called: only the set-up of an
 * interview. A look-up that merely takes a while (GitHub, a web page, Piazza, Canvas) gets its filler from a timer once it has run a moment
 * (session.ts fillLongWait): an immediate "okay, checking." was said after the answer when TAi had already said "let me pull that up".
 */
export const SLOW_FUNCTIONS = new Set(['start_interview']);

/** Functions that go through the call's tool host (a container: it takes several seconds to start, and the first of them waits for it). */
export const TOOL_HOST_FUNCTIONS = new Set(['query_knowledge', 'query_canvas', 'query_github', 'query_piazza', 'browse_url', 'read_file', 'render_diagram']);

/**
 * The look-ups that may be answered provisionally when they run long (TAI_VOICE_ASYNC_AFTER_MS) and delivered later as a note. Only
 * what merely reads: a function with an effect (a message to the chat, a diagram, a memory, a competency change) must have finished
 * when the model is told it did, and the ones that change the call are not look-ups at all.
 */
export const PROMOTABLE_FUNCTIONS = new Set(['query_knowledge', 'query_canvas', 'query_github', 'query_piazza', 'browse_url', 'read_file', 'recall_memory']);

/** The functions session.ts runs itself (they change the call). */
export const CALL_FUNCTIONS = new Set(['start_interview', 'end_interview', 'start_talk_through', 'end_talk_through', 'end_session', 'evaluate_answer']);

/** A model's arguments (a JSON string) as an object; anything else is an empty object, and the function says what is missing. */
export function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.length > 200_000) return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** A function result as Deepgram gets it: at most RESULT_CAP characters. */
export function capResult(text: string, max = RESULT_CAP): string {
  if (text.length <= max) return text;
  const marker = '\n[... cut: ask for something narrower]';
  return text.slice(0, max - marker.length) + marker;
}

export function errorResult(message: string): string {
  return JSON.stringify({ error: message });
}

// ---------------------------------------------------------------- dispatch

export interface FunctionEnv {
  folder: string;
  jid: string;
  githubUsername?: string;
  groupDir: string;
  /** data/ipc/<folder> */
  ipcDir: string;
  /** Waits for the host's answer to a request this call wrote into its IPC tasks directory (ipc-answer.ts); without it a task request is taken as granted, as it always was. */
  awaitIpcAnswer?: (requestId: string, timeoutMs: number) => Promise<{ ok: boolean; message: string } | null>;
  /** YYYY-MM-DD, the host's calendar */
  today: string;
  templateFile?: string;
  now: () => number;
  /** The call's tool host once it is up, or null when it is not available. */
  toolHost: () => Promise<ToolHost | null>;
  /** The tool host only if it is up this moment (never waits for it). */
  toolHostNow?: () => ToolHost | null;
  /** What the course's lists answered during this call (files, modules, pages, assignments), so that a second look is not a second wait. */
  cache?: Map<string, { at: number; r: ToolResult }>;
  /** The links this call has seen (a lookup's answers, what the student typed, the course status): the only ones TAi may put in the chat. */
  urls?: Set<string>;
  /** The mode the call is in: the interviewer reads only the student's own repositories, three actions, and puts only excerpts of what it read in the chat. */
  mode?: AgentMode;
  /** The files this call has read for the interview, and which of them have an excerpt in the chat (the guard on the interviewer's send_to_chat). */
  code?: CodeSeen;
  guard: CompetencyGuard;
  log: VoiceLog;
}

// ---------------------------------------------------------------- what the interviewer may put in the chat

/**
 * The files an interview has read (query_github file_content), as the lines they had, and the files that have an excerpt in the chat already.
 * The chat is the student's screen: what the interviewer puts there as "the file we are looking at" must be that file's own lines, so a model that
 * writes code of its own (or fixes theirs, which is giving the answer) gets nothing through.
 */
export interface CodeSeen {
  /** `repo/path` -> the lines of the file as read (white space collapsed, blank lines left out). */
  files: Map<string, Set<string>>;
  /** The `repo/path` of the files an excerpt of has been sent: once for each. */
  excerpted: Set<string>;
}

export function newCodeSeen(): CodeSeen {
  return { files: new Map(), excerpted: new Set() };
}

/** The most lines of a message to the chat from the interviewer (the prompt says 25; a few more are forgiven), and of a question written down (two lines, 280 characters). */
export const EXCERPT_MAX_LINES = 40;
const PLAIN_MAX_LINES = 2;
const PLAIN_MAX_CHARS = 280;
/** What text next to a code block may be: the file's name, a few words. */
const CAPTION_MAX_CHARS = 160;
/** At least this share of an excerpt's lines must be in the file it claims to be of. */
const EXCERPT_MATCH = 0.8;
const MAX_FILES_SEEN = 20;

const squash = (line: string): string => line.replace(/\s+/g, ' ').trim();
/** A line of an excerpt that says nothing about what it is of: "...", "// ...", "# rest omitted". */
// A bare marker only: "...", "// ...", "/* ... */", "# …". A line that carries words after the dots ("// ... lock the map before the read", "# rest omitted: do X") is
// not an omission: it was taken out of the count before, and then ANY number of hint lines went to the student's screen next to three real ones.
const OMISSION = /^\W*(?:\.{3}|…)\W*$/;
/** Text that is code and not words: such a message has to be a fenced excerpt of the file. */
const CODE_LIKE = /[{};]|:=|=>|\bfunc\b|\bdef\b|\bclass\b|\bimport\b|\breturn\b|\t/;

/** Remembers a file `query_github file_content` returned, for the guard (the whole answer is parsed: its `content` is what the model was shown). */
function noteCodeRead(env: FunctionEnv, repo: string | undefined, asked: string | undefined, answer: string): void {
  const code = env.code;
  const file = readFileAnswer(answer);
  if (!code || !file) return;
  const key = `${repo ?? ''}/${file.path || asked || ''}`;
  if (!code.files.has(key) && code.files.size >= MAX_FILES_SEEN) return;
  const lines = new Set<string>();
  for (const raw of file.content.split('\n')) {
    const line = squash(raw);
    if (line) lines.add(line);
  }
  code.files.set(key, lines);
}

export type ExcerptVerdict = { ok: true; file?: string } | { ok: false; why: string };

/**
 * May this go to the chat from the interviewer? It may be (1) a question (one or two short lines of plain words ending in "?": the question, written
 * down for a student who asked to see it; a statement is an answer or a hint), or (2) a fenced block of at most 40 lines (the prompt says 25) every one of whose lines, to within a fifth of them, is in ONE file this call
 * has read, with at most a few words of caption beside it, and not a file whose excerpt is in the chat already. Anything else is refused with what to do
 * instead: the refusal is the model's, and a model told what to fix does it. The same idea as the guard on links: the chat gets what the call has seen.
 */
export function checkExcerpt(message: string, seen: CodeSeen): ExcerptVerdict {
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > EXCERPT_MAX_LINES) return { ok: false, why: `not sent: that is ${lines.length} lines. The chat takes an excerpt of at most 25 lines of the file: pick the part you will ask about.` };
  const inside: string[] = [];
  const outside: string[] = [];
  let fenced = false;
  let fences = 0;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      fences++;
      continue;
    }
    (fenced ? inside : outside).push(line);
  }
  if (fences === 0) {
    const words = message.trim();
    // words are let through only as a question: a statement ("use an RWMutex here") is the answer or a hint, and neither goes in the chat
    if (lines.length <= PLAIN_MAX_LINES && words.length <= PLAIN_MAX_CHARS && !CODE_LIKE.test(words) && /\?["')\]]*$/.test(words)) return { ok: true };
    return { ok: false, why: 'not sent: the chat takes an excerpt of the file you read (a fenced block of at most 25 lines, copied exactly) or your question written down (one or two short lines ending in a question mark). Yours was neither: no answers, hints or explanations go in the chat.' };
  }
  const caption = outside.join(' ').trim();
  if (caption.length > CAPTION_MAX_CHARS) return { ok: false, why: 'not sent: next to the code put only the file\'s name. Explanations are for you to ask about, not to write down.' };
  const code = inside.map(squash).filter((line) => line && !OMISSION.test(line));
  // a lone brace or parenthesis is in every file: only a line with a letter or a digit in it says which file it is, and every such line counts, short ones too
  const telling = code.filter((line) => /[A-Za-z0-9_]/.test(line));
  if (telling.length === 0) return { ok: false, why: 'not sent: the code block is empty. Copy up to 25 lines of the file you read, exactly.' };
  if (seen.files.size === 0) return { ok: false, why: 'not sent: you have not read a file in this call. Read the file with query_github file_content first, then send the lines you will ask about.' };
  // the file the lines are most of; of two that have them equally (a file copied into another), the one that has no excerpt in the chat yet
  let best = { file: '', hits: 0 };
  for (const [file, lines] of seen.files) {
    const hits = telling.filter((line) => lines.has(line)).length;
    if (hits > best.hits || (hits > 0 && hits === best.hits && seen.excerpted.has(best.file) && !seen.excerpted.has(file))) best = { file, hits };
  }
  if (best.hits / telling.length < EXCERPT_MATCH) {
    return { ok: false, why: 'not sent: those lines are not in a file you read in this call. Copy up to 25 lines exactly as query_github returned them: never write, change or fix code yourself.' };
  }
  if (seen.excerpted.has(best.file)) return { ok: false, why: `not sent: an excerpt of ${best.file.split('/').pop()} is in the chat already. Say "the excerpt above" and ask your question.` };
  return { ok: true, file: best.file };
}

function str(value: unknown, max: number): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const UNAVAILABLE = 'that is not available right now; say so briefly and carry on without it';

/** Remembers the links in an answer: send_to_chat lets through only links that were seen, never one a model made up ("files/xxxx/download"). */
function noteUrls(env: FunctionEnv, answer: string): void {
  if (!env.urls) return;
  for (const u of urlsIn(answer)) if (env.urls.size < 2000) env.urls.add(u);
}

function fromTool(r: ToolResult): string {
  if (r.ok) return r.text || '(no result)';
  if (r.text === 'timeout') return errorResult('that took too long; say so briefly and carry on');
  return errorResult(r.text.slice(0, 300) || 'the tool failed');
}

/** Drops a file for the orchestrator's IPC watcher, the way the container's MCP server does (a temporary name, then the real one). */
export function writeIpcFile(dir: string, data: Record<string, unknown>): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

/**
 * The tool host's send_message and render_diagram leave .send_message_used in the IPC messages directory, which tells the orchestrator
 * to swallow the text agent's next reply (index.ts). There is no text agent in a call, so the flag would swallow the first reply after
 * it instead: remove it.
 */
export function clearSendFlag(ipcDir: string): void {
  try {
    fs.unlinkSync(path.join(ipcDir, 'messages', '.send_message_used'));
  } catch {
    /* not there */
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function localIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

function atTime(base: Date, hours: number, minutes: number): Date {
  const d = new Date(base.getTime());
  d.setHours(hours, minutes, 0, 0);
  return d;
}

/**
 * When a follow-up should run, as the scheduler reads it: local time without a zone ("2026-05-21T09:00:00"). Takes local ISO times,
 * ISO times with a zone, "in N minutes/hours/days/weeks", "today/tomorrow (at) 9am", "tonight", "tomorrow morning/afternoon/evening" and a
 * bare "9pm" (today, or tomorrow when that has passed). Null when it is none of those, in the past, or more than 60 days away.
 */
export function parseWhen(when: string, nowMs: number): string | null {
  const text = when.trim().toLowerCase().replace(/\s+/g, ' ');
  const now = new Date(nowMs);
  let target: Date | null = null;
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2})(?::(\d{2}))?)?(z|[+-]\d{2}:?\d{2})?$/);
  if (iso) {
    const [, y, mo, d, h = '09', mi = '00', s = '00', zone] = iso;
    target = zone ? new Date(when.trim().toUpperCase().replace(' ', 'T')) : new Date(+y, +mo - 1, +d, +h, +mi, +s);
  }
  const rel = !target && text.match(/^in (\d{1,4}) ?(minutes?|mins?|hours?|hrs?|days?|weeks?)$/);
  if (rel) {
    const n = parseInt(rel[1], 10);
    const unit = rel[2].startsWith('m') ? 60_000 : rel[2].startsWith('h') ? 3600_000 : rel[2].startsWith('d') ? 86_400_000 : 7 * 86_400_000;
    target = new Date(nowMs + n * unit);
  }
  if (!target) {
    const named: Record<string, [number, number]> = { morning: [9, 0], afternoon: [14, 0], evening: [19, 0], night: [20, 0] };
    if (text === 'tonight') target = atTime(now, 20, 0);
    if (text === 'tomorrow') target = atTime(new Date(nowMs + 86_400_000), 9, 0);
    const part = text.match(/^(today|tomorrow) (morning|afternoon|evening|night)$/);
    if (part) {
      const day = part[1] === 'tomorrow' ? new Date(nowMs + 86_400_000) : now;
      target = atTime(day, ...named[part[2]]);
    }
    const clock = text.match(/^(?:(today|tomorrow) )?(?:at )?(\d{1,2})(?::(\d{2}))? ?(am|pm)?$/);
    if (!target && clock && (clock[4] || clock[3] || clock[1])) {
      let h = parseInt(clock[2], 10);
      const m = clock[3] ? parseInt(clock[3], 10) : 0;
      if (clock[4] === 'pm' && h < 12) h += 12;
      if (clock[4] === 'am' && h === 12) h = 0;
      if (h <= 23 && m <= 59) {
        const day = clock[1] === 'tomorrow' ? new Date(nowMs + 86_400_000) : now;
        target = atTime(day, h, m);
        if (!clock[1] && target.getTime() <= nowMs) target = atTime(new Date(nowMs + 86_400_000), h, m);
      }
    }
  }
  if (!target || Number.isNaN(target.getTime())) return null;
  if (target.getTime() < nowMs + 60_000 || target.getTime() > nowMs + 60 * 86_400_000) return null;
  return localIso(target);
}

function canvasAction(raw: string): string {
  const a = raw.toLowerCase().replace(/[\s-]+/g, '_');
  const map: Record<string, string> = {
    grades: 'my_grades',
    grade: 'my_grades',
    deadlines: 'upcoming',
    due_dates: 'upcoming',
    submissions: 'student_submission',
    submission: 'student_submission',
    assignment: 'assignment_detail',
  };
  return map[a] ?? a;
}

/**
 * Runs one of the plain functions (not the ones that change the call) and answers what the model is told. Never throws.
 */
export async function runFunction(name: string, args: Record<string, unknown>, env: FunctionEnv): Promise<string> {
  try {
    return await dispatch(name, args, env);
  } catch (err) {
    env.log.warn({ fn: name, err: (err as Error).message }, 'voice function failed');
    return errorResult('that did not work; say so briefly and carry on');
  }
}

async function host(env: FunctionEnv): Promise<ToolHost | null> {
  try {
    return await env.toolHost();
  } catch {
    return null;
  }
}

async function dispatch(name: string, args: Record<string, unknown>, env: FunctionEnv): Promise<string> {
  switch (name) {
    case 'query_knowledge': {
      const question = str(args.question, 500);
      if (!question) return errorResult('give the question to search for');
      const difficulty = ['entity', 'cluster', 'theme'].includes(str(args.difficulty, 20)) ? str(args.difficulty, 20) : 'auto';
      const th = await host(env);
      if (!th) return errorResult(UNAVAILABLE);
      return fromTool(await th.call('query_knowledge', { question, difficulty, top_k: 6 }, { server: 'leanrag' }));
    }

    case 'recall_memory': {
      const query = str(args.query, 300);
      if (!query) return errorResult('give keywords to search for');
      // the container's memory search when it is already up; the same file searched here when it is not (the first look-up of a call does not wait for it)
      const th = env.toolHostNow ? env.toolHostNow() : await host(env);
      if (th) {
        const r = await th.call('memory_query', { query, limit: 6 });
        if (r.ok) return r.text || `Nothing remembered about "${query}".`;
      }
      // the tool host is down: the same file memory_query reads, searched here
      const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const hits = memoriesFromStore(env.groupDir, 200).filter((m) => words.some((w) => m.toLowerCase().includes(w))).slice(0, 6);
      return hits.length ? hits.join('\n') : `Nothing remembered about "${query}".`;
    }

    case 'save_memory': {
      const text = str(args.content, 600);
      if (!text) return errorResult('give the fact to remember');
      const decay = str(args.decay_class, 20); // the design's field: permanent/stable/active
      let category = str(args.category, 40);
      if (!MEMORY_CATEGORIES.includes(category)) category = decay === 'permanent' ? 'student_preference' : decay === 'active' ? 'concept' : 'other';
      // an IPC file, like the container's own memory tool writes: no wait for the tool host
      writeIpcFile(path.join(env.ipcDir, 'messages'), { type: 'memory_store', studentFolder: env.folder, fact: { text, category }, timestamp: new Date(env.now()).toISOString() });
      return 'Remembered.';
    }

    case 'read_competency': {
      const text = readText(path.join(env.groupDir, 'COMPETENCY.md'), env.groupDir);
      const topic = str(args.topic, 120);
      return topic ? competencyForTopic(text, topic) : summarizeCompetency(text, RESULT_CAP);
    }

    case 'update_competency':
      return env.guard.apply(env.groupDir, args, { today: env.today, templateFile: env.templateFile }).message;

    case 'query_canvas': {
      const action = canvasAction(str(args.action, 40));
      if (!CANVAS_ACTIONS.includes(action)) return errorResult(`action must be one of ${CANVAS_ACTIONS.join(', ')}`);
      const params: Record<string, string> = {};
      // the ids a lookup hands out are numbers (a page's is its slug); a model that has only a name passes the name
      const given = str(args.assignment_id, 120);
      const needsAssignment = action === 'assignment_detail' || action === 'student_submission';
      // (a name reaches nothing but matchAssignment, which compares words: "?", "!" and "*" are in real titles. "Homework 7: Cost savings?!" was refused
      // 40 times on 2026-11-04, every time the model passed the title exactly as the assignments list gave it, and it had to ask again with the number)
      if (given && !/^\d{1,15}$/.test(given) && !/^[A-Za-z0-9][A-Za-z0-9 .,:'’#&()_/+?!*–—-]{1,100}$/.test(given)) return errorResult("assignment_id is the number from an assignments lookup, or the assignment's name");
      if (needsAssignment && !given) return errorResult('that needs assignment_id: the number from an assignments lookup, or the assignment\'s name');
      const fileId = str(args.file_id, 20);
      if (action === 'file_content' && !/^\d{1,15}$/.test(fileId)) return errorResult('file_content needs file_id: the number a files, find or modules lookup gave');
      const pageUrl = str(args.page_url, 200).replace(/^.*\/pages\//, '').replace(/[?#].*$/, '');
      if (action === 'page_detail' && !/^[A-Za-z0-9][A-Za-z0-9._~%-]{0,150}$/.test(pageUrl)) return errorResult('page_detail needs page_url: the short name of the page (from a pages, find or modules lookup)');
      const moduleId = str(args.module_id, 20);
      if (action === 'module_items' && !/^\d{1,15}$/.test(moduleId)) return errorResult('module_items needs module_id: the number from a modules lookup');
      const topicId = str(args.topic_id, 20);
      if ((action === 'discussion_detail' || action === 'discussion_entries') && !/^\d{1,15}$/.test(topicId)) return errorResult(`${action} needs topic_id: the number from a discussions lookup`);
      const query = str(args.query, 120);
      if (action === 'find' && !query) return errorResult('find needs query: words from the title of what to look for');
      const th = await host(env);
      if (!th) return errorResult(UNAVAILABLE);
      // the lists of the course do not change during a call: asked once, they are kept for fifteen minutes (find asks for four of them; the
      // call asks for them itself when its tool host is up, so the first search does not wait for Canvas: it took 6.5 seconds in a real call)
      const LISTS = new Set(['files', 'modules', 'pages', 'assignments']);
      const ask = async (a: string, p: Record<string, string> = {}): Promise<ToolResult> => {
        const keep = env.cache && LISTS.has(a) && Object.keys(p).length === 0;
        const hit = keep ? env.cache!.get(a) : undefined;
        if (hit && env.now() - hit.at < 900_000) return hit.r;
        const r = await th.call('canvas_query', { action: a, params: p });
        if (r.ok) {
          noteUrls(env, r.text);
          if (keep) env.cache!.set(a, { at: env.now(), r });
        }
        return r;
      };
      if (action === 'find') {
        const [files, modules, pages, assignments] = await Promise.all([ask('files'), ask('modules'), ask('pages'), ask('assignments')]);
        if (!files.ok && !modules.ok && !pages.ok && !assignments.ok) return fromTool(files);
        return findInCourse(query, files.ok ? files.text : '', modules.ok ? modules.text : '', pages.ok ? pages.text : '', assignments.ok ? assignments.text : '');
      }
      if (needsAssignment) {
        let id = given;
        if (!/^\d{1,15}$/.test(id)) {
          const list = await ask('assignments');
          if (!list.ok) return fromTool(list);
          const match = matchAssignment(given, list.text);
          if (!match.id) return errorResult(`no assignment is called "${given.slice(0, 60)}": the assignments are ${match.names.slice(0, 14).join('; ')}. Ask which one they mean.`);
          id = match.id;
        }
        params.assignment_id = id;
      }
      if (action === 'file_content') params.file_id = fileId;
      if (action === 'page_detail') params.page_url = pageUrl;
      if (action === 'module_items') params.module_id = moduleId;
      if (action === 'discussion_detail' || action === 'discussion_entries') params.topic_id = topicId;
      const r = await ask(action, params);
      if (!r.ok) return fromTool(r);
      if (action === 'assignment_detail') return compactAssignmentDetail(r.text, env.now()) ?? fromTool(r);
      if (action === 'files') return compactFiles(r.text) ?? fromTool(r);
      if (action === 'modules') return compactModules(r.text) ?? fromTool(r);
      return fromTool(r);
    }

    case 'query_github': {
      const action = str(args.action, 40);
      // in the interview: their own account, three actions, whatever the model says (the container checks the account again, and this is stricter)
      const interview = env.mode === 'interviewer';
      const allowed = interview ? INTERVIEW_GITHUB_ACTIONS : GITHUB_ACTIONS;
      if (!allowed.includes(action)) return errorResult(`action must be one of ${allowed.join(', ')}`);
      if (interview && !env.githubUsername) return errorResult('their GitHub account is not linked to TAi, so their code cannot be read: say so in one short sentence and ask them to describe what they built instead');
      const params: Record<string, string> = {};
      const owner = interview ? (env.githubUsername as string) : str(args.owner, 100) || env.githubUsername || '';
      if (owner) {
        if (!NAME.test(owner)) return errorResult('owner is a GitHub account name');
        params[action === 'list_repos' ? 'user' : 'owner'] = owner;
      }
      const repo = str(args.repo, 100);
      if (repo) {
        if (!NAME.test(repo)) return errorResult('repo is the repository name only, without the owner');
        params.repo = repo;
      }
      for (const key of ['path', 'sha', 'number'] as const) {
        const v = str(args[key], 300);
        if (!v) continue;
        if (/(^|\/)\.\.(\/|$)|[?#%\\]/.test(v)) return errorResult(`${key} may not contain "..", "?", "#", "%" or a backslash`);
        params[key] = v;
      }
      if (action !== 'list_repos' && !params.repo) return errorResult(interview ? 'that needs repo: the one in your prompt, or the one the student named' : 'that needs repo: list the repos first');
      if (interview && action === 'file_content' && !params.path) return errorResult('file_content needs path: the file, as your prompt or a folder listing gave it');
      const th = await host(env);
      if (!th) return errorResult(UNAVAILABLE);
      const r = await th.call('github_query', { action, params });
      if (interview && r.ok) {
        // plain lines, so that the model reads code and not a JSON string, and the guard on send_to_chat knows what it was shown
        if (action === 'file_content') {
          noteCodeRead(env, params.repo, params.path, r.text);
          return compactFile(r.text) ?? fromTool(r);
        }
        if (action === 'repo_tree') return compactTree(r.text) ?? fromTool(r);
        return compactRepos(r.text) ?? fromTool(r);
      }
      return fromTool(r);
    }

    case 'query_piazza': {
      const action = str(args.action, 40);
      if (!PIAZZA_ACTIONS.includes(action)) return errorResult(`action must be one of ${PIAZZA_ACTIONS.join(', ')}`);
      const params: Record<string, string> = {};
      for (const key of ['query', 'post_id', 'tag'] as const) {
        const v = str(args[key], 200);
        if (v) params[key] = v;
      }
      if (action === 'recent_posts') params.limit = '10';
      const th = await host(env);
      if (!th) return errorResult(UNAVAILABLE);
      return fromTool(await th.call('piazza_query', { action, params }));
    }

    case 'browse_url': {
      const url = str(args.url, 2000);
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return errorResult('that is not a URL');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return errorResult('only http and https pages can be fetched');
      const th = await host(env);
      if (!th) return errorResult(UNAVAILABLE);
      return fromTool(await th.builtin('web_fetch', { url: parsed.toString() }));
    }

    case 'read_file': {
      const raw = str(args.path, 300).replace(/\\/g, '/');
      const base = raw.split('/').pop() || '';
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(base)) return errorResult('give the file name as the chat message named it');
      const th = await host(env);
      if (!th) return errorResult(UNAVAILABLE);
      return fromTool(await th.builtin('read_file', { path: `/workspace/group/uploads/${base}` }));
    }

    case 'render_diagram': {
      const code = typeof args.mermaid_code === 'string' ? args.mermaid_code.slice(0, 8000) : typeof args.mermaid_syntax === 'string' ? args.mermaid_syntax.slice(0, 8000) : '';
      if (!code.trim()) return errorResult('give the Mermaid code');
      const caption = str(args.caption, 500) || 'A diagram from our call';
      const th = await host(env);
      if (!th) return errorResult(UNAVAILABLE);
      const r = await th.call('render_diagram', { mermaid_syntax: code, caption });
      clearSendFlag(env.ipcDir);
      return r.ok ? 'The diagram is in the chat now.' : fromTool(r);
    }

    case 'send_to_chat': {
      const message = typeof args.message === 'string' ? args.message.trim().slice(0, 6000) : '';
      if (!message) return errorResult('give the text to put in the chat');
      // the interviewer's chat is the file under discussion: lines of a file this call has read, a few of them, once for each file (or the question written down)
      let excerpted: string | undefined;
      if (env.mode === 'interviewer') {
        const verdict = checkExcerpt(message, env.code ?? newCodeSeen());
        if (!verdict.ok) return errorResult(verdict.why);
        excerpted = verdict.file;
      }
      // a link goes in the chat only if it came from somewhere: a lookup, the course status, the student. A model that wants to share "the
      // Raft PDF" and has no address writes one ("files/xxxx/download"), which the student opens and finds nothing behind.
      if (env.urls) {
        const unknown = urlsIn(message).filter((u) => !seenUrl(env.urls!, u));
        if (unknown.length) {
          return errorResult(`not sent: ${unknown[0].slice(0, 80)} is not a link any lookup in this call returned. Never make up a link: look the thing up (query_canvas find, files, modules or pages), use the link it gives, or send the text without a link and say you could not find one.`);
        }
      }
      // the very file the container's send_message tool writes, without waiting for a container to start
      writeIpcFile(path.join(env.ipcDir, 'messages'), { type: 'message', chatJid: env.jid, text: message, groupFolder: env.folder, timestamp: new Date(env.now()).toISOString() });
      if (excerpted && env.code) env.code.excerpted.add(excerpted);
      return 'It is in the chat now.';
    }

    case 'schedule_task': {
      const description = str(args.description, 1000);
      const whenText = str(args.when, 100);
      if (!description || !whenText) return errorResult('give what to do and when');
      const when = parseWhen(whenText, env.now());
      if (!when) return errorResult("I could not read that time: use a local time like 2026-05-21T09:00, or 'in 2 hours', or 'tomorrow 9am' (at least a minute ahead, at most 60 days)");
      const prompt = `[Follow-up agreed in a voice call] ${description}`;
      const requestId = newRequestId(env.now());
      writeIpcFile(path.join(env.ipcDir, 'tasks'), {
        type: 'schedule_task',
        requestId,
        prompt,
        schedule_type: 'once',
        schedule_value: when,
        context_mode: 'group',
        targetJid: env.jid,
        createdBy: env.folder,
        timestamp: new Date(env.now()).toISOString(),
      });
      const set = `Scheduled for ${when.replace('T', ' ').slice(0, 16)}.`;
      if (!env.awaitIpcAnswer) return set;
      // the host decides (limits, a schedule it cannot read) a moment after the file is there: say what it said, not what was asked
      const answer = await env.awaitIpcAnswer(requestId, 6000);
      if (!answer) return errorResult('I asked for it to be scheduled but nothing confirmed that it was set: say that you are not sure it was.');
      return answer.ok ? set : errorResult(answer.message || 'the reminder was not set');
    }

    default:
      return errorResult(`there is no function called ${name.slice(0, 60)}`);
  }
}
