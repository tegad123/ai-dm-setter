"""
Conversation Orchestrator — ties together AI engine, state machine, delay queue,
voice note logic, and database operations for end-to-end message handling.
"""
import uuid
from datetime import datetime, timezone
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Lead, Conversation, Message
from app.models.enums import (
    LeadStatus, Platform, TriggerType, MessageSender, MessageType,
    ConversationState,
)
from app.services.ai_engine import generate_ai_response, build_conversation_history
from app.services.state_machine import get_next_state, get_status_for_state, should_mark_hot_lead
from app.services.voice_note_logic import VoiceNoteDecision
from app.services.elevenlabs_service import generate_voice_note
from app.services.delay_queue import delay_queue
from app.services.message_sender import send_delayed_messages
from app.services.booking_flow import booking_flow


async def handle_incoming_message(
    db: AsyncSession,
    platform: Platform,
    platform_user_id: str,
    username: str,
    message_text: str,
    trigger_type: TriggerType = TriggerType.DIRECT_DM,
    trigger_post_id: str | None = None,
    trigger_post_url: str | None = None,
    trigger_comment_text: str | None = None,
    profile_url: str | None = None,
    platform_message_id: str | None = None,
) -> dict:
    """
    Main entry point for processing an incoming message from a lead.
    Creates/retrieves lead + conversation, generates AI response, schedules delayed send.
    """
    # 1. Get or create lead
    lead = await _get_or_create_lead(
        db, platform, platform_user_id, username, trigger_type,
        trigger_post_id, trigger_post_url, trigger_comment_text, profile_url,
    )

    # 2. Get or create conversation
    conversation = await _get_or_create_conversation(db, lead)

    # 3. Store the incoming message
    incoming_msg = Message(
        conversation_id=conversation.id,
        sender=MessageSender.LEAD,
        content=message_text,
        platform_message_id=platform_message_id,
        is_sent=True,
        sent_at=datetime.now(timezone.utc),
    )
    db.add(incoming_msg)
    conversation.message_count += 1
    lead.last_message_at = datetime.now(timezone.utc)

    # 4. Check if AI is active for this conversation
    if not conversation.ai_active:
        await db.flush()
        return {
            "status": "human_override",
            "lead_id": str(lead.id),
            "conversation_id": str(conversation.id),
            "message": "AI paused — human has taken over this conversation",
        }

    # 5. Cancel any pending delayed responses (lead sent another message)
    delay_queue.cancel_for_conversation(str(conversation.id))

    # 6. Load conversation history
    result = await db.execute(
        select(Message)
        .where(Message.conversation_id == conversation.id)
        .order_by(Message.created_at)
    )
    history = result.scalars().all()
    conversation_history = build_conversation_history(history)

    # 7. If state is ready for booking, inject available slots into context
    booking_context = {}
    if conversation.state in (ConversationState.QUALIFIED, ConversationState.BOOKING):
        booking_context = await booking_flow.get_slots_for_conversation()

    # 8. Generate AI response
    trigger_detail = trigger_post_url or trigger_comment_text or ""
    ai_response = await generate_ai_response(
        username=username,
        platform=platform.value,
        trigger_type=trigger_type.value,
        trigger_detail=trigger_detail,
        conversation_state=conversation.state.value,
        qualification_data=conversation.qualification_data or {},
        objections=conversation.objections_raised or [],
        message_count=conversation.message_count,
        conversation_history=conversation_history,
        booking_slots=booking_context.get("formatted") if booking_context.get("available") else None,
    )

    # 8. Process state transition
    new_state = get_next_state(conversation.state, ai_response.get("new_state", ""))
    conversation.state = new_state

    # 9. Update lead status
    objection_detected = ai_response.get("objection_detected")
    if objection_detected and objection_detected not in (conversation.objections_raised or []):
        if conversation.objections_raised is None:
            conversation.objections_raised = []
        conversation.objections_raised = [*conversation.objections_raised, objection_detected]

    new_status = get_status_for_state(new_state, ai_response.get("new_status"), objection_detected)

    # Check for hot lead
    qual_update = ai_response.get("qualification_update", {})
    if qual_update:
        conversation.qualification_data = {**(conversation.qualification_data or {}), **qual_update}
    if should_mark_hot_lead(conversation.qualification_data or {}, conversation.message_count):
        new_status = LeadStatus.HOT_LEAD

    lead.status = new_status

    # 10. Determine voice note vs text
    messages = ai_response.get("messages", [])
    ai_wants_voice = ai_response.get("should_send_voice_note", False)

    # Find how many messages ago the last voice note was sent
    last_vn_count = 0
    for i, msg in enumerate(reversed(history)):
        if msg.message_type == MessageType.VOICE_NOTE and msg.sender == MessageSender.AI:
            last_vn_count = conversation.message_count - i
            break

    should_voice, voice_reason = VoiceNoteDecision.should_send_voice_note(
        conversation_state=new_state,
        objection_type=objection_detected,
        ai_recommended=ai_wants_voice,
        message_count=conversation.message_count,
        last_voice_note_count=last_vn_count,
    )

    voice_note_text = None
    if should_voice:
        voice_note_text = VoiceNoteDecision.get_voice_note_text(messages, voice_reason)

    await db.flush()

    # 11. Schedule delayed response
    pending = await delay_queue.schedule_response(
        conversation_id=str(conversation.id),
        messages=messages,
        voice_note_text=voice_note_text,
        callback=lambda p: send_delayed_messages(p, str(lead.id)),
        metadata={
            "lead_id": str(lead.id),
            "voice_reason": voice_reason,
            "new_state": new_state.value,
        },
    )

    return {
        "status": "scheduled",
        "lead_id": str(lead.id),
        "conversation_id": str(conversation.id),
        "scheduled_for": pending.scheduled_for.isoformat(),
        "delay_seconds": (pending.scheduled_for - datetime.now(timezone.utc)).seconds,
        "messages_count": len(messages),
        "will_send_voice_note": should_voice,
        "new_state": new_state.value,
        "new_status": new_status.value,
    }


async def _get_or_create_lead(
    db: AsyncSession,
    platform: Platform,
    platform_user_id: str,
    username: str,
    trigger_type: TriggerType,
    trigger_post_id: str | None,
    trigger_post_url: str | None,
    trigger_comment_text: str | None,
    profile_url: str | None,
) -> Lead:
    """Find existing lead or create new one."""
    result = await db.execute(
        select(Lead).where(
            Lead.platform == platform,
            Lead.platform_user_id == platform_user_id,
        )
    )
    lead = result.scalar_one_or_none()

    if not lead:
        lead = Lead(
            platform=platform,
            platform_user_id=platform_user_id,
            username=username,
            trigger_type=trigger_type,
            trigger_post_id=trigger_post_id,
            trigger_post_url=trigger_post_url,
            trigger_comment_text=trigger_comment_text,
            profile_url=profile_url,
            status=LeadStatus.NEW_LEAD,
        )
        db.add(lead)
        await db.flush()

    return lead


async def _get_or_create_conversation(db: AsyncSession, lead: Lead) -> Conversation:
    """Find existing conversation or create new one for lead."""
    result = await db.execute(
        select(Conversation).where(Conversation.lead_id == lead.id)
    )
    conversation = result.scalar_one_or_none()

    if not conversation:
        conversation = Conversation(
            lead_id=lead.id,
            state=ConversationState.GREETING,
            qualification_data={},
            objections_raised=[],
        )
        db.add(conversation)
        await db.flush()

    return conversation


async def handle_booking_selection(
    db: AsyncSession,
    lead: Lead,
    conversation: Conversation,
    message_text: str,
    available_slots: list[dict],
) -> dict | None:
    """
    Check if a lead's message is a slot selection and process the booking.
    Returns booking result if a slot was selected, None otherwise.
    """
    slot_index = booking_flow.parse_slot_selection(message_text, available_slots)
    if slot_index is None:
        return None

    return await booking_flow.book_slot(
        db=db,
        lead=lead,
        conversation=conversation,
        slot_index=slot_index,
        available_slots=available_slots,
    )
