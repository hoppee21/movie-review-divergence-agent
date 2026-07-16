from __future__ import annotations

import re

from app.agent import EvidenceDocument, MovieEvidencePrompt
from app.chat.models import AnswerSegment, ChatMessage, EvidenceReference


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
    r"[ \t]*[\[【(（]\s*P\s*\d+\s*/\s*E\s*\d+"
    r"(?:\s*[,，、;；|&]\s*(?:P\s*\d+\s*/\s*)?E\s*\d+)*\s*$",
    re.IGNORECASE,
)


def prompt_messages(prompt: MovieEvidencePrompt) -> list[ChatMessage]:
    return [
        ChatMessage(role="system", content=prompt.system_prompt),
        ChatMessage(role="user", content=prompt.user_prompt),
    ]


def build_evidence_refs(evidence: list[EvidenceDocument]) -> list[EvidenceReference]:
    pair_labels: dict[str, str] = {}
    refs: list[EvidenceReference] = []
    for index, item in enumerate(evidence, start=1):
        pair_id = item.pair_id or "unknown_pair"
        pair_label = pair_labels.setdefault(pair_id, f"P{len(pair_labels) + 1}")
        refs.append(
            EvidenceReference(
                citation=f"{pair_label}/E{index}",
                platform=item.platform,
                rating=_as_float_or_none(item.metadata.get("rating")),
                text=item.text,
            )
        )
    return refs


def movie_title(evidence: list[EvidenceDocument]) -> str:
    for item in evidence:
        value = item.metadata.get("movie_title")
        if value not in (None, ""):
            return str(value)
    return "unknown"


def split_internal_refs(
    text: str,
    *,
    allowed_refs: set[str] | None = None,
) -> list[AnswerSegment]:
    """Remove compact refs from visible text while preserving popover anchors."""
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


def _expand_refs(raw_refs: str) -> list[str]:
    refs: list[str] = []
    current_pair = ""
    for match in INTERNAL_REF_TOKEN_PATTERN.finditer(raw_refs):
        pair = match.group(1)
        if pair:
            current_pair = _normalize_ref_label(pair)
        if not current_pair:
            continue
        citation = f"{current_pair}/{_normalize_ref_label(match.group(2))}"
        if citation not in refs:
            refs.append(citation)
    return refs


def _normalize_ref_label(value: str) -> str:
    compact = re.sub(r"\s+", "", value).upper()
    return f"{compact[0]}{int(compact[1:])}"


def _strip_residual_internal_refs(text: str) -> str:
    text = RESIDUAL_INTERNAL_REF_PATTERN.sub("", text)
    text = UNTERMINATED_INTERNAL_REF_PATTERN.sub("", text)
    text = re.sub(r"[ \t]+([。！？；：，、])", r"\1", text)
    text = re.sub(r"(?<=[。！？；：，、])[ \t]+(?=\S)", "", text)
    return re.sub(r"[ \t]+\n", "\n", text)


def _merge_empty_segments(segments: list[AnswerSegment]) -> list[AnswerSegment]:
    merged: list[AnswerSegment] = []
    for segment in segments:
        if not segment.text and merged:
            merged[-1].citations.extend(segment.citations)
            continue
        merged.append(segment)
    return merged


def _as_float_or_none(value: object) -> float | None:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
