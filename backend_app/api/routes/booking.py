"""
Booking API routes — Allows dashboard users to view/manage bookings
and provides endpoints for the AI to check availability.
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.models import Lead, Conversation
from app.models.enums import UserRole
from app.api.deps import get_current_user, require_role
from app.services.leadconnector_service import lc_client, LeadConnectorError
from app.services.booking_flow import booking_flow

router = APIRouter(prefix="/booking", tags=["booking"])


@router.get("/slots")
async def get_available_slots(
    max_slots: int = 5,
    _user=Depends(require_role(UserRole.ADMIN, UserRole.SETTER)),
):
    """Get available booking slots from LeadConnector."""
    return await booking_flow.get_slots_for_conversation(max_slots=max_slots)


@router.post("/book/{lead_id}")
async def book_for_lead(
    lead_id: str,
    slot_index: int,
    db: AsyncSession = Depends(get_db),
    _user=Depends(require_role(UserRole.ADMIN, UserRole.SETTER)),
):
    """Manually book a slot for a lead from the dashboard."""
    lead = await db.get(Lead, lead_id)
    if not lead:
        raise HTTPException(status_code=404, detail="Lead not found")

    result = await db.execute(
        select(Conversation).where(Conversation.lead_id == lead.id)
    )
    conversation = result.scalar_one_or_none()
    if not conversation:
        raise HTTPException(status_code=404, detail="Conversation not found")

    # Get current slots
    slot_data = await booking_flow.get_slots_for_conversation()
    if not slot_data.get("available"):
        raise HTTPException(status_code=400, detail="No available slots")

    booking_result = await booking_flow.book_slot(
        db=db,
        lead=lead,
        conversation=conversation,
        slot_index=slot_index,
        available_slots=slot_data["slots"],
    )

    if not booking_result.get("success"):
        raise HTTPException(status_code=400, detail=booking_result.get("error", "Booking failed"))

    return booking_result


@router.get("/appointment/{appointment_id}")
async def get_appointment(
    appointment_id: str,
    _user=Depends(require_role(UserRole.ADMIN, UserRole.CLOSER)),
):
    """Get details of a specific appointment."""
    try:
        return await lc_client.get_appointment(appointment_id)
    except LeadConnectorError as e:
        raise HTTPException(status_code=400, detail=str(e))
