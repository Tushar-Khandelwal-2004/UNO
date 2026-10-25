"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import type { Card } from "@uno/game-engine";
import { checkLayout } from "@uno/game-engine/layoutGeometry";
import type { PublicRoom } from "@uno/protocol";
import { ActionBar } from "./components/ActionBar";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { DiscardPile } from "./components/DiscardPile";
import { DrawPile } from "./components/DrawPile";
import { Hand } from "./components/Hand";
import { LobbyPanel } from "./components/LobbyPanel";
import { OpponentSeat } from "./components/OpponentSeat";
import { ResultOverlay } from "./components/ResultOverlay";
import { Toast } from "./components/Toast";
import { TopBar } from "./components/TopBar";
import { WildColorPicker } from "./components/WildColorPicker";
import { useCardDrag } from "./hooks/useCardDrag";
import { useHandLayout } from "./hooks/useHandLayout";
import { useLegalCards } from "./hooks/useLegalCards";
import { useViewport } from "./hooks/useViewport";

const REALTIME_URL = process.env.NEXT_PUBLIC_REALTIME_URL ?? "http://localhost:4000";

function getGuestId(): string {
  const existing = window.localStorage.getItem("uno-guest-id");
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.localStorage.setItem("uno-guest-id", created);
  return created;
}

function sortHand(cards: Card[]): Card[] {
  const colorOrder: Record<Card["color"], number> = { red: 0, yellow: 1, green: 2, blue: 3, wild: 4 };
  const kindOrder: Record<Card["kind"], number> = { number: 0, skip: 1, reverse: 2, draw2: 3, wild: 4, wildDraw4: 5 };
  return [...cards].sort((left, right) => colorOrder[left.color] - colorOrder[right.color] || kindOrder[left.kind] - kindOrder[right.kind] || (left.value ?? -1) - (right.value ?? -1) || left.id.localeCompare(right.id));
}

export default function RoomPage() {
  const params = useParams<{ roomCode: string }>();
  const router = useRouter();
  const code = String(params.roomCode ?? "").toUpperCase();
  const viewport = useViewport();
  const [room, setRoom] = useState<PublicRoom | null>(null);
  const [hand, setHand] = useState<Card[]>([]);
  const [socket, setSocket] = useState<Socket | null>(null);
  const [error, setError] = useState("");
  const [toast, setToast] = useState("");
  const [pendingWild, setPendingWild] = useState<Card>();
  const [disconnected, setDisconnected] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [hapticsEnabled, setHapticsEnabled] = useState(true);
  const guest = useMemo(() => typeof window === "undefined" ? "" : getGuestId(), []);
  const playerName = typeof window === "undefined" ? "" : window.localStorage.getItem(`uno-name:${code}`) ?? "";
  const player = room?.players.find((candidate) => candidate.id === guest);
  const isMyTurn = Boolean(room?.game?.currentPlayerId === guest && room.status === "in_game" && !disconnected);
  const currentPlayer = room?.players.find((candidate) => candidate.id === room.game?.currentPlayerId);
  const topCard = room?.game?.topCard as Card | undefined;
  const sortedHand = useMemo(() => sortHand(hand), [hand]);
  const legalCardIds = useLegalCards(sortedHand, topCard, room?.game?.currentColor, isMyTurn);
  const handLayout = useHandLayout(sortedHand.length, viewport.phone, viewport.short);
  const drawPileRef = useRef<HTMLDivElement>(null);
  const discardPileRef = useRef<HTMLDivElement>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLElement>(null);
  const playerInfoRef = useRef<HTMLDivElement>(null);
  const handZoneRef = useRef<HTMLElement>(null);
  const actionBarRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!playerName) {
      router.replace("/");
      return;
    }
    const storedHaptics = window.localStorage.getItem("uno-haptics-enabled");
    if (storedHaptics !== null) setHapticsEnabled(storedHaptics !== "false");
  }, [playerName, router]);

  useEffect(() => {
    if (!room?.game?.turnEndsAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [room?.game?.turnEndsAt]);

  useEffect(() => {
    if (!playerName) return;
    const nextSocket = io(REALTIME_URL, { auth: { guestId: guest } });
    setSocket(nextSocket);
    nextSocket.on("connect", () => {
      setDisconnected(false);
      setRecovered(true);
      window.setTimeout(() => setRecovered(false), 1800);
    });
    nextSocket.on("disconnect", () => setDisconnected(true));
    nextSocket.on("room:state", (nextRoom: PublicRoom) => setRoom(nextRoom));
    nextSocket.on("player:hand", (nextHand: Card[]) => setHand(nextHand));
    nextSocket.on("connect_error", () => setError("Realtime server is unavailable."));
    nextSocket.emit("room:join", { roomCode: code, displayName: playerName }, (result: { ok: boolean; room?: PublicRoom; message?: string }) => {
      if (!result.ok || !result.room) {
        setError(result.message ?? "Unable to recover this room.");
        return;
      }
      setRoom(result.room);
      setError("");
    });
    return () => {
      nextSocket.disconnect();
    };
  }, [code, guest, playerName]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const check = () => {
      const named = [
        ["top-bar", topBarRef.current],
        ["draw-pile", drawPileRef.current],
        ["discard-pile", discardPileRef.current],
        ["status-line", statusRef.current],
        ["player-info", playerInfoRef.current],
        ["hand-zone", handZoneRef.current],
        ["action-bar", actionBarRef.current],
        ...Array.from(tableRef.current?.querySelectorAll<HTMLElement>("[data-opponent-seat]") ?? []).map((element, index) => [`opponent-${index}`, element] as const),
      ] as const;
      const rects = named.flatMap(([name, element]) => element ? [{ name, left: element.getBoundingClientRect().left, top: element.getBoundingClientRect().top, right: element.getBoundingClientRect().right, bottom: element.getBoundingClientRect().bottom }] : []);
      const report = checkLayout(rects, innerWidth, innerHeight, document.scrollingElement?.scrollHeight ?? 0);
      if (report.overlaps.length || report.outside.length || report.scroll) console.warn("UNO layout checker", report);
    };
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  });

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }, []);

  const vibrate = useCallback((duration: number) => {
    if (hapticsEnabled && "vibrate" in navigator) navigator.vibrate(duration);
  }, [hapticsEnabled]);

  const emitWithRoom = useCallback((event: string, payload?: unknown) => {
    if (!socket) return;
    const callback = (result: { ok: boolean; room?: PublicRoom; message?: string }) => {
      if (!result.ok) {
        const message = result.message ?? "That action could not be completed.";
        setError(message);
        showToast(message);
      } else if (result.room) {
        setRoom(result.room);
        setError("");
      }
    };
    if (payload === undefined) socket.emit(event, callback);
    else socket.emit(event, payload, callback);
  }, [showToast, socket]);

  const playCard = useCallback((card: Card) => {
    if (card.color === "wild") {
      setPendingWild(card);
      return;
    }
    emitWithRoom("game:play", { cardId: card.id });
  }, [emitWithRoom]);

  const drag = useCardDrag({
    hand: sortedHand,
    legalCardIds,
    isMyTurn,
    onPlay: playCard,
    onIllegalTap: (card) => {
      vibrate(40);
      showToast(`${card.color === "wild" ? "Wild" : card.color} ${card.value ?? card.kind} cannot be played here.`);
    },
    onLockedTap: () => showToast(`Waiting for ${currentPlayer?.displayName ?? "the current player"}.`),
  });

  const isHost = player?.isHost ?? false;
  const noMoves = isMyTurn && sortedHand.length > 0 && legalCardIds.size === 0;
  const unoTargets = room?.players.filter((candidate) => candidate.id !== guest && candidate.cardCount === 1 && !candidate.unoCalled) ?? [];
  const opponents = room?.players.filter((candidate) => candidate.id !== guest) ?? [];
  const topOpponents = opponents.slice(0, opponents.length <= 5 ? opponents.length : opponents.length === 6 ? 2 : 3);
  const leftOpponents = opponents.slice(topOpponents.length, topOpponents.length + 2);
  const rightOpponents = opponents.slice(topOpponents.length + 2);

  const copyInvite = async () => {
    await navigator.clipboard?.writeText(`${window.location.origin}/room/${room?.code ?? code}`);
    showToast("Invite link copied.");
  };

  if (!room) {
    return <main className="fixed inset-0 grid place-items-center overflow-hidden p-4"><div className="w-full max-w-md rounded-panel border border-white/15 bg-uno-panel p-6 text-center shadow-panel"><p className="m-0 text-sm text-uno-muted">{error || "Joining room…"}</p><button type="button" onClick={() => router.push("/")} className="mt-4 min-h-11 rounded-button bg-uno-blue px-5 font-extrabold">Back to home</button></div></main>;
  }

  const timerSeconds = room.game?.turnEndsAt ? Math.max(0, Math.ceil((room.game.turnEndsAt - now) / 1000)) : undefined;

  return (
    <main className="fixed inset-0 grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto] gap-2 overflow-hidden overscroll-none bg-uno-background p-2 text-uno-text sm:p-3">
      <div ref={topBarRef}><TopBar room={room} onLeave={() => router.push("/")} onTransferHost={(playerId) => emitWithRoom("room:transfer-host", { playerId })} hapticsEnabled={hapticsEnabled} onToggleHaptics={() => { const next = !hapticsEnabled; setHapticsEnabled(next); window.localStorage.setItem("uno-haptics-enabled", String(next)); }} /></div>
      <ConnectionBanner disconnected={disconnected} recovered={recovered} />

      <section ref={tableRef} className="relative min-h-0 overflow-hidden px-1 py-2 sm:px-4">
        {room.game ? (
          <div className="felt-texture game-table-grid rounded-panel border border-white/10 shadow-inner">
            <div className="game-table-top seat-row">
              {topOpponents.map((opponent) => <div data-opponent-seat key={opponent.id}><OpponentSeat player={opponent} isTurn={room.game?.currentPlayerId === opponent.id} turnEndsAt={room.game?.currentPlayerId === opponent.id ? room.game.turnEndsAt : undefined} onCatchUno={!opponent.unoCalled && opponent.cardCount === 1 ? () => emitWithRoom("game:call-uno", { targetPlayerId: opponent.id }) : undefined} /></div>)}
            </div>
            <div className="game-table-left seat-column">
              {leftOpponents.map((opponent) => <div data-opponent-seat key={opponent.id}><OpponentSeat player={opponent} isTurn={room.game?.currentPlayerId === opponent.id} turnEndsAt={room.game?.currentPlayerId === opponent.id ? room.game.turnEndsAt : undefined} onCatchUno={!opponent.unoCalled && opponent.cardCount === 1 ? () => emitWithRoom("game:call-uno", { targetPlayerId: opponent.id }) : undefined} /></div>)}
            </div>
            <div className="game-table-center play-piles">
              <DrawPile count={room.game.drawPileCount} disabled={!isMyTurn} pulse={noMoves} pileRef={drawPileRef} onDraw={() => emitWithRoom("game:draw")} />
              <DiscardPile topCard={topCard} currentColor={room.game.currentColor} targetRef={drag.dropTargetRef} pileRef={discardPileRef} active={drag.isDropActive || Boolean(drag.selectedCardId)} onClick={drag.dropSelectedCard} />
            </div>
            <div className="game-table-right seat-column">
              {rightOpponents.map((opponent) => <div data-opponent-seat key={opponent.id}><OpponentSeat player={opponent} isTurn={room.game?.currentPlayerId === opponent.id} turnEndsAt={room.game?.currentPlayerId === opponent.id ? room.game.turnEndsAt : undefined} onCatchUno={!opponent.unoCalled && opponent.cardCount === 1 ? () => emitWithRoom("game:call-uno", { targetPlayerId: opponent.id }) : undefined} /></div>)}
            </div>
            <div ref={statusRef} className="game-table-status flex items-center justify-center gap-2 rounded-full bg-black/25 px-3 py-1 text-xs font-bold text-white/80"><span>{room.game.currentPlayerId === guest ? "Your turn" : `Waiting for ${currentPlayer?.displayName ?? "player"}`}</span>{timerSeconds !== undefined ? <span className="text-uno-accent">· {timerSeconds}s</span> : null}{room.game.direction ? <span className="text-white/60">{room.game.direction === 1 ? "↻" : "↺"}</span> : null}</div>
          </div>
        ) : <div className="felt-texture grid h-full min-h-0 place-items-center overflow-hidden rounded-panel border border-white/10 p-3 shadow-inner"><LobbyPanel room={room} isHost={isHost} onStart={() => emitWithRoom("room:start")} onTransferHost={(playerId) => emitWithRoom("room:transfer-host", { playerId })} onCopy={copyInvite} /></div>}
      </section>

      <section ref={playerInfoRef} className="relative z-hand mx-auto flex min-h-11 w-full max-w-5xl items-center justify-between px-1 sm:px-4">
        <div className={`flex min-h-11 items-center gap-2 rounded-button border px-3 ${isMyTurn ? "border-uno-accent/60 bg-uno-accent/10" : "border-white/10 bg-black/10"}`}><span className="grid h-8 w-8 place-items-center rounded-full border-2 border-uno-blue bg-[#2d638b] text-xs font-extrabold">{playerName.slice(0, 1).toUpperCase()}</span><span className="text-sm font-extrabold">{playerName}</span><span className="text-xs text-uno-muted">{hand.length} cards</span></div>
      </section>

      <section ref={handZoneRef} className="relative z-hand mx-auto flex min-h-0 w-full max-w-6xl items-end px-1 sm:px-4">
        <Hand cards={sortedHand} layout={handLayout} drag={drag} legalCardIds={legalCardIds} isMyTurn={isMyTurn} />
      </section>

      <section ref={actionBarRef} className="relative z-hand mx-auto flex w-full max-w-5xl items-center justify-between gap-3 px-1 pb-1 sm:px-4">
        <ActionBar isMyTurn={isMyTurn} hasNoMoves={noMoves} canCallUno={hand.length === 1 && !player?.unoCalled && !disconnected} onDraw={() => emitWithRoom("game:draw")} onCallUno={() => emitWithRoom("game:call-uno", { targetPlayerId: guest })} isShortLandscape={viewport.short} />
      </section>

      <div className="sr-only" aria-live="polite">{isMyTurn ? "Your turn" : `Waiting for ${currentPlayer?.displayName ?? "the current player"}`}{error ? ` ${error}` : ""}</div>
      <Toast message={toast} />
      {room.game?.winnerId ? <ResultOverlay winner={room.players.find((candidate) => candidate.id === room.game?.winnerId)?.displayName ?? "Player"} didWin={room.game.winnerId === guest} onHome={() => router.push("/")} /> : null}
      {pendingWild ? <WildColorPicker card={pendingWild} onCancel={() => setPendingWild(undefined)} onChoose={(chosenColor) => { setPendingWild(undefined); emitWithRoom("game:play", { cardId: pendingWild.id, chosenColor }); }} /> : null}
      {unoTargets.length > 0 ? <div className="pointer-events-none fixed bottom-20 left-1/2 z-30 hidden -translate-x-1/2 rounded-full bg-uno-error/90 px-3 py-1 text-xs font-extrabold text-[#351416] md:block">{unoTargets[0]!.displayName} has one card</div> : null}
    </main>
  );
}
