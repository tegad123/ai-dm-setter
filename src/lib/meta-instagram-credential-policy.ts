type CredentialMetadata = Record<string, unknown> | null | undefined;

export function shouldPreserveDirectInstagramCredential(
  metadata: CredentialMetadata
): boolean {
  if (!metadata) return false;
  if (metadata.connectedVia === 'META_OAUTH') return false;
  return (
    metadata.connectedVia === 'INSTAGRAM_LOGIN' ||
    typeof metadata.igProfessionalAccountId === 'string' ||
    metadata.webhookSubscribed === true
  );
}
