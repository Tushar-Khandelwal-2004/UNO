"use client";

import type { PublicPlayer } from "@uno/protocol";
import { CardBack } from "./Card";

export function OpponentSeat({ player, isTurn, timerSeconds, compact, unoWindowOpen, unoBubble, penaltyAmount }: { player: PublicPlayer; isTurn: boolean; timerSeconds?: number; compact?: boolean; unoWindowOpen: boolean; unoBubble: boolean; penaltyAmount?: number }) {
  const bubble = penaltyAmount ? `+${penaltyAmount}` : unoBubble ? "UNO!" : player.reaction;
  const bubbleClass = penaltyAmount ? "seat-bubble penalty-bubble" : unoBubble ? "seat-bubble uno-bubble" : "seat-bubble";

  return (
    <article data-layout-role="opponent-seat" data-opponent-seat className={`seat-card ${compact ? "seat-card-compact" : ""}`} aria-label={`${player.displayName}, ${player.cardCount} cards${isTurn ? ", their turn" : ""}`}>
      {bubble ? <div className={bubbleClass}>{bubble}</div> : null}
      <div className={`seat-main ${isTurn ? "seat-active" : ""}`}>
        <span className={`seat-avatar ${isTurn ? "seat-avatar-active" : ""} ${player.connected ? "" : "seat-avatar-offline"}`}>
          {player.displayName.slice(0, 1).toUpperCase()}
          {!player.connected ? <span className="offline-dot" /> : null}
          {isTurn && timerSeconds !== undefined ? <span className="seat-timer">{timerSeconds}</span> : null}
        </span>
        <span className="seat-details">
          <strong>{player.displayName}</strong>
          <span className="seat-count">{player.cardCount}</span>
        </span>
      </div>
      {!compact ? <div className="seat-fan">{Array.from({ length: Math.min(player.cardCount, 5) }).map((_, index) => <CardBack key={`${player.id}-${index}`} dark className="seat-card-back" />)}</div> : null}
      {unoWindowOpen ? <span className="uno-question">UNO?</span> : null}
      {player.unoCalled ? <span className="uno-tag">UNO</span> : null}
    </article>
  );
}
