"use client";

import { useMemo } from "react";
import { canPlay, type Card } from "@uno/game-engine";

export function useLegalCards(
  hand: Card[],
  topCard: Card | undefined,
  currentColor: string | undefined,
  isMyTurn: boolean,
): Set<string> {
  return useMemo(() => {
    if (!isMyTurn || !topCard || !currentColor) return new Set<string>();
    return new Set(
      hand
        .filter((card) => canPlay(card, topCard, currentColor as Card["color"]))
        .map((card) => card.id),
    );
  }, [currentColor, hand, isMyTurn, topCard]);
}
