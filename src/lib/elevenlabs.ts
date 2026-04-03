import { getCredentials } from '@/lib/credential-store';
import { put } from '@vercel/blob';

/**
 * Generate a voice note using ElevenLabs TTS API.
 * Uploads the audio to Vercel Blob Storage and returns a public URL.
 * Falls back with an error if ElevenLabs is not configured or fails.
 */
export async function generateVoiceNote(
  accountId: string,
  text: string,
  voiceId?: string
): Promise<{ audioUrl: string; duration: number; durationMs: number }> {
  const creds = await getCredentials(accountId, 'ELEVENLABS');
  if (!creds?.apiKey) {
    throw new Error('ElevenLabs API key not configured');
  }

  const apiKey = creds.apiKey as string;

  // Voice ID from: explicit param > credential metadata > env var
  const credMeta = creds as any;
  const selectedVoiceId =
    voiceId || credMeta.voiceId || process.env.ELEVENLABS_VOICE_ID || 'default';

  // 1. Generate TTS audio via ElevenLabs API
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${selectedVoiceId}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'xi-api-key': apiKey
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true
        }
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(
      `ElevenLabs API error: ${response.status} ${errorText.slice(0, 200)}`
    );
  }

  // 2. Get audio buffer
  const audioBuffer = await response.arrayBuffer();

  // 3. Upload to Vercel Blob Storage for a public URL
  const filename = `voice-notes/${accountId}/${Date.now()}.mp3`;
  const blob = await put(filename, Buffer.from(audioBuffer), {
    access: 'public',
    contentType: 'audio/mpeg'
  });

  // 4. Estimate duration (MP3 at ~128kbps average)
  const durationMs = Math.round((audioBuffer.byteLength * 8) / 128000) * 1000;

  console.log(
    `[elevenlabs] Voice note generated: ${blob.url} (${Math.round(durationMs / 1000)}s, ${audioBuffer.byteLength} bytes)`
  );

  return {
    audioUrl: blob.url,
    duration: Math.round(durationMs / 1000),
    durationMs
  };
}
