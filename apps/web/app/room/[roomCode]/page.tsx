"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { io, type Socket } from "socket.io-client";
import type { Card } from "@uno/game-engine";
import { checkLayout, type LayoutRect } from "@uno/game-engine/layoutGeometry";
import type { GameNotice, PublicRoom, QuickMessage } from "@uno/protocol";
import { ActionBar } from "./components/ActionBar";
import { ConnectionBanner } from "./components/ConnectionBanner";
import { DiscardPile } from "./components/DiscardPile";
import { DrawPile } from "./components/DrawPile";
import { Hand } from "./components/Hand";
import { LobbyPanel } from "./components/LobbyPanel";
import { OpponentSeat } from "./components/OpponentSeat";
import { PlayerInfo } from "./components/PlayerInfo";
import { QuickMessagePicker } from "./components/QuickMessagePicker";
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

function rectOf(name: string, element: HTMLElement | null): LayoutRect | undefined {
  if (!element) return undefined;
  const rect = element.getBoundingClientRect();
  return { name, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

export default function RoomPage() {
  const params = useParams<{ roomCode: string }>();
  const router = useRouter();
  const code = String(params.roomCode ?? "").toUpperCase();
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
  const [messageOpen, setMessageOpen] = useState(false);
  const [notice, setNotice] = useState<GameNotice>();
  const [penalties, setPenalties] = useState<Record<string, number>>({});
  const [lastHapticSecond, setLastHapticSecond] = useState<number>();
  const tableRef = useRef<HTMLElement>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const playerInfoRef = useRef<HTMLElement>(null);
  const handZoneRef = useRef<HTMLElement>(null);
  const actionBarRef = useRef<HTMLElement>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const drawPileRef = useRef<HTMLDivElement>(null);
  const discardPileRef = useRef<HTMLDivElement>(null);
  const guest = useMemo(() => typeof window === "undefined" ? "" : getGuestId(), []);
  const playerName = typeof window === "undefined" ? "" : window.localStorage.getItem(`uno-name:${code}`) ?? "";
  const player = room?.players.find((candidate) => candidate.id === guest);
  const isGame = room?.status === "in_game" || room?.status === "finished";
  const isMyTurn = Boolean(room?.game?.currentPlayerId === guest && room.status === "in_game" && !disconnected);
  const currentPlayer = room?.players.find((candidate) => candidate.id === room.game?.currentPlayerId);
  const topCard = room?.game?.topCard as Card | undefined;
  const sortedHand = useMemo(() => sortHand(hand), [hand]);
  const viewport = useViewport();
  const handLayout = useHandLayout(sortedHand.length, viewport.cardWidth, viewport.phone, viewport.short);
  const legalCardIds = useLegalCards(sortedHand, topCard, room?.game?.currentColor, isMyTurn);
  const serverOffset = room?.game?.serverTime ? room.game.serverTime - now : 0;
  const correctedNow = now + serverOffset;
  const timerSeconds = room?.game?.turnEndsAt ? Math.max(0, Math.ceil((room.game.turnEndsAt - correctedNow) / 1000)) : undefined;
  const timerRatio = room?.game?.turnEndsAt ? Math.max(0, Math.min(1, (room.game.turnEndsAt - correctedNow) / ((room.turnSeconds || 30) * 1000))) : 0;
  const myUnoWindow = room?.game?.unoWindow?.playerId === guest ? room.game.unoWindow : undefined;
  const unoWindowSeconds = myUnoWindow ? Math.max(0, Math.ceil((myUnoWindow.endsAt - correctedNow) / 1000)) : 0;
  const canCallUno = Boolean(room?.game && ((isMyTurn && hand.length === 2) || hand.length === 1) && !player?.unoCalled && !disconnected);
  const noMoves = isMyTurn && sortedHand.length > 0 && legalCardIds.size === 0;
  const unoLabel = player?.unoCalled ? "Called" : myUnoWindow ? `UNO! ${unoWindowSeconds}s` : "Call UNO";
  const opponents = room?.players.filter((candidate) => candidate.id !== guest) ?? [];
  const compactOpponents = viewport.phone;
  const topOpponents = compactOpponents ? opponents : opponents.length <= 5 ? opponents : opponents.length <= 7 ? opponents.slice(0, opponents.length - 4) : opponents.slice(0, 3);
  const sideOpponents = compactOpponents || opponents.length <= 5 ? [] : opponents.slice(topOpponents.length);
  const leftOpponents = sideOpponents.filter((_, index) => index % 2 === 0);
  const rightOpponents = sideOpponents.filter((_, index) => index % 2 === 1);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2200);
  }, []);

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

  const vibrate = useCallback((duration: number) => {
    if (hapticsEnabled && "vibrate" in navigator) navigator.vibrate(duration);
  }, [hapticsEnabled]);

  useEffect(() => {
    if (!playerName) {
      router.replace("/");
      return;
    }
    const storedHaptics = window.localStorage.getItem("uno-haptics-enabled");
    if (storedHaptics !== null) setHapticsEnabled(storedHaptics !== "false");
  }, [playerName, router]);

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
    nextSocket.on("game:notice", (nextNotice: GameNotice) => {
      setNotice(nextNotice);
      showToast(nextNotice.text);
      window.setTimeout(() => setNotice((current) => current?.id === nextNotice.id ? undefined : current), 2200);
      if (nextNotice.type === "draw_penalty" || nextNotice.type === "uno_penalty") {
        setPenalties((current) => ({ ...current, [nextNotice.playerId]: nextNotice.amount ?? 0 }));
        window.setTimeout(() => setPenalties((current) => ({ ...current, [nextNotice.playerId]: 0 })), 2200);
      }
    });
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
  }, [code, guest, playerName, showToast]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!isMyTurn || timerSeconds !== 5 || lastHapticSecond === 5) return;
    setLastHapticSecond(5);
    vibrate(70);
  }, [isMyTurn, lastHapticSecond, timerSeconds, vibrate]);

  useEffect(() => {
    if (timerSeconds !== 5) setLastHapticSecond(undefined);
  }, [timerSeconds]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const check = () => {
      const rects = [
        rectOf("top-bar", topBarRef.current),
        rectOf("player-info", playerInfoRef.current),
        rectOf("hand-zone", handZoneRef.current),
        rectOf("action-bar", actionBarRef.current),
        rectOf("draw-pile", drawPileRef.current),
        rectOf("discard-pile", discardPileRef.current),
        rectOf("status-line", statusRef.current),
        ...Array.from(tableRef.current?.querySelectorAll<HTMLElement>("[data-opponent-seat]") ?? []).map((element, index) => rectOf(`opponent-${index}`, element)),
        rectOf("lobby-panel", document.querySelector<HTMLElement>("[data-layout-role='lobby-panel']")),
      ].filter((rect): rect is LayoutRect => Boolean(rect));
      const report = checkLayout(rects, innerWidth, innerHeight, document.scrollingElement?.scrollHeight ?? 0);
      document.documentElement.dataset.layoutIssues = JSON.stringify(report);
      if (report.overlaps.length || report.outside.length || report.scroll) console.warn("UNO layout checker", report);
    };
    const observer = new ResizeObserver(check);
    if (tableRef.current) observer.observe(tableRef.current);
    check();
    window.addEventListener("resize", check);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", check);
    };
  }, [room, handLayout]);

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

  const copyInvite = async () => {
    await navigator.clipboard?.writeText(`${window.location.origin}/room/${room?.code ?? code}`);
    showToast("Invite link copied.");
  };

  if (!room) return <main className="app-shell loading-shell"><div className="loading-card"><p>{error || "Joining room…"}</p><button type="button" onClick={() => router.push("/")}>Back to home</button></div></main>;

  const renderSeat = (opponent: PublicRoom["players"][number], compact = compactOpponents) => (
    <OpponentSeat
      key={opponent.id}
      player={opponent}
      compact={compact}
      isTurn={room.game?.currentPlayerId === opponent.id}
      timerSeconds={room.game?.currentPlayerId === opponent.id ? timerSeconds : undefined}
      unoWindowOpen={room.game?.unoWindow?.playerId === opponent.id}
      unoBubble={Boolean(opponent.unoCalled && notice?.type === "uno_called" && notice.playerId === opponent.id)}
      penaltyAmount={penalties[opponent.id]}
    />
  );

  return (
    <main data-screen={isGame ? "game" : "lobby"} data-players={room.players.length} data-hand-size={hand.length} data-current-player={room.game?.currentPlayerId ?? ""} className={`app-shell ${isGame ? "game-shell" : "lobby-shell"}`}>
      <div ref={topBarRef}><TopBar room={room} onLeave={() => router.push("/")} onTransferHost={(playerId) => emitWithRoom("room:transfer-host", { playerId })} hapticsEnabled={hapticsEnabled} onToggleHaptics={() => { const next = !hapticsEnabled; setHapticsEnabled(next); window.localStorage.setItem("uno-haptics-enabled", String(next)); }} onCopyInvite={copyInvite} /></div>
      <ConnectionBanner disconnected={disconnected} recovered={recovered} />

      {room.status === "open" ? (
        <section className="lobby-screen">
          <div className="lobby-panel-wrap"><LobbyPanel room={room} isHost={player?.isHost ?? false} onStart={() => emitWithRoom("room:start")} onTransferHost={(playerId) => emitWithRoom("room:transfer-host", { playerId })} onCopy={copyInvite} /></div>
        </section>
      ) : (
        <>
          <section ref={tableRef} data-layout-role="table" className="game-table-shell">
            {room.game?.turnEndsAt ? <div className="table-progress-track" aria-hidden="true"><span className={`table-progress ${timerSeconds !== undefined && timerSeconds <= 5 ? "progress-red" : timerSeconds !== undefined && timerSeconds <= 10 ? "progress-yellow" : "progress-green"}`} style={{ transform: `scaleX(${timerRatio})` }} /></div> : null}
            <div className="game-table">
              <div className="opponent-top-band">{topOpponents.map((opponent) => renderSeat(opponent))}</div>
              <div className="opponent-side opponent-side-left">{leftOpponents.map((opponent) => renderSeat(opponent, false))}</div>
              <div className="table-center-zone">
                <div className="play-piles"><DrawPile disabled={!isMyTurn} pulse={noMoves} pileRef={drawPileRef} onDraw={() => emitWithRoom("game:draw")} /><DiscardPile topCard={topCard} currentColor={room.game?.currentColor} targetRef={drag.dropTargetRef} pileRef={discardPileRef} active={drag.isDropActive || Boolean(drag.selectedCardId)} onClick={drag.dropSelectedCard} /></div>
                <div ref={statusRef} data-layout-role="status-line" className="status-line"><strong>{isMyTurn ? "Your turn" : `Waiting for ${currentPlayer?.displayName ?? "player"}`}</strong>{timerSeconds !== undefined ? <span>{timerSeconds}s</span> : null}{room.game?.direction ? <span>{room.game.direction === 1 ? "↻" : "↺"}</span> : null}</div>
              </div>
              <div className="opponent-side opponent-side-right">{rightOpponents.map((opponent) => renderSeat(opponent, false))}</div>
            </div>
          </section>
          <section ref={playerInfoRef} className="player-info-row"><PlayerInfo name={playerName} cardCount={hand.length} isMyTurn={isMyTurn} reaction={player?.reaction} unoBubble={Boolean(player?.unoCalled && notice?.type === "uno_called" && notice.playerId === guest)} onChat={() => setMessageOpen((value) => !value)} />{messageOpen ? <QuickMessagePicker onChoose={(message: QuickMessage) => { emitWithRoom("player:reaction", { messageId: message }); setMessageOpen(false); }} /> : null}</section>
          <section ref={handZoneRef} className="hand-section"><Hand cards={sortedHand} layout={handLayout} drag={drag} legalCardIds={legalCardIds} isMyTurn={isMyTurn} /></section>
          <section ref={actionBarRef} className="action-section"><ActionBar isMyTurn={isMyTurn} hasNoMoves={noMoves} drewThisTurn={Boolean(room.game?.drewThisTurn && isMyTurn)} canCallUno={canCallUno} unoLabel={unoLabel} onDraw={() => emitWithRoom(room.game?.drewThisTurn && isMyTurn ? "game:pass" : "game:draw")} onCallUno={() => emitWithRoom("game:call-uno", { targetPlayerId: guest })} /></section>
        </>
      )}

      <div className="sr-only" aria-live="polite">{isMyTurn ? "Your turn" : `Waiting for ${currentPlayer?.displayName ?? "the current player"}`}{error ? ` ${error}` : ""}</div>
      <Toast message={toast} />
      {room.game?.winnerId ? <ResultOverlay winner={room.players.find((candidate) => candidate.id === room.game?.winnerId)?.displayName ?? "Player"} didWin={room.game.winnerId === guest} onHome={() => router.push("/")} /> : null}
      {pendingWild ? <WildColorPicker card={pendingWild} onCancel={() => setPendingWild(undefined)} onChoose={(chosenColor) => { setPendingWild(undefined); emitWithRoom("game:play", { cardId: pendingWild.id, chosenColor }); }} /> : null}
    </main>
  );
}
