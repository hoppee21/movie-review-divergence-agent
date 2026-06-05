from __future__ import annotations

import argparse
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.agent import DEFAULT_QUESTION, MovieEvidencePromptCore
from app.chat import LangChainOpenAIChatClient, MovieChatSession


DEFAULT_CONFIG = "config/openai.yml"
DEFAULT_MANIFEST = "divergence_evidence_artifacts/chroma_divergence_evidence_manifest.json"
EXIT_COMMANDS = {"exit", "quit", "q", ":q"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Start a grounded multi-turn chat for one movie_key."
    )
    parser.add_argument(
        "movie_key",
        help="Movie key to load from Chroma, for example tt0329200_1422925.",
    )
    parser.add_argument(
        "--manifest",
        default=DEFAULT_MANIFEST,
        help="Path to the notebook-generated Chroma evidence manifest.",
    )
    parser.add_argument(
        "--config",
        default=DEFAULT_CONFIG,
        help="Optional OpenAI YAML config path. Default: config/openai.yml.",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="OpenAI model name. Overrides OPENAI_MODEL and config/openai.model.",
    )
    parser.add_argument(
        "--question",
        default=DEFAULT_QUESTION,
        help="Initial question sent with the movie evidence prompt.",
    )
    parser.add_argument(
        "--temperature",
        type=float,
        default=0.0,
        help="LLM temperature. Default: 0.",
    )
    parser.add_argument(
        "--skip-initial-answer",
        action="store_true",
        help="Load evidence but wait for your first typed question before calling the LLM.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    core = MovieEvidencePromptCore.from_manifest(args.manifest)
    session = MovieChatSession.from_movie_key(
        core,
        args.movie_key,
        question=args.question,
    )
    client = LangChainOpenAIChatClient.from_local_settings(
        config_path=args.config,
        model=args.model,
        temperature=args.temperature,
    )

    _print_header(session, client.model)
    if not args.skip_initial_answer:
        reply = session.initial_answer(client)
        _print_assistant(reply.assistant_message.content)

    while True:
        try:
            user_text = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            print()
            return
        if not user_text:
            continue
        if user_text.lower() in EXIT_COMMANDS:
            return
        reply = session.ask(user_text, client)
        _print_assistant(reply.assistant_message.content)


def _print_header(session: MovieChatSession, model: str) -> None:
    print(f"Movie key: {session.movie_key}")
    print(f"Movie title: {session.movie_title}")
    print(f"Evidence documents: {session.evidence_count}")
    print(f"Evidence pairs: {session.pair_count}")
    print(f"Model: {model}")
    print("Type `exit`, `quit`, `q`, or `:q` to stop.")
    print()


def _print_assistant(text: str) -> None:
    print("Assistant:")
    print(text)
    print()


if __name__ == "__main__":
    main()
