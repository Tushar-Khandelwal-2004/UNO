"use client";

import type { CSSProperties } from "react";
import type { Card } from "@uno/game-engine";
import type { CardDragState } from "../hooks/useCardDrag";
import { Card as UnoCard } from "./Card";

type HandLayout = ReturnType<typeof import("../hooks/useHandLayout").useHandLayout>;

export function Hand({ cards, layout, drag, legalCardIds, isMyTurn }: { cards: Card[]; layout: HandLayout; drag: CardDragState; legalCardIds: Set<string>; isMyTurn: boolean }) {
  const rows = layout.rows === 2 ? [cards.slice(0, layout.capacity), cards.slice(layout.capacity)] : [cards];
  return (
    <div ref={layout.ref} data-layout-role="hand-zone" onContextMenu={(event) => event.preventDefault()} className="hand-zone">
      <span className="hand-count">{cards.length} cards</span>
      <span data-card-probe className="card-probe" aria-hidden="true" />
      <div className={`hand-rows ${layout.rows === 2 ? "hand-rows-two" : ""}`}>
        {rows.map((row, rowIndex) => {
          const rowLayout = layout.rowLayouts[rowIndex] ?? layout.rowLayouts[0];
          if (!rowLayout) return null;
          return (
            <div className="hand-row" key={rowIndex}>
              {row.map((card, index) => {
                const props = drag.getCardProps(card);
                const style = {
                  ...props.style,
                  width: rowLayout.cardWidth,
                  height: rowLayout.cardWidth * 1.47,
                  marginLeft: index === 0 || !rowLayout.overlap ? 0 : -(rowLayout.cardWidth - rowLayout.step),
                  zIndex: 1,
                  "--card-width": `${rowLayout.cardWidth}px`,
                  "--card-height": `${rowLayout.cardWidth * 1.47}px`,
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
