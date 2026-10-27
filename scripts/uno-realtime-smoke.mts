import { io as connect, type Socket } from "socket.io-client";
import { canPlay, type Card } from "../packages/game-engine/src/index.ts";
import type { PublicRoom } from "../packages/protocol/src/index.ts";
import { createRealtimeServer, type RealtimeServer } from "../apps/realtime/src/server.ts";

type AckResult = {
  ok: boolean;
  room?: PublicRoom;
  code?: string;
  message?: string;
};

const TURN_SECONDS = 2;
const UNO_GRACE_MS = 3_000;
const clients: Socket[] = [];
const observedHands = new Map<string, Card[]>();
const notices: Array<Record<string, unknown>> = [];
let latestRoom: PublicRoom | undefined;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function emitAck(socket: Socket, event: string, payload?: unknown): Promise<AckResult> {
  return new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, resolve);
    else socket.emit(event, payload, resolve);
  });
}

function attachClient(socket: Socket, playerId: string): void {
  clients.push(socket);
  socket.on("room:state", (room: PublicRoom) => {
    latestRoom = room;
  });
  socket.on("player:hand", (hand: Card[]) => {
    observedHands.set(playerId, hand);
  });
  socket.on("game:notice", (notice: Record<string, unknown>) => {
    notices.push(notice);
  });
}

async function connectClient(url: string, playerId: string): Promise<Socket> {
  const socket = connect(url, {
    auth: { guestId: playerId },
    transports: ["websocket"],
  });
  attachClient(socket, playerId);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  return socket;
}

function roomOrThrow(): PublicRoom {
  if (!latestRoom?.game) throw new Error("The smoke room has no active game");
  return latestRoom;
}

function socketFor(playerId: string, first: Socket, second: Socket): Socket {
  if (playerId === "smoke-p1") return first;
  if (playerId === "smoke-p2") return second;
  throw new Error(`Unknown player ${playerId}`);
}

async function applyAck(result: AckResult): Promise<PublicRoom> {
  if (!result.ok || !result.room) throw new Error(result.message ?? "Smoke action failed");
  latestRoom = result.room;
  await sleep(5);
  return result.room;
}

async function drawAndMaybePass(playerId: string, first: Socket, second: Socket): Promise<void> {
  const socket = socketFor(playerId, first, second);
  const result = await emitAck(socket, "game:draw");
  if (!result.ok) {
    await sleep(5);
    return;
  }
  const room = await applyAck(result);
  if (room.game?.currentPlayerId === playerId && room.game.drewThisTurn) {
    await applyAck(await emitAck(socket, "game:pass"));
  }
}

async function findMissedUnoWindow(first: Socket, second: Socket): Promise<PublicRoom> {
  for (let step = 0; step < 600; step += 1) {
    const room = roomOrThrow();
    const targetHand = observedHands.get("smoke-p1") ?? [];
    if (targetHand.length === 1 && room.game?.unoWindow?.playerId === "smoke-p1") return room;

    const currentPlayerId = room.game.currentPlayerId;
    if (currentPlayerId === "smoke-p1" && targetHand.length > 1) {
      const topCard = room.game.topCard as Card;
      const playable = targetHand.find((card) => canPlay(card, topCard, room.game!.currentColor as Card["color"]));
      if (playable) {
        const chosenColor = playable.color === "wild" ? "blue" : undefined;
        await applyAck(await emitAck(first, "game:play", { cardId: playable.id, chosenColor }));
        continue;
      }
    }

    await drawAndMaybePass(currentPlayerId, first, second);
  }
  throw new Error("Could not reach the missed-UNO state in 600 socket actions");
}

async function run(): Promise<void> {
  const runtime: RealtimeServer = createRealtimeServer({
    logger: false,
    turnSeconds: TURN_SECONDS,
    random: () => 0.999,
  });
  try {
    const port = await runtime.start(0, "127.0.0.1");
    const url = `http://127.0.0.1:${port}`;
    const first = await connectClient(url, "smoke-p1");
    const second = await connectClient(url, "smoke-p2");

    const created = await emitAck(first, "room:create", { displayName: "Alice" });
    if (!created.ok || !created.room) throw new Error(created.message ?? "Room creation failed");
    latestRoom = created.room;
    const joined = await emitAck(second, "room:join", { roomCode: created.room.code, displayName: "Bob" });
    await applyAck(joined);
    await applyAck(await emitAck(first, "room:start"));
    await sleep(50);

    const started = roomOrThrow();
    const drawFourPlayerId = started.game.currentPlayerId;
    const drawFourSocket = socketFor(drawFourPlayerId, first, second);
    const drawFourCard = (observedHands.get(drawFourPlayerId) ?? []).find((card) => card.kind === "wildDraw4");
    if (!drawFourCard) throw new Error("The deterministic smoke hand did not contain Wild Draw Four");
    const victimId = started.players.find((player) => player.id !== drawFourPlayerId)?.id ?? "";
    const victimBefore = started.players.find((player) => player.id === victimId)?.cardCount ?? 0;
    const afterDrawFour = await applyAck(await emitAck(drawFourSocket, "game:play", { cardId: drawFourCard.id, chosenColor: "red" }));
    const victimAfter = afterDrawFour.players.find((player) => player.id === victimId)?.cardCount ?? 0;
    console.log("[smoke] draw-four", JSON.stringify({
      currentPlayerBefore: drawFourPlayerId,
      victimId,
      victimCardsBefore: victimBefore,
      victimCardsAfter: victimAfter,
      currentPlayerAfter: afterDrawFour.game?.currentPlayerId,
      notices: notices.slice(-2),
    }));

    await sleep(TURN_SECONDS * 1000 + 250);
    const afterTimeout = roomOrThrow();
    console.log("[smoke] timeout", JSON.stringify({
      currentPlayerAfterTimeout: afterTimeout.game.currentPlayerId,
      turnEndsAt: afterTimeout.game.turnEndsAt,
      serverTime: afterTimeout.game.serverTime,
      timeoutNotice: notices.findLast((notice) => notice.type === "timeout"),
    }));

    const unoWindowRoom = await findMissedUnoWindow(first, second);
    const unoPlayerBefore = unoWindowRoom.players.find((player) => player.id === "smoke-p1")?.cardCount ?? 0;
    const unoWindowEndsAt = unoWindowRoom.game?.unoWindow?.endsAt;
    await sleep(UNO_GRACE_MS + 250);
    const afterMissedUno = roomOrThrow();
    const unoPlayerAfter = afterMissedUno.players.find((player) => player.id === "smoke-p1")?.cardCount ?? 0;
    console.log("[smoke] missed-uno", JSON.stringify({
      playerId: "smoke-p1",
      unoWindowEndsAt,
      cardsBeforePenalty: unoPlayerBefore,
      cardsAfterPenalty: unoPlayerAfter,
      unoWindowAfter: afterMissedUno.game?.unoWindow,
      penaltyNotice: notices.findLast((notice) => notice.type === "uno_penalty"),
    }));

    const observedBefore = new Set(Array.from(observedHands.values()).flat().map((card) => card.id));
    let explicitDraws = 0;
    while (explicitDraws < 1_000) {
      const room = roomOrThrow();
      const currentPlayerId = room.game.currentPlayerId;
      const result = await emitAck(socketFor(currentPlayerId, first, second), "game:draw");
      if (!result.ok) {
        await sleep(5);
        continue;
      }
      explicitDraws += 1;
      const afterDraw = await applyAck(result);
      if (afterDraw.game?.currentPlayerId === currentPlayerId && afterDraw.game.drewThisTurn) {
        await applyAck(await emitAck(socketFor(currentPlayerId, first, second), "game:pass"));
      }
    }
    await sleep(50);
    const observedAfter = new Set(Array.from(observedHands.values()).flat().map((card) => card.id));
    console.log("[smoke] unlimited-draw", JSON.stringify({
      explicitDraws,
      uniqueObservedCardIdsAdded: observedAfter.size - observedBefore.size,
      drawPileCount: roomOrThrow().game?.drawPileCount,
      gameStatus: roomOrThrow().status,
    }));
  } finally {
    for (const client of clients.splice(0)) client.disconnect();
    await runtime.close();
  }
}

run().catch((error) => {
  console.error("[smoke] failed", error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
