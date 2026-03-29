"""
Meta Graph API Client — Unified client for Instagram and Facebook messaging.
Handles sending text DMs, voice note attachments, and fetching user profiles.
Uses the Meta Graph API v21.0 (Instagram Messaging API + Messenger Platform).
"""
import logging
import httpx
from pathlib import Path
from app.core.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

GRAPH_API_BASE = "https://graph.facebook.com/v21.0"


class MetaAPIError(Exception):
    """Raised when a Meta Graph API call fails."""
    def __init__(self, message: str, status_code: int | None = None, error_data: dict | None = None):
        self.status_code = status_code
        self.error_data = error_data or {}
        super().__init__(message)


class MetaAPIClient:
    """
    Unified client for Instagram Messaging API and Facebook Messenger Platform.
    Both use the same Graph API under the hood with slightly different endpoints.
    """

    def __init__(self):
        self.access_token = settings.meta_page_access_token
        self.ig_account_id = settings.instagram_account_id
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=GRAPH_API_BASE,
                timeout=30.0,
                headers={"Authorization": f"Bearer {self.access_token}"},
            )
        return self._client

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    # ── Instagram Messaging ──────────────────────────────────────────────

    async def send_ig_text_message(self, recipient_id: str, text: str) -> dict:
        """Send a text DM to an Instagram user via the Instagram Messaging API."""
        client = await self._get_client()
        payload = {
            "recipient": {"id": recipient_id},
            "message": {"text": text},
        }
        response = await client.post(
            f"/{self.ig_account_id}/messages",
            json=payload,
        )
        return self._handle_response(response, "send_ig_text_message")

    async def send_ig_voice_note(self, recipient_id: str, audio_url: str) -> dict:
        """Send a voice note as an audio attachment in an Instagram DM."""
        client = await self._get_client()
        payload = {
            "recipient": {"id": recipient_id},
            "message": {
                "attachment": {
                    "type": "audio",
                    "payload": {"url": audio_url, "is_reusable": False},
                }
            },
        }
        response = await client.post(
            f"/{self.ig_account_id}/messages",
            json=payload,
        )
        return self._handle_response(response, "send_ig_voice_note")

    async def get_ig_user_profile(self, ig_scoped_id: str) -> dict:
        """Fetch Instagram user profile info (name, profile_pic, username)."""
        client = await self._get_client()
        response = await client.get(
            f"/{ig_scoped_id}",
            params={"fields": "name,profile_pic,username,follower_count,is_verified_user"},
        )
        return self._handle_response(response, "get_ig_user_profile")

    # ── Facebook Messenger ───────────────────────────────────────────────

    async def send_fb_text_message(self, recipient_id: str, text: str) -> dict:
        """Send a text message via Facebook Messenger."""
        client = await self._get_client()
        payload = {
            "recipient": {"id": recipient_id},
            "messaging_type": "RESPONSE",
            "message": {"text": text},
        }
        response = await client.post("/me/messages", json=payload)
        return self._handle_response(response, "send_fb_text_message")

    async def send_fb_voice_note(self, recipient_id: str, audio_url: str) -> dict:
        """Send a voice note as an audio attachment via Facebook Messenger."""
        client = await self._get_client()
        payload = {
            "recipient": {"id": recipient_id},
            "messaging_type": "RESPONSE",
            "message": {
                "attachment": {
                    "type": "audio",
                    "payload": {"url": audio_url, "is_reusable": False},
                }
            },
        }
        response = await client.post("/me/messages", json=payload)
        return self._handle_response(response, "send_fb_voice_note")

    async def get_fb_user_profile(self, psid: str) -> dict:
        """Fetch Facebook user profile info from Page-Scoped ID."""
        client = await self._get_client()
        response = await client.get(
            f"/{psid}",
            params={"fields": "first_name,last_name,profile_pic"},
        )
        return self._handle_response(response, "get_fb_user_profile")

    # ── Upload audio file (for voice notes that need upload first) ───────

    async def upload_audio_attachment(self, file_path: str, platform: str = "instagram") -> str:
        """
        Upload an audio file to Meta's attachment API and return the attachment URL.
        Used when we need to upload a local file rather than provide a hosted URL.
        """
        client = await self._get_client()
        path = Path(file_path)
        if not path.exists():
            raise MetaAPIError(f"Audio file not found: {file_path}")

        endpoint = f"/{self.ig_account_id}/message_attachments" if platform == "instagram" else "/me/message_attachments"

        with open(path, "rb") as f:
            response = await client.post(
                endpoint,
                data={
                    "message": '{"attachment":{"type":"audio","payload":{"is_reusable":true}}}',
                },
                files={"filedata": (path.name, f, "audio/mpeg")},
            )
        result = self._handle_response(response, "upload_audio_attachment")
        return result.get("attachment_id", "")

    # ── Webhook subscription management ──────────────────────────────────

    async def subscribe_to_webhooks(self, page_id: str, fields: list[str] | None = None) -> dict:
        """Subscribe a Facebook Page to webhook events (messages, comments, etc)."""
        client = await self._get_client()
        if fields is None:
            fields = ["messages", "messaging_postbacks", "feed"]
        response = await client.post(
            f"/{page_id}/subscribed_apps",
            json={"subscribed_fields": fields},
        )
        return self._handle_response(response, "subscribe_to_webhooks")

    # ── Comment detection (used by webhook parser) ───────────────────────

    async def get_post_comments(self, post_id: str, limit: int = 25) -> list[dict]:
        """Fetch recent comments on a specific post."""
        client = await self._get_client()
        response = await client.get(
            f"/{post_id}/comments",
            params={"fields": "id,from,message,created_time", "limit": limit},
        )
        result = self._handle_response(response, "get_post_comments")
        return result.get("data", [])

    async def get_ig_media_comments(self, media_id: str, limit: int = 25) -> list[dict]:
        """Fetch recent comments on an Instagram media post."""
        client = await self._get_client()
        response = await client.get(
            f"/{media_id}/comments",
            params={"fields": "id,from,text,timestamp,username", "limit": limit},
        )
        result = self._handle_response(response, "get_ig_media_comments")
        return result.get("data", [])

    # ── Internal helpers ─────────────────────────────────────────────────

    def _handle_response(self, response: httpx.Response, context: str) -> dict:
        """Parse and validate Meta API response."""
        try:
            data = response.json()
        except Exception:
            raise MetaAPIError(
                f"[{context}] Non-JSON response: {response.text[:200]}",
                status_code=response.status_code,
            )

        if response.status_code >= 400:
            error = data.get("error", {})
            msg = error.get("message", response.text[:200])
            code = error.get("code", "unknown")
            logger.error(f"[{context}] Meta API error {code}: {msg}")
            raise MetaAPIError(
                f"[{context}] {msg}",
                status_code=response.status_code,
                error_data=error,
            )

        return data


# Module-level singleton
meta_client = MetaAPIClient()
