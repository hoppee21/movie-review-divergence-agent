import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import type {
  AnalysisResponse,
  AnswerSegment,
  EvidenceRef,
  FollowUpResponse,
} from "../api";


function platformLabel(platform: string) {
  return platform.toLowerCase() === "douban" ? "Douban" : "IMDb";
}


function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}


function EvidencePopover({
  citations,
  evidenceMap,
  language,
  onAskEvidence,
}: {
  citations: string[];
  evidenceMap: Map<string, EvidenceRef>;
  language: AnalysisResponse["language"];
  onAskEvidence: (citations: string[]) => void;
}) {
  const refs = citations
    .map((citation) => evidenceMap.get(citation))
    .filter((ref): ref is EvidenceRef => Boolean(ref));
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({
    top: 0,
    left: 0,
    width: 420,
    maxHeight: 420,
  });
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const isChinese = language === "zh";

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
      if (
        buttonRef.current?.contains(target) ||
        panelRef.current?.contains(target)
      ) {
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
        aria-label={isChinese ? "查看证据" : "Show source evidence"}
        aria-expanded={open}
      >
        {isChinese ? "依据" : "Source"}
      </button>
      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="fixed z-[80] overflow-hidden rounded-lg border border-neutral-700 bg-neutral-950 p-3 text-left shadow-2xl shadow-black/60"
            style={position}
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-xs font-semibold uppercase tracking-wide text-neutral-400">
                {isChinese ? "证据" : "Evidence"}
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
              >
                {isChinese ? "关闭" : "Close"}
              </button>
            </div>
            <div
              className="space-y-3 overflow-y-auto pr-1 custom-scrollbar"
              style={{ maxHeight: position.maxHeight - 96 }}
            >
              {refs.map((ref) => (
                <div
                  key={ref.citation}
                  className="rounded-md border border-neutral-800 bg-neutral-900/70 p-3"
                >
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
                      {isChinese ? "评分" : "Rating"} {ref.rating ?? "N/A"}
                    </span>
                  </div>
                  <div className="whitespace-pre-wrap text-xs leading-5 text-neutral-200">
                    {ref.text}
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                onAskEvidence(citations);
                setOpen(false);
              }}
              className="mt-3 w-full rounded border border-amber-400/40 bg-amber-300/10 px-3 py-2 text-xs font-semibold text-amber-100 hover:bg-amber-300/20"
            >
              {isChinese ? "就此证据提问" : "Ask about this evidence"}
            </button>
          </div>,
          document.body,
        )}
    </span>
  );
}


function SegmentContent({
  segments,
  evidenceMap,
  language,
  onAskEvidence,
}: {
  segments: AnswerSegment[];
  evidenceMap: Map<string, EvidenceRef>;
  language: AnalysisResponse["language"];
  onAskEvidence: (citations: string[]) => void;
}) {
  return segments.map((segment, index) => (
    <Fragment key={index}>
      <span className="whitespace-pre-wrap">{segment.text}</span>
      {segment.citations.length > 0 && (
        <EvidencePopover
          citations={segment.citations}
          evidenceMap={evidenceMap}
          language={language}
          onAskEvidence={onAskEvidence}
        />
      )}
    </Fragment>
  ));
}


export function AnalysisReport({
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
  analysis: AnalysisResponse;
  followUps: FollowUpResponse[];
  question: string;
  focusRefs: string[];
  loadingFollowUp: boolean;
  followUpError: string | null;
  onQuestionChange: (value: string) => void;
  onFocusEvidence: (citations: string[]) => void;
  onClearFocus: () => void;
  onSubmitQuestion: () => void;
}) {
  const evidenceMap = useMemo(
    () => new Map(analysis.evidence_refs.map((ref) => [ref.citation, ref])),
    [analysis.evidence_refs],
  );
  const canAsk = analysis.remaining_questions > 0 && !loadingFollowUp;
  const isChinese = analysis.language === "zh";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pr-2 custom-scrollbar">
        <div className="mb-4 grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
            <div className="text-neutral-500">Evidence</div>
            <div className="mt-1 font-mono text-lg text-neutral-100">
              {analysis.evidence_count}
            </div>
          </div>
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-3">
            <div className="text-neutral-500">Pairs</div>
            <div className="mt-1 font-mono text-lg text-neutral-100">
              {analysis.pair_count}
            </div>
          </div>
        </div>

        <article className="analysis-copy max-w-5xl text-[15px] leading-8 text-neutral-200">
          <SegmentContent
            segments={analysis.segments}
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
                <article key={`${turn.question}-${index}`}>
                  <div className="mb-3 flex items-start gap-3">
                    <span className="mt-0.5 shrink-0 rounded bg-neutral-800 px-2 py-1 text-[10px] font-semibold uppercase text-neutral-400">
                      {isChinese ? "你" : "You"}
                    </span>
                    <p className="text-sm leading-6 text-neutral-100">
                      {turn.question}
                    </p>
                  </div>
                  <div className="border-l border-neutral-800 pl-4 text-sm leading-7 text-neutral-300">
                    <SegmentContent
                      segments={turn.segments}
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
          <div className="mt-2 text-xs leading-5 text-red-300">
            {followUpError}
          </div>
        )}
      </div>
    </div>
  );
}
