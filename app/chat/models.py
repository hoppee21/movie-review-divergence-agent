from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


ChatRole = Literal["system", "user", "assistant"]


class ChatMessage(BaseModel):
    """Frontend-serializable chat message."""

    model_config = ConfigDict(extra="forbid")

    role: ChatRole
    content: str


class EvidenceReference(BaseModel):
    """Frontend citation map from display labels to source evidence metadata."""

    model_config = ConfigDict(extra="forbid")

    evidence_label: str
    pair_label: str
    citation: str
    evidence_id: str
    pair_id: str
    platform: str
    rating: float | None = None
    text: str


class AnswerSegment(BaseModel):
    """One visible answer span plus internal refs attached to it."""

    model_config = ConfigDict(extra="forbid")

    text: str
    citations: list[str] = Field(default_factory=list)


class MovieChatState(BaseModel):
    """Serializable state for one movie-grounded chat session."""

    model_config = ConfigDict(extra="forbid")

    movie_key: str
    movie_title: str = "unknown"
    evidence_count: int
    pair_count: int
    evidence_ids: list[str] = Field(default_factory=list)
    evidence_refs: list[EvidenceReference] = Field(default_factory=list)
    history: list[ChatMessage] = Field(default_factory=list)


class MovieChatReply(BaseModel):
    """Return payload for an initial answer or one follow-up turn."""

    model_config = ConfigDict(extra="forbid")

    state: MovieChatState
    assistant_message: ChatMessage
    raw_assistant_message: ChatMessage | None = None
    segments: list[AnswerSegment] = Field(default_factory=list)
    user_message: ChatMessage | None = None
