"use client";

import type { Card } from "@uno/game-engine";
import type { CSSProperties, RefObject } from "react";
import { Card as UnoCard, CardBack } from "./Card";

export function DiscardPile({ topCard, currentColor, targetRef, pileRef, active, onClick }: { topCard?: Card; currentColor?: string; targetRef: RefObject<HTMLDivElement | null>; pileRef?: RefObject<HTMLDivElement | null>; active: boolean; onClick?: () => void }) {
  const color = currentColor ?? "#8c979c";
  return (
    <div ref={targetRef} className={`discard-drop-zone ${active ? "discard-drop-active" : ""}`} onClick={onClick}>
      <div className="discard-content">
        <div ref={pileRef} data-layout-role="discard-pile" className="discard-pile" style={{ boxShadow: `0 0 0 3px ${color}99` }}>
          <CardBack dark className="discard-depth discard-depth-one" />
          <CardBack dark className="discard-depth discard-depth-two" />
          {topCard ? <UnoCard card={topCard} variant="discard" cardStyle={{ "--card-width": "var(--card-width)", "--card-height": "var(--card-height)" } as CSSProperties} /> : null}
        </div>
        <span className="color-chip"><span className="color-chip-dot" style={{ backgroundColor: color }} />{currentColor ?? "waiting"}</span>
      </div>
    </div>
  );
}
