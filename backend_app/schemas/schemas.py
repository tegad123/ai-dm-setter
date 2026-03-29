from datetime import datetime
from uuid import UUID
from pydantic import BaseModel, EmailStr
from app.models.enums import (
    LeadStatus, Platform, TriggerType, MessageSender, MessageType,
    ConversationState, UserRole,
)


# ── Auth ──
class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class TokenPayload(BaseModel):
    sub: str
    role: str


class UserCreate(BaseModel):
    email: EmailStr
    password: str
    full_name: str
    role: UserRole = UserRole.READ_ONLY


class UserOut(BaseModel):
    id: UUID
    email: str
    full_name: str
    role: UserRole
    is_active: bool
    created_at: datetime
    model_config = {"from_attributes": True}


# ── Leads ──
class LeadOut(BaseModel):
    id: UUID
    platform: Platform
    username: str
    full_name: str | None
    profile_url: str | None
    status: LeadStatus
    quality_score: float | None
    trigger_type: TriggerType
    trigger_post_url: str | None
    booked_at: datetime | None
    booking_slot: str | None
    showed_up: bool | None
    closed: bool | None
    revenue: float | None
    created_at: datetime
    last_message_at: datetime | None
    model_config = {"from_attributes": True}


class LeadUpdate(BaseModel):
    status: LeadStatus | None = None
    showed_up: bool | None = None
    closed: bool | None = None
    revenue: float | None = None


# ── Conversations ──
class ConversationOut(BaseModel):
    id: UUID
    lead_id: UUID
    state: ConversationState
    ai_active: bool
    human_override_by: UUID | None
    message_count: int
    objections_raised: list | None
    qualification_data: dict | None
    created_at: datetime
    model_config = {"from_attributes": True}


# ── Messages ──
class MessageOut(BaseModel):
    id: UUID
    conversation_id: UUID
    sender: MessageSender
    message_type: MessageType
    content: str
    voice_note_url: str | None
    sent_by_user_id: UUID | None
    is_sent: bool
    sent_at: datetime | None
    created_at: datetime
    model_config = {"from_attributes": True}


class MessageCreate(BaseModel):
    content: str
    message_type: MessageType = MessageType.TEXT


# ── Webhooks ──
class IncomingDM(BaseModel):
    platform: Platform
    platform_user_id: str
    username: str
    message_text: str
    platform_message_id: str | None = None
    profile_url: str | None = None


class IncomingComment(BaseModel):
    platform: Platform
    commenter_user_id: str
    commenter_username: str
    comment_text: str
    post_id: str
    post_url: str | None = None
    profile_url: str | None = None


# ── Analytics ──
class DashboardKPIs(BaseModel):
    total_leads: int
    leads_today: int
    calls_booked_today: int
    calls_booked_week: int
    calls_booked_month: int
    show_rate: float
    close_rate: float
    total_revenue: float
