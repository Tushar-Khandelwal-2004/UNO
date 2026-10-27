"use client";

import type { QuickMessage } from "@uno/protocol";

export function PlayerInfo({ name, cardCount, isMyTurn, reaction, unoBubble, onChat }: { name: string; cardCount: number; isMyTurn: boolean; reaction?: QuickMessage; unoBubble: boolean; onChat: () => void }) {
  return (
    <div className={`player-info-card ${isMyTurn ? "player-info-active" : ""}`}>
      {unoBubble ? <div className="seat-bubble uno-bubble player-bubble">UNO!</div> : reaction ? <div className="seat-bubble player-bubble">{reaction}</div> : null}
      <span className="player-avatar">{name.slice(0, 1).toUpperCase()}</span>
      <span className="player-info-copy"><strong>{name}</strong><span>{cardCount} cards</span></span>
      <button data-testid="chat-button" type="button" className="chat-button" aria-label="Open quick messages" onClick={onChat}>♡</button>
    </div>
  );
}
