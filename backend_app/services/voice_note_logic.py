"""
Voice Note Decision Engine — determines when to send a voice note vs text.
Voice notes are used for high-impact moments: trust building, objection handling, key emotional moments.
"""
from app.models.enums import ConversationState


class VoiceNoteDecision:
    """Rules engine for deciding when a voice note is more effective than text."""

    # States where voice notes are highly effective
    HIGH_IMPACT_STATES = {
        ConversationState.OBJECTION_HANDLING,
        ConversationState.VALUE_DELIVERY,
        ConversationState.PITCH,
    }

    # Objection types where voice builds trust faster
    VOICE_OBJECTION_TYPES = {"trust", "prior_failure"}

    # Don't send voice notes in these states (too early or too transactional)
    NEVER_VOICE_STATES = {
        ConversationState.GREETING,
        ConversationState.BOOKING,
        ConversationState.BOOKED,
        ConversationState.DISQUALIFIED,
    }

    @classmethod
    def should_send_voice_note(
        cls,
        conversation_state: ConversationState,
        objection_type: str | None,
        ai_recommended: bool,
        message_count: int,
        last_voice_note_count: int,
    ) -> tuple[bool, str | None]:
        """
        Decide whether to send a voice note.
        Returns (should_send, reason).
        """
        # Never send voice notes in certain states
        if conversation_state in cls.NEVER_VOICE_STATES:
            return False, None

        # Don't send voice notes too frequently (at least 5 messages between voice notes)
        if last_voice_note_count > 0 and message_count - last_voice_note_count < 5:
            return False, None

        # Trust/prior-failure objections — voice note is powerful here
        if objection_type in cls.VOICE_OBJECTION_TYPES:
            return True, "trust_building"

        # High-impact conversation states
        if conversation_state in cls.HIGH_IMPACT_STATES and ai_recommended:
            return True, "key_emotional_moment"

        # AI specifically recommends it in other contexts
        if ai_recommended and conversation_state not in cls.NEVER_VOICE_STATES:
            # Only if we're deep enough in the conversation
            if message_count >= 6:
                return True, "ai_recommended"

        return False, None

    @classmethod
    def get_voice_note_text(cls, messages: list[str], reason: str) -> str:
        """
        Prepare text for voice note conversion.
        Combines multiple short messages into natural spoken text.
        """
        combined = " ".join(messages)

        # Add natural speech markers for more realistic voice output
        # ElevenLabs handles these well
        if reason == "trust_building":
            # Slightly slower, more sincere delivery
            return combined
        elif reason == "objection_handling":
            # Confident but empathetic
            return combined
        else:
            return combined
