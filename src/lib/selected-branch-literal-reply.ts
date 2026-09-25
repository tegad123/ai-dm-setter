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

type ScriptAction = {
  actionType: string;
  content?: string | null;
  linkUrl?: string | null;
};

function normalized(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resemblesScriptedCopy(candidate: string, scripted: string): boolean {
  const candidateWords = new Set(
    normalized(candidate).split(' ').filter(Boolean)
  );
  const scriptedWords = new Set(
    normalized(scripted).split(' ').filter(Boolean)
  );
  if (candidateWords.size === 0 || scriptedWords.size === 0) return false;
  if (normalized(candidate) === normalized(scripted)) return true;
  if (scriptedWords.size < 4 || candidateWords.size < 4) return false;
  const overlap = Array.from(candidateWords).filter((word) =>
    scriptedWords.has(word)
  );
  return overlap.length / candidateWords.size >= 0.65;
}

/**
 * Keep only model output for runtime {{placeholder}} slots. Fixed messages and
 * asks come from the selected branch, including their original order. If the
 * model copied a sibling branch or produced an ambiguous number of free-text
 * bubbles, the caller must retry or hold instead of guessing a slot mapping.
 */
export function assembleMixedSelectedBranchReply(params: {
  directActions?: ScriptAction[];
  branchActions: ScriptAction[];
  allBranchActions: ScriptAction[][];
  generatedMessages: string[];
  alreadyDelivered: (content: string) => boolean;
  requiredRole?: 'Futures' | 'Forex' | null;
}):
  | { kind: 'not_applicable' }
  | { kind: 'missing_placeholder'; expected: number; found: number }
  | { kind: 'assembled'; bubbles: string[]; fixedMessages: string[] } {
  // A direct action can precede this branch in the same turn or place its
  // own WAIT boundary before it. Until that order is modeled here, leave such
  // steps on the existing path rather than silently dropping their actions.
  if (
    params.directActions?.some((action) =>
      [
        'send_message',
        'ask_question',
        'send_link',
        'send_video',
        'wait_for_response'
      ].includes(action.actionType)
    )
  ) {
    return { kind: 'not_applicable' };
  }
  const waitIndex = params.branchActions.findIndex(
    (action) => action.actionType === 'wait_for_response'
  );
  const actions =
    waitIndex < 0
      ? params.branchActions
      : params.branchActions.slice(0, waitIndex);
  if (actions.some((action) => action.actionType === 'send_video')) {
    return { kind: 'not_applicable' };
  }
  const links = actions.filter((action) => action.actionType === 'send_link');
  const linkUrl = (action: ScriptAction) =>
    (action.linkUrl ?? '').trim() ||
    (action.content ?? '').match(/https?:\/\/\S+/i)?.[0] ||
    '';
  // An unresolved link must go through N1's existing fallback and alert path.
  // Exact assembly is safe only when the script itself has a real destination.
  if (
    links.some(
      (action) =>
        !/^https?:\/\/\S+$/i.test(linkUrl(action)) ||
        /example\.(com|org|net)|your-?domain\.|placeholder\./i.test(
          linkUrl(action)
        )
    )
  ) {
    return { kind: 'not_applicable' };
  }
  const messageActions = actions.filter((action) =>
    ['send_message', 'ask_question'].includes(action.actionType)
  );
  const isPlaceholder = (action: ScriptAction) =>
    /^\s*\{\{[^}]+\}\}\s*$/.test(action.content ?? '');
  const fixedMessages = messageActions
    .filter(
      (action) =>
        !isPlaceholder(action) &&
        !!action.content?.trim() &&
        !params.alreadyDelivered(action.content.trim())
    )
    .map((action) => action.content!.trim());
  const placeholderCount = messageActions.filter(isPlaceholder).length;
  if (
    (fixedMessages.length === 0 && links.length === 0) ||
    (placeholderCount === 0 && links.length === 0)
  ) {
    return { kind: 'not_applicable' };
  }
  if (
    messageActions.some(
      (action) => action.actionType === 'ask_question' && isPlaceholder(action)
    )
  ) {
    return { kind: 'not_applicable' };
  }
  if (
    messageActions.some(
      (action) =>
        !action.content?.trim() ||
        (!isPlaceholder(action) && /\{\{[^}]+\}\}/.test(action.content))
    )
  ) {
    return { kind: 'not_applicable' };
  }

  const allScriptedCopy = params.allBranchActions
    .flat()
    .filter(
      (action) =>
        ['send_message', 'ask_question'].includes(action.actionType) &&
        !!action.content?.trim() &&
        !isPlaceholder(action)
    )
    .map((action) => action.content!.trim());
  const generatedSlots =
    placeholderCount === 0
      ? []
      : params.generatedMessages
          .map((message) => message.trim())
          .filter(
            (message) =>
              message.length > 0 &&
              !/[?？]\s*$/.test(message) &&
              !/https?:\/\//i.test(message) &&
              !allScriptedCopy.some((copy) =>
                resemblesScriptedCopy(message, copy)
              )
          );
  if (generatedSlots.length !== placeholderCount) {
    return {
      kind: 'missing_placeholder',
      expected: placeholderCount,
      found: generatedSlots.length
    };
  }
  const roleSlotIndex = messageActions
    .filter(isPlaceholder)
    .findIndex((action) => /which role to grab/i.test(action.content ?? ''));
  if (params.requiredRole && roleSlotIndex >= 0) {
    const role = params.requiredRole.toLowerCase();
    const opposite = role === 'futures' ? 'forex' : 'futures';
    const slot = generatedSlots[roleSlotIndex].toLowerCase();
    if (
      !new RegExp(`\\b${role}\\s+role\\b`).test(slot) ||
      new RegExp(`\\b${opposite}\\s+role\\b`).test(slot)
    ) {
      return {
        kind: 'missing_placeholder',
        expected: placeholderCount,
        found: Math.max(0, generatedSlots.length - 1)
      };
    }
  }

  let generatedIndex = 0;
  const bubbles = actions.flatMap((action) => {
    if (action.actionType === 'send_link') return [linkUrl(action)];
    if (
      action.actionType !== 'send_message' &&
      action.actionType !== 'ask_question'
    ) {
      return [];
    }
    if (isPlaceholder(action)) return [generatedSlots[generatedIndex++]];
    const content = action.content!.trim();
    return params.alreadyDelivered(content) ? [] : [content];
  });
  return {
    kind: 'assembled',
    bubbles,
    fixedMessages: [...fixedMessages, ...links.map(linkUrl)]
  };
}
