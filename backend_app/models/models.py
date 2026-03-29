import uuid
from datetime import datetime, timezone
from sqlalchemy import (
    String, Text, Float, Integer, Boolean, DateTime, ForeignKey, Enum, Index
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.core.database import Base
from app.models.enums import (
    LeadStatus, Platform, TriggerType, MessageSender, MessageType,
    ConversationState, UserRole,
)


def utcnow():
    return datetime.now(timezone.utc)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255))
    full_name: Mapped[str] = mapped_column(String(255))
    role: Mapped[UserRole] = mapped_column(Enum(UserRole), default=UserRole.READ_ONLY)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    # Relationships
    manual_messages: Mapped[list["Message"]] = relationship(back_populates="sent_by_user")


class Lead(Base):
    __tablename__ = "leads"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    platform: Mapped[Platform] = mapped_column(Enum(Platform))
    platform_user_id: Mapped[str] = mapped_column(String(255), index=True)
    username: Mapped[str] = mapped_column(String(255))
    full_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    profile_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    profile_pic_url: Mapped[str | None] = mapped_column(String(512), nullable=True)

    # Pipeline
    status: Mapped[LeadStatus] = mapped_column(Enum(LeadStatus), default=LeadStatus.NEW_LEAD, index=True)
    quality_score: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Trigger info
    trigger_type: Mapped[TriggerType] = mapped_column(Enum(TriggerType))
    trigger_post_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    trigger_post_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    trigger_comment_text: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Booking
    booked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    booking_slot: Mapped[str | None] = mapped_column(String(255), nullable=True)
    showed_up: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    closed: Mapped[bool | None] = mapped_column(Boolean, nullable=True)
    revenue: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    last_message_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Relationships
    conversation: Mapped["Conversation"] = relationship(back_populates="lead", uselist=False)

    __table_args__ = (
        Index("ix_leads_platform_user", "platform", "platform_user_id", unique=True),
    )


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    lead_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("leads.id"), unique=True)
    platform_thread_id: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # State machine
    state: Mapped[ConversationState] = mapped_column(
        Enum(ConversationState), default=ConversationState.GREETING
    )
    qualification_data: Mapped[dict | None] = mapped_column(JSONB, nullable=True, default=dict)

    # AI control
    ai_active: Mapped[bool] = mapped_column(Boolean, default=True)
    human_override_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    human_override_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Objection tracking
    objections_raised: Mapped[list | None] = mapped_column(JSONB, nullable=True, default=list)

    # Metadata
    message_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    # Relationships
    lead: Mapped["Lead"] = relationship(back_populates="conversation")
    messages: Mapped[list["Message"]] = relationship(back_populates="conversation", order_by="Message.created_at")


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    conversation_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("conversations.id"), index=True)
    sender: Mapped[MessageSender] = mapped_column(Enum(MessageSender))
    message_type: Mapped[MessageType] = mapped_column(Enum(MessageType), default=MessageType.TEXT)
    content: Mapped[str] = mapped_column(Text)

    # Voice note
    voice_note_url: Mapped[str | None] = mapped_column(String(512), nullable=True)
    voice_note_duration: Mapped[float | None] = mapped_column(Float, nullable=True)

    # Platform message ID for tracking
    platform_message_id: Mapped[str | None] = mapped_column(String(255), nullable=True)

    # If sent by human team member
    sent_by_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    sent_by_user: Mapped["User | None"] = relationship(back_populates="manual_messages")

    # Scheduling
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    is_sent: Mapped[bool] = mapped_column(Boolean, default=False)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    # Relationships
    conversation: Mapped["Conversation"] = relationship(back_populates="messages")

    __table_args__ = (
        Index("ix_messages_conversation_created", "conversation_id", "created_at"),
    )


class ScheduledTask(Base):
    """Tracks delayed message sends and other scheduled operations."""
    __tablename__ = "scheduled_tasks"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_type: Mapped[str] = mapped_column(String(50))  # "send_message", "follow_up", "daily_report"
    payload: Mapped[dict] = mapped_column(JSONB)
    scheduled_for: Mapped[datetime] = mapped_column(DateTime(timezone=True), index=True)
    executed: Mapped[bool] = mapped_column(Boolean, default=False)
    executed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
