from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from app.chat.models import AnalysisLanguage, ConversationRecord


class ConversationPolicyError(ValueError):
    """A public-safe policy failure for a bounded follow-up request."""

    def __init__(self, message: str, *, code: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ValidatedFollowUp:
    question: str
    focus_refs: list[str]


class ConversationPolicy:
    """Deterministic limits around an evidence-only movie conversation."""

    def __init__(
        self,
        *,
        max_follow_ups: int = 5,
        max_question_chars: int = 200,
        max_focus_refs: int = 4,
    ) -> None:
        self.max_follow_ups = max_follow_ups
        self.max_question_chars = max_question_chars
        self.max_focus_refs = max_focus_refs

    def validate_follow_up(
        self,
        record: ConversationRecord,
        *,
        question: str,
        focus_refs: Iterable[str] = (),
    ) -> ValidatedFollowUp:
        text = question.strip()
        if not text:
            raise ConversationPolicyError(
                "Question is required.",
                code="empty_question",
            )
        if len(text) > self.max_question_chars:
            raise ConversationPolicyError(
                f"Question must be at most {self.max_question_chars} characters.",
                code="question_too_long",
            )
        if record.remaining_questions <= 0:
            raise ConversationPolicyError(
                "This analysis has no follow-up questions remaining.",
                code="follow_up_limit_reached",
            )

        unique_refs = list(dict.fromkeys(ref.strip() for ref in focus_refs if ref.strip()))
        if len(unique_refs) > self.max_focus_refs:
            raise ConversationPolicyError(
                f"At most {self.max_focus_refs} evidence references may be focused.",
                code="too_many_focus_refs",
            )

        allowed_refs = {ref.citation for ref in record.evidence_refs}
        invalid_refs = [ref for ref in unique_refs if ref not in allowed_refs]
        if invalid_refs:
            raise ConversationPolicyError(
                "One or more focused evidence references do not belong to this analysis.",
                code="invalid_focus_refs",
            )

        return ValidatedFollowUp(question=text, focus_refs=unique_refs)

    def render_follow_up_prompt(
        self,
        *,
        language: AnalysisLanguage,
        question: str,
        focus_refs: list[str],
    ) -> str:
        output_language = "Chinese" if language == "zh" else "English"
        focus = ", ".join(focus_refs) if focus_refs else "none"
        return "\n".join(
            [
                "Follow-up request for the existing movie evidence report.",
                "Use only the fixed evidence documents already provided in this conversation.",
                "Do not use outside knowledge, discuss another movie, or make recommendations.",
                "If the request is outside this scope, briefly explain that it cannot be answered from the current evidence.",
                "Keep the answer concise and professional, and cite valid compact refs after evidence-backed claims.",
                f"Answer in {output_language}.",
                f"Focused evidence refs: {focus}",
                "",
                f"User question: {question}",
            ]
        )

    def suggested_questions(self, language: AnalysisLanguage) -> list[str]:
        if language == "zh":
            return [
                "双方真正一致的地方是什么？",
                "哪组证据最能支持这个结论？",
                "评分差是否大于观点差？",
            ]
        return [
            "Where do both sides actually agree?",
            "Which evidence pair best supports the conclusion?",
            "Is the rating gap larger than the viewpoint gap?",
        ]
