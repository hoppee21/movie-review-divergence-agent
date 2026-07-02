from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.agent import DEFAULT_QUESTION, MovieEvidencePromptCore
from app.chat import (
    AnswerSegment,
    ConversationNotFoundError,
    ConversationPolicyError,
    EvidenceReference,
    LangChainOpenAIChatClient,
    MovieConversationService,
)
from app.movies import MovieListItem, MovieSort, has_movie, query_movies
from app.posters import fetch_imdb_poster_url


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = (
    PROJECT_ROOT
    / "divergence_evidence_artifacts"
    / "chroma_divergence_evidence_manifest.json"
)


class MovieListResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    page: int
    page_size: int
    total: int
    items: list[MovieListItem]


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    language: Literal["zh", "en"] = "zh"


class AnalysisResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    language: Literal["zh", "en"]
    evidence_count: int
    pair_count: int
    remaining_questions: int
    suggested_questions: list[str]
    segments: list[AnswerSegment]
    evidence_refs: list[EvidenceReference]


class FollowUpRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=200)
    focus_refs: list[str] = Field(default_factory=list, max_length=4)


class FollowUpResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str
    remaining_questions: int
    segments: list[AnswerSegment]


@lru_cache(maxsize=2)
def get_core(language: Literal["zh", "en"] = "zh") -> MovieEvidencePromptCore:
    return MovieEvidencePromptCore.from_manifest(
        DEFAULT_MANIFEST,
        config_overrides={"language": language},
    )


def _build_chat_client() -> LangChainOpenAIChatClient:
    return LangChainOpenAIChatClient.from_local_settings()


conversation_service = MovieConversationService(
    core_factory=get_core,
    client_factory=_build_chat_client,
)


def create_app() -> Any:
    try:
        from fastapi import FastAPI, HTTPException, Query
        from fastapi.middleware.cors import CORSMiddleware
    except ImportError as exc:
        raise RuntimeError("Install `fastapi` to run the API server.") from exc

    api = FastAPI(title="Movie Evidence Agent API")
    api.add_middleware(
        CORSMiddleware,
        allow_origins=[
            "http://localhost:5173",
            "http://127.0.0.1:5173",
        ],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @api.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @api.get("/movies", response_model=MovieListResponse)
    def movies(
        page: int = Query(1, ge=1),
        page_size: int = Query(24, ge=1, le=100),
        q: str = "",
        sort: MovieSort = "gap_desc",
    ) -> MovieListResponse:
        items, total = query_movies(
            page=page,
            page_size=page_size,
            query=q,
            sort=sort,
        )
        return MovieListResponse(
            page=page,
            page_size=page_size,
            total=total,
            items=items,
        )

    @api.get("/movie/{imdb_id}/poster")
    def poster(imdb_id: str) -> dict[str, str | None]:
        return {"url": fetch_imdb_poster_url(imdb_id)}

    @api.post("/movie/{movie_key}/analysis", response_model=AnalysisResponse)
    def analyze_movie(movie_key: str, request: AnalysisRequest) -> AnalysisResponse:
        if not has_movie(movie_key):
            raise HTTPException(status_code=404, detail="Movie not found")
        try:
            result = conversation_service.create_analysis(
                movie_key=movie_key,
                language=request.language,
                question=DEFAULT_QUESTION,
            )
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        return AnalysisResponse(
            session_id=result.session_id,
            language=result.language,
            evidence_count=result.evidence_count,
            pair_count=result.pair_count,
            remaining_questions=result.remaining_questions,
            suggested_questions=result.suggested_questions,
            segments=result.segments,
            evidence_refs=result.evidence_refs,
        )

    @api.post("/analysis/{session_id}/messages", response_model=FollowUpResponse)
    def ask_analysis(session_id: str, request: FollowUpRequest) -> FollowUpResponse:
        try:
            result = conversation_service.ask(
                session_id=session_id,
                question=request.question,
                focus_refs=request.focus_refs,
            )
        except ConversationNotFoundError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ConversationPolicyError as exc:
            raise HTTPException(
                status_code=409,
                detail={"code": exc.code, "message": str(exc)},
            ) from exc

        return FollowUpResponse(
            question=result.question,
            remaining_questions=result.remaining_questions,
            segments=result.segments,
        )

    @api.delete("/analysis/{session_id}", status_code=204)
    def delete_analysis(session_id: str) -> None:
        conversation_service.delete(session_id)

    return api


app = create_app()
