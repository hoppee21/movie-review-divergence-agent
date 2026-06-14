from __future__ import annotations

import csv
import html as html_lib
import json
import re
import urllib.error
import urllib.request
from functools import lru_cache
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.agent import DEFAULT_QUESTION, MovieEvidencePromptCore
from app.chat import (
    ConversationNotFoundError,
    ConversationPolicyError,
    LangChainOpenAIChatClient,
    MovieConversationService,
)


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MOVIES_CSV = PROJECT_ROOT / "selected_movies.csv"
DEFAULT_MANIFEST = PROJECT_ROOT / "divergence_evidence_artifacts" / "chroma_divergence_evidence_manifest.json"
IMDB_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


class MovieListItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    movie_key: str
    title: str
    year: int | None = None
    region: str | None = None
    imdb_id: str | None = None
    douban_id: int | None = None
    imdb_url: str | None = None
    douban_url: str | None = None
    imdb_rating: float | None = None
    imdb_votes: int | None = None
    douban_rating: float | None = None
    douban_votes: int | None = None
    gap: float | None = None
    score: float | None = None
    reliability: float | None = None


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
    movie_key: str
    movie_title: str
    language: Literal["zh", "en"]
    evidence_count: int
    pair_count: int
    remaining_questions: int
    suggested_questions: list[str]
    answer: str
    raw_answer: str
    segments: list[dict[str, Any]]
    evidence_refs: list[dict[str, Any]]


class FollowUpRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    question: str = Field(min_length=1, max_length=200)
    focus_refs: list[str] = Field(default_factory=list, max_length=4)


class FollowUpResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    session_id: str
    question: str
    focus_refs: list[str]
    remaining_questions: int
    answer: str
    raw_answer: str
    segments: list[dict[str, Any]]


@lru_cache(maxsize=1)
def load_movies() -> list[MovieListItem]:
    if not DEFAULT_MOVIES_CSV.exists():
        return []

    items: list[MovieListItem] = []
    with DEFAULT_MOVIES_CSV.open(encoding="utf-8-sig", newline="") as file_obj:
        for row in csv.DictReader(file_obj):
            imdb_id = _clean_str(row.get("imdb_id") or row.get("titleId"))
            douban_id = _as_int(row.get("douban_id"))
            if not imdb_id or douban_id is None:
                continue
            imdb_rating = _as_float(row.get("imdb_rating"))
            douban_rating = _as_float(row.get("douban_rating"))
            gap = _as_float(row.get("gap"))
            score = abs(gap) * 25 if gap is not None else None
            items.append(
                MovieListItem(
                    movie_key=f"{imdb_id}_{douban_id}",
                    title=_clean_str(row.get("label") or row.get("original_title")) or "Untitled",
                    year=_as_int(row.get("year")),
                    region=_clean_str(row.get("region")),
                    imdb_id=imdb_id,
                    douban_id=douban_id,
                    imdb_url=_clean_str(row.get("imdb_url")),
                    douban_url=_clean_str(row.get("douban_url_x") or row.get("douban_url_y")),
                    imdb_rating=imdb_rating,
                    imdb_votes=_as_int(row.get("imdb_votes")),
                    douban_rating=douban_rating,
                    douban_votes=_as_int(row.get("douban_votes")),
                    gap=gap,
                    score=min(score, 100.0) if score is not None else None,
                    reliability=_estimate_reliability(row),
                )
            )
    return items


@lru_cache(maxsize=2)
def get_core(language: Literal["zh", "en"] = "zh") -> MovieEvidencePromptCore:
    return MovieEvidencePromptCore.from_manifest(
        DEFAULT_MANIFEST,
        config_overrides={"language": language},
    )


def _build_chat_client(model: str | None, temperature: float) -> LangChainOpenAIChatClient:
    return LangChainOpenAIChatClient.from_local_settings(
        model=model,
        temperature=temperature,
    )


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
        sort: str = "score_desc",
        min_reliability: float = Query(0.0, ge=0.0, le=1.0),
    ) -> MovieListResponse:
        rows = load_movies()
        query = q.strip().lower()
        if query:
            rows = [
                item
                for item in rows
                if query in item.title.lower()
                or (item.imdb_id and query in item.imdb_id.lower())
                or (item.movie_key and query in item.movie_key.lower())
            ]
        if min_reliability > 0:
            rows = [item for item in rows if (item.reliability or 0.0) >= min_reliability]

        rows = _sort_movies(rows, sort)
        total = len(rows)
        start = (page - 1) * page_size
        end = start + page_size
        return MovieListResponse(
            page=page,
            page_size=page_size,
            total=total,
            items=rows[start:end],
        )

    @api.get("/movie/{imdb_id}/poster")
    def poster(imdb_id: str) -> dict[str, str | None]:
        return {"url": _fetch_imdb_poster_url(imdb_id)}

    @api.post("/movie/{movie_key}/analysis", response_model=AnalysisResponse)
    def analyze_movie(movie_key: str, request: AnalysisRequest) -> AnalysisResponse:
        if not any(item.movie_key == movie_key for item in load_movies()):
            raise HTTPException(status_code=404, detail="Movie not found")

        try:
            result = conversation_service.create_analysis(
                movie_key=movie_key,
                language=request.language,
                question=DEFAULT_QUESTION,
            )
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        reply = result.reply
        return AnalysisResponse(
            session_id=result.session_id,
            movie_key=reply.state.movie_key,
            movie_title=reply.state.movie_title,
            language=request.language,
            evidence_count=reply.state.evidence_count,
            pair_count=reply.state.pair_count,
            remaining_questions=result.remaining_questions,
            suggested_questions=result.suggested_questions,
            answer=reply.assistant_message.content,
            raw_answer=reply.raw_assistant_message.content if reply.raw_assistant_message else "",
            segments=[segment.model_dump() for segment in reply.segments],
            evidence_refs=[ref.model_dump() for ref in reply.state.evidence_refs],
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
            session_id=result.session_id,
            question=result.turn.question,
            focus_refs=result.turn.focus_refs,
            remaining_questions=result.remaining_questions,
            answer=result.turn.answer,
            raw_answer=result.turn.raw_answer,
            segments=[segment.model_dump() for segment in result.turn.segments],
        )

    @api.delete("/analysis/{session_id}", status_code=204)
    def delete_analysis(session_id: str) -> None:
        conversation_service.delete(session_id)

    return api


def _sort_movies(rows: list[MovieListItem], sort: str) -> list[MovieListItem]:
    if sort == "score_asc":
        return sorted(rows, key=lambda item: _none_last(item.score))
    if sort == "reliability_desc":
        return sorted(rows, key=lambda item: item.reliability or 0.0, reverse=True)
    if sort == "votes_desc":
        return sorted(rows, key=lambda item: (item.imdb_votes or 0) + (item.douban_votes or 0), reverse=True)
    if sort == "year_desc":
        return sorted(rows, key=lambda item: item.year or 0, reverse=True)
    return sorted(rows, key=lambda item: item.score or 0.0, reverse=True)


def _none_last(value: float | None) -> tuple[int, float]:
    if value is None:
        return (1, 0.0)
    return (0, value)


def _estimate_reliability(row: dict[str, Any]) -> float | None:
    imdb_votes = _as_int(row.get("imdb_votes")) or 0
    douban_votes = _as_int(row.get("douban_votes")) or 0
    vote_score = min((imdb_votes + douban_votes) / 50_000, 1.0)
    return round(0.55 + vote_score * 0.4, 3)


@lru_cache(maxsize=4096)
def _fetch_imdb_poster_url(imdb_id: str) -> str | None:
    normalized_id = imdb_id.strip()
    if not re.fullmatch(r"tt\d+", normalized_id):
        return None

    suggestion_url = f"https://v2.sg.media-imdb.com/suggestion/{normalized_id[0]}/{normalized_id}.json"
    suggestion_text = _fetch_url_text(suggestion_url)
    if suggestion_text:
        poster_url = _extract_suggestion_poster_url(suggestion_text, normalized_id)
        if poster_url:
            return poster_url

    title_html = _fetch_url_text(f"https://www.imdb.com/title/{normalized_id}/")
    if not title_html:
        return None

    return _extract_poster_url(title_html)


def _fetch_url_text(url: str) -> str | None:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "User-Agent": IMDB_USER_AGENT,
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=8) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return response.read().decode(charset, errors="replace")
    except (OSError, urllib.error.URLError, TimeoutError):
        return None


def _extract_poster_url(html_text: str) -> str | None:
    parser = _PosterHTMLParser()
    try:
        parser.feed(html_text)
    except Exception:
        parser.poster_url = None
    if parser.poster_url:
        return parser.poster_url

    return _extract_json_ld_image(html_text)


def _extract_suggestion_poster_url(json_text: str, imdb_id: str) -> str | None:
    try:
        payload = json.loads(json_text)
    except json.JSONDecodeError:
        return None

    candidates = payload.get("d")
    if not isinstance(candidates, list):
        return None

    for candidate in candidates:
        if isinstance(candidate, dict) and candidate.get("id") == imdb_id:
            return _image_from_json_ld(candidate.get("i"))
    return None


class _PosterHTMLParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.poster_url: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.poster_url or tag.lower() != "meta":
            return

        attr_map = {name.lower(): value for name, value in attrs if name and value}
        meta_key = (attr_map.get("property") or attr_map.get("name") or "").lower()
        if meta_key != "og:image":
            return

        url = _clean_str(attr_map.get("content"))
        if _is_http_url(url):
            self.poster_url = html_lib.unescape(url)


def _extract_json_ld_image(html_text: str) -> str | None:
    script_pattern = re.compile(
        r"<script\b[^>]*type=[\"']application/ld\+json[\"'][^>]*>(.*?)</script>",
        re.IGNORECASE | re.DOTALL,
    )
    for match in script_pattern.finditer(html_text):
        raw_json = html_lib.unescape(match.group(1)).strip()
        if not raw_json:
            continue
        try:
            payload = json.loads(raw_json)
        except json.JSONDecodeError:
            continue
        image_url = _image_from_json_ld(payload)
        if image_url:
            return image_url
    return None


def _image_from_json_ld(value: Any) -> str | None:
    if isinstance(value, str):
        return value if _is_http_url(value) else None
    if isinstance(value, list):
        for item in value:
            image_url = _image_from_json_ld(item)
            if image_url:
                return image_url
        return None
    if not isinstance(value, dict):
        return None

    direct_image_url = _image_from_json_ld(value.get("imageUrl"))
    if direct_image_url:
        return direct_image_url

    image = value.get("image")
    if isinstance(image, dict):
        image_url = _image_from_json_ld(image.get("url") or image.get("contentUrl"))
        if image_url:
            return image_url
    image_url = _image_from_json_ld(image)
    if image_url:
        return image_url
    return _image_from_json_ld(value.get("thumbnailUrl"))


def _is_http_url(value: str | None) -> bool:
    return bool(value and re.match(r"^https?://", value))


def _clean_str(value: Any) -> str | None:
    if value in (None, ""):
        return None
    text = str(value).strip()
    return text or None


def _as_int(value: Any) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(float(str(value)))
    except ValueError:
        return None


def _as_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    try:
        return float(str(value))
    except ValueError:
        return None


app = create_app()
