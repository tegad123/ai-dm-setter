export interface UrlSanitizationResult {
  sanitized: string;
  removed: string[];
}

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>"')]+/gi;
const TRAILING_URL_PUNCTUATION = /[.,;:!?]+$/;

export function extractUrlsFromText(text: string | null | undefined): string[] {
  if (!text) return [];
  const urls: string[] = [];
  let match: RegExpExecArray | null;
  URL_PATTERN.lastIndex = 0;
  while ((match = URL_PATTERN.exec(text)) !== null) {
    const normalized = trimUrlPunctuation(match[0]);
    if (normalized) urls.push(normalized);
  }
  return urls;
}

export function trimUrlPunctuation(raw: string): string {
  return raw.trim().replace(TRAILING_URL_PUNCTUATION, '');
}

export function normalizeUrlForAllowlist(
  raw: string | null | undefined
): string | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = trimUrlPunctuation(raw);
  if (!trimmed) return null;

  const withProtocol = /^www\./i.test(trimmed) ? `https://${trimmed}` : trimmed;
  if (!/^https?:\/\//i.test(withProtocol)) return null;

  try {
    const url = new URL(withProtocol);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) {
      url.pathname = url.pathname.replace(/\/+$/, '');
    }
    return url.toString();
  } catch {
    return withProtocol;
  }
}

function removeUrlFragment(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url.split('#')[0] ?? url;
  }
}

export function buildNormalizedUrlAllowlist(
  urls: Iterable<string | null | undefined>
): Set<string> {
  const normalized = new Set<string>();
  for (const url of Array.from(urls)) {
    const value = normalizeUrlForAllowlist(url);
    if (value) normalized.add(value);
  }
  return normalized;
}

export function isUrlAllowed(
  candidate: string,
  allowedUrls: Iterable<string | null | undefined>
): boolean {
  const candidateNormalized = normalizeUrlForAllowlist(candidate);
  if (!candidateNormalized) return false;

  const candidateWithoutFragment = removeUrlFragment(candidateNormalized);
  for (const allowedRaw of Array.from(allowedUrls)) {
    const allowed = normalizeUrlForAllowlist(allowedRaw);
    if (!allowed) continue;
    if (allowed === candidateNormalized) return true;
    if (removeUrlFragment(allowed) === candidateWithoutFragment) return true;
  }

  return false;
}

export function sanitizeDisallowedUrls(
  text: string,
  allowedUrls: Iterable<string | null | undefined>
): UrlSanitizationResult {
  const removed: string[] = [];
  URL_PATTERN.lastIndex = 0;
  const sanitized = text.replace(URL_PATTERN, (match) => {
    const trimmed = trimUrlPunctuation(match);
    if (isUrlAllowed(trimmed, allowedUrls)) return match;
    removed.push(trimmed);
    return '[link removed]';
  });

  return { sanitized, removed };
}

export function sanitizeMessageGroupUrls(
  result: { reply: string; messages?: string[] },
  allowedUrls: Iterable<string | null | undefined>
): string[] {
  const removed: string[] = [];
  const replyResult = sanitizeDisallowedUrls(result.reply, allowedUrls);
  result.reply = replyResult.sanitized;
  removed.push(...replyResult.removed);

  if (Array.isArray(result.messages)) {
    result.messages = result.messages.map((message) => {
      const messageResult = sanitizeDisallowedUrls(message, allowedUrls);
      removed.push(...messageResult.removed);
      return messageResult.sanitized;
    });
  }

  return removed;
}
