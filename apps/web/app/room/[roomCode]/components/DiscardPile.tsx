"use client";

import type { Card } from "@uno/game-engine";
import type { CSSProperties, RefObject } from "react";
import { Card as UnoCard, CardBack } from "./Card";

interface DiscardPileProps {
  topCard?: Card;
  currentColor?: string;
  targetRef: RefObject<HTMLDivElement | null>;
  pileRef?: RefObject<HTMLDivElement | null>;
  active: boolean;
  onClick?: () => void;
}

export function DiscardPile({ topCard, currentColor, targetRef, pileRef, active, onClick }: DiscardPileProps) {
  const color = currentColor ?? "#8c979c";
  return (
    <div ref={targetRef} className={`grid h-[calc(var(--card-height)+48px)] w-[calc(var(--card-width)+48px)] place-items-center rounded-card p-6 transition-transform duration-150 ${active ? "scale-105 bg-uno-accent/10" : ""}`} onClick={onClick}>
      <div className="flex items-center gap-2">
        <div ref={pileRef} className="relative h-[var(--card-height)] w-[var(--card-width)] rounded-card" style={{ boxShadow: `0 0 0 3px ${color}88` }}>
          <CardBack dark className="absolute inset-0 translate-x-3 translate-y-3 rotate-[5deg] opacity-20" />
          <CardBack dark className="absolute inset-0 translate-x-1 translate-y-1 rotate-[2deg] opacity-35" />
          {topCard ? <UnoCard card={topCard} variant="discard" cardStyle={{ "--card-width": "var(--card-width)", "--card-height": "var(--card-height)" } as CSSProperties} /> : <span className="grid h-full place-items-center text-center text-xs font-bold uppercase tracking-[.16em] text-white/40">Discard</span>}
        </div>
        <span className="rounded-full bg-black/25 px-2 py-1 text-[10px] font-bold uppercase tracking-[.12em] text-white/75"><span className="mr-1 inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color }} />{currentColor ?? "waiting"}</span>
      </div>
    </div>
  );
}
