import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { listMovies } from "./api";
import type { Movie, MovieSort } from "./api";
import { MovieDetailModal } from "./components/MovieDetailModal";
import { MovieCard } from "./components/MovieVisuals";


function useDebounce<T>(value: T, delay: number) {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedValue(value), delay);
    return () => window.clearTimeout(timeout);
  }, [value, delay]);
  return debouncedValue;
}


export default function App() {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<MovieSort>("gap_desc");
  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(null);
  const [movies, setMovies] = useState<Movie[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestController = useRef<AbortController | null>(null);
  const loadingRef = useRef(false);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const debouncedQuery = useDebounce(query, 500);
  const pageSize = 24;
  const hasMore = movies.length < total;

  const fetchPage = useCallback(
    async (nextPage: number, replace: boolean) => {
      if (!replace && loadingRef.current) return;

      requestController.current?.abort();
      const controller = new AbortController();
      requestController.current = controller;
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const response = await listMovies({
          page: nextPage,
          pageSize,
          query: debouncedQuery,
          sort,
          signal: controller.signal,
        });
        setTotal(response.total);
        setPage(response.page);
        setMovies((current) =>
          replace ? response.items : [...current, ...response.items],
        );
      } catch (fetchError) {
        if (fetchError instanceof Error && fetchError.name !== "AbortError") {
          setError(fetchError.message);
        }
      } finally {
        if (requestController.current === controller) {
          loadingRef.current = false;
          setLoading(false);
        }
      }
    },
    [debouncedQuery, sort],
  );

  useEffect(() => {
    setMovies([]);
    setPage(1);
    setTotal(0);
    void fetchPage(1, true);
  }, [fetchPage]);

  useEffect(() => () => requestController.current?.abort(), []);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !loadingRef.current && hasMore && !error) {
          void fetchPage(page + 1, false);
        }
      },
      { rootMargin: "360px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [error, fetchPage, hasMore, page]);

  const movieCount = useMemo(
    () => (total > 0 ? total.toLocaleString() : "..."),
    [total],
  );

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {selectedMovie && (
        <MovieDetailModal
          movie={selectedMovie}
          onClose={() => setSelectedMovie(null)}
        />
      )}

      <header className="border-b border-neutral-900 bg-neutral-950 px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-4xl font-bold tracking-tight text-white">
                Movie Evidence Agent
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-500">
                {movieCount} IMDb/Douban cross-platform movies
              </p>
            </div>
            <div className="grid w-full gap-3 sm:grid-cols-[1fr_12rem] lg:w-[34rem]">
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="h-11 rounded-lg border border-neutral-800 bg-neutral-900 px-4 text-sm text-white outline-none transition-colors placeholder:text-neutral-600 focus:border-amber-300/70"
                placeholder="Search movies..."
              />
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value as MovieSort)}
                className="h-11 rounded-lg border border-neutral-800 bg-neutral-900 px-3 text-sm text-neutral-200 outline-none focus:border-amber-300/70"
              >
                <option value="gap_desc">Largest Gap</option>
                <option value="gap_asc">Smallest Gap</option>
                <option value="votes_desc">Most Popular</option>
                <option value="year_desc">Newest</option>
              </select>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl p-4 sm:p-8">
        {error && (
          <div className="mb-6 rounded-lg border border-red-500/40 bg-red-950/40 p-4 text-sm text-red-200">
            {error}
          </div>
        )}

        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {movies.map((movie) => (
            <MovieCard
              key={movie.movie_key}
              movie={movie}
              onClick={setSelectedMovie}
            />
          ))}
        </div>

        <div
          ref={sentinelRef}
          className="flex items-center justify-center py-12"
        >
          {loading ? (
            <div className="flex items-center gap-3 text-sm text-neutral-500">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-amber-300 border-t-transparent" />
              Loading movies...
            </div>
          ) : !hasMore && movies.length > 0 ? (
            <div className="text-xs uppercase tracking-widest text-neutral-700">
              End of list
            </div>
          ) : movies.length === 0 && !error ? (
            <div className="text-neutral-500">No movies found.</div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
