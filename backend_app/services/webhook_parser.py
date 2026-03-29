"""
Webhook Payload Parser — Parses incoming Meta webhook payloads for:
  - Instagram DMs (messaging)
  - Instagram comment triggers
  - Facebook Messenger messages
  - Facebook comment triggers

Meta sends a unified webhook format. This module extracts the relevant fields
and converts them into normalized events the orchestrator can process.
"""
import logging
from dataclasses import dataclass
from app.models.enums import Platform, TriggerType

logger = logging.getLogger(__name__)


@dataclass
class ParsedMessage:
    """Normalized incoming message extracted from a webhook payload."""
    platform: Platform
    trigger_type: TriggerType
    platform_user_id: str
    username: str | None
    message_text: str
    platform_message_id: str | None = None
    profile_url: str | None = None
    trigger_post_id: str | None = None
    trigger_post_url: str | None = None
    trigger_comment_text: str | None = None


def parse_meta_webhook(body: dict) -> list[ParsedMessage]:
    """
    Parse a Meta webhook payload and return a list of normalized messages.
    Meta batches events — one payload can contain multiple messaging entries.
    """
    events: list[ParsedMessage] = []
    obj = body.get("object", "")

    if obj == "instagram":
        events.extend(_parse_instagram_payload(body))
    elif obj == "page":
        events.extend(_parse_facebook_payload(body))
    else:
        logger.warning(f"Unknown webhook object type: {obj}")

    return events


def _parse_instagram_payload(body: dict) -> list[ParsedMessage]:
    """
    Parse Instagram webhook payload.

    Instagram messaging webhook format:
    {
      "object": "instagram",
      "entry": [{
        "id": "<ig_account_id>",
        "time": 1234567890,
        "messaging": [{
          "sender": {"id": "<ig_scoped_user_id>"},
          "recipient": {"id": "<ig_account_id>"},
          "timestamp": 1234567890,
          "message": {
            "mid": "<message_id>",
            "text": "Hello!"
          }
        }],
        "changes": [{
          "field": "comments",
          "value": {
            "from": {"id": "...", "username": "..."},
            "media": {"id": "...", "media_product_type": "..."},
            "id": "<comment_id>",
            "text": "Comment text"
          }
        }]
      }]
    }
    """
    events = []

    for entry in body.get("entry", []):
        # ── Instagram DMs ────────────────────────────────────────────
        for msg_event in entry.get("messaging", []):
            sender = msg_event.get("sender", {})
            message = msg_event.get("message", {})

            # Skip echo messages (messages we sent)
            if message.get("is_echo"):
                continue

            text = message.get("text", "")
            if not text:
                # Could be an attachment-only message; skip for now
                logger.info(f"IG DM with no text from {sender.get('id')} — skipping")
                continue

            events.append(ParsedMessage(
                platform=Platform.INSTAGRAM,
                trigger_type=TriggerType.DIRECT_DM,
                platform_user_id=sender.get("id", ""),
                username=None,  # Will be fetched via profile API
                message_text=text,
                platform_message_id=message.get("mid"),
            ))

        # ── Instagram Comment Triggers ───────────────────────────────
        for change in entry.get("changes", []):
            if change.get("field") != "comments":
                continue

            value = change.get("value", {})
            commenter = value.get("from", {})
            media = value.get("media", {})
            comment_text = value.get("text", "")

            if not commenter.get("id") or not comment_text:
                continue

            media_id = media.get("id", "")
            events.append(ParsedMessage(
                platform=Platform.INSTAGRAM,
                trigger_type=TriggerType.COMMENT,
                platform_user_id=commenter.get("id", ""),
                username=commenter.get("username"),
                message_text=comment_text,
                trigger_post_id=media_id,
                trigger_post_url=f"https://www.instagram.com/p/{media_id}/" if media_id else None,
                trigger_comment_text=comment_text,
            ))

    return events


def _parse_facebook_payload(body: dict) -> list[ParsedMessage]:
    """
    Parse Facebook Page webhook payload.

    Facebook Messenger webhook format:
    {
      "object": "page",
      "entry": [{
        "id": "<page_id>",
        "time": 1234567890,
        "messaging": [{
          "sender": {"id": "<psid>"},
          "recipient": {"id": "<page_id>"},
          "timestamp": 1234567890,
          "message": {
            "mid": "<message_id>",
            "text": "Hello!"
          }
        }],
        "changes": [{
          "field": "feed",
          "value": {
            "from": {"id": "...", "name": "..."},
            "post_id": "...",
            "item": "comment",
            "comment_id": "...",
            "message": "Comment text",
            "verb": "add"
          }
        }]
      }]
    }
    """
    events = []

    for entry in body.get("entry", []):
        # ── Facebook Messenger DMs ───────────────────────────────────
        for msg_event in entry.get("messaging", []):
            sender = msg_event.get("sender", {})
            message = msg_event.get("message", {})

            if message.get("is_echo"):
                continue

            text = message.get("text", "")
            if not text:
                logger.info(f"FB message with no text from {sender.get('id')} — skipping")
                continue

            events.append(ParsedMessage(
                platform=Platform.FACEBOOK,
                trigger_type=TriggerType.DIRECT_DM,
                platform_user_id=sender.get("id", ""),
                username=None,  # Will be fetched via profile API
                message_text=text,
                platform_message_id=message.get("mid"),
            ))

        # ── Facebook Comment Triggers ────────────────────────────────
        for change in entry.get("changes", []):
            if change.get("field") != "feed":
                continue

            value = change.get("value", {})
            if value.get("item") != "comment" or value.get("verb") != "add":
                continue

            commenter = value.get("from", {})
            comment_text = value.get("message", "")
            post_id = value.get("post_id", "")

            if not commenter.get("id") or not comment_text:
                continue

            events.append(ParsedMessage(
                platform=Platform.FACEBOOK,
                trigger_type=TriggerType.COMMENT,
                platform_user_id=commenter.get("id", ""),
                username=commenter.get("name"),
                message_text=comment_text,
                trigger_post_id=post_id,
                trigger_post_url=f"https://www.facebook.com/{post_id}" if post_id else None,
                trigger_comment_text=comment_text,
            ))

    return events
