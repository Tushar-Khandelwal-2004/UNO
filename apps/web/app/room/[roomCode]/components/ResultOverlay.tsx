"use client";

export function ResultOverlay({ winner, didWin, onHome }: { winner: string; didWin: boolean; onHome: () => void }) {
  return <div className="absolute inset-0 z-overlay grid place-items-center bg-black/60 p-5 backdrop-blur-[2px]"><div className="grid max-w-sm place-items-center gap-3 rounded-panel border border-white/15 bg-uno-panel p-7 text-center shadow-panel"><div className="text-5xl">🏆</div><p className="m-0 text-xs font-extrabold uppercase tracking-[.18em] text-uno-accent">Match finished</p><h2 className="m-0 text-3xl font-extrabold">{didWin ? "You won!" : "You lost"}</h2><p className="m-0 text-sm text-uno-muted">{winner} took the round.</p><button type="button" onClick={onHome} className="mt-2 min-h-11 rounded-button bg-uno-blue px-5 font-extrabold text-white">Back to home</button></div></div>;
}
