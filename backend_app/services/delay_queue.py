"""
Response Delay Queue — introduces human-feeling 5-10 minute delays before AI replies.
Uses APScheduler for in-process scheduling with database persistence fallback.
"""
import random
import uuid
import asyncio
from datetime import datetime, timedelta, timezone
from typing import Callable, Awaitable
from dataclasses import dataclass, field
from app.core.config import get_settings

settings = get_settings()


@dataclass
class PendingMessage:
    id: str
    conversation_id: str
    messages: list[str]
    voice_note_text: str | None
    scheduled_for: datetime
    callback: Callable[..., Awaitable] | None = None
    metadata: dict = field(default_factory=dict)


class DelayQueue:
    """
    In-memory delay queue that schedules AI responses with random 5-10 minute delays.
    In production, this would be backed by Redis/Celery for persistence.
    """

    def __init__(self):
        self._pending: dict[str, PendingMessage] = {}
        self._tasks: dict[str, asyncio.Task] = {}

    def calculate_delay(self) -> int:
        """Generate a random delay between min and max response delay (seconds)."""
        return random.randint(settings.min_response_delay, settings.max_response_delay)

    async def schedule_response(
        self,
        conversation_id: str,
        messages: list[str],
        voice_note_text: str | None = None,
        callback: Callable[..., Awaitable] | None = None,
        metadata: dict | None = None,
    ) -> PendingMessage:
        """
        Schedule an AI response with a random delay.
        Returns the PendingMessage for tracking.
        """
        delay_seconds = self.calculate_delay()
        scheduled_for = datetime.now(timezone.utc) + timedelta(seconds=delay_seconds)

        pending = PendingMessage(
            id=str(uuid.uuid4()),
            conversation_id=conversation_id,
            messages=messages,
            voice_note_text=voice_note_text,
            scheduled_for=scheduled_for,
            callback=callback,
            metadata=metadata or {},
        )

        self._pending[pending.id] = pending

        # Create async task for delayed execution
        task = asyncio.create_task(self._execute_after_delay(pending, delay_seconds))
        self._tasks[pending.id] = task

        return pending

    async def _execute_after_delay(self, pending: PendingMessage, delay_seconds: int):
        """Wait for the delay then execute the callback."""
        try:
            await asyncio.sleep(delay_seconds)
            if pending.callback:
                await pending.callback(pending)
        finally:
            self._pending.pop(pending.id, None)
            self._tasks.pop(pending.id, None)

    def cancel(self, pending_id: str) -> bool:
        """Cancel a scheduled response (e.g., when human takes over)."""
        task = self._tasks.pop(pending_id, None)
        if task:
            task.cancel()
            self._pending.pop(pending_id, None)
            return True
        return False

    def cancel_for_conversation(self, conversation_id: str) -> int:
        """Cancel all pending messages for a conversation (for human override)."""
        cancelled = 0
        to_cancel = [
            pid for pid, p in self._pending.items()
            if p.conversation_id == conversation_id
        ]
        for pid in to_cancel:
            if self.cancel(pid):
                cancelled += 1
        return cancelled

    def get_pending(self, conversation_id: str) -> list[PendingMessage]:
        """Get all pending messages for a conversation."""
        return [p for p in self._pending.values() if p.conversation_id == conversation_id]

    @property
    def pending_count(self) -> int:
        return len(self._pending)


# Singleton instance
delay_queue = DelayQueue()
