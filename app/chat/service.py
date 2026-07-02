from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import RLock
from typing import Callable
from uuid import uuid4
from weakref import WeakValueDictionary

from app.agent import MovieEvidencePromptCore
from app.chat.grounding import (
    build_evidence_refs,
    movie_title,
    prompt_messages,
    split_internal_refs,
)
from app.chat.models import (
    AnalysisLanguage,
    AnswerSegment,
    ChatMessage,
    ConversationRecord,
    EvidenceReference,
)
from app.chat.openai_client import ChatClient
from app.chat.policy import ConversationPolicy
from app.chat.store import ConversationStore, InMemoryConversationStore


CoreFactory = Callable[[AnalysisLanguage], MovieEvidencePromptCore]
ClientFactory = Callable[[], ChatClient]


@dataclass(frozen=True)
class CreatedAnalysis:
    session_id: str
    language: AnalysisLanguage
    evidence_count: int
    pair_count: int
    remaining_questions: int
    suggested_questions: list[str]
    segments: list[AnswerSegment]
    evidence_refs: list[EvidenceReference]


@dataclass(frozen=True)
class CreatedFollowUp:
    question: str
    remaining_questions: int
    segments: list[AnswerSegment]


class MovieConversationService:
    """Application service for bounded, evidence-only movie conversations."""

    def __init__(
        self,
        *,
        core_factory: CoreFactory,
        client_factory: ClientFactory,
        store: ConversationStore | None = None,
        policy: ConversationPolicy | None = None,
        session_ttl: timedelta = timedelta(hours=2),
    ) -> None:
        self._core_factory = core_factory
        self._client_factory = client_factory
        self.store = store or InMemoryConversationStore()
        self.policy = policy or ConversationPolicy()
        self._session_ttl = session_ttl
        self._session_locks: WeakValueDictionary[str, RLock] = WeakValueDictionary()
        self._session_locks_guard = RLock()

    def create_analysis(
        self,
        *,
        movie_key: str,
        language: AnalysisLanguage,
        question: str,
    ) -> CreatedAnalysis:
        prompt = self._core_factory(language).build_movie_prompt(
            movie_key,
            question=question,
        )
        if not prompt.evidence:
            raise LookupError("No evidence found for movie.")

        evidence_refs = build_evidence_refs(prompt.evidence)
        history = prompt_messages(prompt)
        assistant_message = self._client_factory().complete(history)
        history.append(assistant_message)
        now = datetime.now(UTC)
        record = ConversationRecord(
            session_id=uuid4().hex,
            language=language,
            movie_key=movie_key,
            movie_title=movie_title(prompt.evidence),
            evidence_refs=evidence_refs,
            history=history,
            remaining_questions=self.policy.max_follow_ups,
            expires_at=now + self._session_ttl,
        )
        self.store.save(record)
        return CreatedAnalysis(
            session_id=record.session_id,
            language=language,
            evidence_count=len(prompt.evidence),
            pair_count=prompt.pair_count,
            remaining_questions=record.remaining_questions,
            suggested_questions=self.policy.suggested_questions(language),
            segments=split_internal_refs(
                assistant_message.content,
                allowed_refs={ref.citation for ref in evidence_refs},
            ),
            evidence_refs=evidence_refs,
        )

    def ask(
        self,
        *,
        session_id: str,
        question: str,
        focus_refs: list[str] | None = None,
    ) -> CreatedFollowUp:
        with self._session_lock(session_id):
            record = self.store.get(session_id)
            validated = self.policy.validate_follow_up(
                record,
                question=question,
                focus_refs=focus_refs or [],
            )
            prompt = self.policy.render_follow_up_prompt(
                language=record.language,
                question=validated.question,
                focus_refs=validated.focus_refs,
            )
            record.history.append(
                ChatMessage(role="user", content=prompt)
            )
            assistant_message = self._client_factory().complete(record.history)
            record.history.append(assistant_message)
            record.remaining_questions -= 1
            self.store.save(record)
            return CreatedFollowUp(
                question=validated.question,
                remaining_questions=record.remaining_questions,
                segments=split_internal_refs(
                    assistant_message.content,
                    allowed_refs={ref.citation for ref in record.evidence_refs},
                ),
            )

    def delete(self, session_id: str) -> None:
        with self._session_lock(session_id):
            self.store.delete(session_id)
        with self._session_locks_guard:
            self._session_locks.pop(session_id, None)

    def _session_lock(self, session_id: str) -> RLock:
        with self._session_locks_guard:
            return self._session_locks.setdefault(session_id, RLock())
