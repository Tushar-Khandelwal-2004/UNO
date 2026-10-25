"use client";

import type { CSSProperties } from "react";
import type { Card } from "@uno/game-engine";
import type { CardDragState } from "../hooks/useCardDrag";
import { Card as UnoCard } from "./Card";

type HandLayout = ReturnType<typeof import("../hooks/useHandLayout").useHandLayout>;

interface HandProps {
  cards: Card[];
  layout: HandLayout;
  drag: CardDragState;
  legalCardIds: Set<string>;
  isMyTurn: boolean;
}

export function Hand({ cards, layout, drag, legalCardIds, isMyTurn }: HandProps) {
  const rows = layout.rows === 2
    ? [cards.slice(0, layout.capacity), cards.slice(layout.capacity)]
    : [cards];
  const visibleRows = rows.filter((row) => row.length > 0);

  return (
    <div ref={layout.ref} onContextMenu={(event) => event.preventDefault()} className="relative flex min-h-0 w-full flex-1 items-end justify-center overflow-visible px-4 pb-1 pt-8">
      <span className="absolute left-1 top-1 z-20 text-[10px] font-extrabold uppercase tracking-[.14em] text-uno-muted">{cards.length} cards</span>
      <span data-card-probe className="pointer-events-none absolute h-[var(--card-height)] w-[var(--card-width)] opacity-0" aria-hidden="true" />
      <div className={`flex w-full min-h-0 flex-col justify-end ${visibleRows.length === 2 ? "gap-0" : ""}`}>
        {visibleRows.map((row, rowIndex) => {
          const rowLayout = layout.rowLayouts[rowIndex] ?? layout.rowLayouts[0];
          if (!rowLayout) return null;
          return (
            <div key={rowIndex} className="flex min-h-0 items-end justify-center px-1">
              {row.map((card, index) => {
                const props = drag.getCardProps(card);
                const style = {
                  ...props.style,
                  width: rowLayout.cardWidth,
                  height: rowLayout.cardWidth / 0.68,
                  marginLeft: index === 0 ? 0 : -(rowLayout.cardWidth - rowLayout.step),
                  zIndex: 1,
                  "--card-width": `${rowLayout.cardWidth}px`,
                  "--card-height": `${rowLayout.cardWidth / 0.68}px`,
                } as CSSProperties;
                return <UnoCard key={card.id} card={card} legal={legalCardIds.has(card.id)} isMyTurn={isMyTurn} selected={drag.selectedCardId === card.id} shaking={drag.shakeCardId === card.id} cardStyle={style} className="hand-card" {...props} />;
              })}
            </div>
          );
        })}
      </div>
      {drag.ghost ? <div className="pointer-events-none fixed z-drag" style={{ left: drag.ghost.x, top: drag.ghost.y, transform: `translate(-50%, -50%) rotate(${drag.ghost.rotation}deg)` }}><UnoCard card={drag.ghost.card} variant="ghost" legal isMyTurn /></div> : null}
    </div>
  );
}
