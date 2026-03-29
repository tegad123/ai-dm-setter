"""
Notification model — persists in-app notifications for the team.
Supports read/unread state and type-based filtering.
"""
import uuid
from datetime import datetime, timezone
from sqlalchemy import String, Text, Boolean, DateTime, ForeignKey, Enum, Index
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship
from app.core.database import Base


def utcnow():
    return datetime.now(timezone.utc)


class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # Who this notification is for (null = all team)
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id"), nullable=True, index=True
    )
    # Notification type
    type: Mapped[str] = mapped_column(String(50))  # call_booked, hot_lead, human_override, daily_summary, weekly_report
    title: Mapped[str] = mapped_column(String(255))
    body: Mapped[str] = mapped_column(Text)

    # Related entities
    lead_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("leads.id"), nullable=True
    )

    # Extra data (flexible JSON)
    metadata: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    # Read state
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    __table_args__ = (
        Index("ix_notifications_user_read", "user_id", "is_read"),
        Index("ix_notifications_created", "created_at"),
    )
