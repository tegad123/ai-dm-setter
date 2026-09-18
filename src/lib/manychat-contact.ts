export type ManyChatPlatform = 'INSTAGRAM' | 'FACEBOOK';

export interface ManyChatContactPayload {
  platform?: ManyChatPlatform;
  instagramUserId?: string;
  instagramUsername?: string;
  facebookUserId?: string;
  contactName?: string;
  manyChatSubscriberId?: string;
}

export interface ManyChatContactIdentity {
  platform: ManyChatPlatform;
  platformUserIds: string[];
  handle: string;
}

function clean(value: string | undefined): string {
  return value?.trim() ?? '';
}

export function cleanManyChatInstagramUsername(
  username: string | undefined
): string {
  return clean(username).replace(/^@+/, '');
}

/**
 * Convert a callback identity into the same platform keys used by Lead.
 * Facebook's ManyChat subscriber id is a valid fallback PSID; Instagram's
 * subscriber id is not an IGSID and is therefore never used as one.
 */
export function resolveManyChatContactIdentity(
  payload: ManyChatContactPayload
): ManyChatContactIdentity {
  const platform = payload.platform ?? 'INSTAGRAM';
  const platformUserIds = Array.from(
    new Set(
      (platform === 'FACEBOOK'
        ? [payload.facebookUserId, payload.manyChatSubscriberId]
        : [payload.instagramUserId]
      )
        .map(clean)
        .filter(Boolean)
    )
  );

  if (platformUserIds.length === 0) {
    throw new Error(
      platform === 'FACEBOOK'
        ? 'Facebook callback requires facebookUserId or manyChatSubscriberId'
        : 'Instagram callback requires instagramUserId'
    );
  }

  return {
    platform,
    platformUserIds,
    handle:
      platform === 'INSTAGRAM'
        ? cleanManyChatInstagramUsername(payload.instagramUsername)
        : ''
  };
}
