from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Protocol, Sequence

from app.chat.models import ChatMessage


DEFAULT_CONFIG_PATH = Path("config/openai.yml")


class ChatClient(Protocol):
    def complete(self, messages: Sequence[ChatMessage]) -> ChatMessage:
        """Return one assistant message for the provided history."""


class LangChainOpenAIChatClient:
    """LangChain/OpenAI adapter behind the small ChatClient protocol."""

    def __init__(
        self,
        *,
        api_key: str,
        model: str,
    ) -> None:
        try:
            from langchain_openai import ChatOpenAI
        except ImportError as exc:
            raise RuntimeError("Install `langchain-openai` to use OpenAI chat.") from exc

        self._llm = ChatOpenAI(
            model=model,
            api_key=api_key,
            temperature=0.0,
        )

    @classmethod
    def from_local_settings(
        cls,
        *,
        config_path: str | Path = DEFAULT_CONFIG_PATH,
    ) -> "LangChainOpenAIChatClient":
        settings = load_openai_settings(config_path)
        api_key = settings.get("api_key")
        model = settings.get("model")
        if not api_key:
            raise RuntimeError("OpenAI API key is not set.")
        if not model:
            raise RuntimeError("OpenAI model is not set.")
        return cls(api_key=api_key, model=model)

    def complete(self, messages: Sequence[ChatMessage]) -> ChatMessage:
        response = self._llm.invoke([_to_langchain_message(message) for message in messages])
        return ChatMessage(role="assistant", content=_message_content(response))


def load_openai_settings(config_path: str | Path = DEFAULT_CONFIG_PATH) -> dict[str, str | None]:
    config = _load_yaml_mapping(Path(config_path))
    openai_config = config.get("openai", {})
    if not isinstance(openai_config, dict):
        raise RuntimeError(f"`openai` config section must be a mapping: {config_path}")

    api_key = os.getenv("OPENAI_API_KEY") or _clean_string(openai_config.get("api_key"))
    model = os.getenv("OPENAI_MODEL") or _clean_string(openai_config.get("model"))
    return {"api_key": api_key, "model": model}


def _load_yaml_mapping(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        import yaml
    except ImportError as exc:
        raise RuntimeError("Install `PyYAML` to read local YAML config.") from exc

    payload = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    if not isinstance(payload, dict):
        raise RuntimeError(f"OpenAI config must be a mapping: {path}")
    return payload


def _clean_string(value: Any) -> str | None:
    if value in (None, ""):
        return None
    text = str(value)
    if text == "replace-with-your-openai-api-key":
        return None
    return text


def _to_langchain_message(message: ChatMessage) -> Any:
    from langchain_core.messages import AIMessage, HumanMessage, SystemMessage

    if message.role == "system":
        return SystemMessage(content=message.content)
    if message.role == "assistant":
        return AIMessage(content=message.content)
    return HumanMessage(content=message.content)


def _message_content(message: Any) -> str:
    if isinstance(message, dict):
        return str(message.get("content", ""))
    return str(getattr(message, "content", message))
