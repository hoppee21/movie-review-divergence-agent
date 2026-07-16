export type AnalysisLanguage = "zh" | "en";
export type MovieSort = "gap_desc" | "gap_asc" | "votes_desc" | "year_desc";

export type Movie = {
  movie_key: string;
  title: string;
  year: number | null;
  region: string | null;
  imdb_id: string;
  imdb_url: string | null;
  douban_url: string | null;
  imdb_rating: number | null;
  imdb_votes: number | null;
  douban_rating: number | null;
  douban_votes: number | null;
  gap: number | null;
};

export type EvidenceRef = {
  citation: string;
  platform: string;
  rating: number | null;
  text: string;
};

export type AnswerSegment = {
  text: string;
  citations: string[];
};

export type AnalysisResponse = {
  session_id: string;
  language: AnalysisLanguage;
  evidence_count: number;
  pair_count: number;
  remaining_questions: number;
  suggested_questions: string[];
  segments: AnswerSegment[];
  evidence_refs: EvidenceRef[];
};

export type FollowUpResponse = {
  question: string;
  remaining_questions: number;
  segments: AnswerSegment[];
};

export type AnalysisSession = {
  analysis: AnalysisResponse;
  followUps: FollowUpResponse[];
};

type MovieListResponse = {
  page: number;
  total: number;
  items: Movie[];
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, init);
  if (response.ok) return response.json() as Promise<T>;

  const payload = await response.json().catch(() => null);
  const detail = payload?.detail;
  const message =
    typeof detail === "string"
      ? detail
      : typeof detail?.message === "string"
        ? detail.message
        : `Request failed (${response.status})`;
  throw new Error(message);
}

export function listMovies({
  page,
  pageSize,
  query,
  sort,
  signal,
}: {
  page: number;
  pageSize: number;
  query: string;
  sort: MovieSort;
  signal: AbortSignal;
}) {
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
    sort,
  });
  if (query.trim()) params.set("q", query.trim());
  return requestJson<MovieListResponse>(`/movies?${params}`, { signal });
}

export async function getPoster(imdbId: string, signal: AbortSignal) {
  const payload = await requestJson<{ url: string | null }>(
    `/movie/${imdbId}/poster`,
    { signal },
  );
  return payload.url;
}

export function createAnalysis(
  movieKey: string,
  language: AnalysisLanguage,
  signal: AbortSignal,
) {
  return requestJson<AnalysisResponse>(`/movie/${movieKey}/analysis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ language }),
  });
}

export function askFollowUp(
  sessionId: string,
  question: string,
  focusRefs: string[],
  signal: AbortSignal,
) {
  return requestJson<FollowUpResponse>(`/analysis/${sessionId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ question, focus_refs: focusRefs }),
  });
}

export async function deleteAnalysis(sessionId: string) {
  await fetch(`${API_BASE}/analysis/${sessionId}`, {
    method: "DELETE",
    keepalive: true,
  });
}
