"use client";

import type { MouseEventHandler } from "react";
import { CardBack } from "./Card";

interface DrawPileProps {
  count: number;
  disabled: boolean;
  pulse: boolean;
  onDraw: MouseEventHandler<HTMLButtonElement>;
}

export function DrawPile({ count, disabled, pulse, onDraw }: DrawPileProps) {
  return (
    <button type="button" onClick={onDraw} disabled={disabled} aria-label={`Draw card, ${count} cards left`} className={`group relative grid min-h-44 min-w-28 place-items-center rounded-card border-2 border-transparent p-1 transition-transform hover:-translate-y-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-uno-accent/80 ${pulse ? "legal-pulse" : ""}`}>
      <CardBack dark className="rotate-[-3deg] group-hover:rotate-[-6deg]" />
      <span className="absolute bottom-[-1.15rem] rounded-full bg-black/35 px-2 py-1 text-[10px] font-bold uppercase tracking-[.14em] text-white/75">{count} left</span>
    </button>
  );
}
