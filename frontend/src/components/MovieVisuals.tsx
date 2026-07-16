import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { getPoster } from "../api";
import type { Movie } from "../api";


const posterCache = new Map<string, string | null>();
const gradientCache = new Map<string, string>();


function usePoster(imdbId: string) {
  const [posterUrl, setPosterUrl] = useState<string | null>(
    posterCache.get(imdbId) ?? null,
  );

  useEffect(() => {
    if (posterCache.has(imdbId)) {
      setPosterUrl(posterCache.get(imdbId) ?? null);
      return;
    }

    const controller = new AbortController();
    getPoster(imdbId, controller.signal)
      .then((url) => {
        posterCache.set(imdbId, url);
        setPosterUrl(url);
      })
      .catch((error) => {
        if (error?.name !== "AbortError") {
          console.error("Poster fetch failed", error);
        }
      });
    return () => controller.abort();
  }, [imdbId]);

  return posterUrl;
}


function movieGradient(title: string) {
  const cached = gradientCache.get(title);
  if (cached) return cached;

  let hash = 0;
  for (const character of title) {
    hash = character.charCodeAt(0) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  const gradient = `linear-gradient(135deg, hsl(${hue}, 58%, 38%), hsl(${(hue + 46) % 360}, 45%, 22%))`;
  gradientCache.set(title, gradient);
  return gradient;
}


export function formatVotes(value: number | null) {
  return value === null ? "N/A" : value.toLocaleString();
}


export function RatingBar({
  label,
  score,
  colorClass,
}: {
  label: string;
  score: number | null;
  colorClass: string;
}) {
  if (score === null) return null;
  const percentage = Math.max(0, Math.min(100, score * 10));
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-12 font-semibold text-neutral-400">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded bg-neutral-800">
        <div className={`h-full ${colorClass}`} style={{ width: `${percentage}%` }} />
      </div>
      <span className="w-8 text-right font-mono text-neutral-200">
        {score.toFixed(1)}
      </span>
    </div>
  );
}


export function PosterFrame({
  movie,
  className,
  titleClassName,
  contain = false,
  children,
}: {
  movie: Movie;
  className: string;
  titleClassName?: string;
  contain?: boolean;
  children?: ReactNode;
}) {
  const posterUrl = usePoster(movie.imdb_id);
  return (
    <div className={`relative overflow-hidden bg-neutral-950 ${className}`}>
      {posterUrl ? (
        <img
          src={posterUrl}
          alt={movie.title}
          loading="lazy"
          className={`h-full w-full ${contain ? "object-contain" : "object-cover"}`}
        />
      ) : (
        <div
          className="flex h-full w-full items-center justify-center px-6 text-center"
          style={{ background: movieGradient(movie.title) }}
        >
          <span className={titleClassName ?? "text-xl font-bold text-white/70"}>
            {movie.title}
          </span>
        </div>
      )}
      {children}
    </div>
  );
}


export function MovieCard({
  movie,
  onClick,
}: {
  movie: Movie;
  onClick: (movie: Movie) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onClick(movie)}
      className="group flex h-full flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 text-left shadow-lg transition-transform hover:-translate-y-0.5 hover:border-neutral-700"
    >
      <PosterFrame
        movie={movie}
        className="aspect-[2/3] w-full"
        titleClassName="text-lg font-bold leading-tight text-white/70"
      >
        <div className="absolute inset-0 bg-linear-to-t from-neutral-950 via-neutral-950/35 to-transparent" />
        <div className="absolute bottom-3 left-3 right-3 z-10">
          <h3 className="line-clamp-3 text-xl font-bold leading-tight text-white group-hover:text-amber-100">
            {movie.title}
          </h3>
        </div>
      </PosterFrame>
      <div className="flex flex-1 flex-col gap-4 p-4">
        <div className="flex items-center justify-between text-xs text-neutral-500">
          <span>{movie.year ?? "N/A"}</span>
          {movie.gap !== null && (
            <span className="font-mono">Gap {Math.abs(movie.gap).toFixed(1)}</span>
          )}
        </div>
        <div className="mt-auto space-y-2">
          <RatingBar label="IMDb" score={movie.imdb_rating} colorClass="bg-amber-400" />
          <RatingBar
            label="Douban"
            score={movie.douban_rating}
            colorClass="bg-emerald-500"
          />
        </div>
      </div>
    </button>
  );
}
