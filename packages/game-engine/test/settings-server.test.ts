import { afterEach, describe, expect, it, vi } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import { createRealtimeServer, type RealtimeServer, type Room } from "../../../apps/realtime/src/server.js";
import type { PublicRoom } from "@uno/protocol";

type AckResult = { ok: boolean; room?: PublicRoom; code?: string; message?: string };
type Match = { runtime: RealtimeServer; sockets: Socket[]; roomCode: string };
const openSockets: Socket[] = [];
const runtimes: RealtimeServer[] = [];

function emitAck(socket: Socket, event: string, payload?: unknown): Promise<AckResult> {
  return new Promise((resolve) => payload === undefined ? socket.emit(event, resolve) : socket.emit(event, payload, resolve));
}

async function socketFor(url: string, id: string): Promise<Socket> {
  const socket = connect(url, { auth: { guestId: id }, transports: ["websocket"] });
  openSockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", reject);
  });
  return socket;
}

async function createMatch(count = 3, options: Parameters<typeof createRealtimeServer>[0] = {}): Promise<Match> {
  const runtime = createRealtimeServer({ logger: false, ...options });
  runtimes.push(runtime);
  const port = await runtime.start(0, "127.0.0.1");
  const url = `http://127.0.0.1:${port}`;
  const sockets = await Promise.all(Array.from({ length: count }, (_, index) => socketFor(url, `settings-test-p${index + 1}`)));
  const created = await emitAck(sockets[0]!, "room:create", { displayName: "P1" });
  if (!created.ok || !created.room) throw new Error(created.message ?? "create failed");
  for (let index = 1; index < count; index += 1) {
    const joined = await emitAck(sockets[index]!, "room:join", { roomCode: created.room.code, displayName: `P${index + 1}` });
    if (!joined.ok) throw new Error(joined.message ?? "join failed");
  }
  return { runtime, sockets, roomCode: created.room.code };
}

function roomOf(match: Match): Room {
  const room = match.runtime.rooms.get(match.roomCode);
  if (!room) throw new Error("room missing");
  return room;
}

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.disconnect();
  for (const runtime of runtimes.splice(0)) await runtime.close();
  vi.useRealTimers();
});

describe("room settings, kick, swap, and authoritative timers", () => {
  it("accepts valid host settings and rejects non-host or invalid settings", async () => {
    const match = await createMatch();
    const nonHost = await emitAck(match.sockets[1]!, "room:settings", { startingHand: 5 });
    expect(nonHost).toMatchObject({ ok: false, code: "NOT_HOST" });
    const invalid = await emitAck(match.sockets[0]!, "room:settings", { startingHand: 4, turnSeconds: 20 });
    expect(invalid).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    const valid = await emitAck(match.sockets[0]!, "room:settings", {
      startingHand: 5,
      turnSeconds: 15,
      stackDrawCards: true,
      unoPenaltyCards: 2,
      drawUntilPlayable: true,
      sevenZero: true,
    });
    expect(valid.ok).toBe(true);
    expect(valid.room?.settings).toEqual({ startingHand: 5, turnSeconds: 15, stackDrawCards: true, unoPenaltyCards: 2, drawUntilPlayable: true, sevenZero: true });
  });

  it("locks settings after the game starts and deals the configured hand size", async () => {
    const match = await createMatch(3);
    await emitAck(match.sockets[0]!, "room:settings", { startingHand: 5, turnSeconds: 0 });
    const started = await emitAck(match.sockets[0]!, "room:start");
    expect(started.ok).toBe(true);
    expect(started.room?.settings.startingHand).toBe(5);
    const room = roomOf(match);
    expect(room.game?.players.every((player) => player.hand.length === 5)).toBe(true);
    const locked = await emitAck(match.sockets[0]!, "room:settings", { startingHand: 10 });
    expect(locked).toMatchObject({ ok: false, code: "ROOM_NOT_READY" });
  });

  it("kicks a lobby player and blocks that guest from rejoining", async () => {
    const match = await createMatch(3);
    const kicked = new Promise<unknown>((resolve) => match.sockets[1]!.once("room:kicked", resolve));
    const result = await emitAck(match.sockets[0]!, "room:kick", { targetPlayerId: "settings-test-p2" });
    expect(result.ok).toBe(true);
    expect(await kicked).toEqual({ roomCode: match.roomCode, reason: "You were kicked by the host." });
    expect(roomOf(match).players.map((player) => player.id)).not.toContain("settings-test-p2");
    const blocked = await emitAck(match.sockets[1]!, "room:join", { roomCode: match.roomCode, displayName: "P2-again" });
    expect(blocked).toMatchObject({ ok: false, code: "ROOM_NOT_READY" });
  });

  it("enforces host-only kick and removes a player during a game", async () => {
    const match = await createMatch(3);
    await emitAck(match.sockets[0]!, "room:start");
    const rejected = await emitAck(match.sockets[1]!, "room:kick", { targetPlayerId: "settings-test-p3" });
    expect(rejected).toMatchObject({ ok: false, code: "NOT_HOST" });
    const kicked = await emitAck(match.sockets[0]!, "room:kick", { targetPlayerId: "settings-test-p3" });
    expect(kicked.ok).toBe(true);
    const room = roomOf(match);
    expect(room.players).toHaveLength(2);
    expect(room.game?.players).toHaveLength(2);
  });

  it("finishes and clears timers when the last opponent is kicked", async () => {
    const match = await createMatch(2, { turnSeconds: 15 });
    await emitAck(match.sockets[0]!, "room:start");
    const kicked = await emitAck(match.sockets[0]!, "room:kick", { targetPlayerId: "settings-test-p2" });
    expect(kicked.ok).toBe(true);
    expect(roomOf(match).status).toBe("finished");
    expect(roomOf(match).turnTimer).toBeUndefined();
    expect(roomOf(match).turnEndsAt).toBeUndefined();
  });

  it("finishes and clears timers when a player leaves", async () => {
    const match = await createMatch(2, { turnSeconds: 15 });
    await emitAck(match.sockets[0]!, "room:start");
    const left = await emitAck(match.sockets[0]!, "room:leave");
    expect(left.ok).toBe(true);
    expect(roomOf(match).status).toBe("finished");
    expect(roomOf(match).turnTimer).toBeUndefined();
    expect(roomOf(match).turnEndsAt).toBeUndefined();
  });

  it("uses the configured UNO penalty size", async () => {
    vi.useFakeTimers({ now: 0 });
    const match = await createMatch(2);
    await emitAck(match.sockets[0]!, "room:settings", { unoPenaltyCards: 2 });
    await emitAck(match.sockets[0]!, "room:start");
    const room = roomOf(match);
    const player = room.game!.players[0]!;
    player.hand = [
      { id: "uno-play", color: "red", kind: "number", value: 7 },
      { id: "uno-keep", color: "blue", kind: "number", value: 2 },
    ];
    room.game!.currentPlayerIndex = 0;
    room.game!.discardPile = [{ id: "uno-top", color: "red", kind: "number", value: 5 }];
    room.game!.currentColor = "red";
    room.game!.drawPile = [];
    await emitAck(match.sockets[0]!, "game:play", { cardId: "uno-play" });
    const before = player.hand.length;
    vi.advanceTimersByTime(3_000);
    expect(player.hand).toHaveLength(before + 2);
  });

  it("supports a seven swap and enforces swap authorization", async () => {
    const match = await createMatch(3);
    await emitAck(match.sockets[0]!, "room:settings", { sevenZero: true, turnSeconds: 15 });
    await emitAck(match.sockets[0]!, "room:start");
    const room = roomOf(match);
    const current = room.game!.players[room.game!.currentPlayerIndex]!;
    const target = room.game!.players.find((player) => player.id !== current.id)!;
    current.hand = [
      { id: "seven", color: "red", kind: "number", value: 7 },
      { id: "spare", color: "blue", kind: "number", value: 1 },
    ];
    room.game!.discardPile = [{ id: "top", color: "red", kind: "number", value: 5 }];
    room.game!.currentColor = "red";
    room.game!.drawPile = [];
    const currentSocket = match.sockets.find((socket) => socket.id === room.players.find((player) => player.id === current.id)?.socketId)!;
    const played = await emitAck(currentSocket, "game:play", { cardId: "seven" });
    expect(played.ok).toBe(true);
    expect(played.room?.game?.pendingSwapPlayerId).toBe(current.id);
    expect(played.room?.game?.currentPlayerId).toBe(current.id);
    expect(room.game!.players.find((player) => player.id === current.id)!.hand[0]?.id).toBe("spare");
    const wrong = await emitAck(match.sockets.find((socket) => socket.id !== currentSocket.id)!, "game:swap", { targetPlayerId: target.id });
    expect(wrong).toMatchObject({ ok: false, code: "INVALID_MOVE" });
    const swapped = await emitAck(currentSocket, "game:swap", { targetPlayerId: target.id });
    expect(swapped.ok).toBe(true);
    expect(swapped.room?.game?.pendingSwapPlayerId).toBeUndefined();
    expect(swapped.room?.game?.currentPlayerId).toBe(target.id);
    expect(swapped.room?.game?.turnEndsAt! - swapped.room?.game?.serverTime!).toBe(15_000);
  });

  it("supports a no-timer room and preserves a deadline on non-turn state emits", async () => {
    vi.useFakeTimers({ now: 0 });
    const noTimer = await createMatch(2);
    await emitAck(noTimer.sockets[0]!, "room:settings", { turnSeconds: 0 });
    const startedNoTimer = await emitAck(noTimer.sockets[0]!, "room:start");
    expect(startedNoTimer.room?.game?.turnEndsAt).toBeUndefined();
    expect(roomOf(noTimer).turnTimer).toBeUndefined();

    const timed = await createMatch(2, { now: () => Date.now() });
    const timedStart = await emitAck(timed.sockets[0]!, "room:start");
    expect(timedStart.room!.game!.turnEndsAt! - timedStart.room!.game!.serverTime!).toBe(30_000);
    const room = roomOf(timed);
    const deadline = room.turnEndsAt;
    const reaction = await emitAck(timed.sockets[0]!, "player:reaction", { messageId: "Nice!" });
    expect(reaction.ok).toBe(true);
    expect(room.turnEndsAt).toBe(deadline);
    expect(reaction.room?.game?.serverTime).toBeDefined();
  });

  it("fires a timeout once and clears it when the game ends", async () => {
    vi.useFakeTimers({ now: 0 });
    const match = await createMatch(2);
    await emitAck(match.sockets[0]!, "room:settings", { turnSeconds: 15 });
    await emitAck(match.sockets[0]!, "room:start");
    const beforeTimeoutPlayer = roomOf(match).game!.players[roomOf(match).game!.currentPlayerIndex]!.id;
    vi.advanceTimersByTime(15_000);
    expect(roomOf(match).game!.players[roomOf(match).game!.currentPlayerIndex]!.id).not.toBe(beforeTimeoutPlayer);
    const versionAfterTimeout = roomOf(match).game!.version;
    vi.advanceTimersByTime(1);
    expect(roomOf(match).game!.version).toBeGreaterThanOrEqual(versionAfterTimeout);
    const room = roomOf(match);
    room.game!.players[room.game!.currentPlayerIndex]!.hand = [{ id: "win", color: room.game!.currentColor as "red" | "yellow" | "green" | "blue", kind: "number", value: 7 }];
    room.game!.discardPile = [{ id: "top-win", color: room.game!.currentColor as "red" | "yellow" | "green" | "blue", kind: "number", value: 5 }];
    const currentId = getCurrentPlayerId(room);
    const currentSocket = match.sockets.find((socket) => room.players.find((player) => player.id === currentId)?.socketId === socket.id)!;
    await emitAck(currentSocket, "game:play", { cardId: "win" });
    expect(room.turnTimer).toBeUndefined();
  });

  it("does not double-fire when a draw arrives at the timer boundary", async () => {
    vi.useFakeTimers({ now: 0 });
    const match = await createMatch(2);
    await emitAck(match.sockets[0]!, "room:settings", { turnSeconds: 15 });
    await emitAck(match.sockets[0]!, "room:start");
    const room = roomOf(match);
    const current = room.game!.players[room.game!.currentPlayerIndex]!;
    room.game!.drawPile = [{ id: "boundary-draw", color: "red", kind: "number", value: 9 }];
    room.game!.currentColor = "red";

    vi.advanceTimersByTime(14_999);
    const draw = await emitAck(match.sockets[0]!, "game:draw");
    expect(draw.ok).toBe(true);
    expect(room.game!.players[room.game!.currentPlayerIndex]!.id).toBe(current.id);
    vi.advanceTimersByTime(1);
    expect(room.game!.players[room.game!.currentPlayerIndex]!.id).not.toBe(current.id);
    expect(room.turnEndsAt).toBe(30_000);
  });

  it("chooses a random target when a seven swap times out", async () => {
    vi.useFakeTimers({ now: 0 });
    const match = await createMatch(3, { turnSeconds: 15, random: () => 0 });
    await emitAck(match.sockets[0]!, "room:settings", { sevenZero: true });
    await emitAck(match.sockets[0]!, "room:start");
    const room = roomOf(match);
    const current = room.game!.players[room.game!.currentPlayerIndex]!;
    const target = room.game!.players.find((player) => player.id !== current.id)!;
    current.hand = [
      { id: "timeout-seven", color: "red", kind: "number", value: 7 },
      { id: "timeout-spare", color: "blue", kind: "number", value: 1 },
    ];
    target.hand = [{ id: "timeout-target", color: "green", kind: "number", value: 2 }];
    room.game!.discardPile = [{ id: "timeout-top", color: "red", kind: "number", value: 5 }];
    room.game!.currentColor = "red";
    const currentSocket = match.sockets.find((socket) => socket.id === room.players.find((player) => player.id === current.id)?.socketId)!;

    const played = await emitAck(currentSocket, "game:play", { cardId: "timeout-seven" });
    expect(played.room?.game?.pendingSwapPlayerId).toBe(current.id);
    vi.advanceTimersByTime(15_000);

    expect(room.game!.pendingSwapPlayerId).toBeUndefined();
    expect(room.game!.currentPlayerIndex).not.toBe(room.game!.players.findIndex((player) => player.id === current.id));
    expect(room.game!.players.find((player) => player.id === current.id)!.hand[0]?.id).toBe("timeout-target");
  });

  it("rejects the non-public two-second timer override in production", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => createRealtimeServer({ turnSeconds: 2 as never })).toThrow("unavailable in production");
      expect(() => createRealtimeServer({ settings: { turnSeconds: 2 as never } })).toThrow("unavailable in production");
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});

function getCurrentPlayerId(room: Room): string {
  return room.game!.players[room.game!.currentPlayerIndex]!.id;
}
