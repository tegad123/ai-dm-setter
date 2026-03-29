from uuid import UUID
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.models.models import Lead, Conversation, Message
from app.models.enums import MessageSender, MessageType, ConversationState, UserRole
from app.schemas.schemas import ConversationOut, MessageOut, MessageCreate
from app.api.deps import get_current_user, require_role
from app.services.delay_queue import delay_queue

router = APIRouter(prefix="/conversations", tags=["conversations"])


@router.get("/{lead_id}", response_model=ConversationOut)
async def get_conversation(
    lead_id: UUID,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    result = await db.execute(
        select(Conversation).where(Conversation.lead_id == lead_id)
    )
    convo = result.scalar_one_or_none()
    if not convo:
        raise HTTPException(status_code=404, detail="Conversation not found")
    return convo


@router.get("/{lead_id}/messages", response_model=list[MessageOut])
async def get_messages(
    lead_id: UUID,
    db: AsyncSession = Depends(get_db),
    user=Depends(get_current_user),
):
    result = await db.execute(
        select(Conversation).where(Conversation.lead_id == lead_id)
    )
    convo = result.scalar_one_or_none()
    if not convo:
        raise HTTPException(status_code=404, detail="Conversation not found")

    msgs = await db.execute(
        select(Message)
        .where(Message.conversation_id == convo.id)
        .order_by(Message.created_at)
    )
    return msgs.scalars().all()


@router.post("/{lead_id}/messages", response_model=MessageOut)
async def send_manual_message(
    lead_id: UUID,
    data: MessageCreate,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_role(UserRole.ADMIN, UserRole.SETTER)),
):
    """Send a manual message as a team member — pauses AI for this conversation."""
    result = await db.execute(
        select(Conversation).where(Conversation.lead_id == lead_id)
    )
    convo = result.scalar_one_or_none()
    if not convo:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # Pause AI and cancel pending messages
    convo.ai_active = False
    convo.human_override_by = user.id
    convo.human_override_at = datetime.now(timezone.utc)
    delay_queue.cancel_for_conversation(str(convo.id))

    msg = Message(
        conversation_id=convo.id,
        sender=MessageSender.HUMAN,
        message_type=data.message_type,
        content=data.content,
        sent_by_user_id=user.id,
        is_sent=True,
        sent_at=datetime.now(timezone.utc),
    )
    db.add(msg)
    convo.message_count += 1
    await db.flush()
    return msg


@router.post("/{lead_id}/override")
async def toggle_ai(
    lead_id: UUID,
    enable_ai: bool,
    db: AsyncSession = Depends(get_db),
    user=Depends(require_role(UserRole.ADMIN, UserRole.SETTER)),
):
    """Toggle AI on/off for a conversation. Human override control."""
    result = await db.execute(
        select(Conversation).where(Conversation.lead_id == lead_id)
    )
    convo = result.scalar_one_or_none()
    if not convo:
        raise HTTPException(status_code=404, detail="Conversation not found")

    convo.ai_active = enable_ai
    if not enable_ai:
        convo.human_override_by = user.id
        convo.human_override_at = datetime.now(timezone.utc)
        delay_queue.cancel_for_conversation(str(convo.id))
    else:
        convo.human_override_by = None
        convo.human_override_at = None

    await db.flush()
    return {"ai_active": convo.ai_active, "conversation_id": str(convo.id)}
