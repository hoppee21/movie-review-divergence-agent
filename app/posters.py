from __future__ import annotations

import html as html_lib
import json
import re
import urllib.error
import urllib.request
from functools import lru_cache
from html.parser import HTMLParser
from typing import Any


IMDB_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


@lru_cache(maxsize=4096)
def fetch_imdb_poster_url(imdb_id: str) -> str | None:
    normalized_id = imdb_id.strip()
    if not re.fullmatch(r"tt\d+", normalized_id):
        return None

    suggestion_url = (
        f"https://v2.sg.media-imdb.com/suggestion/"
        f"{normalized_id[0]}/{normalized_id}.json"
    )
    suggestion_text = _fetch_url_text(suggestion_url)
    if suggestion_text:
        poster_url = extract_suggestion_poster_url(suggestion_text, normalized_id)
        if poster_url:
            return poster_url

    title_html = _fetch_url_text(f"https://www.imdb.com/title/{normalized_id}/")
    return extract_poster_url(title_html) if title_html else None


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


def extract_poster_url(html_text: str) -> str | None:
    parser = _PosterHTMLParser()
    try:
        parser.feed(html_text)
    except Exception:
        parser.poster_url = None
    return parser.poster_url or _extract_json_ld_image(html_text)


def extract_suggestion_poster_url(json_text: str, imdb_id: str) -> str | None:
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
