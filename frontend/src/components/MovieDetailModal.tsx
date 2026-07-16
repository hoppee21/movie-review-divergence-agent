import { useEffect, useRef, useState } from "react";

import {
  askFollowUp,
  createAnalysis,
  deleteAnalysis,
} from "../api";
import type {
  AnalysisLanguage,
  AnalysisSession,
  Movie,
} from "../api";
import { AnalysisReport } from "./AnalysisReport";
import { formatVotes, PosterFrame, RatingBar } from "./MovieVisuals";


export function MovieDetailModal({
  movie,
  onClose,
}: {
  movie: Movie;
  onClose: () => void;
}) {
  const [language, setLanguage] = useState<AnalysisLanguage>("zh");
  const [sessionsByLanguage, setSessionsByLanguage] = useState<
    Partial<Record<AnalysisLanguage, AnalysisSession>>
  >({});
  const [question, setQuestion] = useState("");
  const [focusRefs, setFocusRefs] = useState<string[]>([]);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [loadingFollowUp, setLoadingFollowUp] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const analysisController = useRef<AbortController | null>(null);
  const followUpController = useRef<AbortController | null>(null);
  const session = sessionsByLanguage[language];

  useEffect(() => {
    setSessionsByLanguage({});
    setQuestion("");
    setFocusRefs([]);
    setAnalysisError(null);
    setFollowUpError(null);
    analysisController.current?.abort();
    followUpController.current?.abort();

    return () => {
      analysisController.current?.abort();
      followUpController.current?.abort();
    };
  }, [movie.movie_key]);

  async function generateAnalysis() {
    if (loadingAnalysis) return;
    analysisController.current?.abort();
    const controller = new AbortController();
    analysisController.current = controller;
    setLoadingAnalysis(true);
    setAnalysisError(null);
    try {
      const analysis = await createAnalysis(
        movie.movie_key,
        language,
        controller.signal,
      );
      setSessionsByLanguage((current) => ({
        ...current,
        [language]: { analysis, followUps: [] },
      }));
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        setAnalysisError(error.message);
      }
    } finally {
      if (analysisController.current === controller) {
        setLoadingAnalysis(false);
      }
    }
  }

  function changeLanguage(nextLanguage: AnalysisLanguage) {
    if (nextLanguage === language) return;
    analysisController.current?.abort();
    followUpController.current?.abort();
    setLanguage(nextLanguage);
    setQuestion("");
    setFocusRefs([]);
    setAnalysisError(null);
    setFollowUpError(null);
  }

  function focusEvidence(citations: string[]) {
    setFocusRefs([...new Set(citations)].slice(0, 4));
    setQuestion(
      language === "zh"
        ? "这组证据如何支持或削弱报告中的结论？"
        : "How does this evidence support or weaken the report's conclusion?",
    );
    setFollowUpError(null);
  }

  async function submitFollowUp() {
    const text = question.trim();
    const analysis = session?.analysis;
    if (
      !analysis ||
      !text ||
      loadingFollowUp ||
      analysis.remaining_questions <= 0
    ) {
      return;
    }

    followUpController.current?.abort();
    const controller = new AbortController();
    followUpController.current = controller;
    setLoadingFollowUp(true);
    setFollowUpError(null);
    try {
      const followUp = await askFollowUp(
        analysis.session_id,
        text,
        focusRefs,
        controller.signal,
      );
      setSessionsByLanguage((current) => {
        const active = current[language];
        if (!active) return current;
        return {
          ...current,
          [language]: {
            analysis: {
              ...active.analysis,
              remaining_questions: followUp.remaining_questions,
            },
            followUps: [...active.followUps, followUp],
          },
        };
      });
      setQuestion("");
      setFocusRefs([]);
    } catch (error) {
      if (error instanceof Error && error.name !== "AbortError") {
        setFollowUpError(error.message);
      }
    } finally {
      if (followUpController.current === controller) {
        setLoadingFollowUp(false);
      }
    }
  }

  function closeModal() {
    for (const item of Object.values(sessionsByLanguage)) {
      if (item) void deleteAnalysis(item.analysis.session_id);
    }
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 backdrop-blur-sm sm:p-4"
      onClick={closeModal}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="flex h-[calc(100vh-1rem)] w-full max-w-[min(96rem,calc(100vw-1rem))] flex-col overflow-hidden rounded-lg border border-neutral-800 bg-neutral-950 shadow-2xl sm:h-[calc(100vh-2rem)] md:flex-row"
      >
        <aside className="flex max-h-[45vh] w-full shrink-0 flex-col border-b border-neutral-800 bg-neutral-900 md:max-h-none md:w-[22rem] md:border-b-0 md:border-r lg:w-[24rem]">
          <PosterFrame
            movie={movie}
            contain
            className="h-64 shrink-0 md:h-80"
            titleClassName="text-xl font-bold text-white/70"
          >
            <div className="absolute inset-0 bg-linear-to-t from-neutral-950 via-neutral-950/30 to-transparent" />
            <div className="absolute bottom-4 left-4 right-4">
              <h2 className="text-2xl font-bold leading-tight text-white">
                {movie.title}
              </h2>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-neutral-300">
                <span className="rounded bg-neutral-800 px-2 py-1 font-mono">
                  {movie.year ?? "N/A"}
                </span>
                {movie.region && (
                  <span className="rounded bg-neutral-800 px-2 py-1 uppercase">
                    {movie.region}
                  </span>
                )}
              </div>
            </div>
          </PosterFrame>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 custom-scrollbar">
            <div className="space-y-3">
              <RatingBar
                label="IMDb"
                score={movie.imdb_rating}
                colorClass="bg-amber-400"
              />
              <RatingBar
                label="Douban"
                score={movie.douban_rating}
                colorClass="bg-emerald-500"
              />
              {movie.gap !== null && (
                <div className="flex justify-between border-t border-neutral-800 pt-3 text-xs">
                  <span className="text-neutral-500">Rating Gap</span>
                  <span className="font-mono font-semibold text-neutral-100">
                    {Math.abs(movie.gap).toFixed(2)}
                  </span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs text-neutral-400">
              <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
                <div>IMDb votes</div>
                <div className="mt-1 font-mono text-neutral-100">
                  {formatVotes(movie.imdb_votes)}
                </div>
              </div>
              <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
                <div>Douban votes</div>
                <div className="mt-1 font-mono text-neutral-100">
                  {formatVotes(movie.douban_votes)}
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              {movie.imdb_url && (
                <a
                  href={movie.imdb_url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 rounded border border-amber-400/40 px-3 py-2 text-center text-sm font-semibold text-amber-200 hover:bg-amber-400/10"
                >
                  IMDb
                </a>
              )}
              {movie.douban_url && (
                <a
                  href={movie.douban_url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1 rounded border border-emerald-400/40 px-3 py-2 text-center text-sm font-semibold text-emerald-200 hover:bg-emerald-400/10"
                >
                  Douban
                </a>
              )}
            </div>
          </div>
        </aside>

        <main className="flex min-h-0 flex-1 flex-col bg-neutral-950 p-5 md:p-7">
          <div className="mb-5 flex shrink-0 items-start justify-between gap-4">
            <div>
              <h3 className="text-xl font-semibold text-white">Evidence Analysis</h3>
              <p className="mt-1 text-sm text-neutral-500">
                IMDb/Douban disagreement report
              </p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <div className="inline-flex overflow-hidden rounded border border-neutral-800 bg-neutral-900 p-0.5">
                {(["zh", "en"] as const).map((option) => {
                  const active = language === option;
                  return (
                    <button
                      key={option}
                      type="button"
                      onClick={() => changeLanguage(option)}
                      disabled={loadingAnalysis}
                      aria-pressed={active}
                      className={`h-8 px-3 text-xs font-semibold transition-colors ${
                        active
                          ? "rounded bg-neutral-100 text-neutral-950"
                          : "text-neutral-400 hover:text-neutral-100"
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      {option === "zh" ? "中文" : "English"}
                    </button>
                  );
                })}
              </div>
              <button
                onClick={closeModal}
                className="rounded border border-neutral-800 px-3 py-2 text-sm text-neutral-400 hover:bg-neutral-900 hover:text-white"
                type="button"
              >
                Close
              </button>
            </div>
          </div>

          {!session && !loadingAnalysis && (
            <div className="mb-5 rounded-lg border border-neutral-800 bg-neutral-900 p-5">
              <div className="max-w-2xl text-sm leading-6 text-neutral-300">
                Generate a grounded {language === "zh" ? "Chinese" : "English"}{" "}
                report from the local Chroma evidence index.
              </div>
              <button
                type="button"
                onClick={() => void generateAnalysis()}
                className="mt-4 rounded bg-amber-400 px-4 py-2 text-sm font-semibold text-neutral-950 transition-colors hover:bg-amber-300"
              >
                Generate Analysis
              </button>
            </div>
          )}

          {analysisError && (
            <div className="mb-5 rounded-lg border border-red-500/40 bg-red-950/40 p-4 text-sm text-red-200">
              {analysisError}
            </div>
          )}

          {loadingAnalysis && (
            <div className="flex min-h-52 flex-1 items-center justify-center rounded-lg border border-neutral-800 bg-neutral-900 text-sm text-neutral-400">
              <div className="mr-3 h-5 w-5 animate-spin rounded-full border-2 border-amber-300 border-t-transparent" />
              Generating evidence report...
            </div>
          )}

          {session && !loadingAnalysis && (
            <AnalysisReport
              analysis={session.analysis}
              followUps={session.followUps}
              question={question}
              focusRefs={focusRefs}
              loadingFollowUp={loadingFollowUp}
              followUpError={followUpError}
              onQuestionChange={(value) => {
                setQuestion(value);
                setFollowUpError(null);
              }}
              onFocusEvidence={focusEvidence}
              onClearFocus={() => setFocusRefs([])}
              onSubmitQuestion={() => void submitFollowUp()}
            />
          )}
        </main>
      </div>
    </div>
  );
}
