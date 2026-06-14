from __future__ import annotations

from datetime import UTC, datetime
from threading import RLock
from typing import Protocol

from app.chat.models import ConversationRecord


class ConversationNotFoundError(LookupError):
    """Raised when a conversation does not exist or has expired."""


class ConversationStore(Protocol):
    def save(self, record: ConversationRecord) -> None:
        """Create or replace one conversation record."""

    def get(self, session_id: str) -> ConversationRecord:
        """Return a non-expired conversation record."""

    def delete(self, session_id: str) -> None:
        """Delete a conversation when it exists."""


class InMemoryConversationStore:
    """Thread-safe local store that can later be replaced with Redis."""

    def __init__(self) -> None:
        self._records: dict[str, ConversationRecord] = {}
        self._lock = RLock()

    def save(self, record: ConversationRecord) -> None:
        with self._lock:
            self._prune_expired()
            self._records[record.session_id] = record

    def get(self, session_id: str) -> ConversationRecord:
        with self._lock:
            self._prune_expired()
            record = self._records.get(session_id)
            if record is None:
                raise ConversationNotFoundError("Analysis session not found or expired.")
            return record

    def delete(self, session_id: str) -> None:
        with self._lock:
            self._records.pop(session_id, None)

    def _prune_expired(self) -> None:
        now = datetime.now(UTC)
        expired = [
            session_id
            for session_id, record in self._records.items()
            if record.expires_at <= now
        ]
        for session_id in expired:
            self._records.pop(session_id, None)
