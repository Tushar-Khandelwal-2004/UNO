"use client";

export function ActionBar({ isMyTurn, hasNoMoves, canCallUno, onDraw, onCallUno, isShortLandscape }: { isMyTurn: boolean; hasNoMoves: boolean; canCallUno: boolean; onDraw: () => void; onCallUno: () => void; isShortLandscape: boolean }) {
  return <div className={`short-landscape-actions grid w-full max-w-md grid-cols-2 items-center justify-center gap-2 ${isShortLandscape ? "" : ""}`}><button type="button" onClick={onDraw} disabled={!isMyTurn} className={`min-h-11 min-w-[140px] rounded-button bg-uno-blue px-5 text-sm font-extrabold text-white shadow-lg transition-transform hover:-translate-y-0.5 disabled:opacity-45 ${hasNoMoves ? "legal-pulse" : ""}`}>{hasNoMoves ? "Draw card (no moves)" : "Draw card"}</button><button type="button" onClick={onCallUno} disabled={!canCallUno} className="min-h-11 min-w-[140px] rounded-button bg-[#0a3458] px-5 text-sm font-extrabold text-white shadow-lg disabled:opacity-45">Call UNO</button></div>;
}
