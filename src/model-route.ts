/**
 * Which model a container asks for. The scheduled tasks (the teaching patrol, the grade bootstrap) can use a model of their own, ANTHROPIC_MODEL_LIGHT in .env
 * (tai_live.sh model NAME --background): nobody is waiting for them, and the patrol is the biggest consumer of tokens. Without one they use the chats' model.
 *
 * The harness in the container finds its model under more than one name (pi: TAI_LLM_MODEL, then ANTHROPIC_DEFAULT_SONNET_MODEL, then ANTHROPIC_MODEL), so every
 * name that is set is pointed at the background model. Before this only ANTHROPIC_MODEL was, which pi never reads first: the setting did nothing, and went
 * unnoticed because the deployment always set it to the chats' model.
 */
const MODEL_NAMES = [
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_SMALL_FAST_MODEL',
  'TAI_LLM_MODEL',
];

/** Changes `secrets` in place: the background model replaces the chats' for a scheduled task; the setting itself never goes to the container. */
export function routeModel(secrets: Record<string, string>, scheduledTask: boolean): void {
  const background = (secrets['ANTHROPIC_MODEL_LIGHT'] ?? '').trim();
  delete secrets['ANTHROPIC_MODEL_LIGHT'];
  if (!scheduledTask || !background) return;
  secrets['ANTHROPIC_MODEL'] = background;
  for (const name of MODEL_NAMES) {
    if (secrets[name]) secrets[name] = background;
  }
}
