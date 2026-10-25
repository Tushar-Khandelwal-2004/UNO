"use client";

import type { MouseEventHandler, RefObject } from "react";
import { CardBack } from "./Card";

interface DrawPileProps {
  count: number;
  disabled: boolean;
  pulse: boolean;
  onDraw: MouseEventHandler<HTMLButtonElement>;
  pileRef?: RefObject<HTMLDivElement | null>;
}

export function DrawPile({ count, disabled, pulse, onDraw, pileRef }: DrawPileProps) {
  return (
    <button type="button" onClick={onDraw} disabled={disabled} aria-label={`Draw card, ${count} cards left`} className={`group flex min-h-0 min-w-0 flex-col items-center gap-2 rounded-card p-2 transition-transform hover:-translate-y-2 focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-uno-accent/80 ${pulse ? "legal-pulse" : ""}`}>
      <div ref={pileRef} className="relative h-[var(--card-height)] w-[var(--card-width)]">
        <CardBack dark className="absolute inset-0 rotate-[-3deg] group-hover:rotate-[-6deg]" />
      </div>
      <span className="rounded-full bg-black/35 px-2 py-1 text-[10px] font-bold uppercase tracking-[.14em] text-white/75">{count} left</span>
    </button>
  );
}
