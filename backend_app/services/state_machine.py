"""
Conversation State Machine — tracks where each lead is in the qualification flow.
Manages transitions between states and ensures sequential but natural progression.
"""
from app.models.enums import ConversationState, LeadStatus

# Valid state transitions — defines what states can follow each state
STATE_TRANSITIONS: dict[ConversationState, list[ConversationState]] = {
    ConversationState.GREETING: [
        ConversationState.INTRO,
        ConversationState.QUESTION_1,
        ConversationState.HUMAN_OVERRIDE,
    ],
    ConversationState.INTRO: [
        ConversationState.QUESTION_1,
        ConversationState.OBJECTION_HANDLING,
        ConversationState.HUMAN_OVERRIDE,
    ],
    ConversationState.QUESTION_1: [
        ConversationState.QUESTION_2,
        ConversationState.OBJECTION_HANDLING,
        ConversationState.HUMAN_OVERRIDE,
    ],
    ConversationState.QUESTION_2: [
        ConversationState.QUESTION_3,
        ConversationState.OBJECTION_HANDLING,
        ConversationState.HUMAN_OVERRIDE,
    ],
    ConversationState.QUESTION_3: [
        ConversationState.QUESTION_4,
        ConversationState.OBJECTION_HANDLING,
        ConversationState.VALUE_DELIVERY,
        ConversationState.HUMAN_OVERRIDE,
    ],
    ConversationState.QUESTION_4: [
        ConversationState.QUESTION_5,
        ConversationState.OBJECTION_HANDLING,
        ConversationState.VALUE_DELIVERY,
        ConversationState.HUMAN_OVERRIDE,
    ],
    ConversationState.QUESTION_5: [
        ConversationState.PITCH,
        ConversationState.OBJECTION_HANDLING,
        ConversationState.VALUE_DELIVERY,
        ConversationState.DISQUALIFIED,
        ConversationState.HUMAN_OVERRIDE,
    ],
    ConversationState.OBJECTION_HANDLING: [
        # Can return to any qualification question or move forward
        ConversationState.QUESTION_1,
        ConversationState.QUESTION_2,
        ConversationState.QUESTION_3,
        ConversationState.QUESTION_4,
        ConversationState.QUESTION_5,
        ConversationState.VALUE_DELIVERY,
        ConversationState.PITCH,
        ConversationState.NURTURING,
        ConversationState.DISQUALIFIED,
        ConversationState.HUMAN_OVERRIDE,
    ],
    ConversationState.VALUE_DELIVERY: [
        ConversationState.QUESTION_3,
        ConversationState.QUESTION_4,
        ConversationState.QUESTION_5,
        ConversationState.PITCH,
        ConversationState.OBJECTION_HANDLING,
        ConversationState.HUMAN_OVERRIDE,
    ],
    ConversationState.PITCH: [
        ConversationState.BOOKING,
        ConversationState.OBJECTION_HANDLING,
        ConversationState.NURTURING,
        ConversationState.DISQUALIFIED,
        ConversationState.HUMAN_OVERRIDE,
    ],
    ConversationState.BOOKING: [
        ConversationState.BOOKED,
        ConversationState.OBJECTION_HANDLING,
        ConversationState.NURTURING,
        ConversationState.HUMAN_OVERRIDE,
    ],
    ConversationState.BOOKED: [
        ConversationState.HUMAN_OVERRIDE,
    ],
    ConversationState.NURTURING: [
        ConversationState.QUESTION_1,
        ConversationState.PITCH,
        ConversationState.OBJECTION_HANDLING,
        ConversationState.DISQUALIFIED,
        ConversationState.HUMAN_OVERRIDE,
    ],
    ConversationState.DISQUALIFIED: [
        ConversationState.HUMAN_OVERRIDE,
    ],
    ConversationState.HUMAN_OVERRIDE: [
        # Human can transition to any state when re-enabling AI
        *list(ConversationState),
    ],
}

# Map conversation states to lead status tags
STATE_TO_STATUS: dict[ConversationState, LeadStatus] = {
    ConversationState.GREETING: LeadStatus.NEW_LEAD,
    ConversationState.INTRO: LeadStatus.NEW_LEAD,
    ConversationState.QUESTION_1: LeadStatus.IN_QUALIFICATION,
    ConversationState.QUESTION_2: LeadStatus.IN_QUALIFICATION,
    ConversationState.QUESTION_3: LeadStatus.IN_QUALIFICATION,
    ConversationState.QUESTION_4: LeadStatus.IN_QUALIFICATION,
    ConversationState.QUESTION_5: LeadStatus.IN_QUALIFICATION,
    ConversationState.OBJECTION_HANDLING: LeadStatus.IN_QUALIFICATION,
    ConversationState.VALUE_DELIVERY: LeadStatus.IN_QUALIFICATION,
    ConversationState.PITCH: LeadStatus.QUALIFIED,
    ConversationState.BOOKING: LeadStatus.QUALIFIED,
    ConversationState.BOOKED: LeadStatus.BOOKED,
    ConversationState.NURTURING: LeadStatus.SERIOUS_NOT_READY,
    ConversationState.DISQUALIFIED: LeadStatus.UNQUALIFIED,
}


def validate_transition(current: ConversationState, proposed: ConversationState) -> bool:
    """Check if a state transition is valid."""
    allowed = STATE_TRANSITIONS.get(current, [])
    return proposed in allowed


def get_next_state(current: ConversationState, ai_proposed: str) -> ConversationState:
    """
    Validate and return the next state based on AI's proposal.
    Falls back to natural progression if AI proposes an invalid transition.
    """
    try:
        proposed = ConversationState(ai_proposed)
    except ValueError:
        return _natural_next(current)

    if validate_transition(current, proposed):
        return proposed

    return _natural_next(current)


def _natural_next(current: ConversationState) -> ConversationState:
    """Get the natural next step in the qualification flow."""
    progression = [
        ConversationState.GREETING,
        ConversationState.INTRO,
        ConversationState.QUESTION_1,
        ConversationState.QUESTION_2,
        ConversationState.QUESTION_3,
        ConversationState.QUESTION_4,
        ConversationState.QUESTION_5,
        ConversationState.PITCH,
        ConversationState.BOOKING,
        ConversationState.BOOKED,
    ]
    try:
        idx = progression.index(current)
        if idx + 1 < len(progression):
            return progression[idx + 1]
    except ValueError:
        pass
    return current


def get_status_for_state(
    state: ConversationState,
    ai_proposed_status: str | None = None,
    objection_type: str | None = None,
) -> LeadStatus:
    """
    Determine the lead status tag based on conversation state and context.
    Objection type can override the default status mapping.
    """
    # Objection-specific statuses take priority
    if objection_type:
        objection_map = {
            "trust": LeadStatus.TRUST_OBJECTION,
            "prior_failure": LeadStatus.TRUST_OBJECTION,
            "money": LeadStatus.MONEY_OBJECTION,
        }
        if objection_type in objection_map:
            return objection_map[objection_type]

    # Try AI's proposed status
    if ai_proposed_status:
        try:
            return LeadStatus(ai_proposed_status)
        except ValueError:
            pass

    return STATE_TO_STATUS.get(state, LeadStatus.IN_QUALIFICATION)


def should_mark_hot_lead(qualification_data: dict, message_count: int) -> bool:
    """Determine if a lead should be tagged as Hot Lead based on engagement signals."""
    # Fast responder with strong engagement
    answers_given = sum(1 for v in qualification_data.values() if v)
    return answers_given >= 3 and message_count <= 15


def should_mark_ghosted(last_message_age_hours: float, conversation_state: ConversationState) -> bool:
    """Determine if a lead should be tagged as Ghosted."""
    # No response for 24+ hours during active qualification
    active_states = {
        ConversationState.QUESTION_1, ConversationState.QUESTION_2,
        ConversationState.QUESTION_3, ConversationState.QUESTION_4,
        ConversationState.QUESTION_5, ConversationState.OBJECTION_HANDLING,
        ConversationState.PITCH, ConversationState.BOOKING,
    }
    return last_message_age_hours >= 24 and conversation_state in active_states
