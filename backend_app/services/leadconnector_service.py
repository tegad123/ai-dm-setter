"""
LeadConnector (GoHighLevel) Calendar Integration.
Handles:
  - Pulling Daniel's real-time availability
  - Booking appointments for qualified leads
  - Fetching booking confirmations
  - Cancellation / rescheduling

API docs: https://highlevel.stoplight.io/docs/integrations
"""
import logging
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass
import httpx
from app.core.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

LC_API_BASE = "https://services.leadconnectorhq.com"


class LeadConnectorError(Exception):
    def __init__(self, message: str, status_code: int | None = None):
        self.status_code = status_code
        super().__init__(message)


@dataclass
class TimeSlot:
    """A single available booking slot."""
    start: datetime
    end: datetime
    display: str  # Human-readable for DM, e.g. "Tuesday Mar 19 at 2:00 PM"

    def to_dict(self) -> dict:
        return {
            "start": self.start.isoformat(),
            "end": self.end.isoformat(),
            "display": self.display,
        }


@dataclass
class BookingConfirmation:
    """Confirmation details after a booking is made."""
    appointment_id: str
    calendar_id: str
    contact_id: str
    start_time: datetime
    end_time: datetime
    status: str
    display: str  # Human-readable confirmation message


class LeadConnectorClient:
    """Client for LeadConnector / GoHighLevel calendar API."""

    def __init__(self):
        self.api_key = settings.leadconnector_api_key
        self.calendar_id = settings.leadconnector_calendar_id
        self.location_id = settings.leadconnector_location_id
        self._client: httpx.AsyncClient | None = None

    async def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=LC_API_BASE,
                timeout=30.0,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                    "Version": "2021-07-28",
                },
            )
        return self._client

    async def close(self):
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    # ── Availability ─────────────────────────────────────────────────────

    async def get_available_slots(
        self,
        start_date: datetime | None = None,
        end_date: datetime | None = None,
        max_slots: int = 5,
    ) -> list[TimeSlot]:
        """
        Pull available time slots from Daniel's calendar.
        Defaults to looking 7 days ahead from now.
        Returns up to max_slots options to present in the DM.
        """
        now = datetime.now(timezone.utc)
        if start_date is None:
            start_date = now + timedelta(hours=1)  # At least 1 hour from now
        if end_date is None:
            end_date = now + timedelta(days=7)

        client = await self._get_client()
        response = await client.get(
            f"/calendars/{self.calendar_id}/free-slots",
            params={
                "startDate": start_date.strftime("%Y-%m-%d"),
                "endDate": end_date.strftime("%Y-%m-%d"),
                "timezone": "America/New_York",  # Daniel's timezone
            },
        )
        data = self._handle_response(response, "get_available_slots")

        # Parse slots from response
        slots: list[TimeSlot] = []
        for date_key, slot_list in data.get("slots", {}).items():
            for slot_str in slot_list:
                try:
                    slot_start = datetime.fromisoformat(slot_str)
                    slot_end = slot_start + timedelta(minutes=30)  # Default 30-min calls
                    display = slot_start.strftime("%A %b %d at %-I:%M %p")
                    slots.append(TimeSlot(start=slot_start, end=slot_end, display=display))
                except (ValueError, TypeError):
                    continue

        # Return the first max_slots options
        return slots[:max_slots]

    async def get_slots_formatted_for_dm(self, max_slots: int = 5) -> str:
        """
        Get available slots formatted as a numbered list for DM presentation.
        Returns something like:
          "1. Tuesday Mar 19 at 2:00 PM
           2. Wednesday Mar 20 at 10:00 AM
           3. Thursday Mar 21 at 4:30 PM"
        """
        slots = await self.get_available_slots(max_slots=max_slots)
        if not slots:
            return ""

        lines = [f"{i+1}. {slot.display}" for i, slot in enumerate(slots)]
        return "\n".join(lines)

    # ── Booking ──────────────────────────────────────────────────────────

    async def create_or_get_contact(
        self,
        email: str | None = None,
        phone: str | None = None,
        name: str | None = None,
        ig_username: str | None = None,
    ) -> str:
        """
        Find or create a contact in LeadConnector.
        Returns the contact_id.
        """
        client = await self._get_client()

        # Try to find existing contact first
        if email:
            response = await client.get(
                "/contacts/",
                params={"locationId": self.location_id, "query": email},
            )
            data = self._handle_response(response, "search_contact")
            contacts = data.get("contacts", [])
            if contacts:
                return contacts[0]["id"]

        # Create new contact
        contact_data = {
            "locationId": self.location_id,
            "name": name or ig_username or "DM Lead",
            "tags": ["dm_setter_lead"],
        }
        if email:
            contact_data["email"] = email
        if phone:
            contact_data["phone"] = phone
        if ig_username:
            contact_data["customField"] = {"ig_username": ig_username}

        response = await client.post("/contacts/", json=contact_data)
        data = self._handle_response(response, "create_contact")
        return data.get("contact", {}).get("id", "")

    async def book_appointment(
        self,
        contact_id: str,
        slot: TimeSlot,
        lead_name: str | None = None,
        notes: str | None = None,
    ) -> BookingConfirmation:
        """
        Book an appointment on Daniel's calendar for a qualified lead.
        """
        client = await self._get_client()
        payload = {
            "calendarId": self.calendar_id,
            "locationId": self.location_id,
            "contactId": contact_id,
            "startTime": slot.start.isoformat(),
            "endTime": slot.end.isoformat(),
            "title": f"DAE Trading Call — {lead_name or 'DM Lead'}",
            "appointmentStatus": "confirmed",
        }
        if notes:
            payload["notes"] = notes

        response = await client.post("/calendars/events/appointments", json=payload)
        data = self._handle_response(response, "book_appointment")

        return BookingConfirmation(
            appointment_id=data.get("id", ""),
            calendar_id=self.calendar_id,
            contact_id=contact_id,
            start_time=slot.start,
            end_time=slot.end,
            status="confirmed",
            display=f"Your call is confirmed for {slot.display}. Looking forward to speaking with you! 🔥",
        )

    async def cancel_appointment(self, appointment_id: str) -> dict:
        """Cancel an existing appointment."""
        client = await self._get_client()
        response = await client.delete(f"/calendars/events/appointments/{appointment_id}")
        return self._handle_response(response, "cancel_appointment")

    async def get_appointment(self, appointment_id: str) -> dict:
        """Fetch details of a specific appointment."""
        client = await self._get_client()
        response = await client.get(f"/calendars/events/appointments/{appointment_id}")
        return self._handle_response(response, "get_appointment")

    # ── Internal ─────────────────────────────────────────────────────────

    def _handle_response(self, response: httpx.Response, context: str) -> dict:
        try:
            data = response.json()
        except Exception:
            raise LeadConnectorError(
                f"[{context}] Non-JSON response: {response.text[:200]}",
                status_code=response.status_code,
            )

        if response.status_code >= 400:
            msg = data.get("message", data.get("msg", response.text[:200]))
            logger.error(f"[{context}] LeadConnector error {response.status_code}: {msg}")
            raise LeadConnectorError(f"[{context}] {msg}", status_code=response.status_code)

        return data


# Module-level singleton
lc_client = LeadConnectorClient()
