from __future__ import annotations

import re
from typing import Any, Protocol, Sequence

from app.agent import EvidenceDocument, MovieEvidencePrompt, MovieEvidencePromptCore
from app.chat.models import (
    AnswerSegment,
    ChatMessage,
    EvidenceReference,
    MovieChatReply,
    MovieChatState,
)


class ChatClient(Protocol):
    """Small adapter boundary for any LLM client used by the UI/API layer."""

    def complete(self, messages: Sequence[ChatMessage]) -> ChatMessage:
        """Return one assistant message for the provided chat history."""


class MovieChatSession:
    """Stateful multi-turn chat around one movie's fixed evidence prompt."""

    def __init__(
        self,
        *,
        movie_key: str,
        movie_title: str,
        evidence_count: int,
        pair_count: int,
        evidence_ids: list[str],
        evidence_refs: list[EvidenceReference],
        history: list[ChatMessage],
    ) -> None:
        self.movie_key = movie_key
        self.movie_title = movie_title
        self.evidence_count = evidence_count
        self.pair_count = pair_count
        self.evidence_ids = evidence_ids
        self.evidence_refs = evidence_refs
        self.history = history

    @classmethod
    def from_movie_key(
        cls,
        core: MovieEvidencePromptCore,
        movie_key: str,
        *,
        question: str,
    ) -> "MovieChatSession":
        payload = core.build_movie_prompt(movie_key, question=question)
        return cls.from_prompt_payload(payload)

    @classmethod
    def from_prompt_payload(cls, payload: MovieEvidencePrompt) -> "MovieChatSession":
        movie_title = _first_nonempty(
            item.metadata.get("movie_title") for item in payload.evidence
        )
        return cls(
            movie_key=payload.movie_key,
            movie_title=movie_title or "unknown",
            evidence_count=len(payload.evidence),
            pair_count=payload.pair_count,
            evidence_ids=[item.evidence_id for item in payload.evidence],
            evidence_refs=_build_evidence_refs(payload.evidence),
            history=[_to_chat_message(message) for message in payload.messages],
        )

    @classmethod
    def from_state(cls, state: MovieChatState) -> "MovieChatSession":
        return cls(
            movie_key=state.movie_key,
            movie_title=state.movie_title,
            evidence_count=state.evidence_count,
            pair_count=state.pair_count,
            evidence_ids=list(state.evidence_ids),
            evidence_refs=list(state.evidence_refs),
            history=list(state.history),
        )

    def state(self) -> MovieChatState:
        return MovieChatState(
            movie_key=self.movie_key,
            movie_title=self.movie_title,
            evidence_count=self.evidence_count,
            pair_count=self.pair_count,
            evidence_ids=list(self.evidence_ids),
            evidence_refs=list(self.evidence_refs),
            history=list(self.history),
        )

    def initial_answer(self, client: ChatClient) -> MovieChatReply:
        raw_assistant_message = client.complete(self.history)
        self.history.append(raw_assistant_message)
        return self._build_reply(raw_assistant_message=raw_assistant_message)

    def ask(self, user_text: str, client: ChatClient) -> MovieChatReply:
        text = user_text.strip()
        if not text:
            raise ValueError("user_text is required")

        user_message = ChatMessage(role="user", content=text)
        self.history.append(user_message)
        raw_assistant_message = client.complete(self.history)
        self.history.append(raw_assistant_message)
        return self._build_reply(
            raw_assistant_message=raw_assistant_message,
            user_message=user_message,
        )

    def _build_reply(
        self,
        *,
        raw_assistant_message: ChatMessage,
        user_message: ChatMessage | None = None,
    ) -> MovieChatReply:
        allowed_refs = {ref.citation for ref in self.evidence_refs}
        segments = split_internal_refs(
            raw_assistant_message.content,
            allowed_refs=allowed_refs,
        )
        visible_text = _visible_text_from_segments(segments)
        assistant_message = ChatMessage(role="assistant", content=visible_text)
        return MovieChatReply(
            state=self.state(),
            assistant_message=assistant_message,
            raw_assistant_message=raw_assistant_message,
            segments=segments,
            user_message=user_message,
        )


def _to_chat_message(message: Any) -> ChatMessage:
    if isinstance(message, ChatMessage):
        return message
    if isinstance(message, dict):
        return ChatMessage(
            role=_normalize_role(message.get("role")),
            content=str(message.get("content", "")),
        )

    role = _normalize_role(getattr(message, "type", None))
    return ChatMessage(role=role, content=str(getattr(message, "content", "")))


_REF_BODY = (
    r"P\s*\d+\s*/\s*E\s*\d+"
    r"(?:\s*(?:[,，、;；|]|&|\band\b)\s*(?:P\s*\d+\s*/\s*)?E\s*\d+)*"
)
INTERNAL_REF_PATTERN = re.compile(
    rf"[ \t]*(?:"
    rf"\[\s*({_REF_BODY})\s*\]"
    rf"|【\s*({_REF_BODY})\s*】"
    rf"|\(\s*({_REF_BODY})\s*\)"
    rf"|（\s*({_REF_BODY})\s*）"
    rf")",
    re.IGNORECASE,
)
INTERNAL_REF_TOKEN_PATTERN = re.compile(
    r"(?:(P\s*\d+)\s*/\s*)?(E\s*\d+)",
    re.IGNORECASE,
)
RESIDUAL_INTERNAL_REF_PATTERN = re.compile(
    r"[ \t]*(?:"
    r"\[[^\]\n]{0,160}P\s*\d+\s*/\s*E\s*\d+[^\]\n]{0,160}\]"
    r"|【[^】\n]{0,160}P\s*\d+\s*/\s*E\s*\d+[^】\n]{0,160}】"
    r"|\([^)\n]{0,160}P\s*\d+\s*/\s*E\s*\d+[^)\n]{0,160}\)"
    r"|（[^）\n]{0,160}P\s*\d+\s*/\s*E\s*\d+[^）\n]{0,160}）"
    r")",
    re.IGNORECASE,
)
UNTERMINATED_INTERNAL_REF_PATTERN = re.compile(
    r"[ \t]*[\[【(（]\s*P\s*\d+\s*/\s*E\s*\d+(?:\s*[,，、;；|&]\s*(?:P\s*\d+\s*/\s*)?E\s*\d+)*\s*$",
    re.IGNORECASE,
)


def split_internal_refs(
    text: str,
    *,
    allowed_refs: set[str] | None = None,
) -> list[AnswerSegment]:
    """Remove compact refs from visible text while preserving anchor metadata."""
    segments: list[AnswerSegment] = []
    cursor = 0
    for match in INTERNAL_REF_PATTERN.finditer(text):
        chunk = _strip_residual_internal_refs(text[cursor : match.start()])
        raw_refs = next(group for group in match.groups() if group is not None)
        refs = _expand_refs(raw_refs)
        if allowed_refs is not None:
            refs = [ref for ref in refs if ref in allowed_refs]
        if chunk or refs:
            segments.append(AnswerSegment(text=chunk, citations=refs))
        cursor = match.end()

    tail = _strip_residual_internal_refs(text[cursor:])
    if tail or not segments:
        segments.append(AnswerSegment(text=tail, citations=[]))
    return _merge_empty_segments(segments)


def _visible_text_from_segments(segments: list[AnswerSegment]) -> str:
    text = "".join(segment.text for segment in segments).strip()
    text = _strip_residual_internal_refs(text)
    text = re.sub(r"[ \t]+([。！？；：，、])", r"\1", text)
    text = re.sub(r"(?<=[。！？；：，、])[ \t]+(?=\S)", "", text)
    text = re.sub(r"[ \t]+\n", "\n", text)
    return text


def _expand_refs(raw_refs: str) -> list[str]:
    refs: list[str] = []
    current_pair = ""
    for match in INTERNAL_REF_TOKEN_PATTERN.finditer(raw_refs):
        pair = match.group(1)
        if pair:
            current_pair = _normalize_ref_label(pair)
        if not current_pair:
            continue
        evidence = _normalize_ref_label(match.group(2))
        citation = f"{current_pair}/{evidence}"
        if citation not in refs:
            refs.append(citation)
    return refs


def _normalize_ref_label(value: str) -> str:
    compact = re.sub(r"\s+", "", value).upper()
    return f"{compact[0]}{int(compact[1:])}"


def _strip_residual_internal_refs(text: str) -> str:
    text = RESIDUAL_INTERNAL_REF_PATTERN.sub("", text)
    return UNTERMINATED_INTERNAL_REF_PATTERN.sub("", text)


def _merge_empty_segments(segments: list[AnswerSegment]) -> list[AnswerSegment]:
    merged: list[AnswerSegment] = []
    for segment in segments:
        if not segment.text and merged:
            merged[-1].citations.extend(segment.citations)
            continue
        merged.append(segment)
    return merged


def _build_evidence_refs(evidence: list[EvidenceDocument]) -> list[EvidenceReference]:
    pair_labels: dict[str, str] = {}
    refs: list[EvidenceReference] = []
    for index, item in enumerate(evidence, start=1):
        pair_id = item.pair_id or "unknown_pair"
        pair_label = pair_labels.setdefault(pair_id, f"P{len(pair_labels) + 1}")
        evidence_label = f"E{index}"
        refs.append(
            EvidenceReference(
                evidence_label=evidence_label,
                pair_label=pair_label,
                citation=f"{pair_label}/{evidence_label}",
                evidence_id=item.evidence_id,
                pair_id=pair_id,
                platform=item.platform,
                rating=_as_float_or_none(item.metadata.get("rating")),
                text=item.text,
            )
        )
    return refs


def _normalize_role(value: Any) -> str:
    text = str(value or "").lower()
    if text in {"system", "human", "user", "assistant", "ai"}:
        return {"human": "user", "ai": "assistant"}.get(text, text)
    return "user"


def _as_float_or_none(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _first_nonempty(values: Any) -> str:
    for value in values:
        if value not in (None, ""):
            return str(value)
    return ""
