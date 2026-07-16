from __future__ import annotations

import csv
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MOVIES_CSV = PROJECT_ROOT / "selected_movies.csv"
MovieSort = Literal["gap_desc", "gap_asc", "votes_desc", "year_desc"]


class MovieListItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    movie_key: str
    title: str
    year: int | None = None
    region: str | None = None
    imdb_id: str
    imdb_url: str | None = None
    douban_url: str | None = None
    imdb_rating: float | None = None
    imdb_votes: int | None = None
    douban_rating: float | None = None
    douban_votes: int | None = None
    gap: float | None = None


@lru_cache(maxsize=1)
def load_movies(path: Path = DEFAULT_MOVIES_CSV) -> list[MovieListItem]:
    if not path.exists():
        return []

    items: list[MovieListItem] = []
    with path.open(encoding="utf-8-sig", newline="") as file_obj:
        for row in csv.DictReader(file_obj):
            imdb_id = _clean_str(row.get("imdb_id") or row.get("titleId"))
            douban_id = _as_int(row.get("douban_id"))
            if not imdb_id or douban_id is None:
                continue
            items.append(
                MovieListItem(
                    movie_key=f"{imdb_id}_{douban_id}",
                    title=_clean_str(row.get("label") or row.get("original_title"))
                    or "Untitled",
                    year=_as_int(row.get("year")),
                    region=_clean_str(row.get("region")),
                    imdb_id=imdb_id,
                    imdb_url=_clean_str(row.get("imdb_url")),
                    douban_url=_clean_str(
                        row.get("douban_url_x") or row.get("douban_url_y")
                    ),
                    imdb_rating=_as_float(row.get("imdb_rating")),
                    imdb_votes=_as_int(row.get("imdb_votes")),
                    douban_rating=_as_float(row.get("douban_rating")),
                    douban_votes=_as_int(row.get("douban_votes")),
                    gap=_as_float(row.get("gap")),
                )
            )
    return items


def query_movies(
    *,
    page: int,
    page_size: int,
    query: str,
    sort: MovieSort,
) -> tuple[list[MovieListItem], int]:
    rows = load_movies()
    normalized_query = query.strip().lower()
    if normalized_query:
        rows = [
            item
            for item in rows
            if normalized_query in item.title.lower()
            or normalized_query in item.imdb_id.lower()
            or normalized_query in item.movie_key.lower()
        ]

    rows = _sort_movies(rows, sort)
    start = (page - 1) * page_size
    return rows[start : start + page_size], len(rows)


def has_movie(movie_key: str) -> bool:
    return any(item.movie_key == movie_key for item in load_movies())


def _sort_movies(
    rows: list[MovieListItem],
    sort: MovieSort,
) -> list[MovieListItem]:
    if sort == "gap_asc":
        return sorted(
            rows,
            key=lambda item: (item.gap is None, abs(item.gap or 0.0)),
        )
    if sort == "votes_desc":
        return sorted(
            rows,
            key=lambda item: -((item.imdb_votes or 0) + (item.douban_votes or 0)),
        )
    if sort == "year_desc":
        return sorted(rows, key=lambda item: -(item.year or 0))
    return sorted(
        rows,
        key=lambda item: (item.gap is None, -abs(item.gap or 0.0)),
    )


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
