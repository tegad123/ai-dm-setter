"""
Message Sender — Executes the actual sending of messages via platform APIs.
Called by the delay queue callback after the human-feel delay has elapsed.
Handles:
  - Sending text messages via Instagram or Facebook
  - Generating + sending voice notes via ElevenLabs + platform API
  - Storing sent messages in the database
  - Sending notifications on key events (bookings)
"""
import logging
from datetime import datetime, timezone
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import async_session
from app.models.models import Lead, Conversation, Message
from app.models.enums import Platform, MessageSender, MessageType
from app.services.meta_api import meta_client, MetaAPIError
from app.services.elevenlabs_service import generate_voice_note
from app.services.notification_service import notify_team

logger = logging.getLogger(__name__)


async def send_delayed_messages(pending, lead_id: str):
    """
    Callback executed by the delay queue after the response delay.
    Sends all queued messages (text + optional voice note) via the platform API,
    then stores them in the database.
    """
    async with async_session() as db:
        try:
            # Load lead and conversation
            lead = await db.get(Lead, lead_id)
            if not lead:
                logger.error(f"Lead {lead_id} not found for delayed send")
                return

            conversation_result = await db.execute(
                select(Conversation).where(Conversation.lead_id == lead.id)
            )
            conversation = conversation_result.scalar_one_or_none()
            if not conversation:
                logger.error(f"Conversation not found for lead {lead_id}")
                return

            # Check if AI is still active (human might have taken over during delay)
            if not conversation.ai_active:
                logger.info(f"AI paused for lead {lead_id} — skipping delayed send")
                return

            platform = lead.platform
            recipient_id = lead.platform_user_id

            # Send text messages
            for msg_text in pending.messages:
                platform_msg_id = await _send_text(platform, recipient_id, msg_text)
                await _store_message(
                    db, conversation.id, msg_text,
                    MessageType.TEXT, platform_msg_id,
                )

            # Send voice note if queued
            if pending.voice_note_text:
                await _send_voice_note(
                    db, platform, recipient_id,
                    conversation.id, pending.voice_note_text,
                )

            # Update conversation message count
            total_sent = len(pending.messages) + (1 if pending.voice_note_text else 0)
            conversation.message_count += total_sent

            await db.commit()
            logger.info(
                f"Sent {total_sent} message(s) to lead {lead_id} on {platform.value}"
            )

            # Send booking notification if this was a booking confirmation
            metadata = pending.metadata or {}
            if metadata.get("new_state") == "booked":
                await notify_team(
                    event="call_booked",
                    lead_name=lead.full_name or lead.username,
                    lead_id=str(lead.id),
                    details=f"Booking: {lead.booking_slot}",
                )

        except Exception as e:
            logger.error(f"Failed to send delayed messages for lead {lead_id}: {e}", exc_info=True)
            await db.rollback()


async def _send_text(platform: Platform, recipient_id: str, text: str) -> str | None:
    """Send a text message via the appropriate platform API."""
    try:
        if platform == Platform.INSTAGRAM:
            result = await meta_client.send_ig_text_message(recipient_id, text)
        elif platform == Platform.FACEBOOK:
            result = await meta_client.send_fb_text_message(recipient_id, text)
        else:
            logger.warning(f"Unsupported platform for sending: {platform}")
            return None
        return result.get("message_id")
    except MetaAPIError as e:
        logger.error(f"Failed to send text on {platform.value}: {e}")
        return None


async def _send_voice_note(
    db: AsyncSession,
    platform: Platform,
    recipient_id: str,
    conversation_id,
    voice_text: str,
) -> str | None:
    """Generate a voice note via ElevenLabs and send it as an audio attachment."""
    try:
        # Generate audio
        voice_result = await generate_voice_note(voice_text)
        audio_url = voice_result["url"]

        # Send via platform
        if platform == Platform.INSTAGRAM:
            result = await meta_client.send_ig_voice_note(recipient_id, audio_url)
        elif platform == Platform.FACEBOOK:
            result = await meta_client.send_fb_voice_note(recipient_id, audio_url)
        else:
            return None

        platform_msg_id = result.get("message_id")

        # Store voice note message
        msg = Message(
            conversation_id=conversation_id,
            sender=MessageSender.AI,
            message_type=MessageType.VOICE_NOTE,
            content=voice_text,
            voice_note_url=audio_url,
            voice_note_duration=voice_result.get("duration_estimate"),
            platform_message_id=platform_msg_id,
            is_sent=True,
            sent_at=datetime.now(timezone.utc),
        )
        db.add(msg)

        return platform_msg_id

    except Exception as e:
        logger.error(f"Failed to send voice note: {e}", exc_info=True)
        return None


async def _store_message(
    db: AsyncSession,
    conversation_id,
    content: str,
    message_type: MessageType,
    platform_message_id: str | None,
):
    """Store a sent message in the database."""
    msg = Message(
        conversation_id=conversation_id,
        sender=MessageSender.AI,
        message_type=message_type,
        content=content,
        platform_message_id=platform_message_id,
        is_sent=True,
        sent_at=datetime.now(timezone.utc),
    )
    db.add(msg)
