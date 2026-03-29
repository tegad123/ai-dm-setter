import { getCredentials } from '@/lib/credential-store';

/**
 * Generate a voice note using ElevenLabs TTS API.
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
  const selectedVoiceId = voiceId || (creds as any).voiceId || 'default';

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
        model_id: 'eleven_monolingual_v1',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75
        }
      })
    }
  );

  if (!response.ok) {
    throw new Error(`ElevenLabs API error: ${response.status}`);
  }

  // In a real implementation, you'd upload the audio to a CDN
  // and return the URL. For now, return a placeholder.
  const audioBuffer = await response.arrayBuffer();
  const durationMs = Math.round(audioBuffer.byteLength / 32); // Rough estimate

  return {
    audioUrl: `data:audio/mpeg;base64,placeholder`,
    duration: Math.round(durationMs / 1000),
    durationMs
  };
}
