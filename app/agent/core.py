from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


DEFAULT_COLLECTION_NAME = "divergence_evidence"
DEFAULT_EVIDENCE_DIR = Path("divergence_evidence_artifacts")
DEFAULT_MANIFEST_PATH = DEFAULT_EVIDENCE_DIR / "chroma_divergence_evidence_manifest.json"
DEFAULT_QUESTION = (
    "Provide a concise, evidence-based analysis of the IMDb and Douban disagreement. "
    "Use a professional public-facing tone and include compact internal evidence refs for UI popovers."
)


class AgentCoreConfig(BaseModel):
    """Configuration for the movie evidence prompt core."""

    model_config = ConfigDict(extra="forbid", arbitrary_types_allowed=True)

    manifest_path: Path | None = None
    persist_directory: Path | None = None
    collection_name: str = DEFAULT_COLLECTION_NAME
    language: Literal["zh", "en"] = "zh"


class EvidenceDocument(BaseModel):
    """One evidence document loaded from the notebook-generated Chroma index."""

    model_config = ConfigDict(extra="forbid")

    evidence_id: str
    text: str
    metadata: dict[str, Any] = Field(default_factory=dict)

    @property
    def pair_id(self) -> str:
        return str(self.metadata.get("pair_id") or "")

    @property
    def platform(self) -> str:
        return str(self.metadata.get("platform") or "")

    @property
    def divergence_score(self) -> float:
        return _as_float(self.metadata.get("divergence_score"))


class MovieEvidencePrompt(BaseModel):
    """Prompt payload for one selected movie."""

    model_config = ConfigDict(extra="forbid")

    movie_key: str
    question: str
    prompt: str
    messages: list[Any]
    evidence: list[EvidenceDocument]
    pair_count: int


def load_chroma_manifest(path: str | Path = DEFAULT_MANIFEST_PATH) -> dict[str, Any]:
    manifest_path = Path(path)
    if not manifest_path.exists():
        raise FileNotFoundError(f"Chroma manifest not found: {manifest_path}")
    payload = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError(f"Chroma manifest must be a JSON object: {manifest_path}")
    return payload


def config_from_manifest(
    path: str | Path = DEFAULT_MANIFEST_PATH,
    **overrides: Any,
) -> AgentCoreConfig:
    manifest_path = Path(path)
    manifest = load_chroma_manifest(manifest_path)
    data = {
        "manifest_path": manifest_path,
        "persist_directory": _resolve_persist_directory(
            manifest_path,
            manifest.get("persist_directory"),
        ),
        "collection_name": manifest.get("collection_name", DEFAULT_COLLECTION_NAME),
    }
    data.update(overrides)
    return AgentCoreConfig(**data)


class MovieEvidencePromptCore:
    """
    Single-purpose core: selected movie -> all Chroma evidence -> prompt.

    This module deliberately does not perform query similarity search, query
    embedding, evidence selection, or LLM invocation. The notebook has already
    selected disagreement evidence and written it to Chroma. At runtime, this
    core simply loads every evidence document for one `movie_key` and renders a
    grounded prompt for an outer caller/LLM layer.
    """

    def __init__(
        self,
        config: AgentCoreConfig | None = None,
        *,
        vectorstore: Any | None = None,
        load_vectorstore: bool = False,
    ) -> None:
        self.config = config or AgentCoreConfig()
        self._vectorstore = vectorstore
        if load_vectorstore and self._vectorstore is None:
            self._vectorstore = self._build_vectorstore()

    @classmethod
    def from_manifest(
        cls,
        path: str | Path = DEFAULT_MANIFEST_PATH,
        **kwargs: Any,
    ) -> "MovieEvidencePromptCore":
        config_overrides = kwargs.pop("config_overrides", {})
        return cls(config_from_manifest(path, **config_overrides), **kwargs)

    @property
    def vectorstore(self) -> Any:
        if self._vectorstore is None:
            self._vectorstore = self._build_vectorstore()
        return self._vectorstore

    def extract_movie_evidence(self, movie_key: str) -> list[EvidenceDocument]:
        """Load every evidence document for one movie from Chroma."""
        if not movie_key.strip():
            raise ValueError("movie_key is required")
        raw = self._get_chroma_rows(where={"movie_key": movie_key})
        evidence = self._rows_to_evidence(raw)
        return sorted(evidence, key=_evidence_sort_key)

    def build_movie_prompt(
        self,
        movie_key: str,
        *,
        question: str = DEFAULT_QUESTION,
    ) -> MovieEvidencePrompt:
        evidence = self.extract_movie_evidence(movie_key)
        prompt = self._render_prompt(movie_key, question, evidence)
        messages = self._messages(prompt)
        return MovieEvidencePrompt(
            movie_key=movie_key,
            question=question,
            prompt=prompt,
            messages=messages,
            evidence=evidence,
            pair_count=len({item.pair_id for item in evidence if item.pair_id}),
        )

    def _build_vectorstore(self) -> Any:
        if self.config.persist_directory is None:
            raise ValueError(
                "persist_directory is required. Pass AgentCoreConfig or load from "
                "chroma_divergence_evidence_manifest.json."
            )
        try:
            from langchain_chroma import Chroma
        except ImportError as exc:
            raise RuntimeError(
                "Missing Chroma dependency. Install `langchain-chroma` and `chromadb`."
            ) from exc
        return Chroma(
            collection_name=self.config.collection_name,
            persist_directory=str(self.config.persist_directory),
        )

    def _get_chroma_rows(self, *, where: dict[str, Any]) -> dict[str, Any]:
        vectorstore = self.vectorstore
        include = ["documents", "metadatas"]
        if hasattr(vectorstore, "get"):
            return vectorstore.get(where=where, include=include)
        collection = getattr(vectorstore, "_collection", None)
        if collection is not None and hasattr(collection, "get"):
            return collection.get(where=where, include=include)
        raise TypeError("vectorstore must expose get(where=..., include=...)")

    def _rows_to_evidence(self, rows: dict[str, Any]) -> list[EvidenceDocument]:
        ids = rows.get("ids") or []
        documents = rows.get("documents") or []
        metadatas = rows.get("metadatas") or []
        evidence: list[EvidenceDocument] = []
        for index, text in enumerate(documents):
            metadata = dict(metadatas[index] or {}) if index < len(metadatas) else {}
            evidence_id = str(
                metadata.get("evidence_id")
                or metadata.get("doc_id")
                or (ids[index] if index < len(ids) else "")
                or f"evidence-{index + 1}"
            )
            evidence.append(
                EvidenceDocument(
                    evidence_id=evidence_id,
                    text=str(text or ""),
                    metadata=metadata,
                )
            )
        return evidence

    def _messages(self, prompt: str) -> list[Any]:
        system_prompt = self._system_prompt()
        try:
            from langchain_core.messages import HumanMessage, SystemMessage
        except ImportError:
            return [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": prompt},
            ]
        return [SystemMessage(content=system_prompt), HumanMessage(content=prompt)]

    def _system_prompt(self) -> str:
        output_language = "Chinese" if self.config.language == "zh" else "English"
        return "\n".join(
            [
                "You are a professional movie review evidence analyst.",
                "Use only the provided evidence documents.",
                "The evidence documents are full review comments selected offline from IMDb and Douban.",
                "Do not invent cultural causes or cite reviews not included in the prompt.",
                "Write in a polished analytical tone suitable for a public product.",
                "Avoid slang, overly casual phrasing, and database-style enumeration.",
                "Add compact internal refs such as [P1/E1] after evidence-backed claims.",
                "Use exact ASCII ref syntax with no spaces inside brackets, for example [P1/E1] or [P1/E1,E2].",
                "The application will hide those refs from users or convert them into evidence popovers.",
                "Do not expose raw source_evidence_id values unless the user asks for audit details.",
                f"Answer in {output_language}.",
            ]
        )

    def _render_prompt(
        self,
        movie_key: str,
        question: str,
        evidence: list[EvidenceDocument],
    ) -> str:
        movie_title = _first_nonempty(
            item.metadata.get("movie_title") for item in evidence
        )
        lines = [
            f"Movie key: {movie_key}",
            f"Movie title: {movie_title or 'unknown'}",
            f"Question: {question}",
            "",
            "Audience:",
            "- The answer is for a public-facing movie review product.",
            "- The user wants a professional interpretation of the rating/viewpoint split.",
            "- The UI will convert compact refs such as [P1/E1] into evidence popovers.",
            "",
            "Answer style:",
            "1. Start with a concise thesis about the disagreement.",
            "2. Then give 3 short analytical paragraphs. Do not use Markdown bullet lists.",
            "3. Distinguish strong viewpoint disagreement from cases where the rating gap is stronger than the actual argument gap.",
            "4. Keep the tone measured, professional, and evidence-based.",
            "5. Add compact refs like [P1/E1] or [P1/E1,E2] after concrete evidence-backed claims.",
            "6. Use exact ASCII ref syntax with no spaces inside brackets, and only use refs from the evidence list.",
            "7. Never invent refs and never output raw source_evidence_id values.",
            "8. Do not use outside knowledge.",
            "9. Avoid list markers such as '-', '*', or numbered outlines; the UI will handle visual structure.",
            "",
            f"Evidence count: {len(evidence)}",
            f"Pair count: {len({item.pair_id for item in evidence if item.pair_id})}",
            "",
            "Evidence:",
        ]
        if not evidence:
            lines.append("No evidence documents were found for this movie_key.")
            return "\n".join(lines)

        current_pair = object()
        pair_labels: dict[str, str] = {}
        for index, item in enumerate(evidence, start=1):
            pair_id = item.pair_id or "unknown_pair"
            pair_label = pair_labels.setdefault(pair_id, f"P{len(pair_labels) + 1}")
            evidence_label = f"E{index}"
            meta = item.metadata
            if pair_id != current_pair:
                current_pair = pair_id
                lines.extend(
                    [
                        "",
                        f"Pair {pair_label}:",
                        f"  topic_similarity: {meta.get('topic_similarity', '')}",
                        f"  rating_gap: {meta.get('rating_gap', '')}",
                        f"  divergence_score: {meta.get('divergence_score', '')}",
                    ]
                )
            lines.extend(
                [
                    f"- internal_ref: {pair_label}/{evidence_label}",
                    f"  platform: {meta.get('platform', '')}",
                    f"  rating: {meta.get('rating', '')}",
                    "  full_review:",
                    _indent(item.text, "    "),
                ]
            )
        return "\n".join(lines)


def _resolve_persist_directory(manifest_path: Path, raw_value: Any) -> Path | None:
    if raw_value in (None, ""):
        return None
    path = Path(str(raw_value))
    if path.is_absolute():
        return path
    if manifest_path.parent.name == path.name:
        return manifest_path.parent
    candidate = manifest_path.parent / path
    if candidate.exists():
        return candidate
    chroma_candidate = manifest_path.parent / "chroma"
    if chroma_candidate.exists():
        return chroma_candidate
    return path


def _evidence_sort_key(item: EvidenceDocument) -> tuple[Any, ...]:
    platform_order = {"imdb": 0, "douban": 1}
    return (
        -item.divergence_score,
        item.metadata.get("rank_within_movie", 10_000),
        item.pair_id,
        platform_order.get(item.platform, 99),
        item.evidence_id,
    )


def _as_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _first_nonempty(values: Any) -> str:
    for value in values:
        if value not in (None, ""):
            return str(value)
    return ""


def _indent(text: str, prefix: str) -> str:
    if not text:
        return prefix
    return "\n".join(prefix + line for line in text.splitlines())


__all__ = [
    "AgentCoreConfig",
    "DEFAULT_QUESTION",
    "EvidenceDocument",
    "MovieEvidencePrompt",
    "MovieEvidencePromptCore",
    "config_from_manifest",
    "load_chroma_manifest",
]
