export interface ManyChatProcessingEligibilityInput {
  platform: 'INSTAGRAM' | 'FACEBOOK';
  aiActive: boolean;
  awaitingHumanReview: boolean;
  distressDetected: boolean;
  schedulingConflict: boolean;
  autoSendOverride: boolean;
  awayModeInstagram: boolean;
  awayModeFacebook: boolean;
  generateOnlyInstagram: boolean;
  generateOnlyFacebook: boolean;
}

/**
 * Shared guard for explicit completion and missing-callback recovery.
 *
 * AI-off, Away Mode, and generate-only are delivery policies enforced by the
 * existing scheduler after it generates a suggestion. They are deliberately
 * not intake holds here. Treating them as holds would make the completion
 * callback silently skip the suggestion behavior that normal inbound follows.
 */
export function isManyChatProcessingEligible(
  input: ManyChatProcessingEligibilityInput
): boolean {
  return !input.awaitingHumanReview && !input.schedulingConflict;
}
