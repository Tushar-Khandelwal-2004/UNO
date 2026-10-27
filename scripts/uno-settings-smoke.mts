import { io as connect, type Socket } from "socket.io-client";
import type { PublicRoom } from "../packages/protocol/src/index.ts";
import { createRealtimeServer, type RealtimeServer } from "../apps/realtime/src/server.ts";

type Ack = { ok: boolean; room?: PublicRoom; code?: string; message?: string };
const clients: Socket[] = [];

function emitAck(socket: Socket, event: string, payload?: unknown): Promise<Ack> {
  return new Promise((resolve) => payload === undefined ? socket.emit(event, resolve) : socket.emit(event, payload, resolve));
}

async function connectClient(url: string, guestId: string): Promise<Socket> {
  const socket = connect(url, { auth: { guestId }, transports: ["websocket"] });
  clients.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  return socket;
}

function requireRoom(result: Ack): PublicRoom {
  if (!result.ok || !result.room) throw new Error(result.message ?? "Socket action failed");
  return result.room;
}

async function run(): Promise<void> {
  const runtime: RealtimeServer = createRealtimeServer({ logger: false, turnSeconds: 0, random: () => 0.5 });
  try {
    const port = await runtime.start(0, "127.0.0.1");
    const url = `http://127.0.0.1:${port}`;
    const p1 = await connectClient(url, "settings-smoke-p1");
    const p2 = await connectClient(url, "settings-smoke-p2");
    const p3 = await connectClient(url, "settings-smoke-p3");

    const created = requireRoom(await emitAck(p1, "room:create", { displayName: "Host" }));
    await emitAck(p2, "room:join", { roomCode: created.code, displayName: "Stacker" });
    await emitAck(p3, "room:join", { roomCode: created.code, displayName: "Kicked" });
    const configured = requireRoom(await emitAck(p1, "room:settings", {
      startingHand: 5,
      turnSeconds: 0,
      stackDrawCards: true,
      unoPenaltyCards: 2,
      drawUntilPlayable: true,
      sevenZero: true,
    }));
    console.log("[settings-smoke] settings", JSON.stringify(configured.settings));

    const started = requireRoom(await emitAck(p1, "room:start"));
    const room = runtime.rooms.get(created.code);
    if (!room?.game) throw new Error("Game was not created");
    console.log("[settings-smoke] starting-hand", JSON.stringify({
      settings: started.settings,
      handSizes: room.game.players.map((player) => ({ playerId: player.id, cards: player.hand.length })),
      turnEndsAt: started.game?.turnEndsAt,
    }));

    const p1Game = room.game.players.find((player) => player.id === "settings-smoke-p1")!;
    const p2Game = room.game.players.find((player) => player.id === "settings-smoke-p2")!;
    const p3Game = room.game.players.find((player) => player.id === "settings-smoke-p3")!;
    p1Game.hand = [
      { id: "smoke-draw2-1", color: "red", kind: "draw2" },
      { id: "smoke-p1-spare", color: "blue", kind: "number", value: 1 },
    ];
    p2Game.hand = [
      { id: "smoke-draw2-2", color: "red", kind: "draw2" },
      { id: "smoke-p2-spare", color: "green", kind: "number", value: 2 },
    ];
    p3Game.hand = [{ id: "smoke-p3-spare", color: "yellow", kind: "number", value: 3 }];
    room.game.currentPlayerIndex = room.game.players.findIndex((player) => player.id === p1Game.id);
    room.game.discardPile = [{ id: "smoke-top", color: "red", kind: "number", value: 5 }];
    room.game.currentColor = "red";
    room.game.drawPile = [];
    room.game.pendingDraw = undefined;
    room.game.version += 1;

    const afterFirst = requireRoom(await emitAck(p1, "game:play", { cardId: "smoke-draw2-1" }));
    const afterSecond = requireRoom(await emitAck(p2, "game:play", { cardId: "smoke-draw2-2" }));
    console.log("[settings-smoke] stacked-draw-twos", JSON.stringify({
      firstCurrentPlayer: afterFirst.game?.currentPlayerId,
      secondCurrentPlayer: afterSecond.game?.currentPlayerId,
      pendingDraw: afterSecond.game?.pendingDraw,
    }));

    const kicked = new Promise<unknown>((resolve) => p3.once("room:kicked", resolve));
    const afterKick = requireRoom(await emitAck(p1, "room:kick", { targetPlayerId: "settings-smoke-p3" }));
    await kicked;
    console.log("[settings-smoke] kick-mid-game", JSON.stringify({
      players: afterKick.players.map((player) => player.id),
      gamePlayers: runtime.rooms.get(created.code)?.game?.players.map((player) => player.id),
      currentPlayerId: afterKick.game?.currentPlayerId,
      pendingDraw: afterKick.game?.pendingDraw,
    }));
  } finally {
    for (const client of clients.splice(0)) client.disconnect();
    await runtime.close();
  }
}

run().catch((error) => {
  console.error("[settings-smoke] failed", error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
