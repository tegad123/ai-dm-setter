"""
WebSocket Connection Manager — handles real-time notifications to connected dashboard clients.
Supports per-user connections and broadcast to all connected users.
"""
import json
import logging
from datetime import datetime, timezone
from fastapi import WebSocket
from typing import Any

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections for real-time dashboard updates."""

    def __init__(self):
        # user_id -> list of active WebSocket connections
        self._connections: dict[str, list[WebSocket]] = {}
        # Broadcast connections (no specific user)
        self._broadcast_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket, user_id: str | None = None):
        """Accept a new WebSocket connection."""
        await websocket.accept()
        if user_id:
            if user_id not in self._connections:
                self._connections[user_id] = []
            self._connections[user_id].append(websocket)
            logger.info(f"WebSocket connected: user {user_id}")
        else:
            self._broadcast_connections.append(websocket)
            logger.info("WebSocket connected: anonymous broadcast listener")

    def disconnect(self, websocket: WebSocket, user_id: str | None = None):
        """Remove a disconnected WebSocket."""
        if user_id and user_id in self._connections:
            self._connections[user_id] = [
                ws for ws in self._connections[user_id] if ws != websocket
            ]
            if not self._connections[user_id]:
                del self._connections[user_id]
        else:
            self._broadcast_connections = [
                ws for ws in self._broadcast_connections if ws != websocket
            ]
        logger.info(f"WebSocket disconnected: user {user_id or 'broadcast'}")

    async def send_to_user(self, user_id: str, data: dict):
        """Send a message to a specific user's connections."""
        connections = self._connections.get(user_id, [])
        dead = []
        for ws in connections:
            try:
                await ws.send_json(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.disconnect(ws, user_id)

    async def broadcast(self, data: dict):
        """Send a message to ALL connected clients."""
        dead_user = []
        dead_broadcast = []

        # Send to all user connections
        for user_id, connections in self._connections.items():
            for ws in connections:
                try:
                    await ws.send_json(data)
                except Exception:
                    dead_user.append((ws, user_id))

        # Send to broadcast connections
        for ws in self._broadcast_connections:
            try:
                await ws.send_json(data)
            except Exception:
                dead_broadcast.append(ws)

        for ws, uid in dead_user:
            self.disconnect(ws, uid)
        for ws in dead_broadcast:
            self.disconnect(ws)

    async def notify(
        self,
        event_type: str,
        title: str,
        body: str,
        lead_id: str | None = None,
        metadata: dict | None = None,
        target_user_id: str | None = None,
    ):
        """
        High-level notification: broadcast a structured event to connected clients.
        If target_user_id is set, only sends to that user.
        """
        payload = {
            "type": "notification",
            "event": event_type,
            "title": title,
            "body": body,
            "lead_id": lead_id,
            "metadata": metadata or {},
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }

        if target_user_id:
            await self.send_to_user(target_user_id, payload)
        else:
            await self.broadcast(payload)

    async def send_lead_update(self, lead_id: str, status: str, quality_score: float | None = None):
        """Broadcast a lead status change to all dashboard viewers."""
        await self.broadcast({
            "type": "lead_update",
            "lead_id": lead_id,
            "status": status,
            "quality_score": quality_score,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    async def send_new_message(self, lead_id: str, sender: str, content: str, message_type: str = "text"):
        """Broadcast a new message in a conversation."""
        await self.broadcast({
            "type": "new_message",
            "lead_id": lead_id,
            "sender": sender,
            "content": content[:200],  # Truncate for broadcast
            "message_type": message_type,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        })

    @property
    def active_connections(self) -> int:
        total = sum(len(conns) for conns in self._connections.values())
        return total + len(self._broadcast_connections)


# Singleton instance
ws_manager = ConnectionManager()
