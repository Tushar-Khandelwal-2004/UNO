"use client";

export function ActionBar({ isMyTurn, hasNoMoves, drewThisTurn, canCallUno, unoLabel, onDraw, onCallUno }: { isMyTurn: boolean; hasNoMoves: boolean; drewThisTurn: boolean; canCallUno: boolean; unoLabel: string; onDraw: () => void; onCallUno: () => void }) {
  return (
    <div className="action-bar">
      <button data-testid="draw-action" type="button" onClick={onDraw} disabled={!isMyTurn} className={`action-button action-primary ${hasNoMoves ? "legal-pulse" : ""}`}>
        {drewThisTurn ? "Pass" : "Draw card"}
      </button>
      <button data-testid="call-uno" type="button" onClick={onCallUno} disabled={!canCallUno} className={`action-button action-uno ${unoLabel.startsWith("UNO!") ? "uno-ready" : ""}`}>
        {unoLabel}
      </button>
    </div>
  );
}
