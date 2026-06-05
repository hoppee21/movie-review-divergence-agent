"""Movie evidence prompt core backed by notebook-generated Chroma data."""

from app.agent.core import (
    AgentCoreConfig,
    DEFAULT_QUESTION,
    EvidenceDocument,
    MovieEvidencePrompt,
    MovieEvidencePromptCore,
    config_from_manifest,
    load_chroma_manifest,
)

__all__ = [
    "AgentCoreConfig",
    "DEFAULT_QUESTION",
    "EvidenceDocument",
    "MovieEvidencePrompt",
    "MovieEvidencePromptCore",
    "config_from_manifest",
    "load_chroma_manifest",
]
