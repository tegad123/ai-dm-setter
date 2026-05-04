import prisma from '@/lib/prisma';
import { getCredentials } from '@/lib/credential-store';
import { broadcastNotification } from '@/lib/realtime';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';

export type InboundMediaType = 'audio' | 'image' | 'video';

export interface InboundMediaAttachment {
  type?: string | null;
  mediaType?: string | null;
  mimeType?: string | null;
  payload?: {
    url?: string | null;
    mediaType?: string | null;
    mimeType?: string | null;
    mime_type?: string | null;
    duration?: number | string | null;
    durationMs?: number | string | null;
    duration_ms?: number | string | null;
  } | null;
}

interface DownloadedMedia {
  buffer: Buffer;
  contentType: string;
  extension: string;
}

interface ProcessInboundMediaParams {
  accountId: string;
  personaId: string;
  conversationId: string;
  messageId: string;
  mediaType: 'audio' | 'image';
  sourceUrl: string;
  durationSeconds?: number | null;
}

interface MediaProcessResult {
  success: boolean;
  mediaUrl?: string | null;
  transcription?: string | null;
  imageMetadata?: ImageMetadata | null;
  error?: string | null;
  costUsd?: number | null;
}

export interface ImageMetadata {
  extractedText: string;
  description: string;
  contextualNote: string;
}

const SUPABASE_MEDIA_BUCKET =
  process.env.MEDIA_ATTACHMENTS_BUCKET || 'media-attachments';
const WHISPER_MODEL = 'whisper-1';
const VISION_MODEL = 'gpt-4o';
const AUDIO_TIMEOUT_MS = 10_000;
const IMAGE_TIMEOUT_MS = 8_000;
const WHISPER_USD_PER_MINUTE = 0.006;
const VISION_USD_PER_IMAGE = 0.01;

const IMAGE_METADATA_SYSTEM_PROMPT = `You are processing an image sent by a lead in a high-ticket sales conversation. Return strict JSON only:
{
  "extractedText": "<verbatim text visible in image, or empty string>",
  "description": "<one-sentence description of what the image shows>",
  "contextualNote": "<one-sentence relevance to a sales conversation, e.g. 'screenshot of broker account showing $X balance', 'meme about trading losses', 'screenshot of voice note transcription'>"
}`;

export function detectAttachmentMediaType(
  attachment: InboundMediaAttachment | null | undefined
): InboundMediaType | null {
  const candidates = [
    attachment?.type,
    attachment?.mediaType,
    attachment?.mimeType,
    attachment?.payload?.mediaType,
    attachment?.payload?.mimeType,
    attachment?.payload?.mime_type
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.toLowerCase());

  if (
    candidates.some((value) => value === 'audio' || value.startsWith('audio/'))
  ) {
    return 'audio';
  }
  if (
    candidates.some((value) => value === 'image' || value.startsWith('image/'))
  ) {
    return 'image';
  }
  if (
    candidates.some((value) => value === 'video' || value.startsWith('video/'))
  ) {
    return 'video';
  }

  return null;
}

export function findFirstMediaAttachment(
  attachments: InboundMediaAttachment[] | undefined,
  mediaType: 'audio' | 'image'
): { url: string; attachment: InboundMediaAttachment } | null {
  if (!Array.isArray(attachments)) return null;

  for (const attachment of attachments) {
    if (detectAttachmentMediaType(attachment) !== mediaType) continue;
    const url = attachment.payload?.url;
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
      return { url, attachment };
    }
  }

  return null;
}

export function extractAttachmentDurationSeconds(
  attachment: InboundMediaAttachment | null | undefined
): number | null {
  const raw =
    attachment?.payload?.duration ??
    attachment?.payload?.durationMs ??
    attachment?.payload?.duration_ms;
  if (raw === null || raw === undefined || raw === '') return null;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  // Meta payloads vary by surface. Large values are milliseconds.
  return parsed > 1_000 ? parsed / 1_000 : parsed;
}

export function buildImageContextText(
  metadata: ImageMetadata | Prisma.JsonValue | null | undefined
): string {
  const normalized = normalizeImageMetadata(metadata);
  if (!normalized) return '[Image]';

  const parts = [`Image: ${normalized.description || 'image sent by lead'}`];
  if (normalized.extractedText.trim()) {
    parts.push(`Text: "${normalized.extractedText.trim()}"`);
  }
  if (normalized.contextualNote.trim()) {
    parts.push(`Note: ${normalized.contextualNote.trim()}`);
  }

  return `[${parts.join(' | ')}]`;
}

export function buildVoiceContextText(params: {
  transcription?: string | null;
  mediaProcessedAt?: Date | string | null;
  mediaProcessingError?: string | null;
}): string {
  const transcription = params.transcription?.trim();
  if (transcription) {
    return `[Voice note (transcribed): "${transcription}"]`;
  }
  if (params.mediaProcessedAt || params.mediaProcessingError) {
    return '[Voice note - could not transcribe]';
  }
  return '[Voice note]';
}

export function enqueueInboundMediaProcessing(
  params: ProcessInboundMediaParams
): Promise<MediaProcessResult> {
  return processInboundMediaForMessage(params);
}

export async function processInboundMediaForMessage(
  params: ProcessInboundMediaParams
): Promise<MediaProcessResult> {
  const startedAt = Date.now();
  let mediaUrl: string | null = null;
  let costUsd: number | null = null;
  let transcriptionLength: number | null = null;

  try {
    const downloaded = await downloadRemoteMedia(
      params.sourceUrl,
      params.mediaType === 'audio' ? AUDIO_TIMEOUT_MS : IMAGE_TIMEOUT_MS
    );
    mediaUrl = await uploadMediaAttachment({
      buffer: downloaded.buffer,
      contentType: downloaded.contentType,
      extension: downloaded.extension,
      personaId: params.personaId,
      conversationId: params.conversationId,
      messageId: params.messageId
    });

    if (params.mediaType === 'audio') {
      const transcription = await transcribeAudio({
        accountId: params.accountId,
        media: downloaded
      });
      transcriptionLength = transcription.length;
      costUsd = calculateWhisperCostUsd(params.durationSeconds);

      await prisma.message.update({
        where: { id: params.messageId },
        data: {
          mediaType: 'audio',
          mediaUrl,
          transcription,
          mediaProcessedAt: new Date(),
          mediaProcessingError: null,
          mediaCostUsd: decimalOrNull(costUsd)
        }
      });

      await writeMediaProcessingLog({
        accountId: params.accountId,
        messageId: params.messageId,
        mediaType: 'audio',
        startedAt,
        success: true,
        transcriptionLength,
        costUsd
      });

      return { success: true, mediaUrl, transcription, costUsd };
    }

    const imageMetadata = await extractImageMetadata({
      accountId: params.accountId,
      media: downloaded
    });
    costUsd = VISION_USD_PER_IMAGE;

    await prisma.message.update({
      where: { id: params.messageId },
      data: {
        mediaType: 'image',
        mediaUrl,
        ...(mediaUrl && /^https?:\/\//i.test(mediaUrl)
          ? { imageUrl: mediaUrl }
          : {}),
        hasImage: true,
        imageMetadata: imageMetadata as unknown as Prisma.InputJsonObject,
        mediaProcessedAt: new Date(),
        mediaProcessingError: null,
        mediaCostUsd: decimalOrNull(costUsd)
      }
    });

    await writeMediaProcessingLog({
      accountId: params.accountId,
      messageId: params.messageId,
      mediaType: 'image',
      startedAt,
      success: true,
      transcriptionLength: null,
      costUsd
    });

    return { success: true, mediaUrl, imageMetadata, costUsd };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.message.update({
      where: { id: params.messageId },
      data: {
        mediaType: params.mediaType,
        mediaUrl,
        mediaProcessedAt: new Date(),
        mediaProcessingError: message,
        mediaCostUsd: decimalOrNull(costUsd)
      }
    });
    await writeMediaProcessingLog({
      accountId: params.accountId,
      messageId: params.messageId,
      mediaType: params.mediaType,
      startedAt,
      success: false,
      errorMessage: message,
      transcriptionLength,
      costUsd
    });
    console.warn(
      `[media-processing] ${params.mediaType} processing failed for message ${params.messageId}: ${message}`
    );
    return { success: false, mediaUrl, error: message, costUsd };
  }
}

async function downloadRemoteMedia(
  url: string,
  timeoutMs: number
): Promise<DownloadedMedia> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(
        `media download failed: ${response.status} ${response.statusText}`
      );
    }
    const contentType =
      response.headers.get('content-type') || contentTypeFromUrl(url);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0) {
      throw new Error('media download returned an empty file');
    }
    return {
      buffer,
      contentType,
      extension: extensionFromContentType(contentType)
    };
  } finally {
    clearTimeout(timer);
  }
}

async function uploadMediaAttachment(params: {
  buffer: Buffer;
  contentType: string;
  extension: string;
  personaId: string;
  conversationId: string;
  messageId: string;
}): Promise<string> {
  const objectPath = `${safePathSegment(params.personaId)}/${safePathSegment(
    params.conversationId
  )}/${safePathSegment(params.messageId)}.${params.extension}`;

  const supabaseUrl =
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

  if (supabaseUrl && supabaseKey) {
    const baseUrl = supabaseUrl.replace(/\/$/, '');
    const uploadUrl = `${baseUrl}/storage/v1/object/${SUPABASE_MEDIA_BUCKET}/${objectPath}`;
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${supabaseKey}`,
        apikey: supabaseKey,
        'Content-Type': params.contentType,
        'x-upsert': 'true'
      },
      body: params.buffer
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Supabase media upload failed: ${response.status} ${response.statusText}${body ? ` ${body.slice(0, 160)}` : ''}`
      );
    }
    return objectPath;
  }

  const { put } = await import('@vercel/blob');
  const blob = await put(`media-attachments/${objectPath}`, params.buffer, {
    access: 'public',
    contentType: params.contentType
  });
  return blob.url;
}

async function transcribeAudio(params: {
  accountId: string;
  media: DownloadedMedia;
}): Promise<string> {
  const apiKey = await getOpenAIApiKey(params.accountId);
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });
  const file = new File(
    [params.media.buffer],
    `voice.${params.media.extension}`,
    {
      type: params.media.contentType
    }
  );

  const result = await withTimeout(
    client.audio.transcriptions.create({
      file,
      model: WHISPER_MODEL
    }),
    AUDIO_TIMEOUT_MS,
    'Whisper transcription timed out'
  );

  const text = typeof result.text === 'string' ? result.text.trim() : '';
  if (!text) {
    throw new Error('Whisper returned an empty transcription');
  }
  return text;
}

async function extractImageMetadata(params: {
  accountId: string;
  media: DownloadedMedia;
}): Promise<ImageMetadata> {
  const apiKey = await getOpenAIApiKey(params.accountId);
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey });
  const imageDataUrl = `data:${params.media.contentType};base64,${params.media.buffer.toString('base64')}`;

  const response = await withTimeout(
    client.chat.completions.create({
      model: VISION_MODEL,
      temperature: 0,
      max_completion_tokens: 500,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: IMAGE_METADATA_SYSTEM_PROMPT
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Extract the visible text and sales-relevant context from this image.'
            },
            {
              type: 'image_url',
              image_url: { url: imageDataUrl, detail: 'low' }
            }
          ]
        }
      ]
    }),
    IMAGE_TIMEOUT_MS,
    'Image vision extraction timed out'
  );

  const raw = response.choices[0]?.message?.content || '{}';
  return parseImageMetadata(raw);
}

async function getOpenAIApiKey(accountId: string): Promise<string> {
  const creds = await getCredentials(accountId, 'OPENAI');
  const apiKey =
    (typeof creds?.apiKey === 'string' && creds.apiKey) ||
    process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OpenAI API key not configured');
  }
  return apiKey;
}

function parseImageMetadata(raw: string): ImageMetadata {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Image vision returned invalid JSON');
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Image vision returned a non-object JSON payload');
  }

  const record = parsed as Record<string, unknown>;
  return {
    extractedText:
      typeof record.extractedText === 'string' ? record.extractedText : '',
    description:
      typeof record.description === 'string'
        ? record.description
        : 'image sent by lead',
    contextualNote:
      typeof record.contextualNote === 'string' ? record.contextualNote : ''
  };
}

function normalizeImageMetadata(
  metadata: ImageMetadata | Prisma.JsonValue | null | undefined
): ImageMetadata | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const record = metadata as Record<string, unknown>;
  return {
    extractedText:
      typeof record.extractedText === 'string' ? record.extractedText : '',
    description:
      typeof record.description === 'string'
        ? record.description
        : 'image sent by lead',
    contextualNote:
      typeof record.contextualNote === 'string' ? record.contextualNote : ''
  };
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string
): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function writeMediaProcessingLog(params: {
  accountId: string;
  messageId: string;
  mediaType: 'audio' | 'image';
  startedAt: number;
  success: boolean;
  errorMessage?: string | null;
  transcriptionLength?: number | null;
  costUsd?: number | null;
}) {
  const log = await prisma.mediaProcessingLog.create({
    data: {
      accountId: params.accountId,
      messageId: params.messageId,
      mediaType: params.mediaType,
      latencyMs: Date.now() - params.startedAt,
      success: params.success,
      errorMessage: params.errorMessage ?? null,
      transcriptionLength: params.transcriptionLength ?? null,
      costUsd: decimalOrNull(params.costUsd ?? null)
    }
  });
  await maybeAlertMediaProcessingHealth(params.accountId);
  return log;
}

async function maybeAlertMediaProcessingHealth(
  accountId: string
): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [total, successful, existing] = await Promise.all([
    prisma.mediaProcessingLog.count({
      where: { accountId, createdAt: { gte: oneHourAgo } }
    }),
    prisma.mediaProcessingLog.count({
      where: { accountId, createdAt: { gte: oneHourAgo }, success: true }
    }),
    prisma.notification.findFirst({
      where: {
        accountId,
        type: 'SYSTEM',
        title: { contains: 'Media processing success rate below 95%' },
        createdAt: { gte: oneHourAgo }
      },
      select: { id: true }
    })
  ]);
  if (total === 0 || existing) return;

  const successRate = (successful / total) * 100;
  if (successRate >= 95) return;

  const title = 'Media processing success rate below 95%';
  const body = `Media processing success rate is ${successRate.toFixed(1)}% over the last hour (${successful}/${total} succeeded). Check OpenAI/Supabase credentials and recent MediaProcessingLog rows.`;
  await prisma.notification.create({
    data: {
      accountId,
      type: 'SYSTEM',
      title,
      body
    }
  });
  broadcastNotification(accountId, { type: 'SYSTEM', title });
}

function calculateWhisperCostUsd(durationSeconds?: number | null): number {
  const billableSeconds =
    typeof durationSeconds === 'number' && Number.isFinite(durationSeconds)
      ? Math.max(1, durationSeconds)
      : 60;
  return (billableSeconds / 60) * WHISPER_USD_PER_MINUTE;
}

function decimalOrNull(
  value: number | null | undefined
): Prisma.Decimal | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Prisma.Decimal(value.toFixed(6));
}

function extensionFromContentType(contentType: string): string {
  const normalized = contentType.toLowerCase().split(';')[0]?.trim();
  if (normalized === 'audio/mpeg') return 'mp3';
  if (normalized === 'audio/mp4') return 'm4a';
  if (normalized === 'audio/x-m4a') return 'm4a';
  if (normalized === 'audio/aac') return 'aac';
  if (normalized === 'audio/ogg') return 'ogg';
  if (normalized === 'audio/wav') return 'wav';
  if (normalized === 'audio/webm') return 'webm';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/gif') return 'gif';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  return normalized.startsWith('image/') ? 'jpg' : 'mp3';
}

function contentTypeFromUrl(url: string): string {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith('.png')) return 'image/png';
  if (pathname.endsWith('.webp')) return 'image/webp';
  if (pathname.endsWith('.gif')) return 'image/gif';
  if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (pathname.endsWith('.m4a')) return 'audio/mp4';
  if (pathname.endsWith('.aac')) return 'audio/aac';
  if (pathname.endsWith('.ogg')) return 'audio/ogg';
  if (pathname.endsWith('.wav')) return 'audio/wav';
  if (pathname.endsWith('.webm')) return 'audio/webm';
  return 'audio/mpeg';
}

function safePathSegment(value: string): string {
  return (value || randomUUID()).replace(/[^a-zA-Z0-9._-]/g, '-');
}
