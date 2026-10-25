"use client";

import type { Card } from "@uno/game-engine";
import { Card as UnoCard } from "./Card";

const COLORS = ["red", "yellow", "green", "blue"] as const;

export function WildColorPicker({ card, onChoose, onCancel }: { card: Card; onChoose: (color: typeof COLORS[number]) => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-overlay grid place-items-center bg-black/70 p-5 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="wild-picker-title" onClick={onCancel}>
      <div className="grid w-full max-w-sm place-items-center gap-4 rounded-panel border border-white/15 bg-uno-panel p-5 shadow-panel" onClick={(event) => event.stopPropagation()}>
        <div className="text-center"><p className="m-0 text-xs font-extrabold uppercase tracking-[.18em] text-uno-accent">Choose a color</p><h2 id="wild-picker-title" className="m-1 text-xl font-extrabold">What color is next?</h2></div>
        <UnoCard card={card} variant="picker" />
        <div className="grid w-full grid-cols-2 gap-3">
          {COLORS.map((color) => <button key={color} type="button" autoFocus={color === "red"} className={`min-h-[72px] rounded-button border-2 border-white/75 text-lg font-extrabold capitalize text-white shadow-card focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-uno-accent/80 ${color}`} onClick={() => onChoose(color)}>{color}</button>)}
        </div>
        <button type="button" className="min-h-11 rounded-button bg-white/10 px-5 text-sm font-bold text-white/80 hover:bg-white/15" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}
