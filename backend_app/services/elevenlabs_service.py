"""
ElevenLabs Voice Note Service — text-to-voice-note pipeline using Daniel's cloned voice.
"""
import uuid
import os
import httpx
from app.core.config import get_settings

settings = get_settings()

VOICE_NOTES_DIR = "static/voice_notes"
os.makedirs(VOICE_NOTES_DIR, exist_ok=True)


async def generate_voice_note(text: str) -> dict:
    """
    Convert text to a voice note using Daniel's cloned voice via ElevenLabs.
    Returns dict with file_path, url, and duration.
    """
    async with httpx.AsyncClient() as client:
        response = await client.post(
            f"https://api.elevenlabs.io/v1/text-to-speech/{settings.elevenlabs_voice_id}",
            headers={
                "xi-api-key": settings.elevenlabs_api_key,
                "Content-Type": "application/json",
                "Accept": "audio/mpeg",
            },
            json={
                "text": text,
                "model_id": "eleven_multilingual_v2",
                "voice_settings": {
                    "stability": 0.5,
                    "similarity_boost": 0.8,
                    "style": 0.4,
                    "use_speaker_boost": True,
                },
            },
            timeout=30.0,
        )
        response.raise_for_status()

    # Save audio file
    file_id = str(uuid.uuid4())
    file_name = f"{file_id}.mp3"
    file_path = os.path.join(VOICE_NOTES_DIR, file_name)

    with open(file_path, "wb") as f:
        f.write(response.content)

    # Estimate duration (~150 words per minute, average word = 5 chars)
    word_count = len(text.split())
    estimated_duration = (word_count / 150) * 60

    return {
        "file_path": file_path,
        "file_name": file_name,
        "url": f"/static/voice_notes/{file_name}",
        "duration": round(estimated_duration, 1),
        "size_bytes": len(response.content),
    }


async def get_voice_info() -> dict | None:
    """Get info about Daniel's voice clone from ElevenLabs."""
    if not settings.elevenlabs_api_key or not settings.elevenlabs_voice_id:
        return None

    async with httpx.AsyncClient() as client:
        response = await client.get(
            f"https://api.elevenlabs.io/v1/voices/{settings.elevenlabs_voice_id}",
            headers={"xi-api-key": settings.elevenlabs_api_key},
            timeout=10.0,
        )
        if response.status_code == 200:
            return response.json()
    return None
