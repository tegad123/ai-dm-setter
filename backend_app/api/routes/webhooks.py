"""
Webhook endpoints for receiving incoming messages from Instagram/Facebook.
Parses Meta webhook payloads and routes them through the conversation orchestrator.
"""
import logging
from fastapi import APIRouter, Depends, Request, HTTPException, BackgroundTasks
from fastapi.responses import PlainTextResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.database import get_db
from app.models.enums import Platform, TriggerType
from app.schemas.schemas import IncomingDM, IncomingComment
from app.services.conversation_orchestrator import handle_incoming_message
from app.services.webhook_parser import parse_meta_webhook
from app.services.meta_api import meta_client

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/webhooks", tags=["webhooks"])


@router.get("/meta")
async def verify_webhook(request: Request):
    """Meta webhook verification endpoint."""
    params = request.query_params
    mode = params.get("hub.mode")
    token = params.get("hub.verify_token")
    challenge = params.get("hub.challenge")

    if mode == "subscribe" and token == settings.meta_verify_token:
        return PlainTextResponse(content=challenge)
    raise HTTPException(status_code=403, detail="Verification failed")


@router.post("/meta")
async def receive_meta_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    """
    Receive webhooks from Meta (Instagram/Facebook).
    Parses the payload and routes each event to the conversation orchestrator.
    Must return 200 quickly — Meta retries on slow responses.
    """
    body = await request.json()
    events = parse_meta_webhook(body)

    if not events:
        return {"status": "received", "events_processed": 0}

    results = []
    for event in events:
        try:
            # Enrich username from profile API if missing
            username = event.username
            if not username:
                username = await _fetch_username(event.platform, event.platform_user_id)

            result = await handle_incoming_message(
                db=db,
                platform=event.platform,
                platform_user_id=event.platform_user_id,
                username=username or event.platform_user_id,
                message_text=event.message_text,
                trigger_type=event.trigger_type,
                trigger_post_id=event.trigger_post_id,
                trigger_post_url=event.trigger_post_url,
                trigger_comment_text=event.trigger_comment_text,
                profile_url=event.profile_url,
                platform_message_id=event.platform_message_id,
            )
            results.append(result)
        except Exception as e:
            logger.error(f"Error processing webhook event: {e}", exc_info=True)
            results.append({"status": "error", "error": str(e)})

    return {"status": "received", "events_processed": len(results), "results": results}


async def _fetch_username(platform: Platform, platform_user_id: str) -> str | None:
    """Fetch username from Meta profile API. Returns None on failure."""
    try:
        if platform == Platform.INSTAGRAM:
            profile = await meta_client.get_ig_user_profile(platform_user_id)
            return profile.get("username") or profile.get("name")
        elif platform == Platform.FACEBOOK:
            profile = await meta_client.get_fb_user_profile(platform_user_id)
            first = profile.get("first_name", "")
            last = profile.get("last_name", "")
            return f"{first} {last}".strip() or None
    except Exception as e:
        logger.warning(f"Failed to fetch profile for {platform_user_id}: {e}")
    return None


@router.post("/test/dm")
async def test_incoming_dm(data: IncomingDM, db: AsyncSession = Depends(get_db)):
    """Test endpoint to simulate an incoming DM — for development/testing."""
    result = await handle_incoming_message(
        db=db,
        platform=data.platform,
        platform_user_id=data.platform_user_id,
        username=data.username,
        message_text=data.message_text,
        trigger_type=TriggerType.DIRECT_DM,
        profile_url=data.profile_url,
        platform_message_id=data.platform_message_id,
    )
    return result


@router.post("/test/comment")
async def test_incoming_comment(data: IncomingComment, db: AsyncSession = Depends(get_db)):
    """Test endpoint to simulate an incoming comment trigger — for development/testing."""
    result = await handle_incoming_message(
        db=db,
        platform=data.platform,
        platform_user_id=data.commenter_user_id,
        username=data.commenter_username,
        message_text=data.comment_text,
        trigger_type=TriggerType.COMMENT,
        trigger_post_id=data.post_id,
        trigger_post_url=data.post_url,
        trigger_comment_text=data.comment_text,
        profile_url=data.profile_url,
    )
    return result
