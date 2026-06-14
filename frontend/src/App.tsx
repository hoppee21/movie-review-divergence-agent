import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

type Movie = {
  movie_key?: string | null;
  title: string;
  year: number | null;
  region: string | null;
  imdb_id: string | null;
  douban_id: number | null;
  imdb_url: string | null;
  douban_url: string | null;
  imdb_rating: number | null;
  imdb_votes: number | null;
  douban_rating: number | null;
  douban_votes: number | null;
  gap: number | null;
  score: number | null;
  reliability: number | null;
};

type ApiResp = {
  page: number;
  page_size: number;
  total: number;
  items: Movie[];
};

type EvidenceRef = {
  evidence_label: string;
  pair_label: string;
  citation: string;
  evidence_id: string;
  pair_id: string;
  platform: "imdb" | "douban" | string;
  rating: number | null;
  text: string;
};

type AnswerSegment = {
  text: string;
  citations: string[];
};

type AnalysisLanguage = "zh" | "en";

type AnalysisResp = {
  session_id: string;
  movie_key: string;
  movie_title: string;
  language: AnalysisLanguage;
  evidence_count: number;
  pair_count: number;
  remaining_questions: number;
  suggested_questions: string[];
  answer: string;
  raw_answer: string;
  segments: AnswerSegment[];
  evidence_refs: EvidenceRef[];
};

type FollowUpResp = {
  session_id: string;
  question: string;
  focus_refs: string[];
  remaining_questions: number;
  answer: string;
  raw_answer: string;
  segments: AnswerSegment[];
};

const API_BASE = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";
const posterCache = new Map<string, string | null>();

function usePoster(imdbId: string | null | undefined) {
  const [posterUrl, setPosterUrl] = useState<string | null>(() => {
    if (!imdbId || !posterCache.has(imdbId)) return null;
    return posterCache.get(imdbId) ?? null;
  });

  useEffect(() => {
    if (!imdbId) {
      setPosterUrl(null);
      return;
    }

    if (posterCache.has(imdbId)) {
      setPosterUrl(posterCache.get(imdbId) ?? null);
      return;
    }

    let active = true;
    const controller = new AbortController();
    fetch(`${API_BASE}/movie/${imdbId}/poster`, { signal: controller.signal })
      .then((res) => res.json())
      .then((data: { url?: string | null }) => {
        const url = typeof data.url === "string" && data.url.length > 0 ? data.url : null;
        posterCache.set(imdbId, url);
        if (active) setPosterUrl(url);
      })
      .catch((err) => {
        if (err?.name !== "AbortError") console.error("Poster fetch failed", err);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [imdbId]);

  return posterUrl;
}

function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState(value);
  useEffect(() => {
    const handler = setTimeout(() => setDebouncedValue(value), delay);
    return () => clearTimeout(handler);
  }, [value, delay]);
  return debouncedValue;
}

function getGradient(str: string) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash) % 360;
  return `linear-gradient(135deg, hsl(${hue}, 58%, 38%), hsl(${(hue + 46) % 360}, 45%, 22%))`;
}

const gradientCache = new Map<string, string>();
function getGradientCached(str: string) {
  const cached = gradientCache.get(str);
  if (cached) return cached;
  const gradient = getGradient(str);
  gradientCache.set(str, gradient);
  return gradient;
}

function formatVotes(value: number | null) {
  if (value === null) return "N/A";
  return value.toLocaleString();
}

function platformLabel(platform: string) {
  return platform.toLowerCase() === "douban" ? "Douban" : "IMDb";
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

type InlineToken =
  | { type: "text"; text: string }
  | { type: "citation"; citations: string[] };

type TextBlock =
  | { type: "paragraph"; tokens: InlineToken[] }
  | { type: "list"; items: InlineToken[][] };

const leadingPunctuationPattern = /^([。！？；：，、,.!?;:]+)/;
const bulletMarkerPattern = /^\s*(?:[-*•·]\s+|\d+[.)、]\s+)/;

function parseAnswerBlocks(text: string): TextBlock[] {
  return blocksFromLines(splitTokensIntoLines([{ type: "text", text }]));
}

function parseAnswerSegments(segments: AnswerSegment[], fallbackText: string): TextBlock[] {
  const tokens: InlineToken[] = [];
  for (const segment of segments) {
    let text = segment.text;
    const previous = tokens[tokens.length - 1];
    const punctuation = text.match(leadingPunctuationPattern)?.[1] ?? "";
    if (punctuation && previous?.type === "citation") {
      tokens.splice(tokens.length - 1, 0, { type: "text", text: punctuation });
      text = text.slice(punctuation.length);
    }
    appendTextToken(tokens, text);
    if (segment.citations.length > 0) {
      tokens.push({ type: "citation", citations: [...new Set(segment.citations)] });
    }
  }

  if (tokens.length === 0) return parseAnswerBlocks(fallbackText);
  return blocksFromLines(splitTokensIntoLines(tokens));
}

function appendTextToken(tokens: InlineToken[], text: string) {
  if (!text) return;
  const previous = tokens[tokens.length - 1];
  if (previous?.type === "text") {
    previous.text += text;
  } else {
    tokens.push({ type: "text", text });
  }
}

function splitTokensIntoLines(tokens: InlineToken[]): InlineToken[][] {
  const lines: InlineToken[][] = [[]];
  for (const token of tokens) {
    if (token.type === "citation") {
      lines[lines.length - 1].push(token);
      continue;
    }

    const parts = token.text.replace(/\r\n/g, "\n").split("\n");
    parts.forEach((part, index) => {
      if (index > 0) lines.push([]);
      appendTextToken(lines[lines.length - 1], part);
    });
  }
  return mergeContinuationLines(lines);
}

function mergeContinuationLines(lines: InlineToken[][]): InlineToken[][] {
  const merged: InlineToken[][] = [];
  for (const rawLine of lines) {
    const line = trimInlineTokens(rawLine);
    if (!lineHasText(line)) {
      merged.push([]);
      continue;
    }

    const text = lineText(line);
    const previous = lastContentLine(merged);
    if (previous && leadingPunctuationPattern.test(text)) {
      appendPunctuationContinuation(previous, line);
    } else {
      merged.push(line);
    }
  }
  return merged;
}

function appendPunctuationContinuation(target: InlineToken[], source: InlineToken[]) {
  const sourceCopy = cloneInlineTokens(source);
  const leadingPunctuation = consumeLeadingPunctuation(sourceCopy);
  const trailingCitationIndex = target.length - 1;
  if (leadingPunctuation && target[trailingCitationIndex]?.type === "citation") {
    target.splice(trailingCitationIndex, 0, { type: "text", text: leadingPunctuation });
  } else if (leadingPunctuation) {
    appendTextToken(target, leadingPunctuation);
  }
  appendTokens(target, sourceCopy, "");
}

function blocksFromLines(lines: InlineToken[][]): TextBlock[] {
  const blocks: TextBlock[] = [];
  let paragraph: InlineToken[] = [];
  let listItems: InlineToken[][] = [];

  function flushParagraph() {
    const tokens = trimInlineTokens(paragraph);
    if (lineHasText(tokens)) blocks.push({ type: "paragraph", tokens });
    paragraph = [];
  }

  function flushList() {
    const items = listItems.map(trimInlineTokens).filter(lineHasText);
    if (items.length > 0) blocks.push({ type: "list", items });
    listItems = [];
  }

  for (const line of lines) {
    if (!lineHasText(line)) {
      flushParagraph();
      flushList();
      continue;
    }

    if (isBulletLine(line)) {
      flushParagraph();
      listItems.push(stripBulletMarker(line));
      continue;
    }

    if (listItems.length > 0) {
      appendTokens(listItems[listItems.length - 1], line, " ");
    } else {
      appendTokens(paragraph, line, paragraph.length > 0 ? " " : "");
    }
  }

  flushParagraph();
  flushList();
  return blocks;
}

function isBulletLine(tokens: InlineToken[]) {
  return bulletMarkerPattern.test(lineText(tokens));
}

function stripBulletMarker(tokens: InlineToken[]): InlineToken[] {
  const copy = cloneInlineTokens(tokens);
  for (const token of copy) {
    if (token.type !== "text") continue;
    const replaced = token.text.replace(bulletMarkerPattern, "");
    if (replaced !== token.text) {
      token.text = replaced;
      break;
    }
  }
  return trimInlineTokens(copy);
}

function consumeLeadingPunctuation(tokens: InlineToken[]) {
  for (const token of tokens) {
    if (token.type !== "text") continue;
    const match = token.text.match(leadingPunctuationPattern);
    if (!match) return "";
    token.text = token.text.slice(match[1].length);
    return match[1];
  }
  return "";
}

function appendTokens(target: InlineToken[], source: InlineToken[], separator: string) {
  const tokens = trimInlineTokens(source);
  if (tokens.length === 0) return;
  if (separator && lineHasText(target)) appendTextToken(target, separator);
  tokens.forEach((token) => {
    if (token.type === "text") appendTextToken(target, token.text);
    else target.push({ ...token, citations: [...token.citations] });
  });
}

function trimInlineTokens(tokens: InlineToken[]): InlineToken[] {
  const copy = cloneInlineTokens(tokens);
  while (copy[0]?.type === "text" && copy[0].text.trim() === "") copy.shift();
  while (copy[copy.length - 1]?.type === "text" && copy[copy.length - 1].text.trim() === "") copy.pop();
  if (copy[0]?.type === "text") copy[0].text = copy[0].text.trimStart();
  const last = copy[copy.length - 1];
  if (last?.type === "text") last.text = last.text.trimEnd();
  return copy;
}

function cloneInlineTokens(tokens: InlineToken[]): InlineToken[] {
  return tokens.map((token) =>
    token.type === "text"
      ? { type: "text", text: token.text }
      : { type: "citation", citations: [...token.citations] }
  );
}

function lineHasText(tokens: InlineToken[]) {
  return tokens.some((token) => token.type === "citation" || token.text.trim().length > 0);
}

function lineText(tokens: InlineToken[]) {
  return tokens.map((token) => (token.type === "text" ? token.text : "")).join("").trim();
}

function lastContentLine(lines: InlineToken[][]) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lineHasText(lines[index])) return lines[index];
  }
  return null;
}

function renderInlineMarkdown(text: string) {
  const pieces = text.split(/(\*\*[^*]+\*\*)/g);
  return pieces.map((piece, index) => {
    if (piece.startsWith("**") && piece.endsWith("**")) {
      return (
        <strong key={index} className="font-semibold text-neutral-50">
          {piece.slice(2, -2)}
        </strong>
      );
    }
    return <span key={index}>{piece.replace(/\*\*/g, "")}</span>;
  });
}

function renderInlineTokens(
  tokens: InlineToken[],
  evidenceMap: Map<string, EvidenceRef>,
  language: AnalysisLanguage,
  onAskEvidence?: (citations: string[]) => void
) {
  return tokens.map((token, index) => {
    if (token.type === "citation") {
      return (
        <EvidencePopover
          key={`cite-${index}`}
          citations={token.citations}
          evidenceMap={evidenceMap}
          language={language}
          onAskEvidence={onAskEvidence}
        />
      );
    }
    return <Fragment key={`text-${index}`}>{renderInlineMarkdown(token.text)}</Fragment>;
  });
}

const RatingBar = ({
  label,
  score,
  colorClass,
}: {
  label: string;
  score: number | null;
  colorClass: string;
}) => {
  if (score === null) return null;
  const pct = Math.max(0, Math.min(100, (score / 10) * 100));
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-12 font-semibold text-neutral-400">{label}</span>
      <div className="h-2 flex-1 overflow-hidden rounded bg-neutral-800">
        <div className={`h-full ${colorClass}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="w-8 text-right font-mono text-neutral-200">{score.toFixed(1)}</span>
    </div>
  );
};

const PosterFrame = ({
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
}) => {
  const posterUrl = usePoster(movie.imdb_id);
  const bgStyle = { background: getGradientCached(movie.title) };

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
        <div className="flex h-full w-full items-center justify-center px-6 text-center" style={bgStyle}>
          <span className={titleClassName ?? "text-xl font-bold text-white/70"}>{movie.title}</span>
        </div>
      )}
      {children}
    </div>
  );
};

const EvidencePopover = ({
  citations,
  evidenceMap,
  language,
  onAskEvidence,
}: {
  citations: string[];
  evidenceMap: Map<string, EvidenceRef>;
  language: AnalysisLanguage;
  onAskEvidence?: (citations: string[]) => void;
}) => {
  const refs = citations.map((citation) => evidenceMap.get(citation)).filter(Boolean) as EvidenceRef[];
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 420, maxHeight: 420 });
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const sourceLabel = language === "zh" ? "依据" : "Source";

  function updatePosition() {
    const button = buttonRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const margin = 16;
    const width = Math.min(440, window.innerWidth - margin * 2);
    const left = clamp(rect.left, margin, window.innerWidth - width - margin);
    const spaceBelow = window.innerHeight - rect.bottom - margin;
    const spaceAbove = rect.top - margin;
    const openBelow = spaceBelow >= 320 || spaceBelow >= spaceAbove;
    const availableHeight = Math.max(160, openBelow ? spaceBelow : spaceAbove);
    const maxHeight = Math.min(420, availableHeight);
    const top = openBelow
      ? rect.bottom + 8
      : Math.max(margin, rect.top - maxHeight - 8);
    setPosition({ top, left, width, maxHeight });
  }

  useEffect(() => {
    if (!open) return;
    updatePosition();

    function closeOnOutside(event: MouseEvent) {
      const target = event.target as Node;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("mousedown", closeOnOutside, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("mousedown", closeOnOutside, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  if (refs.length === 0) return null;

  const panel = open
    ? createPortal(
        <div
          ref={panelRef}
          className="fixed z-[80] overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950 p-3 text-left shadow-2xl shadow-black/60"
          style={{
            top: position.top,
            left: position.left,
            width: position.width,
            maxHeight: position.maxHeight,
          }}
        >
          <div className="mb-2 flex items-center justify-between gap-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-neutral-400">Evidence</div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
            >
              Close
            </button>
          </div>
          <div
            className="space-y-3 overflow-y-auto pr-1 custom-scrollbar"
            style={{ maxHeight: position.maxHeight - (onAskEvidence ? 96 : 48) }}
          >
            {refs.map((ref) => (
              <div key={ref.citation} className="rounded-md border border-neutral-800 bg-neutral-900/70 p-3">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <span
                    className={`rounded px-2 py-0.5 text-[11px] font-semibold ${
                      ref.platform.toLowerCase() === "douban"
                        ? "bg-emerald-400/10 text-emerald-200"
                        : "bg-amber-400/10 text-amber-200"
                    }`}
                  >
                    {platformLabel(ref.platform)}
                  </span>
                  <span className="font-mono text-[11px] text-neutral-400">
                    Rating {ref.rating ?? "N/A"}
                  </span>
                </div>
                <div className="whitespace-pre-wrap text-xs leading-5 text-neutral-200">{ref.text}</div>
              </div>
            ))}
          </div>
          {onAskEvidence && (
            <button
              type="button"
              onClick={() => {
                onAskEvidence(citations);
                setOpen(false);
              }}
              className="mt-3 w-full rounded border border-amber-400/40 bg-amber-300/10 px-3 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-300/20"
            >
              {language === "zh" ? "就此证据提问" : "Ask about this evidence"}
            </button>
          )}
        </div>,
        document.body
      )
    : null;

  return (
    <span className="inline-flex align-baseline">
      <button
        ref={buttonRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          updatePosition();
          setOpen((value) => !value);
        }}
        className={`ml-1 inline-flex h-5 min-w-5 items-center justify-center rounded border px-1.5 text-[10px] font-semibold leading-none transition-colors focus:outline-none focus:ring-2 focus:ring-amber-300/50 ${
          open
            ? "border-amber-300 bg-amber-300/25 text-amber-100"
            : "border-amber-400/50 bg-amber-300/10 text-amber-200 hover:bg-amber-300/20"
        }`}
        aria-label={language === "zh" ? "查看证据" : "Show source evidence"}
        aria-expanded={open}
      >
        {sourceLabel}
      </button>
      {panel}
    </span>
  );
};

const AnswerBlocks = ({
  segments,
  answer,
  evidenceMap,
  language,
  onAskEvidence,
}: {
  segments: AnswerSegment[];
  answer: string;
  evidenceMap: Map<string, EvidenceRef>;
  language: AnalysisLanguage;
  onAskEvidence?: (citations: string[]) => void;
}) => {
  const blocks = useMemo(
    () => parseAnswerSegments(segments, answer),
    [segments, answer]
  );

  return (
    <>
      {blocks.map((block, index) =>
        block.type === "list" ? (
          <div key={index} className="my-5 space-y-4">
            {block.items.map((item, itemIndex) => (
              <p key={`${index}-${itemIndex}`} className="border-l border-neutral-800 pl-4">
                {renderInlineTokens(item, evidenceMap, language, onAskEvidence)}
              </p>
            ))}
          </div>
        ) : (
          <p key={index} className="my-5">
            {renderInlineTokens(block.tokens, evidenceMap, language, onAskEvidence)}
          </p>
        )
      )}
    </>
  );
};

const AnalysisReport = ({
  analysis,
  followUps,
  question,
  focusRefs,
  loadingFollowUp,
  followUpError,
  onQuestionChange,
  onFocusEvidence,
  onClearFocus,
  onSubmitQuestion,
}: {
  analysis: AnalysisResp;
  followUps: FollowUpResp[];
  question: string;
  focusRefs: string[];
  loadingFollowUp: boolean;
  followUpError: string | null;
  onQuestionChange: (value: string) => void;
  onFocusEvidence: (citations: string[]) => void;
  onClearFocus: () => void;
  onSubmitQuestion: () => void;
}) => {
  const evidenceMap = useMemo(
    () => new Map(analysis.evidence_refs.map((ref) => [ref.citation, ref])),
    [analysis.evidence_refs]
  );
  const canAsk = analysis.remaining_questions > 0 && !loadingFollowUp;
  const isChinese = analysis.language === "zh";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pr-2 custom-scrollbar">
        <div className="mb-4 grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
            <div className="text-neutral-500">Evidence</div>
            <div className="mt-1 font-mono text-lg text-neutral-100">{analysis.evidence_count}</div>
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
            <div className="text-neutral-500">Pairs</div>
            <div className="mt-1 font-mono text-lg text-neutral-100">{analysis.pair_count}</div>
          </div>
        </div>

        <article className="analysis-copy max-w-5xl text-[15px] leading-8 text-neutral-200">
          <AnswerBlocks
            segments={analysis.segments}
            answer={analysis.answer}
            evidenceMap={evidenceMap}
            language={analysis.language}
            onAskEvidence={onFocusEvidence}
          />
        </article>

        {followUps.length > 0 && (
          <section className="mt-8 max-w-5xl border-t border-neutral-800 pt-6">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              {isChinese ? "追问记录" : "Follow-up discussion"}
            </h4>
            <div className="mt-5 space-y-7">
              {followUps.map((turn, index) => (
                <article key={`${turn.session_id}-${index}`}>
                  <div className="mb-3 flex items-start gap-3">
                    <span className="mt-0.5 shrink-0 rounded bg-neutral-800 px-2 py-1 text-[10px] font-semibold uppercase text-neutral-400">
                      {isChinese ? "你" : "You"}
                    </span>
                    <p className="text-sm leading-6 text-neutral-100">{turn.question}</p>
                  </div>
                  <div className="border-l border-neutral-800 pl-4 text-sm leading-7 text-neutral-300">
                    <AnswerBlocks
                      segments={turn.segments}
                      answer={turn.answer}
                      evidenceMap={evidenceMap}
                      language={analysis.language}
                      onAskEvidence={onFocusEvidence}
                    />
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </div>

      <div className="mt-4 shrink-0 border-t border-neutral-800 pt-4">
        {analysis.remaining_questions > 0 && (
          <div className="mb-3 flex gap-2 overflow-x-auto pb-1 custom-scrollbar">
            {analysis.suggested_questions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => onQuestionChange(suggestion)}
                disabled={loadingFollowUp}
                className="shrink-0 rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-xs text-neutral-300 hover:border-neutral-700 hover:text-white disabled:opacity-50"
              >
                {suggestion}
              </button>
            ))}
          </div>
        )}

        {focusRefs.length > 0 && (
          <div className="mb-2 flex items-center gap-2 text-xs text-amber-200">
            <span className="rounded bg-amber-300/10 px-2 py-1">
              {isChinese
                ? `已聚焦 ${focusRefs.length} 条证据`
                : `${focusRefs.length} focused evidence item${focusRefs.length === 1 ? "" : "s"}`}
            </span>
            <button
              type="button"
              onClick={onClearFocus}
              className="text-neutral-500 hover:text-neutral-200"
            >
              {isChinese ? "取消" : "Clear"}
            </button>
          </div>
        )}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmitQuestion();
          }}
          className="flex items-end gap-3"
        >
          <div className="min-w-0 flex-1">
            <textarea
              rows={2}
              maxLength={200}
              value={question}
              onChange={(event) => onQuestionChange(event.target.value)}
              disabled={!canAsk}
              placeholder={
                analysis.remaining_questions > 0
                  ? isChinese
                    ? "就这份报告继续追问..."
                    : "Ask about this report..."
                  : isChinese
                    ? "本次分析的追问已用完"
                    : "No follow-up questions remaining"
              }
              className="block max-h-28 min-h-16 w-full resize-y rounded-lg border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm leading-6 text-neutral-100 outline-none placeholder:text-neutral-600 focus:border-amber-300/60 disabled:cursor-not-allowed disabled:opacity-60"
            />
            <div className="mt-1 flex items-center justify-between text-[11px] text-neutral-600">
              <span>
                {isChinese
                  ? `仅使用当前电影证据 · 剩余 ${analysis.remaining_questions} 次`
                  : `Current movie evidence only · ${analysis.remaining_questions} remaining`}
              </span>
              <span>{question.length}/200</span>
            </div>
          </div>
          <button
            type="submit"
            disabled={!canAsk || !question.trim()}
            className="h-10 shrink-0 rounded bg-amber-400 px-4 text-sm font-semibold text-neutral-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-neutral-800 disabled:text-neutral-500"
          >
            {loadingFollowUp
              ? isChinese
                ? "回答中..."
                : "Answering..."
              : isChinese
                ? "追问"
                : "Ask"}
          </button>
        </form>

        {followUpError && (
          <div className="mt-2 text-xs leading-5 text-red-300">{followUpError}</div>
        )}
      </div>
    </div>
  );
};

const MovieDetailModal = ({ movie, onClose }: { movie: Movie | null; onClose: () => void }) => {
  const [analysisLanguage, setAnalysisLanguage] = useState<AnalysisLanguage>("zh");
  const [analysesByLanguage, setAnalysesByLanguage] = useState<
    Partial<Record<AnalysisLanguage, AnalysisResp>>
  >({});
  const [followUpsByLanguage, setFollowUpsByLanguage] = useState<
    Partial<Record<AnalysisLanguage, FollowUpResp[]>>
  >({});
  const [question, setQuestion] = useState("");
  const [focusRefs, setFocusRefs] = useState<string[]>([]);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [loadingFollowUp, setLoadingFollowUp] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [followUpError, setFollowUpError] = useState<string | null>(null);
  const analysisControllerRef = useRef<AbortController | null>(null);
  const followUpControllerRef = useRef<AbortController | null>(null);
  const analysis = analysesByLanguage[analysisLanguage] ?? null;
  const followUps = followUpsByLanguage[analysisLanguage] ?? [];

  useEffect(() => {
    if (!movie) return;
    setAnalysesByLanguage({});
    setFollowUpsByLanguage({});
    setQuestion("");
    setFocusRefs([]);
    setAnalysisError(null);
    setFollowUpError(null);
    analysisControllerRef.current?.abort();
    followUpControllerRef.current?.abort();

    return () => {
      analysisControllerRef.current?.abort();
      followUpControllerRef.current?.abort();
    };
  }, [movie]);

  if (!movie) return null;

  const canAnalyze = Boolean(movie.movie_key);

  async function generateAnalysis(language: AnalysisLanguage = analysisLanguage) {
    if (!movie?.movie_key || loadingAnalysis) return;
    analysisControllerRef.current?.abort();
    const controller = new AbortController();
    analysisControllerRef.current = controller;
    setLoadingAnalysis(true);
    setAnalysisError(null);
    try {
      const response = await fetch(`${API_BASE}/movie/${movie.movie_key}/analysis`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ language }),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(text || "Analysis failed");
      }
      const result = (await response.json()) as AnalysisResp;
      setAnalysesByLanguage((previous) => ({ ...previous, [language]: result }));
      setFollowUpsByLanguage((previous) => ({ ...previous, [language]: [] }));
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setAnalysisError(err?.message ?? "Analysis failed");
      }
    } finally {
      if (analysisControllerRef.current === controller) {
        setLoadingAnalysis(false);
      }
    }
  }

  function changeAnalysisLanguage(language: AnalysisLanguage) {
    if (language === analysisLanguage) return;
    setAnalysisLanguage(language);
    setQuestion("");
    setFocusRefs([]);
    setAnalysisError(null);
    setFollowUpError(null);
    analysisControllerRef.current?.abort();
    followUpControllerRef.current?.abort();
  }

  function focusEvidence(citations: string[]) {
    const refs = [...new Set(citations)].slice(0, 4);
    setFocusRefs(refs);
    setQuestion(
      analysisLanguage === "zh"
        ? "这组证据如何支持或削弱报告中的结论？"
        : "How does this evidence support or weaken the report's conclusion?"
    );
    setFollowUpError(null);
  }

  async function submitFollowUp() {
    const text = question.trim();
    if (!analysis || !text || loadingFollowUp || analysis.remaining_questions <= 0) return;
    followUpControllerRef.current?.abort();
    const controller = new AbortController();
    followUpControllerRef.current = controller;
    setLoadingFollowUp(true);
    setFollowUpError(null);
    try {
      const response = await fetch(`${API_BASE}/analysis/${analysis.session_id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ question: text, focus_refs: focusRefs }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const detail = payload?.detail;
        throw new Error(
          typeof detail === "string"
            ? detail
            : detail?.message ?? (analysisLanguage === "zh" ? "追问失败" : "Follow-up failed")
        );
      }
      const result = (await response.json()) as FollowUpResp;
      setFollowUpsByLanguage((previous) => ({
        ...previous,
        [analysisLanguage]: [...(previous[analysisLanguage] ?? []), result],
      }));
      setAnalysesByLanguage((previous) => ({
        ...previous,
        [analysisLanguage]: previous[analysisLanguage]
          ? {
              ...previous[analysisLanguage]!,
              remaining_questions: result.remaining_questions,
            }
          : previous[analysisLanguage],
      }));
      setQuestion("");
      setFocusRefs([]);
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        setFollowUpError(err?.message ?? "Follow-up failed");
      }
    } finally {
      if (followUpControllerRef.current === controller) {
        setLoadingFollowUp(false);
      }
    }
  }

  function closeModal() {
    for (const item of Object.values(analysesByLanguage)) {
      if (item?.session_id) {
        void fetch(`${API_BASE}/analysis/${item.session_id}`, {
          method: "DELETE",
          keepalive: true,
        });
      }
    }
    onClose();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 backdrop-blur-sm sm:p-4" onClick={closeModal}>
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
              <h2 className="text-2xl font-bold leading-tight text-white">{movie.title}</h2>
              <div className="mt-2 flex flex-wrap gap-2 text-xs text-neutral-300">
                <span className="rounded bg-neutral-800 px-2 py-1 font-mono">{movie.year ?? "N/A"}</span>
                {movie.region && <span className="rounded bg-neutral-800 px-2 py-1 uppercase">{movie.region}</span>}
              </div>
            </div>
          </PosterFrame>

          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5 custom-scrollbar">
            <div className="space-y-3">
              <RatingBar label="IMDb" score={movie.imdb_rating} colorClass="bg-amber-400" />
              <RatingBar label="Douban" score={movie.douban_rating} colorClass="bg-emerald-500" />
              {movie.gap !== null && (
                <div className="flex justify-between border-t border-neutral-800 pt-3 text-xs">
                  <span className="text-neutral-500">Rating Gap</span>
                  <span className="font-mono font-semibold text-neutral-100">{Math.abs(movie.gap).toFixed(2)}</span>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3 text-xs text-neutral-400">
              <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
                <div>IMDb votes</div>
                <div className="mt-1 font-mono text-neutral-100">{formatVotes(movie.imdb_votes)}</div>
              </div>
              <div className="rounded-lg border border-neutral-800 bg-neutral-950 p-3">
                <div>Douban votes</div>
                <div className="mt-1 font-mono text-neutral-100">{formatVotes(movie.douban_votes)}</div>
              </div>
            </div>

            <div className="flex gap-3">
              {movie.imdb_url && (
                <a href={movie.imdb_url} target="_blank" rel="noreferrer" className="flex-1 rounded border border-amber-400/40 px-3 py-2 text-center text-sm font-semibold text-amber-200 hover:bg-amber-400/10">
                  IMDb
                </a>
              )}
              {movie.douban_url && (
                <a href={movie.douban_url} target="_blank" rel="noreferrer" className="flex-1 rounded border border-emerald-400/40 px-3 py-2 text-center text-sm font-semibold text-emerald-200 hover:bg-emerald-400/10">
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
              <p className="mt-1 text-sm text-neutral-500">IMDb/Douban disagreement report</p>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-3">
              <div className="inline-flex overflow-hidden rounded border border-neutral-800 bg-neutral-900 p-0.5">
                {(["zh", "en"] as const).map((language) => {
                  const active = analysisLanguage === language;
                  return (
                    <button
                      key={language}
                      type="button"
                      onClick={() => changeAnalysisLanguage(language)}
                      disabled={loadingAnalysis}
                      aria-pressed={active}
                      className={`h-8 px-3 text-xs font-semibold transition-colors ${
                        active
                          ? "rounded bg-neutral-100 text-neutral-950"
                          : "text-neutral-400 hover:text-neutral-100"
                      } disabled:cursor-not-allowed disabled:opacity-60`}
                    >
                      {language === "zh" ? "中文" : "English"}
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

          {!analysis && (
            <div className="mb-5 rounded-lg border border-neutral-800 bg-neutral-900 p-5">
              <div className="max-w-2xl text-sm leading-6 text-neutral-300">
                Generate a grounded {analysisLanguage === "zh" ? "Chinese" : "English"} report from the notebook-built Chroma evidence index.
              </div>
              <button
                type="button"
                onClick={() => generateAnalysis()}
                disabled={!canAnalyze || loadingAnalysis}
                className="mt-4 rounded bg-amber-400 px-4 py-2 text-sm font-semibold text-neutral-950 transition-colors hover:bg-amber-300 disabled:cursor-not-allowed disabled:bg-neutral-700 disabled:text-neutral-400"
              >
                {loadingAnalysis ? "Generating..." : "Generate Analysis"}
              </button>
              {!canAnalyze && <div className="mt-3 text-sm text-red-300">No movie_key available for this movie.</div>}
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

          {analysis && !loadingAnalysis && (
            <AnalysisReport
              analysis={analysis}
              followUps={followUps}
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
};

const MovieCard = ({ movie, onClick }: { movie: Movie; onClick: (movie: Movie) => void }) => {
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
          {movie.gap !== null && <span className="font-mono">Gap {Math.abs(movie.gap).toFixed(1)}</span>}
        </div>
        <div className="mt-auto space-y-2">
          <RatingBar label="IMDb" score={movie.imdb_rating} colorClass="bg-amber-400" />
          <RatingBar label="Douban" score={movie.douban_rating} colorClass="bg-emerald-500" />
        </div>
      </div>
    </button>
  );
};

export default function App() {
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("score_desc");
  const [selectedMovie, setSelectedMovie] = useState<Movie | null>(null);
  const [items, setItems] = useState<Movie[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listControllerRef = useRef<AbortController | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const debouncedQ = useDebounce(q, 500);
  const pageSize = 24;
  const hasMore = items.length < total;

  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    params.set("page_size", String(pageSize));
    params.set("sort", sort);
    if (debouncedQ.trim()) params.set("q", debouncedQ.trim());
    return params.toString();
  }, [debouncedQ, sort]);

  async function loadPage(nextPage: number, replace = false) {
    if (!replace && loading) return;
    listControllerRef.current?.abort();
    const controller = new AbortController();
    listControllerRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/movies?${queryParams}&page=${nextPage}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Server error");
      const data = (await response.json()) as ApiResp;
      setTotal(data.total);
      setPage(data.page);
      setItems((prev) => (replace ? data.items : [...prev, ...data.items]));
    } catch (err: any) {
      if (err?.name !== "AbortError") setError(err?.message ?? "Error");
    } finally {
      if (listControllerRef.current === controller) setLoading(false);
    }
  }

  useEffect(() => {
    setItems([]);
    setPage(1);
    setTotal(0);
    loadPage(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryParams]);

  useEffect(() => () => listControllerRef.current?.abort(), []);

  useEffect(() => {
    const element = sentinelRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loading && hasMore && !error) {
          loadPage(page + 1, false);
        }
      },
      { rootMargin: "360px" }
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [page, loading, hasMore, error]);

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-100">
      {selectedMovie && <MovieDetailModal movie={selectedMovie} onClose={() => setSelectedMovie(null)} />}

      <header className="border-b border-neutral-900 bg-neutral-950 px-4 py-8 sm:px-8">
        <div className="mx-auto max-w-7xl">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <h1 className="text-4xl font-bold tracking-tight text-white">Movie Evidence Agent</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-neutral-500">
                {total > 0 ? total.toLocaleString() : "..."} IMDb/Douban cross-platform movies
              </p>
            </div>
            <div className="grid w-full gap-3 sm:grid-cols-[1fr_12rem] lg:w-[34rem]">
              <input
                type="text"
                value={q}
                onChange={(event) => setQ(event.target.value)}
                className="h-11 rounded-lg border border-neutral-800 bg-neutral-900 px-4 text-sm text-white outline-none transition-colors placeholder:text-neutral-600 focus:border-amber-300/70"
                placeholder="Search movies..."
              />
              <select
                value={sort}
                onChange={(event) => setSort(event.target.value)}
                className="h-11 rounded-lg border border-neutral-800 bg-neutral-900 px-3 text-sm text-neutral-200 outline-none focus:border-amber-300/70"
              >
                <option value="score_desc">Largest Gap</option>
                <option value="score_asc">Smallest Gap</option>
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
          {items.map((movie) => (
            <MovieCard key={movie.movie_key ?? movie.imdb_id ?? movie.title} movie={movie} onClick={setSelectedMovie} />
          ))}
        </div>

        <div ref={sentinelRef} className="flex items-center justify-center py-12">
          {loading ? (
            <div className="flex items-center gap-3 text-sm text-neutral-500">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-amber-300 border-t-transparent" />
              Loading movies...
            </div>
          ) : !hasMore && items.length > 0 ? (
            <div className="text-xs uppercase tracking-widest text-neutral-700">End of list</div>
          ) : items.length === 0 && !error ? (
            <div className="text-neutral-500">No movies found.</div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
