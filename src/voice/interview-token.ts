/**
 * The mock interview's deep link (port of voice/interview-token.ts): start_mock_interview in the student's container signs
 * base64url(JSON {folder, assignmentId, ts}) with VOICE_INTERVIEW_SECRET (HMAC-SHA256, hex) and returns <VOICE_BASE_URL>/interview/<token>.
 * The page opens that link and starts a call in interview mode with the token; the hub checks it here.
 *
 * The secret is in every student container's MCP server environment, and an admin container may sign for any folder: a token says
 * which interview, never who the caller is. The caller is the signed-in student, and the hub refuses a token whose folder is not theirs.
 * Not single-use (a dropped call may be restarted from the same link within the hour).
 */
import crypto from 'crypto';

export const INTERVIEW_TOKEN_TTL_MS = 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface InterviewTokenInfo {
  folder: string;
  assignmentId?: string;
}

function sign(json: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(json).digest('hex');
}

/** What the container's start_mock_interview produces (for tests and tools). */
export function signInterviewToken(secret: string, folder: string, assignmentId: string | undefined, ts: number): string {
  const json = Buffer.from(JSON.stringify({ folder, assignmentId, ts })).toString('base64url');
  return `${json}.${sign(json, secret)}`;
}

/** Who and what the token is for, or null: malformed, forged, expired, from the future, or naming something that is not a folder. */
export function verifyInterviewToken(token: unknown, secret: string | undefined, now: number): InterviewTokenInfo | null {
  if (!secret || typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [json, sig] = parts;
  if (!/^[A-Za-z0-9_-]{8,}$/.test(json) || !/^[0-9a-f]{64}$/.test(sig)) return null;
  const expected = Buffer.from(sign(json, secret), 'hex');
  const given = Buffer.from(sig, 'hex');
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  let payload: { folder?: unknown; assignmentId?: unknown; ts?: unknown };
  try {
    payload = JSON.parse(Buffer.from(json, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.folder !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(payload.folder)) return null;
  if (typeof payload.ts !== 'number' || !Number.isFinite(payload.ts)) return null;
  if (now - payload.ts > INTERVIEW_TOKEN_TTL_MS || payload.ts - now > FUTURE_SKEW_MS) return null;
  const info: InterviewTokenInfo = { folder: payload.folder };
  if (payload.assignmentId !== undefined && payload.assignmentId !== null && payload.assignmentId !== '') {
    if (typeof payload.assignmentId !== 'string' || !/^\d{1,15}$/.test(payload.assignmentId)) return null;
    info.assignmentId = payload.assignmentId;
  }
  return info;
}
