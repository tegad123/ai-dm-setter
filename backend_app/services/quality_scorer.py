"""
Lead Quality Scoring Algorithm — Computes a 0-100 score for each lead.

Factors:
  - Engagement (response speed, message count, message length) — 30 pts max
  - Qualification progress (questions answered) — 25 pts max
  - Intent signals (positive language, urgency) — 20 pts max
  - Objection resolution (objections raised + handled) — 15 pts max
  - Profile completeness (name, platform) — 10 pts max
"""
import logging
from datetime import datetime, timezone

logger = logging.getLogger(__name__)


def compute_quality_score(
    message_count: int,
    qualification_data: dict | None,
    objections_raised: list | None,
    lead_messages: list[dict],
    conversation_state: str,
    has_full_name: bool,
    trigger_type: str,
    created_at: datetime,
    last_message_at: datetime | None,
) -> int:
    """
    Compute lead quality score (0-100) based on engagement, qualification
    progress, intent signals, objection handling, and profile data.

    Returns integer score clamped to [0, 100].
    """
    score = 0.0

    # ── 1. Engagement Score (max 30) ──
    score += _engagement_score(
        message_count, lead_messages, created_at, last_message_at
    )

    # ── 2. Qualification Progress (max 25) ──
    score += _qualification_score(qualification_data, conversation_state)

    # ── 3. Intent Signals (max 20) ──
    score += _intent_score(lead_messages, conversation_state)

    # ── 4. Objection Resolution (max 15) ──
    score += _objection_score(objections_raised, conversation_state)

    # ── 5. Profile Completeness (max 10) ──
    score += _profile_score(has_full_name, trigger_type)

    return max(0, min(100, round(score)))


def _engagement_score(
    message_count: int,
    lead_messages: list[dict],
    created_at: datetime,
    last_message_at: datetime | None,
) -> float:
    """Score based on response frequency, message length, and recency. Max 30."""
    pts = 0.0

    # Message count — more messages = more engaged (up to 12)
    if message_count >= 20:
        pts += 12
    elif message_count >= 10:
        pts += 9
    elif message_count >= 5:
        pts += 6
    elif message_count >= 2:
        pts += 3

    # Average message length from lead — longer = more engaged (up to 10)
    if lead_messages:
        avg_len = sum(len(m.get("content", "")) for m in lead_messages) / len(lead_messages)
        if avg_len >= 100:
            pts += 10
        elif avg_len >= 50:
            pts += 7
        elif avg_len >= 20:
            pts += 4
        else:
            pts += 2

    # Recency — recent activity scores higher (up to 8)
    if last_message_at:
        now = datetime.now(timezone.utc)
        hours_since = (now - last_message_at).total_seconds() / 3600
        if hours_since < 1:
            pts += 8
        elif hours_since < 6:
            pts += 6
        elif hours_since < 24:
            pts += 4
        elif hours_since < 72:
            pts += 2

    return min(30, pts)


def _qualification_score(qualification_data: dict | None, state: str) -> float:
    """Score based on how far through qualification. Max 25."""
    pts = 0.0

    # Questions answered
    if qualification_data:
        answers = sum(1 for v in qualification_data.values() if v)
        pts += min(15, answers * 3)  # 3 pts per answer, max 15

    # Conversation state progression
    state_weights = {
        "greeting": 0,
        "intro": 2,
        "question_1": 3,
        "question_2": 5,
        "question_3": 6,
        "question_4": 7,
        "question_5": 8,
        "pitch": 9,
        "booking": 10,
        "booked": 10,
    }
    pts += state_weights.get(state, 3)

    return min(25, pts)


def _intent_score(lead_messages: list[dict], state: str) -> float:
    """Score based on positive language and buying signals. Max 20."""
    pts = 0.0

    # Positive intent keywords in lead messages
    high_intent = [
        "interested", "sign up", "ready", "let's do it", "book",
        "when can", "how much", "tell me more", "sounds good",
        "i'm in", "let's go", "absolutely", "yes", "for sure",
        "how do i start", "what's next", "definitely",
    ]
    medium_intent = [
        "curious", "maybe", "thinking about", "considering",
        "what is", "how does", "can you explain",
    ]

    all_text = " ".join(
        m.get("content", "").lower() for m in lead_messages
    )

    high_matches = sum(1 for kw in high_intent if kw in all_text)
    medium_matches = sum(1 for kw in medium_intent if kw in all_text)

    pts += min(12, high_matches * 3)
    pts += min(5, medium_matches * 1.5)

    # Booking-adjacent states show intent
    if state in ("booking", "booked", "pitch"):
        pts += 3

    return min(20, pts)


def _objection_score(objections_raised: list | None, state: str) -> float:
    """
    Score based on objection handling. Raising objections isn't negative —
    it shows engagement. Resolving them (continuing past objection) is positive.
    Max 15.
    """
    pts = 5  # Base: no objections = neutral-positive

    if objections_raised:
        num_objections = len(objections_raised)
        # Having objections shows engagement
        pts += min(5, num_objections * 2)

        # If state is past objection handling, they were resolved
        resolved_states = {
            "question_3", "question_4", "question_5",
            "pitch", "booking", "booked",
            "value_delivery",
        }
        if state in resolved_states:
            pts += 5  # Resolved = very positive

    return min(15, pts)


def _profile_score(has_full_name: bool, trigger_type: str) -> float:
    """Score based on profile data and trigger source. Max 10."""
    pts = 0.0

    if has_full_name:
        pts += 5

    # Comment triggers show higher intent than cold DMs
    if trigger_type == "comment":
        pts += 5
    else:
        pts += 3  # Direct DM still shows some intent

    return min(10, pts)


async def update_lead_quality_score(db, lead_id, lead, conversation, messages) -> int:
    """
    Convenience function: compute and persist quality score for a lead.
    Returns the new score.
    """
    # Extract lead messages only
    lead_messages = [
        {"content": m.content}
        for m in messages
        if m.sender.value == "lead"
    ]

    score = compute_quality_score(
        message_count=conversation.message_count,
        qualification_data=conversation.qualification_data or {},
        objections_raised=conversation.objections_raised or [],
        lead_messages=lead_messages,
        conversation_state=conversation.state.value,
        has_full_name=bool(lead.full_name),
        trigger_type=lead.trigger_type.value,
        created_at=lead.created_at,
        last_message_at=lead.last_message_at,
    )

    lead.quality_score = float(score)
    logger.info(f"Lead {lead.username} quality score updated: {score}")
    return score
