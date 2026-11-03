/**
 * The subagent child-session convention, in one place.
 *
 * The CLI stores a background subagent's child session as
 * `sess_subagent_<agentId>` (createSessionId(`subagent_${agentId}`) in
 * `apps/zcode-cli/packages/core/src/subagent/runner.ts`), and the launch ACK
 * of the Agent/Task tool carries that `agentId`. Clients (the Kotlin daemon,
 * the bot) address a subagent with exactly that session id — there is no
 * second id to translate to.
 *
 * Why the parser lives in shared: the daemon channel (host), the task
 * service adapter and the UI all need to recognise the convention without
 * inventing their own prefix string; a typo'd prefix silently turns an order
 * into "unknown task".
 */

/** Prefix of a child session id: `sess_subagent_` + the harness agentId. */
export const SUBAGENT_SESSION_PREFIX = "sess_subagent_";

/**
 * The child session id for a harness agentId — the same value the CLI writes
 * into its session store. Inverse of {@link subagentAgentIdFromSessionId}.
 */
export function subagentSessionIdFor(agentId: string): string {
  return `${SUBAGENT_SESSION_PREFIX}${agentId}`;
}

/**
 * The harness agentId when `taskId` follows the child-session convention;
 * null for every other id (main sessions, forks, workflow children, ...).
 */
export function subagentAgentIdFromSessionId(taskId: string): string | null {
  if (!taskId.startsWith(SUBAGENT_SESSION_PREFIX)) {
    return null;
  }
  const agentId = taskId.slice(SUBAGENT_SESSION_PREFIX.length);
  return agentId.length > 0 ? agentId : null;
}
