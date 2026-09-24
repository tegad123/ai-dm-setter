/**
 * Build a reply from authored copy when the selected branch has no generated
 * message slots. A null result means the caller must use the normal adaptive
 * path (for example, a runtime placeholder or a link action).
 */
export function buildSelectedBranchLiteralReply(params: {
  directActions: Array<{ actionType: string; content?: string | null }>;
  branchActions: Array<{ actionType: string; content?: string | null }>;
  resolve: (content: string) => string;
  alreadyDelivered: (content: string) => boolean;
}): string[] | null {
  const branchHasDeliverable = params.branchActions.some((action) =>
    ['send_message', 'ask_question', 'send_link', 'send_video'].includes(
      action.actionType
    )
  );
  const actions = branchHasDeliverable
    ? [...params.directActions, ...params.branchActions]
    : params.branchActions;
  // A step-level WAIT separates turns. If the branch has its own deliverable,
  // a preceding direct WAIT makes the current-turn boundary ambiguous here.
  if (
    branchHasDeliverable &&
    params.directActions.some(
      (action) => action.actionType === 'wait_for_response'
    )
  ) {
    return null;
  }
  const reply: string[] = [];
  let hasFixedMessage = false;

  for (const action of actions) {
    if (action.actionType === 'wait_for_response') break;
    if (
      action.actionType === 'send_link' ||
      action.actionType === 'send_video'
    ) {
      return null;
    }
    if (
      action.actionType !== 'send_message' &&
      action.actionType !== 'ask_question'
    ) {
      continue;
    }
    if (action.actionType === 'send_message') hasFixedMessage = true;
    const source = action.content?.trim();
    if (!source || /^\s*\{\{[^}]+\}\}\s*$/.test(source)) {
      return null;
    }
    const resolved = params.resolve(source).trim();
    if (!resolved || /\{\{[^}]+\}\}/.test(resolved)) return null;
    if (!params.alreadyDelivered(resolved)) reply.push(resolved);
  }

  return hasFixedMessage && reply.length > 0 ? reply : null;
}
