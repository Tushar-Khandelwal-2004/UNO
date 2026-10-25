"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import type { Card } from "@uno/game-engine";
import type { PublicRoom } from "@uno/protocol";

const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL ?? "http://localhost:4000";
const REACTIONS = ["good-luck", "nice-move", "oops", "uno", "gg"];

function getGuestId(): string {
  const existing = window.localStorage.getItem("uno-guest-id");
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem("uno-guest-id", created);
  return created;
}

function cardLabel(card: Card): string {
  if (card.kind === "number") return String(card.value);
  if (card.kind === "wildDraw4") return "+4";
  if (card.kind === "draw2") return "+2";
  if (card.kind === "skip") return "Skip";
  if (card.kind === "reverse") return "↻";
  return "Wild";
}

function reactionLabel(reaction?: string): string | undefined {
  if (!reaction) return undefined;
  if (reaction === "didn't-call-uno") return "Didn't call UNO";
  return reaction.replaceAll("-", " ");
}

export default function RoomPage() {
  const params = useParams<{ roomCode: string }>();
  const router = useRouter();
  const code = String(params.roomCode ?? "").toUpperCase();
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [hand, setHand] = useState<Card[]>([]);
  const [error, setError] = useState("");
  const [socket, setSocket] = useState<Socket | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<string>();
  const [draggedCardId, setDraggedCardId] = useState<string>();
  const guest = useMemo(() => typeof window === "undefined" ? "" : getGuestId(), []);
  const playerName = typeof window === "undefined" ? "" : window.localStorage.getItem(`uno-name:${code}`) ?? "";
  const player = room?.players.find((candidate) => candidate.id === guest);
  const isHost = player?.isHost ?? false;
  const currentPlayer = room?.players.find((candidate) => candidate.id === room.game?.currentPlayerId);
  const topCard = room?.game?.topCard as Card | undefined;
  const selectedCard = hand.find((card) => card.id === selectedCardId);

  useEffect(() => {
    if (!playerName) {
      router.replace("/");
      return;
    }
    const nextSocket = io(REALTIME_URL, { auth: { guestId: guest } });
    setSocket(nextSocket);
    nextSocket.on("room:state", (nextRoom: PublicRoom) => setRoom(nextRoom));
    nextSocket.on("player:hand", (nextHand: Card[]) => setHand(nextHand));
    nextSocket.on("connect_error", () => setError("Realtime server is unavailable. Start the local realtime service and try again."));
    nextSocket.emit("room:join", { roomCode: code, displayName: playerName }, (result: { ok: boolean; room?: PublicRoom; message?: string }) => {
      if (!result.ok || !result.room) {
        setError(result.message ?? "Unable to recover this room.");
        return;
      }
      setRoom(result.room);
    });
    return () => {
      nextSocket.disconnect();
    };
  }, [code, guest, playerName, router]);

  function emitWithRoom(event: string, payload?: unknown) {
    if (!socket) return;
    const callback = (result: { ok: boolean; room?: PublicRoom; message?: string }) => {
      if (!result.ok) setError(result.message ?? "That action could not be completed.");
      else if (result.room) setRoom(result.room);
    };
    if (payload === undefined) socket.emit(event, callback);
    else socket.emit(event, payload, callback);
  }

  function play(card: Card) {
    const chosenColor = card.color === "wild" ? window.prompt("Choose a color: red, yellow, green, or blue")?.toLowerCase() : undefined;
    if (card.color === "wild" && !["red", "yellow", "green", "blue"].includes(chosenColor ?? "")) return;
    setSelectedCardId(undefined);
    setDraggedCardId(undefined);
    emitWithRoom("game:play", { cardId: card.id, chosenColor });
  }

  function dropSelectedCard() {
    const card = hand.find((candidate) => candidate.id === (draggedCardId ?? selectedCardId));
    if (card) play(card);
  }

  if (!room) {
    return <main className="page-shell"><section className="panel"><p>{error || "Joining room…"}</p></section></main>;
  }

  const opponents = room.players.filter((candidate) => candidate.id !== guest);
  const unoTargets = room.players.filter((candidate) => candidate.id !== guest && candidate.cardCount === 1 && !candidate.unoCalled);

  return (
    <main className="game-shell">
      <header className="game-header">
        <div className="room-title"><span className="room-gear">⚙</span><span>Room: <strong>{room.code.toLowerCase()}</strong></span></div>
        <div className="game-header-actions">
          <span className="turn-pill">{room.status === "finished" ? "Match finished" : `Turn: ${currentPlayer?.displayName ?? "…"}`}</span>
          <button className="icon-button" aria-label="Leave room" onClick={() => router.push("/")}>×</button>
        </div>
      </header>

      <section className="uno-table-layout">
        <div className="opponents-ring">
          {opponents.map((candidate, index) => (
            <article className={`opponent-seat seat-${index % 7} ${room.game?.currentPlayerId === candidate.id ? "active-turn" : ""}`} key={candidate.id}>
              <div className="opponent-label">
                <span className="avatar">{candidate.displayName.slice(0, 1).toUpperCase()}</span>
                <span><strong>{candidate.displayName}</strong><small>{candidate.cardCount} card{candidate.cardCount === 1 ? "" : "s"}</small></span>
                {candidate.isHost ? <span className="host-dot">★</span> : null}
              </div>
              <div className="opponent-hand" aria-label={`${candidate.displayName} has ${candidate.cardCount} cards`}>
                {Array.from({ length: Math.min(candidate.cardCount, 8) }).map((_, cardIndex) => <span className="mini-card-back" key={`${candidate.id}-${cardIndex}`} />)}
                <span className="opponent-count">{candidate.cardCount}</span>
              </div>
              {reactionLabel(candidate.reaction) ? <span className="opponent-reaction">{reactionLabel(candidate.reaction)}</span> : null}
            </article>
          ))}
        </div>

        <section className="felt-table">
          <div className="table-meta">
            <span>{room.players.length}/{room.maxPlayers} players</span>
            <span>Rule set {room.rulesetVersion}</span>
          </div>
          {room.game ? (
            <>
              <div className="center-play-area">
                <button className="draw-pile" onClick={() => emitWithRoom("game:draw")} disabled={room.status !== "in_game"} aria-label={`Draw card, ${room.game.drawPileCount} cards left`}>
                  <span className="card-back-pattern" />
                  <strong>DRAW</strong>
                  <small>{room.game.drawPileCount} left</small>
                </button>
                <div className={`drop-zone ${draggedCardId || selectedCardId ? "drop-ready" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={dropSelectedCard} onClick={selectedCard ? dropSelectedCard : undefined}>
                  <span className="drop-label">{selectedCard ? "Play selected card" : "Drop card here"}</span>
                  {topCard ? <div className={`uno-card center-card ${topCard.color}`}><span className="card-corner">{cardLabel(topCard)}</span><span className="card-symbol">{cardLabel(topCard)}</span><span className="card-corner bottom">{cardLabel(topCard)}</span></div> : null}
                </div>
              </div>
              <div className="table-status">
                <span><span className="color-indicator" data-color={room.game.currentColor} /> Current color: <strong>{room.game.currentColor}</strong></span>
                <span>{currentPlayer?.displayName ?? ""}'s turn</span>
              </div>
            </>
          ) : (
            <div className="lobby-center">
              <span className="lobby-kicker">Room lobby</span>
              <h2>Ready when you are?</h2>
              <p>{room.players.length < 2 ? "Invite at least one more player to unlock the match." : "Everyone is in. The host can start the table."}</p>
              {isHost ? <button className="start-game-button" disabled={room.players.length < 2} onClick={() => emitWithRoom("room:start")}>Start game <span>→</span></button> : <div className="waiting-host">Waiting for {room.players.find((candidate) => candidate.isHost)?.displayName ?? "the host"} to start</div>}
            </div>
          )}
        </section>
      </section>

      <section className="player-zone">
        <div className={`player-banner ${room.game?.currentPlayerId === guest ? "your-turn" : ""}`}>
          <div className="player-banner-name"><span className="avatar my-avatar">{playerName.slice(0, 1).toUpperCase()}</span><strong>{playerName}</strong>{isHost ? <span className="host-badge">HOST</span> : null}</div>
          <div className="player-banner-meta">{hand.length} cards · {room.turnSeconds}s turn timer</div>
        </div>
        <div className="hand-stage" aria-label="Your hand">
          {hand.map((card, index) => (
            <button
              className={`uno-card hand-card ${card.color} ${selectedCardId === card.id ? "selected" : ""}`}
              key={card.id}
              draggable
              style={{ zIndex: index + 1 }}
              onClick={() => setSelectedCardId(selectedCardId === card.id ? undefined : card.id)}
              onDragStart={() => { setDraggedCardId(card.id); setSelectedCardId(card.id); }}
              onDragEnd={() => setDraggedCardId(undefined)}
              aria-label={`Play ${cardLabel(card)} card`}
            >
              <span className="card-corner">{cardLabel(card)}</span><span className="card-symbol">{cardLabel(card)}</span><span className="card-corner bottom">{cardLabel(card)}</span>
            </button>
          ))}
        </div>
        <div className="action-bar">
          <button className="draw-button" onClick={() => emitWithRoom("game:draw")} disabled={room.status !== "in_game"}>Draw card</button>
          <button className="call-uno-button" onClick={() => emitWithRoom("game:call-uno", { targetPlayerId: guest })} disabled={hand.length !== 1 || Boolean(player?.unoCalled)}>Call UNO</button>
          {unoTargets.map((target) => <button className="catch-uno-button" key={target.id} onClick={() => emitWithRoom("game:call-uno", { targetPlayerId: target.id })}>Call UNO on {target.displayName}</button>)}
        </div>
        <div className="reaction-row game-reactions">
          {REACTIONS.map((reaction) => <button key={reaction} className="reaction-button" onClick={() => emitWithRoom("player:reaction", { messageId: reaction })}>{reaction.replaceAll("-", " ")}</button>)}
        </div>
        {room.status === "finished" ? <div className="finish-banner">Winner: {room.players.find((candidate) => candidate.id === room.game?.winnerId)?.displayName ?? "Player"}</div> : null}
        {error ? <p className="error game-error">{error}</p> : null}
      </section>
    </main>
  );
}
