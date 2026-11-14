/**
 * look_at_image: the voice call's way to look at a picture the student attached in the chat (docs/VISION.md, docs/RUN_CARDS.md). It maps onto the tool of the same name that the student's agent container has
 * (container/agent-runner/src/vision.ts: the picture goes to the vision model behind the gateway, which is a service outside TAi), the way read_file maps onto the container's own reader: the call's
 * tool host runs it, so the picture is read and sent by the container's tool, behind its own checks (the picture's size and type, five looks to a call), and never by the orchestrator.
 *
 * What this module does, and nothing else: it checks what the model gave (a name, like the other upload names: letters, digits and `._-`, at most 100 characters, a picture's extension, no directory),
 * says plainly that the function is not available when the host's switch is off (callVisionOn, src/vision-env.ts: TAI_VISION=1 and not TAI_CALL_VISION=0; the same one the page's words follow), builds the path itself
 * (`/workspace/group/uploads/<name>`: the student's own uploads, in the tool host's mount of THIS student's folder, never anything the model wrote beyond the name), looks at each
 * picture once in a call (the first description is kept in the call's cache and handed back, not fetched again), and relays the tool's answer. What the vision model said is DATA about a picture, whatever the
 * picture holds: the container's tool frames it as such, and it is passed on as it came.
 *
 * It is in the function lists of the conversation and the interview where `callVisionOn()` (src/vision-env.ts: TAI_VISION on and TAI_CALL_VISION not 0, the owner's decision of 2026-11-07), and the call's
 * tool host is started with the picture tool for the same switch (src/container-runner.ts spawnToolHost); docs/RUN_CARDS.md.
 */
import { callVisionOn } from '../vision-env.js';
import type { FunctionDef, FunctionEnv } from './functions.js';

/** A picture's name as an upload keeps it: the same shape as the names read_file and the sandbox accept. */
export const PICTURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const PICTURE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;
/** The most of the student's question that goes along with the picture (the container's tool takes a sentence). */
export const LOOK_IMAGE_QUESTION_CHARS = 300;
/** Where the call's tool host sees the student's attached files. */
const UPLOADS = '/workspace/group/uploads/';

export const LOOK_IMAGE_NOT_AVAILABLE =
  'looking at a picture is not available in a call here; say so in one short sentence and ask them to describe it or to paste the text, and do not guess what it shows';
const UNAVAILABLE = 'that is not available right now; say so briefly and carry on without it';
const SEEN_BEFORE = '(You looked at this picture earlier in this call; this is what it showed. It is not sent again.)\n';

const error = (message: string): string => JSON.stringify({ error: message });

/** One line of at most `max` characters: control, format and line-separator characters turned into spaces, white space made single. */
function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const flat = value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max).trimEnd() : flat;
}

export const LOOK_IMAGE_DEF: FunctionDef = {
  name: 'look_at_image',
  description:
    'Look at a picture the student attached in this chat (a chart, a diagram, a screenshot of an error or an interface) and get what it shows. ONLY for a picture they attached here, ONCE for each picture, and the picture goes to an outside vision service: say so if they ask.\n\n' +
    'WHEN TO CALL:\n- The chat message names a picture they attached ("(a picture, ...)") and they ask what it shows or what a chart in it says\n\n' +
    'CORRECT PATTERN:\n1. Call look_at_image with the picture\'s name exactly as the chat message gave it and, if they asked something, their question in a few words\n2. Say in one or two short sentences what it showed next to what they asked, then ask what they make of it\n\n' +
    'WRONG PATTERN:\n- Looking at a picture that was not attached in this chat, or at a name you guessed\n- Looking at the same picture again: the first description is what there is\n- Reading the description aloud, or guessing what a picture shows when the answer says it was not clear: say so and ask them to describe it',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: "The picture's file name as the chat message gave it (e.g. 'pasted-picture.png' or '/workspace/group/uploads/pasted-picture.png')" },
      question: { type: 'string', description: 'What they want to know about it, in a sentence (optional): it makes the description about what matters' },
    },
    required: ['name'],
  },
  // the picture leaves TAi's own systems: a turn that is not confirmed yet must not send it
  defer_until_eot: true,
};

/**
 * One call of the function, for the student of this call (`env`: its tool host and its cache). `vision` is the host's switch (tests give their own; it is read when the function is called, so that a
 * switch turned on or off applies to the next call). Never throws: every way out is a JSON sentence the model can say.
 */
export async function lookAtImage(args: Record<string, unknown>, env: FunctionEnv, vision: () => boolean = callVisionOn): Promise<string> {
  try {
    if (!vision()) return error(LOOK_IMAGE_NOT_AVAILABLE);
    const raw = oneLine(args?.name, 300).replace(/\\/g, '/');
    const base = raw.split('/').pop() || '';
    if (!PICTURE_NAME.test(base) || !PICTURE_EXTENSION.test(base)) return error("give the picture's file name as the chat message named it (a .png, .jpg, .gif or .webp file they attached)");
    const question = oneLine(args.question, LOOK_IMAGE_QUESTION_CHARS);

    // once for each picture in a call: the first look is kept, and a second ask is answered from it without sending the picture again
    const key = `look_at_image:${base}`;
    const before = env.cache?.get(key);
    if (before) return SEEN_BEFORE + before.r.text;

    let host = null;
    try {
      host = await env.toolHost();
    } catch {
      host = null;
    }
    if (!host) return error(UNAVAILABLE);
    const r = await host.call('look_at_image', { path: `${UPLOADS}${base}`, ...(question ? { question } : {}) });
    if (!r.ok) {
      if (r.text === 'timeout') return error('that took too long; say so briefly and carry on');
      // a tool host that does not have the tool (it is only offered where the host started it for pictures) says so in the MCP's words
      if (/not found|unknown tool|no such tool|method not found/i.test(r.text)) return error(LOOK_IMAGE_NOT_AVAILABLE);
      return error(r.text.slice(0, 300) || 'the tool failed');
    }
    const text = r.text || '(no result)';
    env.cache?.set(key, { at: env.now(), r: { ok: true, text } });
    return text;
  } catch (err) {
    env.log.warn({ folder: env.folder, err: err instanceof Error ? err.message : String(err) }, 'voice: look_at_image failed');
    return error('that did not work; say so briefly and carry on');
  }
}
