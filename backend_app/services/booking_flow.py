"""
Booking Flow — Manages the end-to-end booking process within a DM conversation.
Handles:
  - Presenting available slots when a lead is qualified
  - Parsing slot selection from lead's reply
  - Confirming the booking on LeadConnector
  - Updating lead status to BOOKED
  - Sending confirmation message + pre-call instructions
"""
import logging
from datetime import datetime, timezone
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.models import Lead, Conversation
from app.models.enums import LeadStatus, ConversationState
from app.services.leadconnector_service import lc_client, TimeSlot, LeadConnectorError

logger = logging.getLogger(__name__)

# Pre-call instructions Daniel wants sent after booking
PRE_CALL_INSTRUCTIONS = (
    "Before the call, make sure you've got a quiet spot with good reception. "
    "Come ready to talk about where you're at with trading and where you want to be. "
    "This isn't a sales pitch — it's a real conversation about whether we're a good fit. "
    "See you then 💪"
)


class BookingFlow:
    """Orchestrates the booking process within DM conversations."""

    async def get_slots_for_conversation(self, max_slots: int = 5) -> dict:
        """
        Pull available slots and format them for the AI to present in a DM.
        Returns a dict with slot data the AI engine can weave into its response.
        """
        try:
            slots = await lc_client.get_available_slots(max_slots=max_slots)
        except LeadConnectorError as e:
            logger.error(f"Failed to get slots: {e}")
            return {
                "available": False,
                "error": str(e),
                "slots": [],
                "formatted": "I'm having trouble pulling up the calendar right now. Let me get back to you on that.",
            }

        if not slots:
            return {
                "available": False,
                "slots": [],
                "formatted": "No available slots in the next 7 days. Let me check with Daniel and get back to you.",
            }

        slot_list = [slot.to_dict() for slot in slots]
        formatted = "\n".join(f"{i+1}. {s.display}" for i, s in enumerate(slots))

        return {
            "available": True,
            "slots": slot_list,
            "formatted": formatted,
            "count": len(slots),
        }

    def parse_slot_selection(self, message_text: str, available_slots: list[dict]) -> int | None:
        """
        Parse a lead's reply to determine which slot they selected.
        Returns the 0-based index of the selected slot, or None if unclear.

        Handles:
          - "1", "2", "3" (number selection)
          - "the first one", "second", "third"
          - "Tuesday" (day matching)
          - "2pm", "2:00" (time matching)
        """
        text = message_text.strip().lower()

        # Direct number: "1", "2", "3"
        if text.isdigit():
            num = int(text)
            if 1 <= num <= len(available_slots):
                return num - 1

        # Ordinal words
        ordinals = {"first": 0, "second": 1, "third": 2, "fourth": 3, "fifth": 4}
        for word, idx in ordinals.items():
            if word in text and idx < len(available_slots):
                return idx

        # Day name matching
        days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        for day in days:
            if day in text:
                for idx, slot in enumerate(available_slots):
                    if day in slot.get("display", "").lower():
                        return idx

        # Time matching (e.g., "2pm", "2:00", "10am")
        import re
        # Require either am/pm suffix OR colon format to count as a time reference
        time_match = re.search(r'(\d{1,2}):(\d{2})\s*(am|pm)?|(\d{1,2})\s*(am|pm)', text)
        if time_match:
            if time_match.group(4):
                # Format: "2pm", "10am"
                hour = time_match.group(4)
                ampm = time_match.group(5)
            else:
                # Format: "2:00", "4:30 pm"
                hour = time_match.group(1)
                ampm = time_match.group(3) or ""
            for idx, slot in enumerate(available_slots):
                display = slot.get("display", "").lower()
                if f"{hour}:{time_match.group(2) or '00'}" in display or (ampm and f"{hour} {ampm}" in display) or f"{hour}:" in display:
                    return idx

        return None

    async def book_slot(
        self,
        db: AsyncSession,
        lead: Lead,
        conversation: Conversation,
        slot_index: int,
        available_slots: list[dict],
    ) -> dict:
        """
        Execute the booking: create contact, book on calendar, update lead status.
        Returns a result dict with confirmation details or error.
        """
        if slot_index < 0 or slot_index >= len(available_slots):
            return {"success": False, "error": "Invalid slot selection"}

        slot_data = available_slots[slot_index]
        slot = TimeSlot(
            start=datetime.fromisoformat(slot_data["start"]),
            end=datetime.fromisoformat(slot_data["end"]),
            display=slot_data["display"],
        )

        try:
            # Create or find contact in LeadConnector
            contact_id = await lc_client.create_or_get_contact(
                name=lead.full_name or lead.username,
                ig_username=lead.username,
            )

            # Book the appointment
            qualification_notes = _build_qualification_notes(conversation)
            confirmation = await lc_client.book_appointment(
                contact_id=contact_id,
                slot=slot,
                lead_name=lead.full_name or lead.username,
                notes=qualification_notes,
            )

            # Update lead and conversation status
            lead.status = LeadStatus.BOOKED
            lead.booked_at = datetime.now(timezone.utc)
            lead.booking_slot = slot.display
            conversation.state = ConversationState.BOOKED

            await db.flush()

            return {
                "success": True,
                "appointment_id": confirmation.appointment_id,
                "confirmation_message": confirmation.display,
                "pre_call_instructions": PRE_CALL_INSTRUCTIONS,
                "slot_display": slot.display,
            }

        except LeadConnectorError as e:
            logger.error(f"Booking failed for lead {lead.id}: {e}")
            return {
                "success": False,
                "error": str(e),
                "fallback_message": "Hmm, something went wrong with the booking. Let me sort this out and get back to you real quick.",
            }


def _build_qualification_notes(conversation: Conversation) -> str:
    """Build notes for the appointment from qualification data."""
    notes_parts = ["Lead qualified via AI DM Setter"]

    qual = conversation.qualification_data or {}
    if qual.get("trading_experience"):
        notes_parts.append(f"Trading experience: {qual['trading_experience']}")
    if qual.get("goals"):
        notes_parts.append(f"Goals: {qual['goals']}")
    if qual.get("current_situation"):
        notes_parts.append(f"Current situation: {qual['current_situation']}")
    if qual.get("investment_ready"):
        notes_parts.append(f"Investment ready: {qual['investment_ready']}")

    objections = conversation.objections_raised or []
    if objections:
        notes_parts.append(f"Objections raised: {', '.join(objections)}")

    return "\n".join(notes_parts)


# Module-level singleton
booking_flow = BookingFlow()
