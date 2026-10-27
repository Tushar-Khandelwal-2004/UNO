"use client";

import type { MouseEventHandler, RefObject } from "react";
import { CardBack } from "./Card";

export function DrawPile({ disabled, pulse, onDraw, pileRef }: { count?: number; disabled: boolean; pulse: boolean; onDraw: MouseEventHandler<HTMLButtonElement>; pileRef?: RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={pileRef} data-layout-role="draw-pile" className="draw-pile">
      <button type="button" onClick={onDraw} disabled={disabled} aria-label="Draw card" className={`draw-pile-button ${pulse ? "legal-pulse" : ""}`}>
        <span className="draw-pile-stack">
          <CardBack dark className="draw-back draw-back-one" />
          <CardBack dark className="draw-back draw-back-two" />
          <CardBack dark className="draw-back draw-back-top" />
        </span>
        <strong>∞</strong>
        <span>Draw pile</span>
      </button>
    </div>
  );
}
