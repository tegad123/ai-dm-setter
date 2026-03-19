import { writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { getCredentials } from '@/lib/credential-store';

const BASE_URL = 'https://api.elevenlabs.io/v1';

/** Voice settings optimized for DM-style voice notes */
const DM_VOICE_SETTINGS = {
  stability: 0.5, // Natural variation
  similarity_boost: 0.8, // Sound like the account's voice clone
  style: 0.3, // Moderate expressiveness
  use_speaker_boost: true
};

interface GenerateVoiceNoteResult {
  audioUrl: string;
  duration: number;
}

interface Voice {
  voice_id: string;
  name: string;
}

/**
 * Resolve ElevenLabs credentials for the given account.
 * Tries the per-account credential store first, then falls back to env vars.
 */
async function resolveElevenLabsCredentials(accountId: string): Promise<{
  apiKey: string;
  voiceId: string;
}> {
  const stored = await getCredentials(accountId, 'ELEVENLABS');

  const apiKey = stored?.apiKey ?? process.env.ELEVENLABS_API_KEY;
  const voiceId = stored?.voiceId ?? process.env.ELEVENLABS_VOICE_ID;

  if (!apiKey) {
    throw new Error(
      `No ElevenLabs API key found for account ${accountId}. ` +
        'Store credentials via the credential store or set ELEVENLABS_API_KEY env var.'
    );
  }
  if (!voiceId) {
    throw new Error(
      `No ElevenLabs voice ID found for account ${accountId}. ` +
        'Store credentials via the credential store or set ELEVENLABS_VOICE_ID env var.'
    );
  }

  return { apiKey, voiceId };
}

/**
 * Generate a voice note using the account's ElevenLabs voice clone.
 * Converts text to speech and saves the MP3 to a temp file.
 * The storage path can be swapped for S3 later.
 */
export async function generateVoiceNote(
  accountId: string,
  text: string
): Promise<GenerateVoiceNoteResult> {
  const { apiKey, voiceId } = await resolveElevenLabsCredentials(accountId);

  const response = await fetch(`${BASE_URL}/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_monolingual_v1',
      voice_settings: DM_VOICE_SETTINGS
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`ElevenLabs API error (${response.status}): ${errorBody}`);
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());

  // Save to tmp directory (swap with S3 upload later)
  const filename = `voice_${randomUUID()}.mp3`;
  const filePath = join(tmpdir(), filename);
  await writeFile(filePath, audioBuffer);

  // Estimate duration from MP3 file size
  // Average MP3 bitrate ~128kbps = 16KB/s
  const estimatedDuration = Math.round(audioBuffer.length / 16000);

  return {
    audioUrl: filePath,
    duration: estimatedDuration
  };
}

/**
 * List all available voices from ElevenLabs account.
 */
export async function getVoices(accountId: string): Promise<Voice[]> {
  const { apiKey } = await resolveElevenLabsCredentials(accountId);

  const response = await fetch(`${BASE_URL}/voices`, {
    headers: {
      'xi-api-key': apiKey
    }
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`ElevenLabs API error (${response.status}): ${errorBody}`);
  }

  const data = await response.json();

  return (data.voices ?? []).map((v: { voice_id: string; name: string }) => ({
    voice_id: v.voice_id,
    name: v.name
  }));
}

/**
 * Get voice settings for a specific voice.
 */
export async function getVoiceSettings(
  accountId: string,
  voiceId: string
): Promise<unknown> {
  const { apiKey } = await resolveElevenLabsCredentials(accountId);

  const response = await fetch(`${BASE_URL}/voices/${voiceId}/settings`, {
    headers: {
      'xi-api-key': apiKey
    }
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`ElevenLabs API error (${response.status}): ${errorBody}`);
  }

  return response.json();
}
