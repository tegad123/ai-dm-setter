import enum


class LeadStatus(str, enum.Enum):
    NEW_LEAD = "new_lead"
    IN_QUALIFICATION = "in_qualification"
    HOT_LEAD = "hot_lead"
    QUALIFIED = "qualified"
    BOOKED = "booked"
    SHOWED_UP = "showed_up"
    NO_SHOW = "no_show"
    CLOSED = "closed"
    SERIOUS_NOT_READY = "serious_not_ready"
    MONEY_OBJECTION = "money_objection"
    TRUST_OBJECTION = "trust_objection"
    GHOSTED = "ghosted"
    UNQUALIFIED = "unqualified"


class Platform(str, enum.Enum):
    INSTAGRAM = "instagram"
    FACEBOOK = "facebook"


class TriggerType(str, enum.Enum):
    COMMENT = "comment"
    DIRECT_DM = "direct_dm"


class MessageSender(str, enum.Enum):
    AI = "ai"
    HUMAN = "human"
    LEAD = "lead"


class MessageType(str, enum.Enum):
    TEXT = "text"
    VOICE_NOTE = "voice_note"


class ConversationState(str, enum.Enum):
    """Tracks where a lead is in the qualification flow."""
    GREETING = "greeting"
    INTRO = "intro"
    QUESTION_1 = "question_1"  # Trading experience
    QUESTION_2 = "question_2"  # Current situation / goals
    QUESTION_3 = "question_3"  # What they've tried
    QUESTION_4 = "question_4"  # Investment readiness
    QUESTION_5 = "question_5"  # Timeline / urgency
    OBJECTION_HANDLING = "objection_handling"
    VALUE_DELIVERY = "value_delivery"
    PITCH = "pitch"
    BOOKING = "booking"
    BOOKED = "booked"
    NURTURING = "nurturing"
    DISQUALIFIED = "disqualified"
    HUMAN_OVERRIDE = "human_override"


class UserRole(str, enum.Enum):
    ADMIN = "admin"
    CLOSER = "closer"
    SETTER = "setter"
    READ_ONLY = "read_only"
