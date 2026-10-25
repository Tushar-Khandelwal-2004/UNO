"use client";

import type { Card } from "@uno/game-engine";
import type { CSSProperties, RefObject } from "react";
import { Card as UnoCard, CardBack } from "./Card";

interface DiscardPileProps {
  topCard?: Card;
  currentColor?: string;
  targetRef: RefObject<HTMLDivElement | null>;
  active: boolean;
  onClick?: () => void;
}

export function DiscardPile({ topCard, currentColor, targetRef, active, onClick }: DiscardPileProps) {
  return (
    <div ref={targetRef} className={`relative grid min-h-48 min-w-32 place-items-center rounded-card border-2 border-dashed transition-transform duration-150 ${active ? "scale-105 border-uno-accent bg-uno-accent/10 shadow-[0_0_34px_rgb(247_201_72_/_35%)]" : "border-white/10"}`} onClick={onClick}>
      <CardBack dark className="absolute translate-x-3 translate-y-3 rotate-[5deg] opacity-20" />
      <CardBack dark className="absolute translate-x-1 translate-y-1 rotate-[2deg] opacity-35" />
      {topCard ? <UnoCard card={topCard} variant="discard" cardStyle={{ "--card-width": "clamp(64px, 10vw, 96px)", "--card-height": "calc(clamp(64px, 10vw, 96px) / .68)" } as CSSProperties} /> : <span className="text-center text-xs font-bold uppercase tracking-[.16em] text-white/40">Discard pile</span>}
      <span className="absolute -bottom-7 flex items-center gap-1 rounded-full bg-black/25 px-2 py-1 text-[10px] font-bold uppercase tracking-[.12em] text-white/65"><span className="h-2 w-2 rounded-full" style={{ backgroundColor: currentColor ?? "#8c979c" }} /> {currentColor ?? "waiting"}</span>
    </div>
  );
}
