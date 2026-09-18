export const META_PAGE_WEBHOOK_FIELDS = [
  'messages',
  'message_echoes',
  'messaging_postbacks',
  'messaging_optins',
  'message_deliveries',
  'message_reads'
] as const;

export const META_INSTAGRAM_WEBHOOK_FIELDS = [
  'messages',
  'message_echoes',
  'messaging_postbacks',
  'messaging_optins'
] as const;

export const REQUIRED_META_PAGE_WEBHOOK_FIELDS = [
  'messages',
  'message_echoes',
  'messaging_postbacks'
] as const;

export const META_SUBSCRIPTION_ALERT_THROTTLE_MS = 24 * 60 * 60 * 1000;

export function buildMetaPageSubscriptionPayload(accessToken: string): {
  subscribed_fields: string;
  access_token: string;
} {
  return {
    subscribed_fields: META_PAGE_WEBHOOK_FIELDS.join(','),
    access_token: accessToken
  };
}

export function buildMetaInstagramSubscriptionPayload(accessToken: string): {
  subscribed_fields: string;
  access_token: string;
} {
  return {
    subscribed_fields: META_INSTAGRAM_WEBHOOK_FIELDS.join(','),
    access_token: accessToken
  };
}

export interface MetaWebhookSubscriptionAssessment {
  healthy: boolean;
  missingFields: string[];
  alertTitle?: string;
  alertBody?: string;
}

/**
 * Describe the user-visible impact of the Page webhook fields that are
 * actually missing. `messages`, `message_echoes`, and `messaging_postbacks`
 * carry different traffic, so reporting every partial subscription as an
 * inbound-DM outage sends operators to the wrong incident.
 */
export function assessMetaWebhookSubscription(params: {
  pageId: string;
  appSubscribed: boolean;
  subscribedFields?: string[];
}): MetaWebhookSubscriptionAssessment {
  const { pageId, appSubscribed } = params;

  if (!appSubscribed) {
    return {
      healthy: false,
      missingFields: [...REQUIRED_META_PAGE_WEBHOOK_FIELDS],
      alertTitle: 'Meta webhook subscription issue: app not subscribed',
      alertBody:
        `Health check: page ${pageId} is not subscribed to this Meta app. ` +
        'Inbound lead DMs, messages sent outside Convlo, and button or postback interactions will not reach Convlo. ' +
        'Reconnect via Settings > Integrations to restore the Page webhook subscription.'
    };
  }

  const subscribed = new Set(params.subscribedFields ?? []);
  const missingFields = REQUIRED_META_PAGE_WEBHOOK_FIELDS.filter(
    (field) => !subscribed.has(field)
  );
  if (missingFields.length === 0) {
    return { healthy: true, missingFields: [] };
  }

  const impacts: string[] = [];
  const missingMessages = missingFields.includes('messages');
  const missingEchoes = missingFields.includes('message_echoes');
  const missingPostbacks = missingFields.includes('messaging_postbacks');

  if (missingMessages) {
    impacts.push('New inbound lead DMs will not reach Convlo.');
  }
  if (missingEchoes) {
    impacts.push(
      missingMessages
        ? 'Messages sent from the Page, Meta Business Suite, a phone, or another connected app will also be absent from Convlo.'
        : 'Inbound lead DMs still reach Convlo, but messages sent from the Page, Meta Business Suite, a phone, or another connected app will not be mirrored into Convlo. Conversation history can be incomplete.'
    );
  }
  if (missingPostbacks) {
    impacts.push(
      missingMessages
        ? 'Button and postback interactions will not reach Convlo.'
        : 'Text DMs still reach Convlo, but button and postback interactions will not.'
    );
  }

  return {
    healthy: false,
    missingFields: [...missingFields],
    alertTitle: `Meta webhook subscription issue: missing ${missingFields.join(', ')}`,
    alertBody:
      `Health check: page ${pageId} is missing webhook fields: ${missingFields.join(', ')}. ` +
      `${impacts.join(' ')} ` +
      'Reconnect via Settings > Integrations to restore the missing subscription fields.'
  };
}
