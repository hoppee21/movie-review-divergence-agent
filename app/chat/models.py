from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


ChatRole = Literal["system", "user", "assistant"]
AnalysisLanguage = Literal["zh", "en"]


class ChatMessage(BaseModel):
    """Frontend-serializable chat message."""

    model_config = ConfigDict(extra="forbid")

    role: ChatRole
    content: str


class EvidenceReference(BaseModel):
    """Public citation target used by the evidence popover."""

    model_config = ConfigDict(extra="forbid")

    citation: str
    platform: str
    rating: float | None = None
    text: str


class AnswerSegment(BaseModel):
    """One visible answer span plus internal refs attached to it."""

    model_config = ConfigDict(extra="forbid")

    text: str
    citations: list[str] = Field(default_factory=list)


class ConversationRecord(BaseModel):
    """Server-side record for one language-specific movie analysis session."""

    model_config = ConfigDict(extra="forbid")

    session_id: str
    language: AnalysisLanguage
    movie_key: str
    movie_title: str
    evidence_refs: list[EvidenceReference] = Field(default_factory=list)
    history: list[ChatMessage] = Field(default_factory=list)
    remaining_questions: int
    expires_at: datetime
