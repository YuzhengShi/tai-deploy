/**
 * TAI_VISION: whether TAi may LOOK at a picture a student attached (the tool `look_at_image`: a vision model behind the gateway, docs/VISION.md).
 * It is off unless the orchestrator's environment says exactly "1" (as TAI_PORTAL_STREAM does: "true", "yes" and " 1" are off), because the
 * student's picture then leaves TAi's own systems for z.ai, and nothing is to go there before the owner has turned it on.
 *
 * Two places act on the switch and must agree, so both ask here: the container runner (a student's chat container is started with TAI_VISION=1 and
 * the alias that looks at pictures) and the page's upload store (the words that tell TAi it may look, src/portal/uploads.ts). Words that promise a tool
 * that is not offered, or a tool that is offered while the words say there is none, would send the model to a call that cannot work.
 *
 * Only the switch and the model's name are here. The gateway's address and the key it is given are the ones the model already uses (ANTHROPIC_BASE_URL
 * and ANTHROPIC_AUTH_TOKEN, handed to the container as secrets on its stdin): the container builds the tool's settings from them
 * (container/agent-runner/src/vision.ts), so no key is ever on a command line or in a second place.
 */

/** Exactly "1" in the orchestrator's environment. */
export function visionOn(env: Record<string, string | undefined> = process.env): boolean {
  return env.TAI_VISION === '1';
}

/**
 * What a gateway alias looks like (letters, digits and . _ : -, at most 64). The name goes on the `docker run` command line, so nothing else is let
 * through: a value that is not a plain alias is ignored and the container's own default (`glm-vision`, eval/litellm/config.yaml) is used.
 */
export const MODEL_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

/** TAI_VISION_MODEL when it is a plain alias, else null. */
export function visionModel(env: Record<string, string | undefined> = process.env): string | null {
  const value = (env.TAI_VISION_MODEL ?? '').trim();
  return MODEL_ALIAS.test(value) ? value : null;
}

/** What a container is started with for the picture tool: `model` is null when the container is to use its default alias. */
export interface VisionLaunch {
  model: string | null;
}

/**
 * The picture tool for one run, or null for none. Only a student's own run gets it: not the admin's chat (it has no student's uploads folder), not a
 * scheduled task (the patrol and the grade bootstrap never look at pictures, and the host's own tasks are not held to the tools' limits), and never the voice tool
 * host, which is started by another function that does not call this (src/container-runner.ts spawnToolHost).
 */
export function visionFor(input: { isMain: boolean; isScheduledTask?: boolean }, env: Record<string, string | undefined> = process.env): VisionLaunch | null {
  if (!visionOn(env) || input.isMain || input.isScheduledTask === true) return null;
  return { model: visionModel(env) };
}
