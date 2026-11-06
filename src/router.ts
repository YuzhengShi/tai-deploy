import { ASSISTANT_NAME, MAX_MESSAGE_LENGTH, TIMEZONE } from './config.js';
import { Channel, NewMessage } from './types.js';

export function escapeXml(s: string): string {
  if (!s) return '';
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-US', { timeZone: TIMEZONE });
  } catch {
    return iso;
  }
}

export function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map((m) => {
    let content = m.content;
    if (content.length > MAX_MESSAGE_LENGTH) {
      content = content.slice(0, MAX_MESSAGE_LENGTH) + `\n[... truncated — original was ${content.length} chars]`;
    }
    return `<message id="${escapeXml(m.id)}" sender="${escapeXml(m.sender_name)}" time="${formatTimestamp(m.timestamp)}">${escapeXml(content)}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

export function stripInternalTags(text: string): string {
  return text
    // A model that is not Claude sometimes writes a tool call as text, ending in a stray closing tag, ahead of the reply:
    //   <internal to=TodoWrite{ "todos": [...] }></commentary}hey! I'm TAi ...
    .replace(/<internal\b(?:(?!<internal\b|<\/internal)[\s\S])*?<\/commentary[}>]?/gi, '')
    .replace(/<internal\b[^>]*>[\s\S]*?<\/internal\s*>/gi, '')  // closed tags (attributes tolerated)
    .replace(/<internal\b[\s\S]*$/gi, '')                        // unclosed tag → strip to end
    // qwen sometimes writes its reasoning as emphasised text instead of a tag: "<i>internal: ... </i>" (closed, or running to the end)
    .replace(/<(i|em|b)>\s*internal\b[\s\S]*?<\/\1>/gi, '')
    .replace(/<(?:i|em|b)>\s*internal\b[\s\S]*$/gi, '')
    .replace(/<\/?(?:commentary|analysis)\b(?:\s[^>\n]*)?[}>]?/gi, '')     // stray reasoning-channel tags
    .replace(/^[\s\S]*?assistantfinal/i, '')                     // reasoning-channel text ahead of the final answer
    .replace(/^.*\bto=functions\.[^\n]*$/gim, '')                // a tool call written as a line of text
    // A planning sentence run into the reply without a space: "We need to introduce ourselves as TAi.hey! i'm TAi ..."
    .replace(/^\s*(?:We|I)\s+(?:need|should|must|will|have to)\s[^\n]*?[.!?](?=[A-Za-z])/, '')
    .replace(/Human:\s*<messages>[\s\S]*/g, '')                // hallucinated Human turn → strip everything after
    .replace(/<reply_rule>[\s\S]*?<\/reply_rule>/g, '')       // the host's length rule (src/reply-shape.ts), if a model repeats it
    .replace(/<reply_rule>[\s\S]*$/g, '')
    .replace(/<messages>[\s\S]*?<\/messages>/g, '')           // bare message XML (closed)
    .replace(/<messages>[\s\S]*$/g, '')                       // bare message XML (unclosed)
    .replace(/<message\s+[^>]*>[\s\S]*?<\/message>/g, '')   // individual <message> tags (closed)
    .replace(/<message\s+[^>]*>[\s\S]*$/g, '')               // individual <message> tag (unclosed)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Fingerprint phrases from system prompt files that should never appear in student-facing output.
// These are unique enough to not occur in normal conversation but reliably identify leakage.
const SYSTEM_PROMPT_FINGERPRINTS = [
  'Six-Step Pedagogical Reasoning Loop',
  'COMPETENCY_PROTOCOL.md',
  'TEACHING_STRATEGIES.md',
  'COURSE_REFERENCE.md',
  'createSanitizeBashHook',
  'createCompetencyGuardHook',
  'mcp__nanoclaw__',
  'mcp__leanrag__',
  'hookEventName',
  'PreToolUse',
  'permissionMode',
  'bypassPermissions',
  'NANOCLAW_IS_MAIN',
  'NANOCLAW_CHAT_JID',
  'NANOCLAW_GROUP_FOLDER',
  'writeIpcFile',
  'boundCanvasUserId',
  'boundGithubUsername',
  'hasFullAccess',
  'Proactive Intervention Log',
  'Teaching Strategy Log',
  'confidence_delta',
  'stability_delta',
  'COMPETENCY.md',
];

/**
 * Detect and redact system prompt leakage from agent output.
 * Returns the cleaned text, or a replacement message if heavily contaminated.
 */
function redactSystemPromptLeakage(text: string): string {
  // Count fingerprints against original text first
  let leakCount = 0;
  for (const fp of SYSTEM_PROMPT_FINGERPRINTS) {
    if (text.includes(fp)) leakCount++;
  }

  // If heavily contaminated (3+ fingerprints), replace entire output
  if (leakCount >= 3) {
    return "hmm, I got a bit confused there — what were we talking about?";
  }

  // For 1-2 fingerprints, redact the sentences containing them
  if (leakCount > 0) {
    let cleaned = text;
    for (const fp of SYSTEM_PROMPT_FINGERPRINTS) {
      if (cleaned.includes(fp)) {
        const escaped = fp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        cleaned = cleaned.replace(new RegExp(`[^.!?\\n]*${escaped}[^.!?\\n]*[.!?]?`, 'g'), '[redacted]');
      }
    }
    return cleaned;
  }

  return text;
}

/**
 * gpt-oss writes some of its ordinary characters as look-alikes: a non-breaking hyphen (U+2011) in "half‑open", a narrow no-break space
 * (U+202F) before a unit or in a date, a zero-width space now and then. They look like the plain ones and are not: a student who
 * searches for "half-open", pastes "load‑test" into a shell or a file name, or compiles a snippet copied from a code block gets a
 * mismatch nobody can see (the memory-recall check of the evaluation failed on exactly that). They become the plain character. The
 * dashes and curly quotes of ordinary prose stay as written; inside code (a fenced block or backticks) a curly quote or a long dash is
 * never what was meant and is straightened. The zero-width joiner is left alone: emoji sequences are built with it.
 */
export function normalizeTypography(text: string): string {
  const plain = text
    .replace(/[‐‑‒]/g, '-')
    .replace(/[     ]/g, ' ')
    .replace(/[​⁠﻿]/g, '');
  return plain.replace(/```[\s\S]*?```|`[^`\n]+`/g, (code) =>
    code
      .replace(/[‘’]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[–—−]/g, '-'),
  );
}

/**
 * gpt-oss, writing in the persona's lower-case voice, now and then splits its own name when it introduces itself: "hey! i'm ta i".
 * Only that: lower case, right after "i'm", "i am", "this is" or "it's". A course about a TA says "the TA I met" and "ask your ta i
 * think" in other places, and those stay as written.
 */
export function mendOwnName(text: string): string {
  return text.replace(/\b(i['’]?m|i am|this is|it['’]?s) ta i\b/gi, (_whole, lead: string) => `${lead} ${ASSISTANT_NAME}`);
}

export function formatOutbound(rawText: string): string {
  let text = stripInternalTags(rawText);
  if (!text) return '';
  text = mendOwnName(normalizeTypography(text));
  text = redactSystemPromptLeakage(text);
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text);
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
