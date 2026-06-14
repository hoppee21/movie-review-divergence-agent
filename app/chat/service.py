from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from threading import RLock
from typing import Callable
from uuid import uuid4
from weakref import WeakValueDictionary

from app.agent import MovieEvidencePromptCore
from app.chat.models import (
    AnalysisLanguage,
    ConversationRecord,
    ConversationTurn,
    MovieChatReply,
)
from app.chat.policy import ConversationPolicy
from app.chat.session import ChatClient, MovieChatSession
from app.chat.store import ConversationStore, InMemoryConversationStore


CoreFactory = Callable[[AnalysisLanguage], MovieEvidencePromptCore]
ClientFactory = Callable[[str | None, float], ChatClient]


@dataclass(frozen=True)
class CreatedAnalysis:
    session_id: str
    reply: MovieChatReply
    remaining_questions: int
    suggested_questions: list[str]


@dataclass(frozen=True)
class CreatedFollowUp:
    session_id: str
    turn: ConversationTurn
    remaining_questions: int


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
        model: str | None = None,
        temperature: float = 0.0,
    ) -> CreatedAnalysis:
        session = MovieChatSession.from_movie_key(
            self._core_factory(language),
            movie_key,
            question=question,
        )
        if session.evidence_count == 0:
            raise LookupError("No evidence found for movie.")

        reply = session.initial_answer(self._client_factory(model, temperature))
        now = datetime.now(UTC)
        record = ConversationRecord(
            session_id=uuid4().hex,
            language=language,
            chat_state=session.state(),
            model=model,
            temperature=temperature,
            remaining_questions=self.policy.max_follow_ups,
            created_at=now,
            expires_at=now + self._session_ttl,
        )
        self.store.save(record)
        return CreatedAnalysis(
            session_id=record.session_id,
            reply=reply,
            remaining_questions=record.remaining_questions,
            suggested_questions=self.policy.suggested_questions(language),
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
            session = MovieChatSession.from_state(record.chat_state)
            prompt = self.policy.render_follow_up_prompt(
                language=record.language,
                question=validated.question,
                focus_refs=validated.focus_refs,
            )
            reply = session.ask(
                prompt,
                self._client_factory(record.model, record.temperature),
            )
            turn = ConversationTurn(
                question=validated.question,
                focus_refs=validated.focus_refs,
                answer=reply.assistant_message.content,
                raw_answer=reply.raw_assistant_message.content
                if reply.raw_assistant_message
                else "",
                segments=reply.segments,
            )
            record.chat_state = session.state()
            record.turns.append(turn)
            record.remaining_questions -= 1
            self.store.save(record)
            return CreatedFollowUp(
                session_id=session_id,
                turn=turn,
                remaining_questions=record.remaining_questions,
            )

    def delete(self, session_id: str) -> None:
        with self._session_lock(session_id):
            self.store.delete(session_id)
        with self._session_locks_guard:
            self._session_locks.pop(session_id, None)

    def _session_lock(self, session_id: str) -> RLock:
        with self._session_locks_guard:
            return self._session_locks.setdefault(session_id, RLock())
