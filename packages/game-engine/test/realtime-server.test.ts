import { afterEach, describe, expect, it, vi } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import { createRealtimeServer, type RealtimeServer, type Room } from "../../../apps/realtime/src/server.js";
import type { PublicRoom } from "@uno/protocol";

type AckResult = {
  ok: boolean;
  room?: PublicRoom;
  code?: string;
  message?: string;
};

type TestMatch = {
  runtime: RealtimeServer;
  first: Socket;
  second: Socket;
  roomCode: string;
};

const clients: Socket[] = [];
const runtimes: RealtimeServer[] = [];

function waitForConnect(socket: Socket): Promise<void> {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
}

function emitAck(socket: Socket, event: string, payload?: unknown): Promise<AckResult> {
  return new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, resolve);
    else socket.emit(event, payload, resolve);
  });
}

function roomOf(runtime: RealtimeServer, roomCode: string): Room {
  const room = runtime.rooms.get(roomCode);
  if (!room) throw new Error(`Missing test room ${roomCode}`);
  return room;
}

async function startMatch(): Promise<TestMatch> {
  const runtime = createRealtimeServer({ logger: false });
  runtimes.push(runtime);
  const port = await runtime.start(0, "127.0.0.1");
  const first = connect(`http://127.0.0.1:${port}`, {
    auth: { guestId: "server-test-p1" },
    transports: ["websocket"],
  });
  const second = connect(`http://127.0.0.1:${port}`, {
    auth: { guestId: "server-test-p2" },
    transports: ["websocket"],
  });
  clients.push(first, second);
  await Promise.all([waitForConnect(first), waitForConnect(second)]);

  const created = await emitAck(first, "room:create", { displayName: "Alice" });
  if (!created.ok || !created.room) throw new Error(created.message ?? "Could not create test room");
  const roomCode = created.room.code;
  const joined = await emitAck(second, "room:join", { roomCode, displayName: "Bob" });
  if (!joined.ok) throw new Error(joined.message ?? "Could not join test room");
  const started = await emitAck(first, "room:start");
  if (!started.ok) throw new Error(started.message ?? "Could not start test room");
  return { runtime, first, second, roomCode };
}

function setCurrentPlayerHand(room: Room, playerId: string, hand: NonNullable<Room["game"]>["players"][number]["hand"]): void {
  if (!room.game) throw new Error("The test game has not started");
  room.game.players.forEach((player) => {
    if (player.id === playerId) player.hand = hand;
  });
  room.game.currentPlayerIndex = room.game.players.findIndex((player) => player.id === playerId);
  room.game.discardPile = [{ id: "test-top", color: "red", kind: "number", value: 5 }];
  room.game.currentColor = "red";
  room.game.drawPile = [];
  room.game.drewThisTurn = false;
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  vi.useRealTimers();
});

describe("realtime server authoritative rules", () => {
  it("auto draws and passes on a turn timeout, then resets the next deadline", async () => {
    vi.useFakeTimers({ now: 0 });
    const match = await startMatch();
    const room = roomOf(match.runtime, match.roomCode);
    const currentPlayerId = room.game!.players[room.game!.currentPlayerIndex]!.id;
    const before = room.game!.players.find((player) => player.id === currentPlayerId)!.hand.length;

    vi.advanceTimersByTime(30_000);

    expect(room.game!.players.find((player) => player.id === currentPlayerId)!.hand).toHaveLength(before + 1);
    expect(room.game!.players[room.game!.currentPlayerIndex]!.id).not.toBe(currentPlayerId);
    expect(room.turnEndsAt).toBe(60_000);
  });

  it("only passes after a player has already drawn", async () => {
    vi.useFakeTimers({ now: 0 });
    const match = await startMatch();
    const room = roomOf(match.runtime, match.roomCode);
    const currentPlayer = room.game!.players[room.game!.currentPlayerIndex]!;
    room.game!.drawPile = [{ id: "playable-draw", color: room.game!.currentColor as "red" | "yellow" | "green" | "blue", kind: "number", value: 9 }];
    const before = currentPlayer.hand.length;

    const drawResult = await emitAck(match.first, "game:draw");
    expect(drawResult.ok).toBe(true);
    expect(room.game!.drewThisTurn).toBe(true);
    expect(room.game!.players[room.game!.currentPlayerIndex]!.id).toBe(currentPlayer.id);

    vi.advanceTimersByTime(30_000);

    expect(currentPlayer.hand).toHaveLength(before + 1);
    expect(room.game!.players[room.game!.currentPlayerIndex]!.id).not.toBe(currentPlayer.id);
    expect(room.game!.players.find((player) => player.id === currentPlayer.id)!.hand).toHaveLength(before + 1);
  });

  it("clears turn and UNO timers when the game ends", async () => {
    vi.useFakeTimers({ now: 0 });
    const match = await startMatch();
    const room = roomOf(match.runtime, match.roomCode);
    setCurrentPlayerHand(room, "server-test-p1", [{ id: "winning-card", color: "red", kind: "number", value: 7 }]);

    const result = await emitAck(match.first, "game:play", { cardId: "winning-card" });

    expect(result.ok).toBe(true);
    expect(room.status).toBe("finished");
    expect(room.game?.status).toBe("finished");
    expect(room.turnTimer).toBeUndefined();
    expect(room.turnEndsAt).toBeUndefined();
    expect(room.unoWindow).toBeUndefined();
  });

  it("deals the automatic four-card penalty after the UNO grace window", async () => {
    vi.useFakeTimers({ now: 0 });
    const match = await startMatch();
    const room = roomOf(match.runtime, match.roomCode);
    setCurrentPlayerHand(room, "server-test-p1", [
      { id: "leave-one", color: "red", kind: "number", value: 7 },
      { id: "remaining", color: "blue", kind: "number", value: 2 },
    ]);
    const player = room.game!.players.find((candidate) => candidate.id === "server-test-p1")!;
    const before = player.hand.length;

    const result = await emitAck(match.first, "game:play", { cardId: "leave-one" });
    expect(result.ok).toBe(true);
    expect(room.unoWindow?.playerId).toBe("server-test-p1");

    vi.advanceTimersByTime(3_000);

    expect(player.hand).toHaveLength(before - 1 + 4);
    expect(room.unoWindow).toBeUndefined();
    expect(room.players.find((candidate) => candidate.id === "server-test-p1")?.unoCalled).toBe(false);
  });

  it("does not penalize a player who calls UNO during the grace window", async () => {
    vi.useFakeTimers({ now: 0 });
    const match = await startMatch();
    const room = roomOf(match.runtime, match.roomCode);
    setCurrentPlayerHand(room, "server-test-p1", [
      { id: "leave-one", color: "red", kind: "number", value: 7 },
      { id: "remaining", color: "blue", kind: "number", value: 2 },
    ]);
    const player = room.game!.players.find((candidate) => candidate.id === "server-test-p1")!;

    await emitAck(match.first, "game:play", { cardId: "leave-one" });
    const call = await emitAck(match.first, "game:call-uno", { targetPlayerId: "server-test-p1" });
    expect(call.ok).toBe(true);

    vi.advanceTimersByTime(3_000);

    expect(player.hand).toHaveLength(1);
    expect(room.unoWindow).toBeUndefined();
    expect(room.players.find((candidate) => candidate.id === "server-test-p1")?.unoCalled).toBe(true);
  });

  it("accepts a pre-call with two cards and rejects a call with five", async () => {
    vi.useFakeTimers({ now: 0 });
    const match = await startMatch();
    const room = roomOf(match.runtime, match.roomCode);
    setCurrentPlayerHand(room, "server-test-p1", [
      { id: "two-a", color: "red", kind: "number", value: 7 },
      { id: "two-b", color: "blue", kind: "number", value: 2 },
    ]);

    const preCall = await emitAck(match.first, "game:call-uno", { targetPlayerId: "server-test-p1" });
    expect(preCall.ok).toBe(true);
    expect(room.players.find((player) => player.id === "server-test-p1")?.unoCalled).toBe(true);

    setCurrentPlayerHand(room, "server-test-p1", [
      { id: "five-a", color: "red", kind: "number", value: 1 },
      { id: "five-b", color: "red", kind: "number", value: 2 },
      { id: "five-c", color: "red", kind: "number", value: 3 },
      { id: "five-d", color: "red", kind: "number", value: 4 },
      { id: "five-e", color: "red", kind: "number", value: 5 },
    ]);
    room.players.find((player) => player.id === "server-test-p1")!.unoCalled = false;

    const rejected = await emitAck(match.first, "game:call-uno", { targetPlayerId: "server-test-p1" });
    expect(rejected.ok).toBe(false);
    expect(rejected.message).toContain("two cards");
  });

  it("enforces the quick-message whitelist and one-second rate limit", async () => {
    vi.useFakeTimers({ now: 0 });
    const match = await startMatch();
    const room = roomOf(match.runtime, match.roomCode);
    const player = room.players.find((candidate) => candidate.id === "server-test-p1")!;

    const first = await emitAck(match.first, "player:reaction", { messageId: "Nice!" });
    expect(first.ok).toBe(true);
    expect(player.reaction).toBe("Nice!");

    const invalid = await emitAck(match.first, "player:reaction", { messageId: "Hello" });
    expect(invalid.ok).toBe(false);
    expect(invalid.code).toBe("INVALID_INPUT");

    const limited = await emitAck(match.first, "player:reaction", { messageId: "GG" });
    expect(limited.ok).toBe(false);
    expect(limited.code).toBe("RATE_LIMITED");

    vi.advanceTimersByTime(1_000);
    const second = await emitAck(match.first, "player:reaction", { messageId: "GG" });
    expect(second.ok).toBe(true);
    expect(player.reaction).toBe("GG");

    vi.advanceTimersByTime(3_000);
    expect(player.reaction).toBeUndefined();
  });
});
