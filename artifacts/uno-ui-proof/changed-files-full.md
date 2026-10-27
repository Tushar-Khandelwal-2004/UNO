# Full contents of changed text files

## `apps/realtime/src/server.ts`

```text
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { pathToFileURL } from "node:url";
import { Server, type Socket } from "socket.io";
import {
  createGame,
  drawCards,
  drawOne,
  getCurrentPlayer,
  passTurn,
  playCard,
  publicGameState,
  type GameState,
} from "@uno/game-engine";
import {
  callUnoSchema,
  createRoomSchema,
  joinRoomSchema,
  reactionSchema,
  transferHostSchema,
  type GameNotice,
  type PublicPlayer,
  type PublicRoom,
  type QuickMessage,
} from "@uno/protocol";

const PORT = Number(process.env.PORT ?? 4000);
const MAX_PLAYERS = 8;
const ROOM_RETENTION_MS = 5 * 60 * 1000;
const HOST_DISCONNECT_GRACE_MS = 5_000;
const TURN_SECONDS = 30;
const UNO_GRACE_MS = 3_000;
const REACTION_DURATION_MS = 3_000;
const REACTION_COOLDOWN_MS = 1_000;

type TimeoutHandle = ReturnType<typeof setTimeout>;

type Scheduler = {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => TimeoutHandle;
  clearTimeout: (timer: TimeoutHandle) => void;
};

export type RealtimeServerOptions = {
  turnSeconds?: number;
  roomRetentionMs?: number;
  hostDisconnectGraceMs?: number;
  unoGraceMs?: number;
  reactionDurationMs?: number;
  reactionCooldownMs?: number;
  webOrigin?: string;
  logger?: boolean;
  random?: () => number;
  now?: () => number;
  setTimeout?: (callback: () => void, delay: number) => TimeoutHandle;
  clearTimeout?: (timer: TimeoutHandle) => void;
};

type RoomPlayer = {
  id: string;
  socketId: string;
  displayName: string;
  connected: boolean;
  unoCalled: boolean;
  reaction?: QuickMessage;
  lastReactionAt?: number;
  reactionTimer?: TimeoutHandle;
};

type UnoWindow = {
  playerId: string;
  endsAt: number;
  timer: TimeoutHandle;
};

export type Room = {
  code: string;
  status: PublicRoom["status"];
  hostId: string;
  players: RoomPlayer[];
  game?: GameState;
  turnEndsAt?: number;
  turnTimer?: TimeoutHandle;
  unoWindow?: UnoWindow;
  cleanupTimer?: TimeoutHandle;
  hostTransferTimer?: TimeoutHandle;
  nextNoticeId: number;
};

type AckResult =
  | { ok: true; room: PublicRoom }
  | { ok: false; code: string; message: string };

type Ack = (result: AckResult) => void;

export type RealtimeServer = {
  app: FastifyInstance;
  io: Server;
  rooms: Map<string, Room>;
  socketRooms: Map<string, string>;
  start: (port?: number, host?: string) => Promise<number>;
  close: () => Promise<void>;
};

function defaultScheduler(): Scheduler {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  };
}

function guestId(socket: Socket): string {
  const value = socket.handshake.auth?.guestId;
  return typeof value === "string" && value.length >= 8 ? value : socket.id;
}

function errorAck(ack: Ack | undefined, code: string, message: string): void {
  ack?.({ ok: false, code, message });
}

function ackRoom(ack: Ack | undefined, room: Room, publicRoom: () => PublicRoom): void {
  ack?.({ ok: true, room: publicRoom() });
}

export function createRealtimeServer(options: RealtimeServerOptions = {}): RealtimeServer {
  const scheduler = defaultScheduler();
  const clock: Scheduler = {
    now: options.now ?? scheduler.now,
    setTimeout: options.setTimeout ?? scheduler.setTimeout,
    clearTimeout: options.clearTimeout ?? scheduler.clearTimeout,
  };
  const turnSeconds = options.turnSeconds ?? TURN_SECONDS;
  const roomRetentionMs = options.roomRetentionMs ?? ROOM_RETENTION_MS;
  const hostDisconnectGraceMs = options.hostDisconnectGraceMs ?? HOST_DISCONNECT_GRACE_MS;
  const unoGraceMs = options.unoGraceMs ?? UNO_GRACE_MS;
  const reactionDurationMs = options.reactionDurationMs ?? REACTION_DURATION_MS;
  const reactionCooldownMs = options.reactionCooldownMs ?? REACTION_COOLDOWN_MS;
  const random = options.random ?? Math.random;
  const webOrigin = options.webOrigin ?? process.env.WEB_ORIGIN ?? "http://localhost:3000";
  const app = Fastify({ logger: options.logger ?? false });
  const io = new Server(app.server, {
    cors: {
      origin: webOrigin,
      credentials: true,
    },
  });
  const rooms = new Map<string, Room>();
  const socketRooms = new Map<string, string>();

  void app.register(cors, {
    origin: webOrigin,
    credentials: true,
  });

  app.get("/health", async () => ({ ok: true, rooms: rooms.size }));

  function randomRoomCode(): string {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "";
    do {
      code = Array.from({ length: 6 }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
    } while (rooms.has(code));
    return code;
  }

  function roomForSocket(socket: Socket): Room | undefined {
    const roomCode = socketRooms.get(socket.id);
    return roomCode ? rooms.get(roomCode) : undefined;
  }

  function roomPlayer(room: Room, playerId: string): RoomPlayer | undefined {
    return room.players.find((player) => player.id === playerId);
  }

  function publicRoom(room: Room): PublicRoom {
    const players: PublicPlayer[] = room.players.map((player) => ({
      id: player.id,
      displayName: player.displayName,
      isHost: player.id === room.hostId,
      connected: player.connected,
      cardCount: room.game?.players.find((gamePlayer) => gamePlayer.id === player.id)?.hand.length ?? 0,
      unoCalled: player.unoCalled,
      reaction: player.reaction,
    }));

    return {
      code: room.code,
      status: room.status,
      players,
      maxPlayers: MAX_PLAYERS,
      rulesetVersion: "standard-v1",
      turnSeconds,
      game: room.game
        ? publicGameState(room.game, {
            turnEndsAt: room.turnEndsAt,
            serverTime: clock.now(),
            unoWindow: room.unoWindow
              ? { playerId: room.unoWindow.playerId, endsAt: room.unoWindow.endsAt }
              : undefined,
          })
        : undefined,
    };
  }

  function clearTurnTimer(room: Room): void {
    if (room.turnTimer) clock.clearTimeout(room.turnTimer);
    room.turnTimer = undefined;
    room.turnEndsAt = undefined;
  }

  function clearUnoWindow(room: Room): void {
    if (room.unoWindow) clock.clearTimeout(room.unoWindow.timer);
    room.unoWindow = undefined;
  }

  function clearReactionTimers(room: Room, clearMessages: boolean): void {
    for (const player of room.players) {
      if (player.reactionTimer) clock.clearTimeout(player.reactionTimer);
      player.reactionTimer = undefined;
      if (clearMessages) player.reaction = undefined;
    }
  }

  function clearGameTimers(room: Room): void {
    clearTurnTimer(room);
    clearUnoWindow(room);
    clearReactionTimers(room, true);
  }

  function clearRoomTimers(room: Room): void {
    clearGameTimers(room);
    if (room.cleanupTimer) clock.clearTimeout(room.cleanupTimer);
    if (room.hostTransferTimer) clock.clearTimeout(room.hostTransferTimer);
    room.cleanupTimer = undefined;
    room.hostTransferTimer = undefined;
  }

  function emitRoom(room: Room): void {
    io.to(room.code).emit("room:state", publicRoom(room));
    for (const player of room.players) {
      const socket = io.sockets.sockets.get(player.socketId);
      if (!socket || !room.game) continue;
      const hand = room.game.players.find((gamePlayer) => gamePlayer.id === player.id)?.hand ?? [];
      socket.emit("player:hand", hand);
    }
  }

  function emitNotice(
    room: Room,
    notice: Omit<GameNotice, "id">,
  ): void {
    const nextNotice: GameNotice = { id: room.nextNoticeId++, ...notice };
    io.to(room.code).emit("game:notice", nextNotice);
  }

  function scheduleCleanup(room: Room): void {
    if (room.cleanupTimer) clock.clearTimeout(room.cleanupTimer);
    room.cleanupTimer = clock.setTimeout(() => {
      clearRoomTimers(room);
      rooms.delete(room.code);
    }, roomRetentionMs);
  }

  function transferHost(room: Room): void {
    const candidates = room.players.filter((player) => player.id !== room.hostId);
    const nextHost = candidates[Math.floor(random() * candidates.length)];
    if (!nextHost) {
      scheduleCleanup(room);
      return;
    }
    room.hostId = nextHost.id;
    room.hostTransferTimer = undefined;
    emitRoom(room);
  }

  function scheduleHostTransfer(room: Room): void {
    if (room.hostTransferTimer) clock.clearTimeout(room.hostTransferTimer);
    room.hostTransferTimer = clock.setTimeout(() => {
      const host = roomPlayer(room, room.hostId);
      if (!host?.connected) transferHost(room);
    }, hostDisconnectGraceMs);
  }

  function setTurnDeadline(room: Room): void {
    clearTurnTimer(room);
    if (room.status !== "in_game" || !room.game || room.game.status !== "playing") return;
    room.turnEndsAt = clock.now() + turnSeconds * 1000;
    room.turnTimer = clock.setTimeout(() => handleTurnTimeout(room), turnSeconds * 1000);
  }

  function updateHandAfterDraw(room: Room, playerId: string): void {
    const player = roomPlayer(room, playerId);
    if (player) player.unoCalled = false;
  }

  function openUnoWindow(room: Room, playerId: string): void {
    clearUnoWindow(room);
    const endsAt = clock.now() + unoGraceMs;
    const timer = clock.setTimeout(() => expireUnoWindow(room, playerId, endsAt), unoGraceMs);
    room.unoWindow = { playerId, endsAt, timer };
  }

  function expireUnoWindow(room: Room, playerId: string, endsAt: number): void {
    if (room.unoWindow?.playerId !== playerId || room.unoWindow.endsAt !== endsAt) return;
    room.unoWindow = undefined;
    if (room.status !== "in_game" || !room.game || room.game.status !== "playing") return;
    const player = roomPlayer(room, playerId);
    const gamePlayer = room.game.players.find((candidate) => candidate.id === playerId);
    if (!player || !gamePlayer || player.unoCalled) return;
    drawCards(room.game, playerId, 4);
    player.unoCalled = false;
    emitNotice(room, {
      type: "uno_penalty",
      playerId,
      amount: 4,
      text: `${player.displayName} draws 4 for missing UNO`,
    });
    emitRoom(room);
  }

  function handleTurnTimeout(room: Room): void {
    if (room.status !== "in_game" || !room.game || room.game.status !== "playing") return;
    room.turnTimer = undefined;
    room.turnEndsAt = undefined;
    const currentPlayer = getCurrentPlayer(room.game);
    const player = roomPlayer(room, currentPlayer.id);
    if (!player) return;

    try {
      if (!room.game.drewThisTurn) {
        const previousPlayerId = currentPlayer.id;
        drawOne(room.game, currentPlayer.id);
        updateHandAfterDraw(room, currentPlayer.id);
        if (getCurrentPlayer(room.game).id === previousPlayerId) passTurn(room.game, currentPlayer.id);
        emitNotice(room, {
          type: "timeout",
          playerId: currentPlayer.id,
          amount: 1,
          text: `${player.displayName} timed out and drew 1`,
        });
      } else {
        passTurn(room.game, currentPlayer.id);
        emitNotice(room, {
          type: "timeout",
          playerId: currentPlayer.id,
          text: `${player.displayName} timed out`,
        });
      }
      if (room.game.status === "playing") setTurnDeadline(room);
      emitRoom(room);
    } catch {
      if (room.game.status === "playing") setTurnDeadline(room);
    }
  }

  function joinSocketToRoom(socket: Socket, room: Room, player: RoomPlayer): void {
    socket.join(room.code);
    socketRooms.set(socket.id, room.code);
    player.socketId = socket.id;
    player.connected = true;
    if (room.cleanupTimer) {
      clock.clearTimeout(room.cleanupTimer);
      room.cleanupTimer = undefined;
    }
    if (room.hostTransferTimer && player.id === room.hostId) {
      clock.clearTimeout(room.hostTransferTimer);
      room.hostTransferTimer = undefined;
    }
  }

  function createRoom(socket: Socket, displayName: string): Room {
    const playerId = guestId(socket);
    const room: Room = {
      code: randomRoomCode(),
      status: "open",
      hostId: playerId,
      players: [
        {
          id: playerId,
          socketId: socket.id,
          displayName,
          connected: true,
          unoCalled: false,
        },
      ],
      nextNoticeId: 1,
    };
    rooms.set(room.code, room);
    joinSocketToRoom(socket, room, room.players[0]!);
    return room;
  }

  function ensureRoomPlayer(socket: Socket, room: Room): RoomPlayer | undefined {
    return roomPlayer(room, guestId(socket));
  }

  function finishGameIfNeeded(room: Room): void {
    if (room.game?.status !== "finished") return;
    room.status = "finished";
    clearGameTimers(room);
    scheduleCleanup(room);
  }

  function handleCallUno(socket: Socket, payload: unknown, ack: Ack | undefined): void {
    const room = roomForSocket(socket);
    if (!room?.game || room.game.status !== "playing") return errorAck(ack, "ROOM_NOT_READY", "The match has not started.");
    const caller = ensureRoomPlayer(socket, room);
    const parsed = callUnoSchema.safeParse(payload);
    if (!caller || !parsed.success) return errorAck(ack, "INVALID_INPUT", "Choose yourself to call UNO.");
    if (parsed.data.targetPlayerId !== caller.id) {
      return errorAck(ack, "INVALID_MOVE", "Manual UNO catches are no longer used; UNO penalties are automatic.");
    }

    const targetGamePlayer = room.game.players.find((candidate) => candidate.id === caller.id);
    if (!targetGamePlayer) return errorAck(ack, "INVALID_INPUT", "You are not in this match.");
    const isCurrentPlayer = getCurrentPlayer(room.game).id === caller.id;
    const validPreCall = targetGamePlayer.hand.length === 2 && isCurrentPlayer;
    const validOneCardCall = targetGamePlayer.hand.length === 1;
    if (!validPreCall && !validOneCardCall) {
      return errorAck(ack, "INVALID_MOVE", "Call UNO on your turn with two cards before playing, or when you have one card.");
    }

    caller.unoCalled = true;
    if (room.unoWindow?.playerId === caller.id) clearUnoWindow(room);
    room.game.version += 1;
    emitNotice(room, {
      type: "uno_called",
      playerId: caller.id,
      text: `${caller.displayName} called UNO`,
    });
    ackRoom(ack, room, () => publicRoom(room));
    emitRoom(room);
  }

  io.on("connection", (socket) => {
    socket.on("room:create", (payload: unknown, ack: Ack) => {
      const parsed = createRoomSchema.safeParse(payload);
      if (!parsed.success) return errorAck(ack, "INVALID_INPUT", "Enter a valid display name.");
      const room = createRoom(socket, parsed.data.displayName);
      ackRoom(ack, room, () => publicRoom(room));
      emitRoom(room);
    });

    socket.on("room:join", (payload: unknown, ack: Ack) => {
      const parsed = joinRoomSchema.safeParse(payload);
      if (!parsed.success) return errorAck(ack, "INVALID_INPUT", "Enter a six-character room code and display name.");
      const room = rooms.get(parsed.data.roomCode);
      if (!room) return errorAck(ack, "ROOM_NOT_FOUND", "That room does not exist or has expired.");
      if (room.status !== "open" && room.status !== "in_game") return errorAck(ack, "ROOM_NOT_READY", "This room is no longer accepting players.");

      const existing = ensureRoomPlayer(socket, room);
      if (existing) {
        joinSocketToRoom(socket, room, existing);
        ackRoom(ack, room, () => publicRoom(room));
        emitRoom(room);
        return;
      }
      if (room.players.length >= MAX_PLAYERS) return errorAck(ack, "ROOM_FULL", "This room is full.");
      if (room.status !== "open") return errorAck(ack, "ROOM_NOT_READY", "The match has already started.");
      if (room.players.some((player) => player.displayName.toLowerCase() === parsed.data.displayName.toLowerCase())) {
        return errorAck(ack, "NAME_TAKEN", "That display name is already being used in this room.");
      }

      const player: RoomPlayer = {
        id: guestId(socket),
        socketId: socket.id,
        displayName: parsed.data.displayName,
        connected: true,
        unoCalled: false,
      };
      room.players.push(player);
      joinSocketToRoom(socket, room, player);
      ackRoom(ack, room, () => publicRoom(room));
      emitRoom(room);
    });

    socket.on("room:start", (ack: Ack) => {
      const room = roomForSocket(socket);
      if (!room) return errorAck(ack, "NOT_IN_ROOM", "Join a room first.");
      const player = ensureRoomPlayer(socket, room);
      if (!player || player.id !== room.hostId) return errorAck(ack, "NOT_HOST", "Only the host can start the match.");
      if (room.players.length < 2) return errorAck(ack, "ROOM_NOT_READY", "At least two players are required.");

      room.status = "in_game";
      room.game = createGame(room.players.map(({ id, displayName }) => ({ id, displayName })), { random });
      setTurnDeadline(room);
      ackRoom(ack, room, () => publicRoom(room));
      emitRoom(room);
    });

    socket.on("room:transfer-host", (payload: unknown, ack: Ack) => {
      const room = roomForSocket(socket);
      if (!room) return errorAck(ack, "NOT_IN_ROOM", "Join a room first.");
      const player = ensureRoomPlayer(socket, room);
      const parsed = transferHostSchema.safeParse(payload);
      if (!player || player.id !== room.hostId) return errorAck(ack, "NOT_HOST", "Only the host can transfer ownership.");
      if (!parsed.success || !roomPlayer(room, parsed.data.playerId)) return errorAck(ack, "INVALID_INPUT", "Choose a player in this room.");
      room.hostId = parsed.data.playerId;
      emitRoom(room);
      ackRoom(ack, room, () => publicRoom(room));
    });

    socket.on("game:play", (payload: unknown, ack: Ack) => {
      const room = roomForSocket(socket);
      if (!room?.game) return errorAck(ack, "ROOM_NOT_READY", "The match has not started.");
      const player = ensureRoomPlayer(socket, room);
      if (!player) return errorAck(ack, "NOT_IN_ROOM", "Join a room first.");
      if (!payload || typeof payload !== "object") return errorAck(ack, "INVALID_INPUT", "Choose a card.");
      const cardId = "cardId" in payload && typeof payload.cardId === "string" ? payload.cardId : "";
      const chosenColor = "chosenColor" in payload && typeof payload.chosenColor === "string" ? payload.chosenColor : undefined;
      try {
        const result = playCard(room.game, player.id, cardId, chosenColor as "red" | "yellow" | "green" | "blue" | undefined);
        clearTurnTimer(room);

        if (result.penaltyPlayerId && result.penaltyAmount) {
          updateHandAfterDraw(room, result.penaltyPlayerId);
          const penaltyPlayer = roomPlayer(room, result.penaltyPlayerId);
          emitNotice(room, {
            type: "draw_penalty",
            playerId: result.penaltyPlayerId,
            amount: result.penaltyAmount,
            text: `${penaltyPlayer?.displayName ?? "Player"} draws ${result.penaltyAmount}`,
          });
        }
        if (result.skippedPlayerId && (result.playedCard.kind === "skip" || result.penaltyAmount || result.playedCard.kind === "reverse" && room.game.players.length === 2)) {
          const skippedPlayer = roomPlayer(room, result.skippedPlayerId);
          emitNotice(room, {
            type: "skip",
            playerId: result.skippedPlayerId,
            text: `${skippedPlayer?.displayName ?? "Player"} is skipped`,
          });
        }
        if (result.playedCard.kind === "reverse") {
          emitNotice(room, {
            type: "reverse",
            playerId: player.id,
            text: `${player.displayName} reversed direction`,
          });
        }

        if (room.game.status === "playing" && room.game.players.find((candidate) => candidate.id === player.id)?.hand.length === 1 && !player.unoCalled) {
          openUnoWindow(room, player.id);
        }
        finishGameIfNeeded(room);
        if (room.status === "in_game") setTurnDeadline(room);
        ackRoom(ack, room, () => publicRoom(room));
        emitRoom(room);
      } catch (error) {
        errorAck(ack, "INVALID_MOVE", error instanceof Error ? error.message : "That move is not allowed.");
      }
    });

    socket.on("game:draw", (ack: Ack) => {
      const room = roomForSocket(socket);
      if (!room?.game) return errorAck(ack, "ROOM_NOT_READY", "The match has not started.");
      const player = ensureRoomPlayer(socket, room);
      if (!player) return errorAck(ack, "NOT_IN_ROOM", "Join a room first.");
      try {
        const previousPlayerId = getCurrentPlayer(room.game).id;
        drawOne(room.game, player.id);
        updateHandAfterDraw(room, player.id);
        if (getCurrentPlayer(room.game).id !== previousPlayerId) setTurnDeadline(room);
        ackRoom(ack, room, () => publicRoom(room));
        emitRoom(room);
      } catch (error) {
        errorAck(ack, "INVALID_MOVE", error instanceof Error ? error.message : "You cannot draw right now.");
      }
    });

    socket.on("game:pass", (ack: Ack) => {
      const room = roomForSocket(socket);
      if (!room?.game) return errorAck(ack, "ROOM_NOT_READY", "The match has not started.");
      const player = ensureRoomPlayer(socket, room);
      if (!player) return errorAck(ack, "NOT_IN_ROOM", "Join a room first.");
      try {
        passTurn(room.game, player.id);
        clearTurnTimer(room);
        setTurnDeadline(room);
        ackRoom(ack, room, () => publicRoom(room));
        emitRoom(room);
      } catch (error) {
        errorAck(ack, "INVALID_MOVE", error instanceof Error ? error.message : "You cannot pass right now.");
      }
    });

    socket.on("game:call-uno", (payload: unknown, ack: Ack) => handleCallUno(socket, payload, ack));
    socket.on("game:catch-uno", (_payload: unknown, ack: Ack) => errorAck(ack, "INVALID_MOVE", "UNO penalties are automatic; manual catches are no longer used."));

    socket.on("player:reaction", (payload: unknown, ack: Ack) => {
      const room = roomForSocket(socket);
      if (!room) return errorAck(ack, "NOT_IN_ROOM", "Join a room first.");
      const player = ensureRoomPlayer(socket, room);
      const parsed = reactionSchema.safeParse(payload);
      if (!player || !parsed.success) return errorAck(ack, "INVALID_INPUT", "That quick message is not available.");
      const now = clock.now();
      if (player.lastReactionAt !== undefined && now - player.lastReactionAt < reactionCooldownMs) {
        return errorAck(ack, "RATE_LIMITED", "Please wait before sending another quick message.");
      }
      player.lastReactionAt = now;
      player.reaction = parsed.data.messageId;
      if (player.reactionTimer) clock.clearTimeout(player.reactionTimer);
      player.reactionTimer = clock.setTimeout(() => {
        player.reactionTimer = undefined;
        player.reaction = undefined;
        emitRoom(room);
      }, reactionDurationMs);
      ackRoom(ack, room, () => publicRoom(room));
      emitRoom(room);
    });

    socket.on("disconnect", () => {
      const room = roomForSocket(socket);
      if (!room) return;
      const player = ensureRoomPlayer(socket, room);
      if (!player || player.socketId !== socket.id) return;
      player.connected = false;
      if (player.id === room.hostId) scheduleHostTransfer(room);
      if (room.players.every((candidate) => !candidate.connected)) scheduleCleanup(room);
      emitRoom(room);
    });
  });

  return {
    app,
    io,
    rooms,
    socketRooms,
    async start(port = PORT, host = "0.0.0.0") {
      await app.listen({ port, host });
      const address = app.server.address();
      return typeof address === "object" && address ? address.port : port;
    },
    async close() {
      for (const room of rooms.values()) clearRoomTimers(room);
      rooms.clear();
      socketRooms.clear();
      await new Promise<void>((resolve) => io.close(() => resolve()));
      await app.close();
    },
  };
}

const isEntryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href === import.meta.url
  : false;

if (isEntryPoint && process.env.NODE_ENV !== "test") {
  const runtime = createRealtimeServer({ logger: true });
  void runtime.start(PORT, "0.0.0.0")
    .then(() => runtime.app.log.info(`UNO realtime server listening on http://localhost:${PORT}`))
    .catch((error: unknown) => {
      runtime.app.log.error(error);
      process.exitCode = 1;
    });
}
```

## `apps/web/app/globals.css`

```text
@import "tailwindcss";

@theme {
  --spacing-1: 4px;
  --spacing-2: 8px;
  --spacing-3: 12px;
  --spacing-4: 16px;
  --spacing-6: 24px;
  --color-uno-background: #202427;
  --color-uno-felt: #27343a;
  --color-uno-felt-deep: #1c292e;
  --color-uno-panel: #2a3034;
  --color-uno-panel-light: #3b454b;
  --color-uno-text: #f6f7f8;
  --color-uno-muted: #aab4b9;
  --color-uno-accent: #f7c948;
  --color-uno-blue: #0768c9;
  --color-uno-error: #ff8585;
  --color-card-red-start: #f13a43;
  --color-card-red-end: #ae0b25;
  --color-card-yellow-start: #ffdb34;
  --color-card-yellow-end: #c28d03;
  --color-card-green-start: #0bb96c;
  --color-card-green-end: #00884d;
  --color-card-blue-start: #258be8;
  --color-card-blue-end: #0750ac;
  --color-card-wild-start: #30353a;
  --color-card-wild-end: #0c1014;
  --radius-panel: 16px;
  --radius-button: 12px;
  --radius-card: 14px;
  --shadow-card: 0 12px 22px rgb(0 0 0 / 35%);
  --shadow-card-hover: 0 22px 34px rgb(0 0 0 / 48%);
  --shadow-panel: 0 24px 80px rgb(0 0 0 / 30%);
  --z-base: 0;
  --z-table: 10;
  --z-seat: 20;
  --z-hand: 30;
  --z-drag: 100;
  --z-overlay: 200;
  --card-width: clamp(44px, min(10.5dvh, 17vw), 96px);
  --card-height: calc(var(--card-width) * 1.47);
}

:root {
  --card-width: clamp(44px, min(10.5dvh, 17vw), 96px);
  --card-height: calc(var(--card-width) * 1.47);
}

html,
body {
  width: 100%;
  height: 100%;
  overflow: hidden;
  overscroll-behavior: none;
}

body {
  margin: 0;
  background:
    radial-gradient(circle at 50% 8%, rgb(50 59 64 / 80%), transparent 44%),
    #202427;
  color: #f6f7f8;
  font-family: var(--font-nunito), Arial, Helvetica, sans-serif;
}

button,
input {
  font: inherit;
}

button {
  cursor: pointer;
}

button:disabled {
  cursor: not-allowed;
}

@keyframes legal-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 2px rgb(255 255 255 / 92%), 0 0 16px rgb(255 255 255 / 14%), 0 12px 22px rgb(0 0 0 / 35%);
  }
  50% {
    box-shadow: 0 0 0 3px rgb(255 255 255 / 100%), 0 0 28px var(--card-glow, rgb(255 255 255 / 28%)), 0 14px 24px rgb(0 0 0 / 38%);
  }
}

@keyframes card-shake {
  0%,
  100% { transform: translateX(0); }
  25% { transform: translateX(-5px); }
  75% { transform: translateX(5px); }
}

@keyframes card-deal-in {
  from { opacity: 0; transform: translateY(28px) scale(0.82) rotate(-8deg); }
  to { opacity: 1; transform: translateY(0) scale(1) rotate(0); }
}

@keyframes card-fly {
  from { opacity: 1; transform: translate3d(var(--fly-x, 0), var(--fly-y, 0), 0) scale(1); }
  to { opacity: 0.8; transform: translate3d(0, 0, 0) scale(0.82); }
}

@keyframes turn-ring {
  from { box-shadow: 0 0 0 0 rgb(247 201 72 / 40%); }
  to { box-shadow: 0 0 0 8px rgb(247 201 72 / 0%); }
}

@keyframes bubble-pop {
  0% { opacity: 0; transform: translate(-50%, 8px) scale(.8); }
  12%, 76% { opacity: 1; transform: translate(-50%, 0) scale(1); }
  100% { opacity: 0; transform: translate(-50%, -4px) scale(.96); }
}

@keyframes bubble-pulse {
  0%, 100% { transform: translateX(-50%) scale(1); }
  50% { transform: translateX(-50%) scale(1.05); }
}

.legal-pulse {
  animation: legal-pulse 1.6s ease-in-out infinite;
}

.card-shake {
  animation: card-shake 150ms ease-in-out;
}

.card-deal-in {
  animation: card-deal-in 320ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

.card-fly {
  animation: card-fly 250ms ease-out both;
}

.turn-ring {
  animation: turn-ring 1.4s ease-out infinite;
}

.app-shell {
  position: fixed;
  inset: 0;
  display: grid;
  min-height: 0;
  gap: 8px;
  overflow: hidden;
  padding: 8px;
  background: #202427;
  color: var(--color-uno-text);
}

.lobby-shell { grid-template-rows: clamp(44px, 7dvh, 60px) minmax(0, 1fr); }
.game-shell { grid-template-rows: clamp(44px, 7dvh, 60px) minmax(0, 1fr) 40px minmax(0, calc(var(--card-height) + 20px)) clamp(44px, 6.5dvh, 56px); }
.top-bar { position: relative; z-index: 40; display: flex; min-width: 0; min-height: 0; align-items: center; justify-content: space-between; border-radius: 12px; padding: 0 16px; background: linear-gradient(100deg, #0965bc, #0d5da5); box-shadow: 0 12px 24px rgb(0 0 0 / 22%); }
.top-bar-room, .top-bar-right { display: flex; min-width: 0; align-items: center; gap: 12px; }
.top-bar-room > span:not(.top-bar-gear) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: clamp(13px, 1.5vw, 18px); font-weight: 800; }
.top-bar-gear { font-size: 20px; }
.top-bar-copy, .top-bar-count, .top-bar-menu { border: 0; border-radius: 999px; background: rgb(0 0 0 / 15%); color: rgb(255 255 255 / 88%); font-weight: 800; }
.top-bar-copy { padding: 6px 12px; font-size: 12px; }
.top-bar-count { padding: 6px 12px; font-size: 12px; }
.top-bar-menu { display: grid; min-height: 40px; min-width: 40px; place-items: center; font-size: 20px; }
.settings-popover { position: absolute; top: calc(100% + 8px); right: 8px; display: grid; width: min(280px, calc(100vw - 16px)); gap: 8px; border: 1px solid rgb(255 255 255 / 14%); border-radius: 16px; padding: 16px; background: #2a3034; box-shadow: 0 24px 80px rgb(0 0 0 / 30%); font-size: 13px; }
.settings-popover p { margin: 0; color: var(--color-uno-muted); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .12em; }
.settings-popover button { min-height: 40px; border: 0; border-radius: 12px; padding: 0 12px; background: rgb(255 255 255 / 10%); color: white; text-align: left; font-weight: 800; }
.settings-popover .settings-leave { color: var(--color-uno-error); background: rgb(255 133 133 / 14%); }
.settings-host-list { display: grid; gap: 4px; }

.lobby-screen { min-height: 0; display: grid; place-items: center; overflow: hidden; }
.lobby-panel-wrap { display: grid; width: min(720px, 100%); height: 100%; min-height: 0; place-items: center; border: 1px solid rgb(255 255 255 / 10%); border-radius: 16px; padding: 16px; background: radial-gradient(circle at 50% 30%, rgb(255 255 255 / 4%), transparent 50%), linear-gradient(145deg, #30383d, #202528); box-shadow: 0 24px 80px rgb(0 0 0 / 30%); }
.lobby-panel { display: grid; width: min(100%, 640px); height: 100%; min-height: 0; grid-template-rows: auto auto auto auto minmax(0, 1fr) auto; gap: 8px; align-items: center; text-align: center; }
.lobby-kicker { color: var(--color-uno-accent); font-size: 11px; font-weight: 800; letter-spacing: .18em; text-transform: uppercase; }
.lobby-panel h1 { margin: 0; font-size: clamp(24px, 4vw, 36px); letter-spacing: -.04em; }
.lobby-panel p { margin: 0; color: var(--color-uno-muted); font-size: 13px; }
.lobby-code-row { display: flex; align-items: center; justify-content: center; gap: 12px; }
.lobby-code-label { color: var(--color-uno-muted); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .12em; }
.lobby-code-row strong { font-size: 20px; letter-spacing: .16em; }
.lobby-code-row button, .lobby-start { border: 0; border-radius: 12px; font-weight: 800; }
.lobby-code-row button { min-height: 32px; padding: 0 12px; background: rgb(255 255 255 / 10%); color: white; font-size: 12px; }
.lobby-player-list { display: grid; min-height: 0; align-content: start; grid-template-columns: 1fr; gap: 8px; overflow: auto; padding: 4px 0; text-align: left; }
.lobby-player-list-many { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.lobby-player { display: grid; min-height: 42px; min-width: 0; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 8px; border: 1px solid rgb(255 255 255 / 10%); border-radius: 12px; padding: 0 8px; background: rgb(0 0 0 / 13%); }
.lobby-avatar, .player-avatar, .seat-avatar { position: relative; display: grid; place-items: center; border: 2px solid #1681e1; border-radius: 50%; background: #7a4c31; color: white; font-weight: 800; }
.lobby-avatar { width: 28px; height: 28px; font-size: 11px; }
.lobby-avatar.offline, .seat-avatar-offline { filter: grayscale(1); opacity: .55; }
.lobby-player-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 800; }
.lobby-player-state { color: var(--color-uno-muted); font-size: 10px; font-weight: 800; text-transform: uppercase; }
.make-host { grid-column: 2 / -1; justify-self: start; border: 0; background: transparent; color: var(--color-uno-accent); font-size: 10px; font-weight: 800; }
.lobby-start { min-height: 44px; width: min(260px, 100%); justify-self: center; background: linear-gradient(100deg, #ffd858, #e8ae21); color: #423100; box-shadow: 0 12px 24px rgb(0 0 0 / 22%); }
.lobby-start:disabled { opacity: .45; }
.lobby-waiting { justify-self: center; border: 1px solid rgb(255 255 255 / 12%); border-radius: 999px; padding: 8px 16px; color: rgb(255 255 255 / 72%); font-size: 12px; font-weight: 800; }

.game-table-shell { position: relative; min-height: 0; overflow: hidden; }
.table-progress-track { position: absolute; z-index: 12; top: 0; left: 0; right: 0; height: 4px; overflow: hidden; border-radius: 999px; background: rgb(255 255 255 / 12%); }
.table-progress { display: block; height: 100%; transform-origin: left center; transition: transform 180ms linear, background-color 180ms ease; }
.progress-green { background: #41d17e; }.progress-yellow { background: #f7c948; }.progress-red { background: #ff6868; }
.game-table { display: grid; height: 100%; min-height: 0; grid-template-areas: "top top top" "left center right"; grid-template-columns: minmax(0, 140px) minmax(0, 1fr) minmax(0, 140px); grid-template-rows: minmax(64px, auto) minmax(0, 1fr); gap: 8px 16px; overflow: hidden; border: 1px solid rgb(255 255 255 / 10%); border-radius: 16px; padding: 16px; background: radial-gradient(circle at 50% 42%, rgb(255 255 255 / 4%), transparent 42%), repeating-linear-gradient(115deg, rgb(255 255 255 / 2%) 0 1px, transparent 1px 5px), radial-gradient(circle at 50% 50%, #35454b, #27343a 64%, #1c292e); box-shadow: inset 0 0 40px rgb(0 0 0 / 25%); }
.opponent-top-band { grid-area: top; display: flex; min-width: 0; align-items: start; justify-content: center; gap: 12px; padding-top: 32px; padding-bottom: 16px; }
.opponent-side { display: flex; min-height: 0; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
.opponent-side-left { grid-area: left; }.opponent-side-right { grid-area: right; }
.table-center-zone { grid-area: center; display: grid; min-width: 0; min-height: 0; grid-template-rows: minmax(0, 1fr) auto; align-items: center; justify-items: center; }
.play-piles { display: flex; min-width: 0; min-height: 0; align-items: center; justify-content: center; gap: clamp(16px, 3vw, 48px); transform: translateY(-4px); }
.draw-pile, .discard-drop-zone { display: grid; place-items: center; }
.draw-pile-button { display: grid; place-items: center; gap: 2px; border: 0; background: transparent; color: white; }
.draw-pile-button:disabled { opacity: .55; }
.draw-pile-stack, .discard-pile { position: relative; width: var(--card-width); height: var(--card-height); }
.draw-back, .discard-depth { position: absolute; inset: 0; }
.draw-back-one { transform: translate(6px, 6px) rotate(5deg); opacity: .35; }.draw-back-two { transform: translate(3px, 3px) rotate(2deg); opacity: .65; }.draw-back-top { transform: rotate(-2deg); }
.draw-pile-button strong { font-size: 22px; line-height: 1; }.draw-pile-button > span:last-child { color: rgb(255 255 255 / 68%); font-size: 10px; font-weight: 800; line-height: 1; text-transform: uppercase; letter-spacing: .12em; }
.discard-drop-zone { width: calc(var(--card-width) + 48px); height: calc(var(--card-height) + 48px); padding: 24px; border-radius: 14px; }
.discard-drop-active { box-shadow: 0 0 0 3px rgb(247 201 72 / 80%), 0 0 26px rgb(247 201 72 / 30%); }
.discard-content { display: flex; align-items: center; gap: 8px; }.discard-pile { flex: 0 0 auto; }.discard-depth-one { transform: translate(6px, 6px) rotate(5deg); opacity: .22; }.discard-depth-two { transform: translate(3px, 3px) rotate(2deg); opacity: .4; }
.color-chip { display: flex; align-items: center; gap: 4px; border-radius: 999px; padding: 4px 8px; background: rgb(0 0 0 / 28%); color: rgb(255 255 255 / 76%); font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
.color-chip-dot { width: 8px; height: 8px; border-radius: 50%; }
.status-line { display: flex; align-items: center; justify-content: center; gap: 8px; border-radius: 999px; padding: 6px 12px; background: rgb(0 0 0 / 24%); color: rgb(255 255 255 / 82%); font-size: 12px; font-weight: 800; transform: translateY(clamp(12px, 3dvh, 20px)); }
.status-line span { color: var(--color-uno-accent); }.status-line span:last-child { color: rgb(255 255 255 / 55%); }

.seat-card { position: relative; width: min(140px, 100%); min-width: 0; text-align: center; }.seat-card-compact { width: min(96px, 100%); }.seat-main { display: inline-flex; max-width: 100%; align-items: center; gap: 8px; border: 1px solid rgb(255 255 255 / 10%); border-radius: 12px; padding: 4px 8px; background: rgb(18 22 24 / 92%); text-align: left; }.seat-active { border-color: var(--color-uno-accent); }.seat-avatar { width: 36px; height: 36px; flex: 0 0 auto; font-size: 13px; }.seat-avatar-active { animation: turn-ring 1.4s ease-out infinite; }.seat-avatar-compact { width: 28px; height: 28px; }.seat-details { display: flex; min-width: 0; align-items: center; gap: 4px; }.seat-details strong { max-width: 78px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }.seat-count { color: var(--color-uno-muted); font-size: 10px; }.seat-timer { position: absolute; right: -4px; top: -4px; display: grid; width: 20px; height: 20px; place-items: center; border: 2px solid var(--color-uno-accent); border-radius: 50%; background: #17232a; color: white; font-size: 9px; }.offline-dot { position: absolute; right: -1px; bottom: -1px; width: 9px; height: 9px; border: 2px solid #17232a; border-radius: 50%; background: #879197; }.seat-fan { display: flex; justify-content: center; margin-top: 4px; }.seat-card-back { width: 28px !important; height: 42px !important; margin-left: -16px; border-width: 2px; }.seat-card-back:first-child { margin-left: 0; }.uno-tag, .uno-question { position: absolute; top: 100%; left: 50%; display: inline-block; margin-top: 4px; transform: translateX(-50%); white-space: nowrap; border-radius: 999px; padding: 3px 7px; font-size: 9px; font-weight: 800; text-transform: uppercase; }.uno-tag { background: #f7c948; color: #493600; }.uno-question { animation: bubble-pulse 1s ease-in-out infinite; background: #f7c948; color: #493600; }.seat-bubble { position: absolute; z-index: 15; left: 50%; bottom: calc(100% + 8px); white-space: nowrap; border-radius: 12px; padding: 6px 10px; background: white; color: #182126; font-size: 12px; font-weight: 800; box-shadow: 0 10px 24px rgb(0 0 0 / 22%); animation: bubble-pop 3s ease both; pointer-events: none; }.seat-bubble::after { content: ""; position: absolute; bottom: -5px; left: 50%; width: 10px; height: 10px; transform: translateX(-50%) rotate(45deg); background: white; }.uno-bubble { background: #f7c948; color: #493600; }.uno-bubble::after { background: #f7c948; }.penalty-bubble { background: #ff8585; color: #351416; }.penalty-bubble::after { background: #ff8585; }

.player-info-row, .hand-section, .action-section { position: relative; z-index: 20; width: min(1200px, 100%); min-width: 0; margin: 0 auto; }.player-info-row { display: flex; align-items: center; }.player-info-card { position: relative; display: flex; min-width: 0; align-items: center; gap: 8px; border: 1px solid rgb(255 255 255 / 10%); border-radius: 12px; padding: 4px 8px; background: rgb(0 0 0 / 16%); }.player-info-active { border-color: rgb(247 201 72 / 55%); background: rgb(247 201 72 / 10%); }.player-avatar { width: 28px; height: 28px; font-size: 11px; }.player-info-copy { display: grid; min-width: 0; }.player-info-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }.player-info-copy span { color: var(--color-uno-muted); font-size: 10px; }.chat-button { display: grid; width: 28px; height: 28px; place-items: center; border: 0; border-radius: 50%; background: rgb(255 255 255 / 10%); color: white; font-size: 18px; }.player-bubble { left: 40px; bottom: calc(100% + 4px); transform: translateX(-10%); }.quick-message-picker { position: absolute; z-index: 50; left: 100px; bottom: calc(100% + 8px); display: grid; width: min(240px, calc(100vw - 24px)); grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px; border: 1px solid rgb(255 255 255 / 14%); border-radius: 12px; padding: 8px; background: #2a3034; box-shadow: 0 24px 80px rgb(0 0 0 / 30%); }.quick-message-picker button { min-height: 32px; border: 0; border-radius: 8px; background: rgb(255 255 255 / 9%); color: white; font-size: 11px; font-weight: 800; }.hand-section { min-height: 0; }.hand-zone { position: relative; display: flex; min-width: 0; width: 100%; height: 100%; min-height: 0; align-items: end; overflow: visible; padding: 12px 8px 0; }.hand-count { position: absolute; top: 0; left: 8px; color: var(--color-uno-muted); font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .14em; }.card-probe { position: absolute; width: var(--card-width); height: var(--card-height); opacity: 0; pointer-events: none; }.hand-rows { display: flex; width: 100%; min-width: 0; min-height: 0; flex-direction: column; justify-content: end; }.hand-row { display: flex; min-width: 0; min-height: 0; align-items: end; justify-content: center; padding: 0 4px; }.hand-row + .hand-row { margin-top: -10px; }.hand-card { flex: 0 0 auto; }.legal-card { animation: legal-pulse 1.6s ease-in-out infinite; }.card-oval { position: absolute; inset: 13% 10%; transform: rotate(-28deg); border-radius: 50%; background: rgb(255 255 255 / 94%); pointer-events: none; }.card-corner { position: absolute; z-index: 10; top: 3%; left: 5%; font-size: calc(var(--card-width) * .28); font-weight: 800; line-height: 1; text-shadow: 1px 2px 0 rgb(0 0 0 / 35%); }.card-corner-bottom { top: auto; right: 5%; bottom: 3%; left: auto; transform: rotate(180deg); }.card-number { position: relative; z-index: 10; font-size: clamp(2rem, 5vw, 3.2rem); font-weight: 800; line-height: 1; text-shadow: 1px 2px 0 rgb(0 0 0 / 25%); }.wild-icon { position: relative; z-index: 10; display: grid; width: 62%; aspect-ratio: 1; grid-template-columns: repeat(2, 1fr); overflow: hidden; border: 2px solid rgb(255 255 255 / 80%); border-radius: 50%; }.wild-icon b { position: absolute; inset: 0; display: grid; place-items: center; color: white; font-size: 22px; text-shadow: 1px 2px 0 rgb(0 0 0 / 35%); }.card-svg { position: relative; z-index: 10; width: 58%; height: 58%; color: white; filter: drop-shadow(1px 2px 0 rgb(0 0 0 / 25%)); }.card-slash { position: absolute; inset: 0; z-index: 20; background: repeating-linear-gradient(135deg, transparent 0 9px, rgb(0 0 0 / 12%) 9px 11px); pointer-events: none; }.uno-card-back { background: repeating-linear-gradient(135deg, #d3d4cf 0 3px, #a8aba8 3px 5px, #e8e9e4 5px 8px), #b9bbb7; }.uno-card-back-dark { background: repeating-linear-gradient(135deg, rgb(255 255 255 / 12%) 0 3px, transparent 3px 7px), #152b43; }.card-back-logo { display: grid; width: 72%; height: 72%; place-items: center; border: 2px solid rgb(255 255 255 / 45%); border-radius: 45%; color: rgb(255 255 255 / 70%); font-size: 10px; font-weight: 800; letter-spacing: .18em; }
.action-section { display: flex; align-items: center; }.action-bar { display: grid; width: min(560px, 100%); grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0 auto; }.action-button { min-height: 44px; border: 0; border-radius: 12px; padding: 0 16px; font-size: 13px; font-weight: 800; color: white; box-shadow: 0 10px 20px rgb(0 0 0 / 18%); }.action-primary { background: #0768c9; }.action-uno { background: #0a3458; }.action-uno.uno-ready { background: #f7c948; color: #493600; }.action-button:disabled { opacity: .45; }
.toast { position: fixed; z-index: 200; bottom: 72px; left: 50%; max-width: min(90vw, 420px); transform: translateX(-50%); border: 1px solid rgb(255 255 255 / 15%); border-radius: 999px; padding: 8px 16px; background: rgb(18 24 27 / 95%); color: white; text-align: center; font-size: 13px; font-weight: 800; pointer-events: none; box-shadow: 0 24px 80px rgb(0 0 0 / 30%); }.loading-shell { place-items: center; }.loading-card { border: 1px solid rgb(255 255 255 / 15%); border-radius: 16px; padding: 24px; background: #2a3034; text-align: center; }.loading-card button { min-height: 44px; border: 0; border-radius: 12px; padding: 0 16px; background: #0768c9; color: white; font-weight: 800; }

.felt-texture {
  background:
    radial-gradient(circle at 50% 45%, rgb(255 255 255 / 4%), transparent 42%),
    repeating-linear-gradient(115deg, rgb(255 255 255 / 2%) 0 1px, transparent 1px 5px),
    radial-gradient(circle at 50% 50%, #35454b, #27343a 64%, #1c292e);
}

.uno-card-back {
  background:
    repeating-linear-gradient(135deg, #d3d4cf 0 3px, #a8aba8 3px 5px, #e8e9e4 5px 8px),
    #b9bbb7;
}

.uno-card-back-dark {
  background:
    repeating-linear-gradient(135deg, rgb(255 255 255 / 12%) 0 3px, transparent 3px 7px),
    #152b43;
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 1ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 1ms !important;
  }
}

@media (max-height: 700px) and (min-width: 701px) {
  .opponent-side { gap: 8px; }
  .opponent-side .seat-fan { display: none; }
  .opponent-side .seat-main { padding: 2px 4px; }
  .opponent-side .seat-avatar { width: 28px; height: 28px; }
}

@media (max-width: 700px) {
  .app-shell { padding: 8px; }.top-bar { padding: 0 8px; }.top-bar-room, .top-bar-right { gap: 8px; }.top-bar-gear { display: none; }.top-bar-copy { padding: 5px 8px; font-size: 10px; }.top-bar-count { padding: 5px 8px; }.top-bar-room > span:not(.top-bar-gear) { font-size: 12px; }
  .game-shell { grid-template-rows: clamp(44px, 7dvh, 56px) minmax(0, 1fr) 40px minmax(0, calc(var(--card-height) + 20px)) clamp(44px, 6.5dvh, 56px); }
  .game-table { grid-template-areas: "top" "center"; grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr); gap: 8px; padding: 12px 8px; }
  .opponent-side { display: none; }.opponent-top-band { display: grid; grid-template-columns: repeat(4, minmax(0, 72px)); justify-content: center; gap: 4px; padding-top: 26px; }.seat-card { width: 72px; }.seat-main { gap: 4px; padding: 2px 4px; }.seat-avatar { width: 24px; height: 24px; font-size: 10px; }.seat-details { gap: 2px; }.seat-details strong { max-width: 34px; font-size: 8px; }.seat-count { font-size: 8px; }.seat-fan { display: none; }.uno-tag, .uno-question { margin-top: 2px; }.table-center-zone { grid-template-rows: minmax(0, 1fr) auto; }.play-piles { gap: 16px; }.color-chip { font-size: 9px; }.lobby-panel-wrap { padding: 12px 8px; }.lobby-player-list-many { grid-template-columns: repeat(2, minmax(0, 1fr)); }.lobby-player { gap: 4px; padding: 0 6px; }.lobby-player-state { display: none; }.make-host { font-size: 9px; }.quick-message-picker { left: 0; bottom: calc(100% + 8px); }.seat-bubble { font-size: 10px; }.toast { bottom: 64px; }
}

@media (max-height: 480px) and (orientation: landscape) {
  .game-shell { grid-template-rows: 44px minmax(0, 1fr) 40px minmax(0, calc(var(--card-height) + 20px)); }
  .game-table-shell { grid-row: 2; grid-column: 1; padding-right: 88px; }
  .player-info-row { grid-row: 3; grid-column: 1; }
  .hand-section { grid-row: 4; grid-column: 1; }
  .action-section { grid-row: 2; grid-column: 1; z-index: 35; display: flex; width: 80px !important; margin: 0 0 0 auto !important; align-items: center; justify-content: center; pointer-events: none; justify-self: end; }
  .action-bar { width: 76px; grid-template-columns: 1fr; gap: 4px; pointer-events: auto; }
  .action-button { min-height: 24px; padding: 0 6px; font-size: 9px; }
  .game-table { grid-template-areas: "top top top" "left center right"; grid-template-columns: minmax(0, 56px) minmax(0, 1fr) minmax(0, 56px); grid-template-rows: minmax(40px, auto) minmax(0, 1fr); padding: 8px; }
  .opponent-top-band { display: flex; flex-wrap: nowrap; gap: 4px; padding-top: 0; padding-bottom: 0; }
  .opponent-side { display: none; }
  .seat-card { width: 72px; }
  .seat-fan { display: none; }
  .table-center-zone { padding-top: 0; }
  .play-piles { gap: 4px; transform: none; }
  .draw-pile-button { position: relative; height: var(--card-height); }
  .draw-pile-button > span:last-child { display: none; }
  .draw-pile-button > strong { position: absolute; bottom: -2px; }
  .draw-pile-button strong { font-size: 18px; }
  .discard-drop-zone { width: var(--card-width); height: var(--card-height); padding: 0; }
  .color-chip { display: none; }
  .status-line { transform: translateY(2px); font-size: 9px; padding: 4px 6px; }
}
```

## `apps/web/app/room/[roomCode]/components/ActionBar.tsx`

```text
"use client";

export function ActionBar({ isMyTurn, hasNoMoves, drewThisTurn, canCallUno, unoLabel, onDraw, onCallUno }: { isMyTurn: boolean; hasNoMoves: boolean; drewThisTurn: boolean; canCallUno: boolean; unoLabel: string; onDraw: () => void; onCallUno: () => void }) {
  return (
    <div className="action-bar">
      <button data-testid="draw-action" type="button" onClick={onDraw} disabled={!isMyTurn} className={`action-button action-primary ${hasNoMoves ? "legal-pulse" : ""}`}>
        {drewThisTurn ? "Pass" : "Draw card"}
      </button>
      <button data-testid="call-uno" type="button" onClick={onCallUno} disabled={!canCallUno} className={`action-button action-uno ${unoLabel.startsWith("UNO!") ? "uno-ready" : ""}`}>
        {unoLabel}
      </button>
    </div>
  );
}
```

## `apps/web/app/room/[roomCode]/components/Card.tsx`

```text
"use client";

import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from "react";
import type { Card as UnoCard } from "@uno/game-engine";

const CARD_BASE = "relative isolate grid shrink-0 place-items-center overflow-hidden rounded-card border-[3px] border-white text-white shadow-card transition-transform duration-150 ease-out focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-uno-accent/80";
const CARD_TONES: Record<UnoCard["color"], string> = {
  red: "bg-gradient-to-br from-card-red-start to-card-red-end",
  yellow: "bg-gradient-to-br from-card-yellow-start to-card-yellow-end",
  green: "bg-gradient-to-br from-card-green-start to-card-green-end",
  blue: "bg-gradient-to-br from-card-blue-start to-card-blue-end",
  wild: "bg-gradient-to-br from-card-wild-start to-card-wild-end",
};

export type CardVariant = "hand" | "discard" | "ghost" | "picker";

interface CardProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  card: UnoCard;
  variant?: CardVariant;
  legal?: boolean;
  isMyTurn?: boolean;
  selected?: boolean;
  shaking?: boolean;
  cardStyle?: CSSProperties;
  children?: ReactNode;
}

function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

export function cardLabel(card: UnoCard): string {
  if (card.kind === "number") return String(card.value);
  if (card.kind === "wildDraw4") return "+4";
  if (card.kind === "draw2") return "+2";
  if (card.kind === "skip") return "Skip";
  if (card.kind === "reverse") return "Reverse";
  return "Wild";
}

export function cardAriaLabel(card: UnoCard): string {
  const color = card.color === "wild" ? "Wild" : `${card.color.charAt(0).toUpperCase()}${card.color.slice(1)}`;
  return `${color} ${cardLabel(card).toLowerCase()} card`;
}

function CardIcon({ card }: { card: UnoCard }) {
  if (card.kind === "number") return <span className="card-number">{card.value}</span>;
  if (card.kind === "wild" || card.kind === "wildDraw4") return <span className="wild-icon"><span className="bg-red-500" /><span className="bg-yellow-300" /><span className="bg-blue-500" /><span className="bg-green-500" />{card.kind === "wildDraw4" ? <b>+4</b> : null}</span>;
  if (card.kind === "skip") return <svg aria-hidden="true" className="card-svg" viewBox="0 0 64 64" fill="none"><circle cx="32" cy="32" r="22" stroke="currentColor" strokeWidth="6" /><path d="M17 47 47 17" stroke="currentColor" strokeWidth="7" strokeLinecap="round" /></svg>;
  if (card.kind === "reverse") return <svg aria-hidden="true" className="card-svg" viewBox="0 0 64 64" fill="none"><path d="M12 24h35m0 0-9-9m9 9-9 9M52 40H17m0 0 9-9m-9 9 9 9" stroke="currentColor" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" /></svg>;
  return <svg aria-hidden="true" className="card-svg" viewBox="0 0 64 64" fill="none"><rect x="15" y="15" width="25" height="30" rx="4" stroke="currentColor" strokeWidth="5" /><path d="M26 11h23v30" stroke="currentColor" strokeWidth="5" /><path d="M45 25v14m-7-7h14" stroke="currentColor" strokeWidth="5" strokeLinecap="round" /></svg>;
}

export function Card({ card, variant = "hand", legal = false, isMyTurn = false, selected = false, shaking = false, cardStyle, className, children, ...buttonProps }: CardProps) {
  const interactive = variant === "hand";
  const stateClasses = interactive
    ? isMyTurn
      ? legal
        ? "legal-card cursor-grab hover:z-40 hover:-translate-y-3 hover:shadow-card-hover active:cursor-grabbing"
        : "cursor-not-allowed brightness-[.6] saturate-[.7]"
      : "cursor-default brightness-75 saturate-75"
    : "cursor-default";
  const { style: buttonStyle, ...restButtonProps } = buttonProps;
  const style = { ...cardStyle, ...buttonStyle, "--card-glow": `var(--color-card-${card.color}-end)` } as CSSProperties;
  return (
    <button
      type="button"
      data-card-id={card.id}
      data-card-legal={legal}
      aria-label={cardAriaLabel(card)}
      aria-pressed={selected}
      aria-disabled={interactive && (!isMyTurn || !legal)}
      className={cn(CARD_BASE, CARD_TONES[card.color], `h-[var(--card-height)] w-[var(--card-width)]`, stateClasses, selected && "z-40 -translate-y-3 scale-[1.04] shadow-card-hover ring-4 ring-uno-accent", shaking && "card-shake", variant === "discard" && "shadow-card-hover", variant === "ghost" && "pointer-events-none scale-[1.08] shadow-[0_22px_38px_rgb(0_0_0_/_55%)]", variant === "picker" && "h-36 w-24", className)}
      style={style}
      {...restButtonProps}
    >
      <span className="card-oval" />
      <span className="card-corner">{cardLabel(card)}</span>
      <CardIcon card={card} />
      <span className="card-corner card-corner-bottom">{cardLabel(card)}</span>
      {!legal && isMyTurn && interactive ? <span aria-hidden="true" className="card-slash" /> : null}
      {children}
    </button>
  );
}

export function CardBack({ dark = false, className }: { dark?: boolean; className?: string }) {
  return <span className={cn("uno-card-back relative grid h-[var(--card-height)] w-[var(--card-width)] shrink-0 place-items-center overflow-hidden rounded-card border-[3px] border-white/80 shadow-card", dark ? "uno-card-back-dark" : "", className)} aria-hidden="true"><span className="card-back-logo">UNO</span></span>;
}
```

## `apps/web/app/room/[roomCode]/components/DiscardPile.tsx`

```text
"use client";

import type { Card } from "@uno/game-engine";
import type { CSSProperties, RefObject } from "react";
import { Card as UnoCard, CardBack } from "./Card";

export function DiscardPile({ topCard, currentColor, targetRef, pileRef, active, onClick }: { topCard?: Card; currentColor?: string; targetRef: RefObject<HTMLDivElement | null>; pileRef?: RefObject<HTMLDivElement | null>; active: boolean; onClick?: () => void }) {
  const color = currentColor ?? "#8c979c";
  return (
    <div ref={targetRef} className={`discard-drop-zone ${active ? "discard-drop-active" : ""}`} onClick={onClick}>
      <div className="discard-content">
        <div ref={pileRef} data-layout-role="discard-pile" className="discard-pile" style={{ boxShadow: `0 0 0 3px ${color}99` }}>
          <CardBack dark className="discard-depth discard-depth-one" />
          <CardBack dark className="discard-depth discard-depth-two" />
          {topCard ? <UnoCard card={topCard} variant="discard" cardStyle={{ "--card-width": "var(--card-width)", "--card-height": "var(--card-height)" } as CSSProperties} /> : null}
        </div>
        <span className="color-chip"><span className="color-chip-dot" style={{ backgroundColor: color }} />{currentColor ?? "waiting"}</span>
      </div>
    </div>
  );
}
```

## `apps/web/app/room/[roomCode]/components/DrawPile.tsx`

```text
"use client";

import type { MouseEventHandler, RefObject } from "react";
import { CardBack } from "./Card";

export function DrawPile({ disabled, pulse, onDraw, pileRef }: { count?: number; disabled: boolean; pulse: boolean; onDraw: MouseEventHandler<HTMLButtonElement>; pileRef?: RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={pileRef} data-layout-role="draw-pile" className="draw-pile">
      <button type="button" onClick={onDraw} disabled={disabled} aria-label="Draw card" className={`draw-pile-button ${pulse ? "legal-pulse" : ""}`}>
        <span className="draw-pile-stack">
          <CardBack dark className="draw-back draw-back-one" />
          <CardBack dark className="draw-back draw-back-two" />
          <CardBack dark className="draw-back draw-back-top" />
        </span>
        <strong>∞</strong>
        <span>Draw pile</span>
      </button>
    </div>
  );
}
```

## `apps/web/app/room/[roomCode]/components/Hand.tsx`

```text
"use client";

import type { CSSProperties } from "react";
import type { Card } from "@uno/game-engine";
import type { CardDragState } from "../hooks/useCardDrag";
import { Card as UnoCard } from "./Card";

type HandLayout = ReturnType<typeof import("../hooks/useHandLayout").useHandLayout>;

export function Hand({ cards, layout, drag, legalCardIds, isMyTurn }: { cards: Card[]; layout: HandLayout; drag: CardDragState; legalCardIds: Set<string>; isMyTurn: boolean }) {
  const rows = layout.rows === 2 ? [cards.slice(0, layout.capacity), cards.slice(layout.capacity)] : [cards];
  return (
    <div ref={layout.ref} data-layout-role="hand-zone" onContextMenu={(event) => event.preventDefault()} className="hand-zone">
      <span className="hand-count">{cards.length} cards</span>
      <span data-card-probe className="card-probe" aria-hidden="true" />
      <div className={`hand-rows ${layout.rows === 2 ? "hand-rows-two" : ""}`}>
        {rows.map((row, rowIndex) => {
          const rowLayout = layout.rowLayouts[rowIndex] ?? layout.rowLayouts[0];
          if (!rowLayout) return null;
          return (
            <div className="hand-row" key={rowIndex}>
              {row.map((card, index) => {
                const props = drag.getCardProps(card);
                const style = {
                  ...props.style,
                  width: rowLayout.cardWidth,
                  height: rowLayout.cardWidth * 1.47,
                  marginLeft: index === 0 || !rowLayout.overlap ? 0 : -(rowLayout.cardWidth - rowLayout.step),
                  zIndex: 1,
                  "--card-width": `${rowLayout.cardWidth}px`,
                  "--card-height": `${rowLayout.cardWidth * 1.47}px`,
                } as CSSProperties;
                return <UnoCard key={card.id} card={card} legal={legalCardIds.has(card.id)} isMyTurn={isMyTurn} selected={drag.selectedCardId === card.id} shaking={drag.shakeCardId === card.id} cardStyle={style} className="hand-card" {...props} />;
              })}
            </div>
          );
        })}
      </div>
      {drag.ghost ? <div className="pointer-events-none fixed z-drag" style={{ left: drag.ghost.x, top: drag.ghost.y, transform: `translate(-50%, -50%) rotate(${drag.ghost.rotation}deg)` }}><UnoCard card={drag.ghost.card} variant="ghost" legal isMyTurn /></div> : null}
    </div>
  );
}
```

## `apps/web/app/room/[roomCode]/components/LobbyPanel.tsx`

```text
"use client";

import type { PublicRoom } from "@uno/protocol";

export function LobbyPanel({ room, isHost, onStart, onTransferHost, onCopy }: { room: PublicRoom; isHost: boolean; onStart: () => void; onTransferHost: (playerId: string) => void; onCopy: () => void }) {
  const manyPlayers = room.players.length > 4;
  const hostName = room.players.find((player) => player.isHost)?.displayName ?? "the host";

  return (
    <div className="lobby-panel" data-layout-role="lobby-panel">
      <span className="lobby-kicker">Room lobby</span>
      <h1>Ready when you are?</h1>
      <p>{room.players.length < 2 ? "Invite at least one more player to unlock the match." : "Everyone is in. The host can start the table."}</p>
      <div className="lobby-code-row">
        <span className="lobby-code-label">Room code</span>
        <strong>{room.code}</strong>
        <button type="button" onClick={onCopy}>Copy</button>
      </div>
      <div className={`lobby-player-list ${manyPlayers ? "lobby-player-list-many" : ""}`} aria-label="Players in the room">
        {room.players.map((player) => (
          <div className="lobby-player" key={player.id}>
            <span className={`lobby-avatar ${player.connected ? "" : "offline"}`}>{player.displayName.slice(0, 1).toUpperCase()}</span>
            <span className="lobby-player-name">{player.displayName}</span>
            <span className="lobby-player-state">{player.isHost ? "Host" : player.connected ? "Ready" : "Offline"}</span>
            {isHost && !player.isHost ? <button type="button" className="make-host" onClick={() => onTransferHost(player.id)}>Make host</button> : null}
          </div>
        ))}
      </div>
      {isHost ? <button type="button" disabled={room.players.length < 2} onClick={onStart} className="lobby-start">Start game <span aria-hidden="true">→</span></button> : <div className="lobby-waiting">Waiting for {hostName} to start</div>}
    </div>
  );
}
```

## `apps/web/app/room/[roomCode]/components/OpponentSeat.tsx`

```text
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
```

## `apps/web/app/room/[roomCode]/components/PlayerInfo.tsx`

```text
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
```

## `apps/web/app/room/[roomCode]/components/QuickMessagePicker.tsx`

```text
"use client";

import type { QuickMessage } from "@uno/protocol";

const MESSAGES: QuickMessage[] = ["Nice!", "Dang!", "GG", "Hurry up!", "Oops", "Wow!", "Your turn", "Good game"];

export function QuickMessagePicker({ onChoose }: { onChoose: (message: QuickMessage) => void }) {
  return (
    <div className="quick-message-picker" role="dialog" aria-label="Quick messages">
      {MESSAGES.map((message) => <button key={message} type="button" onClick={() => onChoose(message)}>{message}</button>)}
    </div>
  );
}
```

## `apps/web/app/room/[roomCode]/components/Toast.tsx`

```text
"use client";

export function Toast({ message }: { message?: string }) {
  if (!message) return null;
  return <div role="status" className="toast">{message}</div>;
}
```

## `apps/web/app/room/[roomCode]/components/TopBar.tsx`

```text
"use client";

import { useState } from "react";
import type { PublicRoom } from "@uno/protocol";

export function TopBar({ room, onLeave, onTransferHost, hapticsEnabled, onToggleHaptics, onCopyInvite }: { room: PublicRoom; onLeave: () => void; onTransferHost: (playerId: string) => void; hapticsEnabled: boolean; onToggleHaptics: () => void; onCopyInvite: () => void }) {
  const [open, setOpen] = useState(false);
  const host = room.players.find((player) => player.isHost);
  return (
    <header data-layout-role="top-bar" className="top-bar">
      <div className="top-bar-room"><span className="top-bar-gear">⚙</span><span>Room: <strong>{room.code.toLowerCase()}</strong></span><button type="button" onClick={onCopyInvite} className="top-bar-copy">Copy invite</button></div>
      <div className="top-bar-right"><span className="top-bar-count">{room.players.length}/{room.maxPlayers}</span><button type="button" aria-expanded={open} aria-label="Open room settings" className="top-bar-menu" onClick={() => setOpen((value) => !value)}>⋮</button></div>
      {open ? <div className="settings-popover"><p>Room settings</p><span>Turn timer <strong>{room.turnSeconds}s</strong></span><span>Host <strong>{host?.displayName ?? "—"}</strong></span><button type="button" onClick={onToggleHaptics}>Haptics <strong>{hapticsEnabled ? "On" : "Off"}</strong></button><div className="settings-host-list">{room.players.filter((player) => !player.isHost).map((player) => <button type="button" key={player.id} onClick={() => onTransferHost(player.id)}>Make {player.displayName} host</button>)}</div><button type="button" className="settings-leave" onClick={onLeave}>Leave room</button></div> : null}
    </header>
  );
}
```

## `apps/web/app/room/[roomCode]/hooks/useHandLayout.ts`

```text
"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

const HAND_GAP = 8;

export interface HandRowLayout {
  cardWidth: number;
  step: number;
  overlap: boolean;
  width: number;
}

function layoutRow(count: number, width: number, desired: number, minimum: number): HandRowLayout {
  if (!count) return { cardWidth: desired, step: desired + HAND_GAP, overlap: false, width: 0 };
  const available = Math.max(0, width);
  const normalWidth = count * desired + Math.max(0, count - 1) * HAND_GAP;
  if (normalWidth <= available) return { cardWidth: desired, step: desired + HAND_GAP, overlap: false, width: normalWidth };

  const maximumVisibleWidth = available / (1 + Math.max(0, count - 1) * 0.4);
  const cardWidth = Math.min(desired, maximumVisibleWidth);
  const step = count === 1 ? 0 : Math.max(cardWidth * 0.4, (available - cardWidth) / (count - 1));
  return {
    cardWidth: Math.max(minimum, cardWidth),
    step,
    overlap: true,
    width: cardWidth + Math.max(0, count - 1) * step,
  };
}

function canFitOneRow(count: number, width: number, desired: number, minimum: number): boolean {
  if (count <= 1) return true;
  return width / (1 + (count - 1) * 0.4) >= minimum;
}

export function useHandLayout(count: number, desiredCardWidth: number, phone: boolean, short: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const minimum = phone || short ? 44 : 44;

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => setWidth(Math.max(0, node.clientWidth - 16));
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    measure();
    return () => observer.disconnect();
  }, [phone, short]);

  return useMemo(() => {
    const rows = count > 0 && !canFitOneRow(count, width, desiredCardWidth, minimum) ? 2 : 1;
    const capacity = rows === 2 ? Math.ceil(count / 2) : count;
    const rowCounts = rows === 2 ? [capacity, Math.max(0, count - capacity)] : [count];
    return {
      ref,
      rows,
      capacity,
      rowLayouts: rowCounts.map((rowCount) => layoutRow(rowCount, width, desiredCardWidth, minimum)),
    };
  }, [count, desiredCardWidth, minimum, width]);
}
```

## `apps/web/app/room/[roomCode]/hooks/useViewport.ts`

```text
"use client";

import { useEffect, useState } from "react";

type ViewportState = {
  width: number;
  height: number;
  reduced: boolean;
  cardWidth: number;
};

function getCardWidth(width: number, height: number, centerHeight: number): number {
  if (!width || !height) return 64;
  const base = Math.max(44, Math.min(96, Math.min(height * 0.105, width * 0.17)));
  if (!centerHeight || centerHeight >= base * 1.47 + 72) return base;
  return Math.max(44, Math.min(base, (centerHeight - 72) / 1.47));
}

export function useViewport() {
  const [size, setSize] = useState<ViewportState>({ width: 0, height: 0, reduced: false, cardWidth: 64 });

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const check = () => {
      const scrollHeight = document.scrollingElement?.scrollHeight ?? 0;
      if (scrollHeight > innerHeight + 1) console.warn("UNO viewport overflow", { scrollHeight, innerHeight });
    };
    const frame = requestAnimationFrame(check);
    window.addEventListener("resize", check);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", check);
    };
  }, []);

  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      const width = innerWidth;
      const height = visualViewport?.height ?? innerHeight;
      const centerHeight = document.querySelector<HTMLElement>("[data-layout-role='table'] .table-center-zone")?.clientHeight ?? 0;
      setSize({ width, height, reduced: media.matches, cardWidth: getCardWidth(width, height, centerHeight) });
    };
    const table = document.querySelector<HTMLElement>("[data-layout-role='table']");
    const observer = table ? new ResizeObserver(update) : undefined;
    if (table) observer?.observe(table);
    const mutationObserver = new MutationObserver(update);
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    update();
    window.addEventListener("resize", update);
    visualViewport?.addEventListener("resize", update);
    media.addEventListener("change", update);
    return () => {
      observer?.disconnect();
      mutationObserver.disconnect();
      window.removeEventListener("resize", update);
      visualViewport?.removeEventListener("resize", update);
      media.removeEventListener("change", update);
    };
  }, []);

  return {
    ...size,
    short: size.height < 480 && size.width > size.height,
    phone: size.width < 700,
    portrait: size.width < size.height,
  };
}
```

## `apps/web/app/room/[roomCode]/page.tsx`

```text
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
```

## `apps/web/next-env.d.ts`

```text
/// <reference types="next" />
/// <reference types="next/image-types/global" />
import "./.next/types/routes.d.ts";
import "./.next/types/root-params.d.ts";

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
```

## `package-lock.json`

```text
{
  "name": "uno-multiplayer",
  "version": "0.1.0",
  "lockfileVersion": 3,
  "requires": true,
  "packages": {
    "": {
      "name": "uno-multiplayer",
      "version": "0.1.0",
      "workspaces": [
        "apps/*",
        "packages/*"
      ],
      "devDependencies": {
        "@playwright/test": "^1.64.1",
        "tsx": "^4.20.6"
      },
      "engines": {
        "node": ">=20.9.0"
      }
    },
    "apps/realtime": {
      "name": "@uno/realtime",
      "version": "0.1.0",
      "dependencies": {
        "@fastify/cors": "^11.3.1",
        "@uno/game-engine": "0.1.0",
        "@uno/protocol": "0.1.0",
        "fastify": "^5.12.7",
        "socket.io": "^4.8.4"
      },
      "devDependencies": {
        "@types/node": "^24.10.1",
        "tsx": "^4.20.6",
        "typescript": "^5.0.5"
      }
    },
    "apps/web": {
      "name": "@uno/web",
      "version": "0.1.0",
      "dependencies": {
        "@uno/game-engine": "0.1.0",
        "@uno/protocol": "0.1.0",
        "next": "^16.4.3",
        "react": "^19.3.1",
        "react-dom": "^19.3.1",
        "socket.io-client": "^4.8.4"
      },
      "devDependencies": {
        "@tailwindcss/postcss": "^4.3.3",
        "@types/node": "^24.10.1",
        "@types/react": "^19.2.7",
        "@types/react-dom": "^19.2.3",
        "tailwindcss": "^4.3.3",
        "typescript": "^5.0.5"
      }
    },
    "node_modules/@alloc/quick-lru": {
      "version": "5.3.0",
      "resolved": "https://registry.npmjs.org/@alloc/quick-lru/-/quick-lru-5.3.0.tgz",
      "integrity": "sha512-U4+70Pc5ZS9osnCBCE5Jha/ciHM+Yp+CNMNC/7HvYbNRk1Ldd+f7qO65W5qfhu/TCv+/ozljlXXe9Nj8419DMA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=10"
      },
      "funding": {
        "url": "https://github.com/sponsors/sindresorhus"
      }
    },
    "node_modules/@emnapi/runtime": {
      "version": "1.11.3",
      "resolved": "https://registry.npmjs.org/@emnapi/runtime/-/runtime-1.11.3.tgz",
      "integrity": "sha512-Xz4Tpyki7XyrpbUK1jR1AhdAdaXyhhY4lZ3neLodmhpuWfy2PAQN5B46sAiU4liOXGLkHypn/qU+jvfWSCYYLA==",
      "license": "MIT",
      "optional": true,
      "dependencies": {
        "tslib": "^2.4.0"
      }
    },
    "node_modules/@esbuild/aix-ppc64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/aix-ppc64/-/aix-ppc64-0.28.2.tgz",
      "integrity": "sha512-XExcO+dvLKvVtNTibSTBej1NCAbaGhWn9Ww1ZPx80qsahhPFe/8jgWP0IchNe0F3HwkU7n8ejhH8bjonqht8mQ==",
      "cpu": [
        "ppc64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "aix"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/android-arm": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/android-arm/-/android-arm-0.28.2.tgz",
      "integrity": "sha512-kXXoiPVVGQcnIYGOeaovwOURpniDBpSq4A03qkQ+BMQqtGG6HYap3xne9C1O1yo4TR3qxlCX5IqqmX6fFo2Lqg==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "android"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/android-arm64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/android-arm64/-/android-arm64-0.28.2.tgz",
      "integrity": "sha512-5YfKeeI8qWfBZIX+u2xZC3Zlb3Os/gLS2sbEKM+I4ZOcsWmHS2WLysCcQZDAFRslDUU5Oiq44gf6PYN1vGwG5A==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "android"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/android-x64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/android-x64/-/android-x64-0.28.2.tgz",
      "integrity": "sha512-O387ite7SzUyCcy3JQX4P4bLtEA7bLLkx+esve5JHnyYfNTxcVpXZo9jhdB0lTKN44gztELTdU7nS8Nr16Fs1Q==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "android"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/darwin-arm64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/darwin-arm64/-/darwin-arm64-0.28.2.tgz",
      "integrity": "sha512-n4KqkOQrraxHJcgjM1RvwbigfQKIKJVpM7xp+KsxiyUSrRdIXnt73VhrPAx0fV44hgfmIVKjxMN9J1t5jySVkw==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/darwin-x64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/darwin-x64/-/darwin-x64-0.28.2.tgz",
      "integrity": "sha512-uq6suIWYP37qzGddBKPw5QEQPi6HiLGsO7UmkpfyaYNQ3D+rN6w6WfwH+nuqcGXWvawGwxOEroO4YGnFh95azw==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/freebsd-arm64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/freebsd-arm64/-/freebsd-arm64-0.28.2.tgz",
      "integrity": "sha512-n+I0BTSRIoy+d6RPKnEVwql5UwBJolytvY4mAOIEJorKlqgPII8ix6slVVrfZ5Tnj7glIZvloylbB/EJPMWEXw==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "freebsd"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/freebsd-x64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/freebsd-x64/-/freebsd-x64-0.28.2.tgz",
      "integrity": "sha512-78XJTJkvPs0kz2w61301PJjXl4g7q3JqiYMZ/M/yVI73EHBrCRTgkhu9oqG7vPqq+a/yadEW8aD+agKlk5xrmg==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "freebsd"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-arm": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-arm/-/linux-arm-0.28.2.tgz",
      "integrity": "sha512-XlDnu2q5yoqems+xay6wSAcg9DDD7K9RLKZEBOMZm3ckNpJBvOX20tSfby8KfrrhINDyv9V2YVZKY/SpoGJI8w==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-arm64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-arm64/-/linux-arm64-0.28.2.tgz",
      "integrity": "sha512-pW4AC0P3it8c7do9MVM4p51FzHzdM/TZrerurgRcHJ2WTa1VQ1CIq18xncfpBJw4ojkiZZrKW2yIBWBP92j6Ug==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-ia32": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-ia32/-/linux-ia32-0.28.2.tgz",
      "integrity": "sha512-CYbnj78HsIeA+DhgUKgFCfvNsTHFhMMrinUrMZpDXJXKN8T3XViTZ/+wtHeVxEWY8ewSzTFN+nRmSwO2tZaLUQ==",
      "cpu": [
        "ia32"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-loong64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-loong64/-/linux-loong64-0.28.2.tgz",
      "integrity": "sha512-buwkd8nsph4R+ajRvw0qM5Hja/TXQow3ptzWO2EbG/cqcIkHloRrdlBtQlshyYGTNFvfkfJ5tpPLVkY4DtsPfQ==",
      "cpu": [
        "loong64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-mips64el": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-mips64el/-/linux-mips64el-0.28.2.tgz",
      "integrity": "sha512-ZVykbDyk7519VwiNb9Lcj9m8XM6v5V9uKPvrEMkkEedVewf+0itkhahp4HDpgERXhwLRpWFypsGbG/J8s0QjJA==",
      "cpu": [
        "mips64el"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-ppc64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-ppc64/-/linux-ppc64-0.28.2.tgz",
      "integrity": "sha512-CAXl+Dtd9UUuJd8pKKdwh6MLm3MUMiqMPmhZ3tTSXPqfyQ3vDl6R5hZdZ/kYojK4ofXtdfSv1tFq8XzWx3heNQ==",
      "cpu": [
        "ppc64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-riscv64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-riscv64/-/linux-riscv64-0.28.2.tgz",
      "integrity": "sha512-GeXCej4IQtU1B+QlDV8W/RRvbzI3O/Stss+/bCXv4lZls5WGRtu2a+3JkA3i4qIUlMXpcHebWpF8AkJhATowuA==",
      "cpu": [
        "riscv64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-s390x": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-s390x/-/linux-s390x-0.28.2.tgz",
      "integrity": "sha512-3H1weTYZPxt/WOhByszQZybS9w5lKzUn1FDMsgEChbHWQwHYQQRfBxgCcZvPhjHfKyJjIievvMmEUawJrdY9Dg==",
      "cpu": [
        "s390x"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/linux-x64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/linux-x64/-/linux-x64-0.28.2.tgz",
      "integrity": "sha512-4xTZr1FUmSoQW4XIWmit3tzQrUTZM+N3P0XV8xROKYF50XfI7xeO90+1bZvNwxIufQ9hDQVRJH5YhgPVF8A/HQ==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/netbsd-arm64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/netbsd-arm64/-/netbsd-arm64-0.28.2.tgz",
      "integrity": "sha512-sSATRjPeDBg3pdgHoQfoYBob11Kk1FGa9lui5RIHZCoCkJa9QKlvl3/vKz2usCmYYjs7ymJR/2Nnsqe+Hjt5nw==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "netbsd"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/netbsd-x64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/netbsd-x64/-/netbsd-x64-0.28.2.tgz",
      "integrity": "sha512-lqnzCV+mM0gIADaKihiCg6ifgfU2L3h5E33rNQBN1Y4MaVGnzryzmvvf7UHxprpQdE8hpqLolJ9Rl+SkIRDpyw==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "netbsd"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/openbsd-arm64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/openbsd-arm64/-/openbsd-arm64-0.28.2.tgz",
      "integrity": "sha512-AL2qJILH7lNjrDmCQDvdxMfAUIv8KMNZOvrwAQ8i8//ntL9FflhOyMJ8OZSMBb8/AWXe3/5v5S20y3zCoZWKoQ==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "openbsd"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/openbsd-x64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/openbsd-x64/-/openbsd-x64-0.28.2.tgz",
      "integrity": "sha512-QtiuPytchRyC4rwUKhexJdQKvDuZ6hWloi3igqPQNUJCS1/v9EiO3UTOXR6A3FoMo4fnAKbWJdqaIwhOzh8qEw==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "openbsd"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/openharmony-arm64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/openharmony-arm64/-/openharmony-arm64-0.28.2.tgz",
      "integrity": "sha512-WkhYDmpTjLvGlScA1rwjRUmhl4k8oXR3cIbtqWmELgU/dFeHHlEllxDvdWcNJV9rbzCexB5vz8gtNewWLgCT7Q==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "openharmony"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/sunos-x64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/sunos-x64/-/sunos-x64-0.28.2.tgz",
      "integrity": "sha512-GPMSkTOtMnv2U2F8gxe4Io6qmVs+YKyp832Etqqxr0hFngmXQ3rzwytelm3GIn7T4VviRUlf3sOgBOiTdvaf7g==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "sunos"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/win32-arm64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/win32-arm64/-/win32-arm64-0.28.2.tgz",
      "integrity": "sha512-PIhhEkE9uPBleRBrQEJpUn7MBnibZzbGzYWPmY3x+YoVg/95zbjB4CxPPOQ8l5tYYM4mMaCthF8/1DIfBQQyWQ==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/win32-ia32": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/win32-ia32/-/win32-ia32-0.28.2.tgz",
      "integrity": "sha512-YmJbfTlvU7Sdn9BB+4PRES4oB6pxgS37MAONj+hBr/cpXS1aBPKXxNnDbu+QCWPj0o9dgyxeq79g6c5P8KeuYA==",
      "cpu": [
        "ia32"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@esbuild/win32-x64": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/@esbuild/win32-x64/-/win32-x64-0.28.2.tgz",
      "integrity": "sha512-5ebpxr3nWMzrL/rnUI755Jkuee0bHL/Gq0WTF9lvcpv73wAp5eu8MfBUgWK9bhWvZjj7yX8etf/8tI8Ney695g==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@fastify/ajv-compiler": {
      "version": "4.0.7",
      "resolved": "https://registry.npmjs.org/@fastify/ajv-compiler/-/ajv-compiler-4.0.7.tgz",
      "integrity": "sha512-VP0yIfwlc1ohj733keYDqyHm1VWeP9VQxYomunhr90jkC4aNNibbkrRiaNgPgqj1ORxUenILR4qzA/ppYBNAtQ==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "ajv": "^8.12.0",
        "ajv-formats": "^3.0.1",
        "fast-uri": "^4.0.0"
      }
    },
    "node_modules/@fastify/cors": {
      "version": "11.3.1",
      "resolved": "https://registry.npmjs.org/@fastify/cors/-/cors-11.3.1.tgz",
      "integrity": "sha512-gZXNzd6FLHzOIfvoK4+Az3Wko2V6Y0MIsLxpyo4AEYl7a9q1JBPwPaxLea4nkr++8FCiJiPpYYo6E02uZW0dqw==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "fastify-plugin": "^6.0.0",
        "toad-cache": "^3.7.0"
      }
    },
    "node_modules/@fastify/deepmerge": {
      "version": "3.2.4",
      "resolved": "https://registry.npmjs.org/@fastify/deepmerge/-/deepmerge-3.2.4.tgz",
      "integrity": "sha512-kc8GQq5gX9RRhw0rov3DMrN8wS8yRlxJRdDzsYwwdBV/wazuVgc/1K7CKL90tlvu3RlHan6Y0R0aE3nJtBz2eQ==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT"
    },
    "node_modules/@fastify/error": {
      "version": "4.2.1",
      "resolved": "https://registry.npmjs.org/@fastify/error/-/error-4.2.1.tgz",
      "integrity": "sha512-MYBumuIwP+5MIpXSyKm6/o1Eigcoij186lWUssX3LH5U8KWqU0ktZhzC4CErIX9EJeQeRGI+zJZQWakBlFbUcg==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT"
    },
    "node_modules/@fastify/fast-json-stringify-compiler": {
      "version": "5.1.1",
      "resolved": "https://registry.npmjs.org/@fastify/fast-json-stringify-compiler/-/fast-json-stringify-compiler-5.1.1.tgz",
      "integrity": "sha512-pyxRKk7UpUnnrztP9pF4+ZYxusEQ4LifTyzRdiXmyql1QezNHxO02D25MVU2o4kMeAMYWAjG6RKRlojgkbiDAw==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "fast-json-stringify": "^7.0.0"
      }
    },
    "node_modules/@fastify/forwarded": {
      "version": "3.1.2",
      "resolved": "https://registry.npmjs.org/@fastify/forwarded/-/forwarded-3.1.2.tgz",
      "integrity": "sha512-89WiRG+hW3VQSfCwg4Hb8b43PeyEX15K5+lEfsZ4EUth/FyOjS/lv8HsVuswUNXWiSnxMGNouE/fq/0w3VumHQ==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT"
    },
    "node_modules/@fastify/merge-json-schemas": {
      "version": "0.2.2",
      "resolved": "https://registry.npmjs.org/@fastify/merge-json-schemas/-/merge-json-schemas-0.2.2.tgz",
      "integrity": "sha512-d/gx9sRbUCVgGRGzma46wLcwiY8noTqO2Nmjg/vbTARxHRE5bdh5PIL8s97Lt1X7ScRWRW52eVYxwIoPwIdVUA==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "dequal": "^2.0.3"
      }
    },
    "node_modules/@fastify/proxy-addr": {
      "version": "5.1.2",
      "resolved": "https://registry.npmjs.org/@fastify/proxy-addr/-/proxy-addr-5.1.2.tgz",
      "integrity": "sha512-uqB4QsgVoro0XDC+DIftIMGXHdBPn+lK6Ek3xXAIxPMCJfqxnbtyEoMCm2KPUVOuIosd7Cyw9HawEqMFM/UA+g==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "@fastify/forwarded": "^3.0.0",
        "ipaddr.js": "^2.1.0"
      }
    },
    "node_modules/@img/colour": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/@img/colour/-/colour-1.1.0.tgz",
      "integrity": "sha512-Td76q7j57o/tLVdgS746cYARfSyxk8iEfRxewL9h4OMzYhbW4TAcppl0mT4eyqXddh6L/jwoM75mo7ixa/pCeQ==",
      "license": "MIT",
      "optional": true,
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/@img/sharp-darwin-arm64": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-darwin-arm64/-/sharp-darwin-arm64-0.35.5.tgz",
      "integrity": "sha512-QRUlFQ0WxvdWyqqG/WtI3iupfD5rBzmCHXSdPsY91sAtVtTo7Q4cb6zOccZ3gqEqkr0f1As1ehLqmEpDsRf+lg==",
      "cpu": [
        "arm64"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-darwin-arm64": "1.3.4"
      }
    },
    "node_modules/@img/sharp-darwin-x64": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-darwin-x64/-/sharp-darwin-x64-0.35.5.tgz",
      "integrity": "sha512-+BR255RhDlpygUpOc/Jdt1nT6DQ3XG/ERo5wbcdOf5Q320dKtPCKPLR1LJs9VGXRaMa8l1uUa0tkCNOXiAxZUw==",
      "cpu": [
        "x64"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-darwin-x64": "1.3.4"
      }
    },
    "node_modules/@img/sharp-freebsd-wasm32": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-freebsd-wasm32/-/sharp-freebsd-wasm32-0.35.5.tgz",
      "integrity": "sha512-Y/z91nEZ4uIBX5X3nfTovjU9lHNKFYbL2lpHCLVNmXQK03VIZvXBBt0KxbPGp2SdGSF+2mQU4e+hQaWOt86iAw==",
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "freebsd"
      ],
      "dependencies": {
        "@img/sharp-wasm32": "0.35.5"
      },
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-darwin-arm64": {
      "version": "1.3.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-darwin-arm64/-/sharp-libvips-darwin-arm64-1.3.4.tgz",
      "integrity": "sha512-5R89nBYiRdUlSWJxPhO+GVtaXzXSxKnRu/xqMn3KTA3L9EB9Oy/P+Nn2f2vlhPuUdy/Zusb2DarbyTpGCfEDuw==",
      "cpu": [
        "arm64"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "darwin"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-darwin-x64": {
      "version": "1.3.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-darwin-x64/-/sharp-libvips-darwin-x64-1.3.4.tgz",
      "integrity": "sha512-iR2OKH80yi0U+dUplyh3/xdpFvps6YkCwsXenIJxqxR1v9o+xtKTGbS9H7cps+2Vxjc8B1j96p75NmTGjIhtpQ==",
      "cpu": [
        "x64"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "darwin"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-linux-arm": {
      "version": "1.3.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-linux-arm/-/sharp-libvips-linux-arm-1.3.4.tgz",
      "integrity": "sha512-LmRtTsOHuvM2+wlO2Db37dx5MiZhB0FvSunciw48YjdOkZz9KAiRbm8ujeMOA1INqmei5NapFxYEK1D1ZSidmw==",
      "cpu": [
        "arm"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "linux"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-linux-arm64": {
      "version": "1.3.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-linux-arm64/-/sharp-libvips-linux-arm64-1.3.4.tgz",
      "integrity": "sha512-Y3dgX/6lE2QhQb+Gxy0WZxfg9MEm/JBjamZpS2IklP7xIQoKN4hzAm7KcMVGtaVDt3neE9OKBC7vAfonA/Lr1A==",
      "cpu": [
        "arm64"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "linux"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-linux-ppc64": {
      "version": "1.3.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-linux-ppc64/-/sharp-libvips-linux-ppc64-1.3.4.tgz",
      "integrity": "sha512-Le6boB8Tai0Nis+gIxIpKx68UDVVIqdR8Tin5Yf1z2LJJQLDJvCDRqRu+jC2qCoD+eIomonmOwB4smBRxfVpYQ==",
      "cpu": [
        "ppc64"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "linux"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-linux-riscv64": {
      "version": "1.3.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-linux-riscv64/-/sharp-libvips-linux-riscv64-1.3.4.tgz",
      "integrity": "sha512-aHkkIEHPRdQEegJN20MLmGtxYD9R2wQr3Cwpddnu5+YKMt6Uzax7S9h5gpZTo8wyrGuZSlfQ63OevL5mTyOC7Q==",
      "cpu": [
        "riscv64"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "linux"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-linux-s390x": {
      "version": "1.3.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-linux-s390x/-/sharp-libvips-linux-s390x-1.3.4.tgz",
      "integrity": "sha512-ra/mB6MikESDUO7Yg+Mi95bFBb9GsObURuhnOv3OqknjGe9sZrG8tCe9q0xSIGrtLgvgw0gKnFWcK4blSgQOuQ==",
      "cpu": [
        "s390x"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "linux"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-linux-x64": {
      "version": "1.3.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-linux-x64/-/sharp-libvips-linux-x64-1.3.4.tgz",
      "integrity": "sha512-GJ//SSXbnwSDes02umB3nDJLFcQzw8a18V8fyhqr6tV515tOEMdImjjxj1AoafMRz56F3PHgftnj1QEKSU1zkw==",
      "cpu": [
        "x64"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "linux"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-linuxmusl-arm64": {
      "version": "1.3.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-linuxmusl-arm64/-/sharp-libvips-linuxmusl-arm64-1.3.4.tgz",
      "integrity": "sha512-hvulFwtjUcagsis6BBxHwGFwWoNZjgYmULGVrZcyfNbjA8hKILbRxGg15/7w5HDyXHXUos/j6baAWqnCyQ2DWA==",
      "cpu": [
        "arm64"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "linux"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-libvips-linuxmusl-x64": {
      "version": "1.3.4",
      "resolved": "https://registry.npmjs.org/@img/sharp-libvips-linuxmusl-x64/-/sharp-libvips-linuxmusl-x64-1.3.4.tgz",
      "integrity": "sha512-6zXKeE/p39I1AmA3cJG35eyBGNqNddLnUXjhwBnsGjFPWqf5VKkDBEqaEkPDoTEtkxwi2vv8Tcr2mDyP4So7Fg==",
      "cpu": [
        "x64"
      ],
      "license": "LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "linux"
      ],
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-linux-arm": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-linux-arm/-/sharp-linux-arm-0.35.5.tgz",
      "integrity": "sha512-LEaXK2WdXVK5ykcw0buWyPMsmLLL2vpHLD6yrNSW+JGEL3BZPA4tpKN6iaMc4AxTTAoaX/sU1rOL51lcIz48ZQ==",
      "cpu": [
        "arm"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-linux-arm": "1.3.4"
      }
    },
    "node_modules/@img/sharp-linux-arm64": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-linux-arm64/-/sharp-linux-arm64-0.35.5.tgz",
      "integrity": "sha512-LYVx5JTsOM2CBzmxreh+nl64/3H6Xb09iSLknqH47z2T2DFFxDeFLP5y4dJwe6H7uGQlHPyEEtIqyo3DYsRwdQ==",
      "cpu": [
        "arm64"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-linux-arm64": "1.3.4"
      }
    },
    "node_modules/@img/sharp-linux-ppc64": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-linux-ppc64/-/sharp-linux-ppc64-0.35.5.tgz",
      "integrity": "sha512-QVxAAq8evVRI9ia2vqgwrmWucn5Dfv+JdWzj75pD8omHLPSP7f8p20O8jxzjCcuCEQEOtYOZUmX1hkiZ0kdevA==",
      "cpu": [
        "ppc64"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-linux-ppc64": "1.3.4"
      }
    },
    "node_modules/@img/sharp-linux-riscv64": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-linux-riscv64/-/sharp-linux-riscv64-0.35.5.tgz",
      "integrity": "sha512-LtdreXguaavKODPIfzJ4kffx7UNt1omwtK0rch4EBbbSTXPnxWmYSayXdLJw0fJzQ97kHt1gL/yh4tvU+nCyRQ==",
      "cpu": [
        "riscv64"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-linux-riscv64": "1.3.4"
      }
    },
    "node_modules/@img/sharp-linux-s390x": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-linux-s390x/-/sharp-linux-s390x-0.35.5.tgz",
      "integrity": "sha512-UZasTOFiYzotTsGOCu42BfUzP6Tu6Do/947iRm1RsLKvlllxwGcn4RN27LibGWceix4Y+Pmw3jsnTcCQIgWjqA==",
      "cpu": [
        "s390x"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-linux-s390x": "1.3.4"
      }
    },
    "node_modules/@img/sharp-linux-x64": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-linux-x64/-/sharp-linux-x64-0.35.5.tgz",
      "integrity": "sha512-SxFtLTeJInhAA9Q836kux2vZNeOBQEx658qvbboZScr0wIARym3IcGmW7KpVD5sbVg0Ojy+udFQdayYIZyoNog==",
      "cpu": [
        "x64"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-linux-x64": "1.3.4"
      }
    },
    "node_modules/@img/sharp-linuxmusl-arm64": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-linuxmusl-arm64/-/sharp-linuxmusl-arm64-0.35.5.tgz",
      "integrity": "sha512-9HbMclmI1zlNkFRs3z9/eBtDjfD0sGlrX1z6b1qwmiFY5ElDLh4BC0LPBdVp7z1DXFiKlIcznf+ZlsuZzLxQqg==",
      "cpu": [
        "arm64"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-linuxmusl-arm64": "1.3.4"
      }
    },
    "node_modules/@img/sharp-linuxmusl-x64": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-linuxmusl-x64/-/sharp-linuxmusl-x64-0.35.5.tgz",
      "integrity": "sha512-4KOphqB035HrVdqLZfCgMzzERrQkkzOwRhl4OAkRO1YCldbaFjySXMaK534Mo0V+LndnlJk+sbUyLeU0ULyD1A==",
      "cpu": [
        "x64"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-libvips-linuxmusl-x64": "1.3.4"
      }
    },
    "node_modules/@img/sharp-wasm32": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-wasm32/-/sharp-wasm32-0.35.5.tgz",
      "integrity": "sha512-Ptsga1su4tQx+LLF1ECS9U6nz5kmrXKo6XVbtR48Ke3ZRxxgaWBu7IDtEe1quo8hiupwm6WFqxVlXaSf7IINGQ==",
      "license": "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
      "optional": true,
      "dependencies": {
        "@emnapi/runtime": "^1.11.3"
      },
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-webcontainers-wasm32": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-webcontainers-wasm32/-/sharp-webcontainers-wasm32-0.35.5.tgz",
      "integrity": "sha512-hfhF/FmoQyTUkA0bIKFOtw536BQSeBMe6BF6QyWlrPxT754+TFLaZ7sKKTfvvM0yJgKgaYTwnFCIZ/GuDw5SUA==",
      "cpu": [
        "wasm32"
      ],
      "license": "Apache-2.0",
      "optional": true,
      "dependencies": {
        "@img/sharp-wasm32": "0.35.5"
      },
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-win32-arm64": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-win32-arm64/-/sharp-win32-arm64-0.35.5.tgz",
      "integrity": "sha512-X4t7g+7ZA5DKblCBEXGjUqqemj4vczING/5viFwAL8h4N3qYeyjwdCvRLHi4EdOUI+2Z7UFlp1VM+p/AuEtm6Q==",
      "cpu": [
        "arm64"
      ],
      "license": "Apache-2.0 AND LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-win32-ia32": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-win32-ia32/-/sharp-win32-ia32-0.35.5.tgz",
      "integrity": "sha512-5Zm82LoBc43nhwNybZlG7Y1KO//Zhsn306fQl29ZOuStHLGTo3BWL83q3cznX0poxSAMuYL1On/BHBxkBeKr6A==",
      "cpu": [
        "ia32"
      ],
      "license": "Apache-2.0 AND LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": "^20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@img/sharp-win32-x64": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/@img/sharp-win32-x64/-/sharp-win32-x64-0.35.5.tgz",
      "integrity": "sha512-x76eH0vEiHlcMQu8Y8IenntaACtddpT6W0wmXtWrnKcnKI7ME5DdgqhAD6SEWOEl1v2zDvkZDhFA9KnURwpfqg==",
      "cpu": [
        "x64"
      ],
      "license": "Apache-2.0 AND LGPL-3.0-or-later",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      }
    },
    "node_modules/@jridgewell/gen-mapping": {
      "version": "0.3.13",
      "resolved": "https://registry.npmjs.org/@jridgewell/gen-mapping/-/gen-mapping-0.3.13.tgz",
      "integrity": "sha512-2kkt/7niJ6MgEPxF0bYdQ6etZaA+fQvDcLKckhy1yIQOzaoKjBBjSj63/aLVjYE3qhRt5dvM+uUyfCg6UKCBbA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@jridgewell/sourcemap-codec": "^1.5.0",
        "@jridgewell/trace-mapping": "^0.3.24"
      }
    },
    "node_modules/@jridgewell/remapping": {
      "version": "2.3.5",
      "resolved": "https://registry.npmjs.org/@jridgewell/remapping/-/remapping-2.3.5.tgz",
      "integrity": "sha512-LI9u/+laYG4Ds1TDKSJW2YPrIlcVYOwi2fUC6xB43lueCjgxV4lffOCZCtYFiH6TNOX+tQKXx97T4IKHbhyHEQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@jridgewell/gen-mapping": "^0.3.5",
        "@jridgewell/trace-mapping": "^0.3.24"
      }
    },
    "node_modules/@jridgewell/resolve-uri": {
      "version": "3.1.2",
      "resolved": "https://registry.npmjs.org/@jridgewell/resolve-uri/-/resolve-uri-3.1.2.tgz",
      "integrity": "sha512-bRISgCIjP20/tbWSPWMEi54QVPRZExkuD9lJL+UIxUKtwVJA8wW1Trb1jMs1RFXo1CBTNZ/5hpC9QvmKWdopKw==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6.0.0"
      }
    },
    "node_modules/@jridgewell/sourcemap-codec": {
      "version": "1.6.0",
      "resolved": "https://registry.npmjs.org/@jridgewell/sourcemap-codec/-/sourcemap-codec-1.6.0.tgz",
      "integrity": "sha512-T7jf+5zgsZHwNJ4lvQ7/aezbyk0nNX+zJVWpmHA7VYsEx7a7qr5Rg5IbtJFqkgze5Y2sruq1RUY8Q837Od7iFw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/@jridgewell/trace-mapping": {
      "version": "0.3.31",
      "resolved": "https://registry.npmjs.org/@jridgewell/trace-mapping/-/trace-mapping-0.3.31.tgz",
      "integrity": "sha512-zzNR+SdQSDJzc8joaeP8QQoCQr8NuYx2dIIytl1QeBEZHJ9uW6hebsrYgbz8hJwUQao3TWCMtmfV8Nu1twOLAw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@jridgewell/resolve-uri": "^3.1.0",
        "@jridgewell/sourcemap-codec": "^1.4.14"
      }
    },
    "node_modules/@next/env": {
      "version": "16.4.3",
      "resolved": "https://registry.npmjs.org/@next/env/-/env-16.4.3.tgz",
      "integrity": "sha512-a7tz1QCcWWkwC/rPJcPMJk/UNRu9CFhDd3OHYE5hddbJrs8BqRTalxI6GlKCWEGzRLHN+S/B7a4PAHCtm25aBQ==",
      "license": "MIT"
    },
    "node_modules/@next/swc-darwin-arm64": {
      "version": "16.4.3",
      "resolved": "https://registry.npmjs.org/@next/swc-darwin-arm64/-/swc-darwin-arm64-16.4.3.tgz",
      "integrity": "sha512-4yq5EXBt+VDtAZwTyfijaFp5D2C5oz3Ikw5a2kiX2K9nw72vrZX2q5UuAlkPtUMO1tQz6JTKpaKWjS7OOefTDQ==",
      "cpu": [
        "arm64"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">= 10"
      }
    },
    "node_modules/@next/swc-darwin-x64": {
      "version": "16.4.3",
      "resolved": "https://registry.npmjs.org/@next/swc-darwin-x64/-/swc-darwin-x64-16.4.3.tgz",
      "integrity": "sha512-1Rvkn/LUhnEF8WxnRkOrqGhbwXui1bkWFxONKIbN+r7C+9KHDSZ+iUoj4CzymVMWUyZIyx9szcb9+kbKhD500A==",
      "cpu": [
        "x64"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">= 10"
      }
    },
    "node_modules/@next/swc-linux-arm64-gnu": {
      "version": "16.4.3",
      "resolved": "https://registry.npmjs.org/@next/swc-linux-arm64-gnu/-/swc-linux-arm64-gnu-16.4.3.tgz",
      "integrity": "sha512-dCKpXErGg3abUM6t5JTJV/ottVBTStJB5lRJTbgdUdQaQ+jNHiK56Hsc0YAEg/rinSh42hYG3HWiYmEMdilnxg==",
      "cpu": [
        "arm64"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 10"
      }
    },
    "node_modules/@next/swc-linux-arm64-musl": {
      "version": "16.4.3",
      "resolved": "https://registry.npmjs.org/@next/swc-linux-arm64-musl/-/swc-linux-arm64-musl-16.4.3.tgz",
      "integrity": "sha512-WwYbhWkhYBvBtib1K4W0kL8MW2snBD2A5b3SN4vPpqalZbZs5+bQ1yzAdepVoOqrFfEW3dmREy4Zs1MrWcrFbw==",
      "cpu": [
        "arm64"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 10"
      }
    },
    "node_modules/@next/swc-linux-x64-gnu": {
      "version": "16.4.3",
      "resolved": "https://registry.npmjs.org/@next/swc-linux-x64-gnu/-/swc-linux-x64-gnu-16.4.3.tgz",
      "integrity": "sha512-QymWvfUwDEC5/lpJOsxX5VAbyoR2D13+2Jsjz4be7gT4LPqEgdpkeLIR/HFfCLgKzoMhpJbp6I/JnogyNZHcaA==",
      "cpu": [
        "x64"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 10"
      }
    },
    "node_modules/@next/swc-linux-x64-musl": {
      "version": "16.4.3",
      "resolved": "https://registry.npmjs.org/@next/swc-linux-x64-musl/-/swc-linux-x64-musl-16.4.3.tgz",
      "integrity": "sha512-Vmjd9D7DpA4Vv3cUlr82QWgJD/BQZmns801vtC5VWHg6jCIA4a5vMKpQnfrM2pyCrp2eV0ENdUg4PlN3bAc2Yw==",
      "cpu": [
        "x64"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 10"
      }
    },
    "node_modules/@next/swc-win32-arm64-msvc": {
      "version": "16.4.3",
      "resolved": "https://registry.npmjs.org/@next/swc-win32-arm64-msvc/-/swc-win32-arm64-msvc-16.4.3.tgz",
      "integrity": "sha512-lG1pPdPLk7gTyGb00n5JIMLdBJgjb+UEhSdZvFbhUMg0DyC6z4B7RnpSKF9VCd4imkLObVbXOFA0kFCpw7yFow==",
      "cpu": [
        "arm64"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">= 10"
      }
    },
    "node_modules/@next/swc-win32-x64-msvc": {
      "version": "16.4.3",
      "resolved": "https://registry.npmjs.org/@next/swc-win32-x64-msvc/-/swc-win32-x64-msvc-16.4.3.tgz",
      "integrity": "sha512-NmQC9RkJdnPXRaMxtkCzobB3teVjqF33oSOnwDfi+XYGWWYpt+xlGK3mtktSKLbdjwaWbJu2OkkMiRFGUUncKg==",
      "cpu": [
        "x64"
      ],
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">= 10"
      }
    },
    "node_modules/@oxc-project/types": {
      "version": "0.155.0",
      "resolved": "https://registry.npmjs.org/@oxc-project/types/-/types-0.155.0.tgz",
      "integrity": "sha512-SeE8JPwW1xs1tHeNycjUtUBdhorRa8o4jlvjwk49R7/Z291i+4DQa7JJIgOm/TaYQZx+QrPQbVJ/9c8dMIZN8Q==",
      "dev": true,
      "license": "MIT",
      "funding": {
        "url": "https://github.com/sponsors/oxc-project"
      }
    },
    "node_modules/@pinojs/redact": {
      "version": "0.4.0",
      "resolved": "https://registry.npmjs.org/@pinojs/redact/-/redact-0.4.0.tgz",
      "integrity": "sha512-k2ENnmBugE/rzQfEcdWHcCY+/FM3VLzH9cYEsbdsoqrvzAKRhUZeRNhAZvB8OitQJ1TBed3yqWtdjzS6wJKBwg==",
      "license": "MIT"
    },
    "node_modules/@playwright/test": {
      "version": "1.64.1",
      "resolved": "https://registry.npmjs.org/@playwright/test/-/test-1.64.1.tgz",
      "integrity": "sha512-IaYGml/nSOiZWROfPtuIL7neuu9qDOZ3TNvNljUIrhDMxiGTgPjzj/g9p9RxpS2tSepPDRY+UwAaEeiKtUvIAg==",
      "devOptional": true,
      "license": "Apache-2.0",
      "peer": true,
      "dependencies": {
        "playwright": "1.64.1"
      },
      "bin": {
        "playwright": "cli.js"
      },
      "engines": {
        "node": ">=20"
      }
    },
    "node_modules/@rolldown/binding-android-arm-eabi": {
      "version": "1.2.15",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-android-arm-eabi/-/binding-android-arm-eabi-1.2.15.tgz",
      "integrity": "sha512-aLcgK9gIJ3YRvrrtfSBbRa27F5WrpiTaPulnFpsHPxpUHgFlSgnU4854MHwoRGEBhfRJDWCS2WQ7lIjskE9Olw==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "android"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-android-arm64": {
      "version": "1.2.15",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-android-arm64/-/binding-android-arm64-1.2.15.tgz",
      "integrity": "sha512-xD7DdZCrbThKuxNg7ooQmvp07ys4J/pnSEMTG3/OdOWl6daC67m/Q4fL78sRHMxTH/N4fGUbYhcPM0MF5WFHkg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "android"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-darwin-arm64": {
      "version": "1.2.15",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-darwin-arm64/-/binding-darwin-arm64-1.2.15.tgz",
      "integrity": "sha512-m2WuQ6r0B4OTYxyPpNLtXaMRbRDUbG8YQV2Q3KTdSSK8Th6KHCnC8jVCJt8bvYeSB5WivkkNbc85mKadaSdOxA==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-darwin-x64": {
      "version": "1.2.15",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-darwin-x64/-/binding-darwin-x64-1.2.15.tgz",
      "integrity": "sha512-5RtnsHM36nodM9WbMy+zip0LGS/G+y5wro5RHrpOlr4ac24+1zSi9kiV2MP1myZeZ/ifEHfulQcWjnAXzc2C2A==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-freebsd-x64": {
      "version": "1.2.15",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-freebsd-x64/-/binding-freebsd-x64-1.2.15.tgz",
      "integrity": "sha512-g3l09pyFqhu+135JKkbkwiKGQmwU5hUMUPJ4VdBADvuqR8d33L6H578rh8m7rtxbdp+VmX/+nzI7nvhSZlzpUQ==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "freebsd"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-linux-arm-gnueabihf": {
      "version": "1.2.15",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-linux-arm-gnueabihf/-/binding-linux-arm-gnueabihf-1.2.15.tgz",
      "integrity": "sha512-nIe3VugI97nGQtspPxDqA4sXMUpeiocKIP/CqpY/u/vgbT+alX+cVxu1C/oVBPKg4feNTmYovE91v4DgXvXNwQ==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-linux-arm64-gnu": {
      "version": "1.2.15",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-linux-arm64-gnu/-/binding-linux-arm64-gnu-1.2.15.tgz",
      "integrity": "sha512-iTBjXx+B5QSvgI89lJfmqh4wTh8NabR1YZIIN3hNx4zSG0EVfVqkOvLulNpG4251pbd6/IAmZ/LefVk1Y4rPhw==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-linux-arm64-musl": {
      "version": "1.2.15",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-linux-arm64-musl/-/binding-linux-arm64-musl-1.2.15.tgz",
      "integrity": "sha512-uN26XOnVR7rqQupG3V9oAG2EGGatWjcJHOeDOHUFCh4TBWmP2tHTFoVN13aYbwfm0aHqJAEmcwhAu6sooIjfqQ==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-linux-ppc64-gnu": {
      "version": "1.2.15",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-linux-ppc64-gnu/-/binding-linux-ppc64-gnu-1.2.15.tgz",
      "integrity": "sha512-9nWkcdd+H+XhaA3fQIwpHnKIrfx/PQ6rO0pivr78Og07tXlUlctBBJoEYLPfhTmCR/QxEVdn6uPjHV5SymPhdw==",
      "cpu": [
        "ppc64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-linux-s390x-gnu": {
      "version": "1.2.15",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-linux-s390x-gnu/-/binding-linux-s390x-gnu-1.2.15.tgz",
      "integrity": "sha512-Ggh0ciFjLwIusLSLz7LZYEaGdxOAUJXI+Qu5JCbhPJJHEt8vP+IjRATTJheiJsdzzTYgUiHUiw3X1Ea3ZpMBdA==",
      "cpu": [
        "s390x"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-linux-x64-gnu": {
      "version": "1.2.15",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-linux-x64-gnu/-/binding-linux-x64-gnu-1.2.15.tgz",
      "integrity": "sha512-FHg60rS6DBePAYZ9X9F67x+JObFdmgn6tupA1C/a3B+CufFmTD4mX+e8M75tCiAO3foR/6xwVBI0KQiI7sn/rw==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-linux-x64-musl": {
      "version": "1.2.15",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-linux-x64-musl/-/binding-linux-x64-musl-1.2.15.tgz",
      "integrity": "sha512-/cvV/7v5VGz/moiz0XKRj2dE8DzsKyhIu1KpOvJGPjRywg3yscON889UGvAe8zfiJLHup7VLjBduoGWi3HusWQ==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-openharmony-arm64": {
      "version": "1.2.15",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-openharmony-arm64/-/binding-openharmony-arm64-1.2.15.tgz",
      "integrity": "sha512-MyzC5Hrv/sm+Z7TSGKP/j8001RO2xQm1zOpCNVL4j0cY/VhBZviludA2YFQ7i4lH6ZAXxQm0lcMdBzM+99mE7w==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "openharmony"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-win32-arm64-msvc": {
      "version": "1.2.15",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-win32-arm64-msvc/-/binding-win32-arm64-msvc-1.2.15.tgz",
      "integrity": "sha512-+PgYiS+AH5omy6L45ZLxybasauJaj3M8buoT83D+nzPmCayXlxUV9hydhciCKVyIg0B/v0BtXPDE1uGqNwCPpg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/binding-win32-x64-msvc": {
      "version": "1.2.15",
      "resolved": "https://registry.npmjs.org/@rolldown/binding-win32-x64-msvc/-/binding-win32-x64-msvc-1.2.15.tgz",
      "integrity": "sha512-HFZd2QNQYn1JbIi+Hpd7H+r/lkWxcfIu28nirZ6eCn2LafuvmExMlb/P96Sfx5tf7pPArw39IdhmCF8vmV+NhQ==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      }
    },
    "node_modules/@rolldown/pluginutils": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/@rolldown/pluginutils/-/pluginutils-1.0.1.tgz",
      "integrity": "sha512-2j9bGt5Jh8hj+vPtgzPtl72j0yRxHAyumoo6TNfAjsLB04UtpSvPbPcDcBMxz7n+9CYB0c1GxQFxYRg2jimqGw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/@socket.io/component-emitter": {
      "version": "3.1.2",
      "resolved": "https://registry.npmjs.org/@socket.io/component-emitter/-/component-emitter-3.1.2.tgz",
      "integrity": "sha512-9BCxFwvbGg/RsZK9tjXd8s4UcwR0MWeFQ1XEKIQVVvAGJyINdrqKMcTRyLoK8Rse1GjzLV9cwjWV1olXRWEXVA==",
      "license": "MIT"
    },
    "node_modules/@standard-schema/spec": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/@standard-schema/spec/-/spec-1.1.0.tgz",
      "integrity": "sha512-l2aFy5jALhniG5HgqrD6jXLi/rUWrKvqN/qJx6yoJsgKhblVd+iqqU4RCXavm/jPityDo5TCvKMnpjKnOriy0w==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/@swc/helpers": {
      "version": "0.5.23",
      "resolved": "https://registry.npmjs.org/@swc/helpers/-/helpers-0.5.23.tgz",
      "integrity": "sha512-5lSsMOTXURePglDfvuAQUqkGek9Hg2kksOYay2m0+XR++b2NWYL/4sWyuvVBIs8oKnJaxkdi9whaL/sqN13afw==",
      "license": "Apache-2.0",
      "dependencies": {
        "tslib": "^2.8.0"
      }
    },
    "node_modules/@tailwindcss/node": {
      "version": "4.3.3",
      "resolved": "https://registry.npmjs.org/@tailwindcss/node/-/node-4.3.3.tgz",
      "integrity": "sha512-/T8IKEsf9VTU6tLjgC7+sv2mOPtQxzE2jMw7u4Tt40Tx+QSZxpzh95/H6cMKoja9XuW7iMdLJYBB0o9G1CaAgg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@jridgewell/remapping": "^2.3.5",
        "enhanced-resolve": "^5.24.1",
        "jiti": "^2.7.0",
        "lightningcss": "1.32.0",
        "magic-string": "^0.30.21",
        "source-map-js": "^1.2.1",
        "tailwindcss": "4.3.3"
      }
    },
    "node_modules/@tailwindcss/node/node_modules/lightningcss": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss/-/lightningcss-1.32.0.tgz",
      "integrity": "sha512-NXYBzinNrblfraPGyrbPoD19C1h9lfI/1mzgWYvXUTe414Gz/X1FD2XBZSZM7rRTrMA8JL3OtAaGifrIKhQ5yQ==",
      "dev": true,
      "license": "MPL-2.0",
      "dependencies": {
        "detect-libc": "^2.0.3"
      },
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      },
      "optionalDependencies": {
        "lightningcss-android-arm64": "1.32.0",
        "lightningcss-darwin-arm64": "1.32.0",
        "lightningcss-darwin-x64": "1.32.0",
        "lightningcss-freebsd-x64": "1.32.0",
        "lightningcss-linux-arm-gnueabihf": "1.32.0",
        "lightningcss-linux-arm64-gnu": "1.32.0",
        "lightningcss-linux-arm64-musl": "1.32.0",
        "lightningcss-linux-x64-gnu": "1.32.0",
        "lightningcss-linux-x64-musl": "1.32.0",
        "lightningcss-win32-arm64-msvc": "1.32.0",
        "lightningcss-win32-x64-msvc": "1.32.0"
      }
    },
    "node_modules/@tailwindcss/node/node_modules/lightningcss-android-arm64": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-android-arm64/-/lightningcss-android-arm64-1.32.0.tgz",
      "integrity": "sha512-YK7/ClTt4kAK0vo6w3X+Pnm0D2cf2vPHbhOXdoNti1Ga0al1P4TBZhwjATvjNwLEBCnKvjJc2jQgHXH0NEwlAg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "android"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/node/node_modules/lightningcss-darwin-arm64": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-darwin-arm64/-/lightningcss-darwin-arm64-1.32.0.tgz",
      "integrity": "sha512-RzeG9Ju5bag2Bv1/lwlVJvBE3q6TtXskdZLLCyfg5pt+HLz9BqlICO7LZM7VHNTTn/5PRhHFBSjk5lc4cmscPQ==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/node/node_modules/lightningcss-darwin-x64": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-darwin-x64/-/lightningcss-darwin-x64-1.32.0.tgz",
      "integrity": "sha512-U+QsBp2m/s2wqpUYT/6wnlagdZbtZdndSmut/NJqlCcMLTWp5muCrID+K5UJ6jqD2BFshejCYXniPDbNh73V8w==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/node/node_modules/lightningcss-freebsd-x64": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-freebsd-x64/-/lightningcss-freebsd-x64-1.32.0.tgz",
      "integrity": "sha512-JCTigedEksZk3tHTTthnMdVfGf61Fky8Ji2E4YjUTEQX14xiy/lTzXnu1vwiZe3bYe0q+SpsSH/CTeDXK6WHig==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "freebsd"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/node/node_modules/lightningcss-linux-arm-gnueabihf": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-arm-gnueabihf/-/lightningcss-linux-arm-gnueabihf-1.32.0.tgz",
      "integrity": "sha512-x6rnnpRa2GL0zQOkt6rts3YDPzduLpWvwAF6EMhXFVZXD4tPrBkEFqzGowzCsIWsPjqSK+tyNEODUBXeeVHSkw==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/node/node_modules/lightningcss-linux-arm64-gnu": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-arm64-gnu/-/lightningcss-linux-arm64-gnu-1.32.0.tgz",
      "integrity": "sha512-0nnMyoyOLRJXfbMOilaSRcLH3Jw5z9HDNGfT/gwCPgaDjnx0i8w7vBzFLFR1f6CMLKF8gVbebmkUN3fa/kQJpQ==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/node/node_modules/lightningcss-linux-arm64-musl": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-arm64-musl/-/lightningcss-linux-arm64-musl-1.32.0.tgz",
      "integrity": "sha512-UpQkoenr4UJEzgVIYpI80lDFvRmPVg6oqboNHfoH4CQIfNA+HOrZ7Mo7KZP02dC6LjghPQJeBsvXhJod/wnIBg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/node/node_modules/lightningcss-linux-x64-gnu": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-x64-gnu/-/lightningcss-linux-x64-gnu-1.32.0.tgz",
      "integrity": "sha512-V7Qr52IhZmdKPVr+Vtw8o+WLsQJYCTd8loIfpDaMRWGUZfBOYEJeyJIkqGIDMZPwPx24pUMfwSxxI8phr/MbOA==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/node/node_modules/lightningcss-linux-x64-musl": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-x64-musl/-/lightningcss-linux-x64-musl-1.32.0.tgz",
      "integrity": "sha512-bYcLp+Vb0awsiXg/80uCRezCYHNg1/l3mt0gzHnWV9XP1W5sKa5/TCdGWaR/zBM2PeF/HbsQv/j2URNOiVuxWg==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/node/node_modules/lightningcss-win32-arm64-msvc": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-win32-arm64-msvc/-/lightningcss-win32-arm64-msvc-1.32.0.tgz",
      "integrity": "sha512-8SbC8BR40pS6baCM8sbtYDSwEVQd4JlFTOlaD3gWGHfThTcABnNDBda6eTZeqbofalIJhFx0qKzgHJmcPTnGdw==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/node/node_modules/lightningcss-win32-x64-msvc": {
      "version": "1.32.0",
      "resolved": "https://registry.npmjs.org/lightningcss-win32-x64-msvc/-/lightningcss-win32-x64-msvc-1.32.0.tgz",
      "integrity": "sha512-Amq9B/SoZYdDi1kFrojnoqPLxYhQ4Wo5XiL8EVJrVsB8ARoC1PWW6VGtT0WKCemjy8aC+louJnjS7U18x3b06Q==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/@tailwindcss/oxide": {
      "version": "4.3.3",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide/-/oxide-4.3.3.tgz",
      "integrity": "sha512-krXjAikiaFSPaK/FkAQT5UTx3VormQaiZ5hBFlJZ9UFQGB/rwg1MZIhHAG9smMQRTdyJxP6Qt5MwMtdyU5FWrA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">= 20"
      },
      "optionalDependencies": {
        "@tailwindcss/oxide-android-arm64": "4.3.3",
        "@tailwindcss/oxide-darwin-arm64": "4.3.3",
        "@tailwindcss/oxide-darwin-x64": "4.3.3",
        "@tailwindcss/oxide-freebsd-x64": "4.3.3",
        "@tailwindcss/oxide-linux-arm-gnueabihf": "4.3.3",
        "@tailwindcss/oxide-linux-arm64-gnu": "4.3.3",
        "@tailwindcss/oxide-linux-arm64-musl": "4.3.3",
        "@tailwindcss/oxide-linux-x64-gnu": "4.3.3",
        "@tailwindcss/oxide-linux-x64-musl": "4.3.3",
        "@tailwindcss/oxide-wasm32-wasi": "4.3.3",
        "@tailwindcss/oxide-win32-arm64-msvc": "4.3.3",
        "@tailwindcss/oxide-win32-x64-msvc": "4.3.3"
      }
    },
    "node_modules/@tailwindcss/oxide-android-arm64": {
      "version": "4.3.3",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-android-arm64/-/oxide-android-arm64-4.3.3.tgz",
      "integrity": "sha512-Y85A2gmPSkl5Ve5qR86GL4HT509cFqQh1aes9p3sSkyTPwt0Pppf3GkwGe4JPACcRYjgJIEhQgM6dBClnr0NYw==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "android"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/oxide-darwin-arm64": {
      "version": "4.3.3",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-darwin-arm64/-/oxide-darwin-arm64-4.3.3.tgz",
      "integrity": "sha512-BiaWatpBcERQFDlOjRDpIVXuFK5PJez5SA4JMg6VYZdBYU+qKfV/vqjcIs+IYmtitf1xYQZTwXvU/8y4lfZUGw==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/oxide-darwin-x64": {
      "version": "4.3.3",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-darwin-x64/-/oxide-darwin-x64-4.3.3.tgz",
      "integrity": "sha512-fAeUqfV5ndhxRwai8cXGzdLvul9utWOmeTkv69unv4ZXixjn61Z+p9lCWdwOwA3TYboG3BwdVuN/RDjhBRl0mw==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/oxide-freebsd-x64": {
      "version": "4.3.3",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-freebsd-x64/-/oxide-freebsd-x64-4.3.3.tgz",
      "integrity": "sha512-iyf5bV6+wnAlflVeEy7R25dupxTNECZN5QMI0qNT6eT+EgaGdZcKhGkr5SdoaWiLJ3spLqIY9VCeSGrwmtg4kw==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "freebsd"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/oxide-linux-arm-gnueabihf": {
      "version": "4.3.3",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-linux-arm-gnueabihf/-/oxide-linux-arm-gnueabihf-4.3.3.tgz",
      "integrity": "sha512-aAYUprJAJQWWbRrPvtjdroZ56Md+JM8pMiopS6xGEwDfLhqj+2ver2p4nU4Mb3CRqcMmNBjo8KkUgcxhkzVQGQ==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/oxide-linux-arm64-gnu": {
      "version": "4.3.3",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-linux-arm64-gnu/-/oxide-linux-arm64-gnu-4.3.3.tgz",
      "integrity": "sha512-nDxldcEENOxZRzC2uu9jrutZdAAQtb+8WWDCSnWL1zvBk1+FN+x6MtDViPB5AJMfttVCUhehGWus3XBPgatM/w==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/oxide-linux-arm64-musl": {
      "version": "4.3.3",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-linux-arm64-musl/-/oxide-linux-arm64-musl-4.3.3.tgz",
      "integrity": "sha512-Md44bD6veX/PC5iyF8cDVnw4HBIANZepRZZ7a8DQOvkfo5WUBwcp6iAuCUz23u+4SUkhJlD3eL7hNdW8ezd/kA==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/oxide-linux-x64-gnu": {
      "version": "4.3.3",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-linux-x64-gnu/-/oxide-linux-x64-gnu-4.3.3.tgz",
      "integrity": "sha512-tx7us1muwOKAKWao2v/GaafFeQboE6aj88vC6ziN2NCGcRm8gWUhwjzg+YdVB1e4boAtdtma4L43onunI6NS4w==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/oxide-linux-x64-musl": {
      "version": "4.3.3",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-linux-x64-musl/-/oxide-linux-x64-musl-4.3.3.tgz",
      "integrity": "sha512-SJxX60smvHgasZoBy11dX6YRjXJFovwWBoedhbQPOBzgFWBHGB+TVPWB9BxzR7TTxU8FQZAI2AyiNCMzFm8Img==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/oxide-wasm32-wasi": {
      "version": "4.3.3",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-wasm32-wasi/-/oxide-wasm32-wasi-4.3.3.tgz",
      "integrity": "sha512-jx1+rPhY/5Ympkktd656HBWEBLxP7dH06losBLjjf5vgCODXvi9KhtftWcMIwTFIDqBr7cRnQkdLnAG+IOlGvQ==",
      "bundleDependencies": [
        "@napi-rs/wasm-runtime",
        "@emnapi/core",
        "@emnapi/runtime",
        "@tybys/wasm-util",
        "@emnapi/wasi-threads",
        "tslib"
      ],
      "cpu": [
        "wasm32"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "dependencies": {
        "@emnapi/core": "^1.11.1",
        "@emnapi/runtime": "^1.11.1",
        "@emnapi/wasi-threads": "^1.2.2",
        "@napi-rs/wasm-runtime": "^1.1.4",
        "@tybys/wasm-util": "^0.10.2",
        "tslib": "^2.8.1"
      },
      "engines": {
        "node": ">=14.0.0"
      }
    },
    "node_modules/@tailwindcss/oxide-win32-arm64-msvc": {
      "version": "4.3.3",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-win32-arm64-msvc/-/oxide-win32-arm64-msvc-4.3.3.tgz",
      "integrity": "sha512-3rc292Ca2ceK6Ulcc/bAVnTs/3nDtoPhyEKlgPv+yQJQi/JS/AMJlqzxvlDacL1nekbrcf6bTqp/jV4qgnPxNQ==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/oxide-win32-x64-msvc": {
      "version": "4.3.3",
      "resolved": "https://registry.npmjs.org/@tailwindcss/oxide-win32-x64-msvc/-/oxide-win32-x64-msvc-4.3.3.tgz",
      "integrity": "sha512-yJ0pwIVc/nYeGoV02WtsN8KYyLQv7kyI2wDnkezyJlGGjkd4QLwDGAwl47YpPJeuI0M0ObaXGSPjvWDPeTPggw==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">= 20"
      }
    },
    "node_modules/@tailwindcss/postcss": {
      "version": "4.3.3",
      "resolved": "https://registry.npmjs.org/@tailwindcss/postcss/-/postcss-4.3.3.tgz",
      "integrity": "sha512-JTSZZGQi1AyKirbLN3azmjVzef92tcX7h+iSqPdaeStyFpGpDlKvvpxeOE8njhbUanbRwr3z8DyzhICWnMtQeg==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@alloc/quick-lru": "^5.2.0",
        "@tailwindcss/node": "4.3.3",
        "@tailwindcss/oxide": "4.3.3",
        "postcss": "^8.5.16",
        "tailwindcss": "4.3.3"
      }
    },
    "node_modules/@types/chai": {
      "version": "5.2.3",
      "resolved": "https://registry.npmjs.org/@types/chai/-/chai-5.2.3.tgz",
      "integrity": "sha512-Mw558oeA9fFbv65/y4mHtXDs9bPnFMZAL/jxdPFUpOHHIXX91mcgEHbS5Lahr+pwZFR8A7GQleRWeI6cGFC2UA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@types/deep-eql": "*",
        "assertion-error": "^2.0.1"
      }
    },
    "node_modules/@types/cors": {
      "version": "2.8.19",
      "resolved": "https://registry.npmjs.org/@types/cors/-/cors-2.8.19.tgz",
      "integrity": "sha512-mFNylyeyqN93lfe/9CSxOGREz8cpzAhH+E93xJ4xWQf62V8sQ/24reV2nyzUWM6H6Xji+GGHpkbLe7pVoUEskg==",
      "license": "MIT",
      "dependencies": {
        "@types/node": "*"
      }
    },
    "node_modules/@types/deep-eql": {
      "version": "4.0.2",
      "resolved": "https://registry.npmjs.org/@types/deep-eql/-/deep-eql-4.0.2.tgz",
      "integrity": "sha512-c9h9dVVMigMPc4bwTvC5dxqtqJZwQPePsWjPlpSOnojbor6pGqdk541lfA7AqFQr5pB1BRdq0juY9db81BwyFw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/@types/estree": {
      "version": "1.0.9",
      "resolved": "https://registry.npmjs.org/@types/estree/-/estree-1.0.9.tgz",
      "integrity": "sha512-GhdPgy1el4/ImP05X05Uw4cw2/M93BCUmnEvWZNStlCzEKME4Fkk+YpoA5OiHNQmoS7Cafb8Xa3Pya8m1Qrzeg==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/@types/node": {
      "version": "24.19.2",
      "resolved": "https://registry.npmjs.org/@types/node/-/node-24.19.2.tgz",
      "integrity": "sha512-93d49wCWJkCyN87MxLpNN6KXPCwFw7bVUg79mGUV1OS40JGWwVCr8n61DXCSqz7CV6/VfPkb7xec7uP2M+QHWQ==",
      "license": "MIT",
      "dependencies": {
        "undici-types": ">=7.24.0 <7.24.7"
      }
    },
    "node_modules/@types/react": {
      "version": "19.3.0",
      "resolved": "https://registry.npmjs.org/@types/react/-/react-19.3.0.tgz",
      "integrity": "sha512-N0rFCuH9YoxG9/m61l9MfpJKfmLOVU0em7ipIz6TRgSSkvReLB9vL85GB+yr8Bs5leqpvg96JSwF4ZS1s4viQg==",
      "dev": true,
      "license": "MIT",
      "peer": true,
      "dependencies": {
        "csstype": "^3.2.2"
      }
    },
    "node_modules/@types/react-dom": {
      "version": "19.3.0",
      "resolved": "https://registry.npmjs.org/@types/react-dom/-/react-dom-19.3.0.tgz",
      "integrity": "sha512-ZI7bU42mZXXKHn/qNLEw2IrbiINU7X5+vfgdixBHkCNpYWXjKgfQ/P+uyGb5CjOLB9UcnTeg3rylQtV2hym44Q==",
      "dev": true,
      "license": "MIT",
      "peerDependencies": {
        "@types/react": "^19.3.0"
      }
    },
    "node_modules/@types/ws": {
      "version": "8.18.2",
      "resolved": "https://registry.npmjs.org/@types/ws/-/ws-8.18.2.tgz",
      "integrity": "sha512-67MQl+fpWKVTT1NYdnmo3U4sc/xPo/zQBncVnI74qmQa0z/b+1g6iYqNmGCPbxO+zz2aklb08a0oHfegiVd0/w==",
      "license": "MIT",
      "dependencies": {
        "@types/node": "*"
      }
    },
    "node_modules/@uno/game-engine": {
      "resolved": "packages/game-engine",
      "link": true
    },
    "node_modules/@uno/protocol": {
      "resolved": "packages/protocol",
      "link": true
    },
    "node_modules/@uno/realtime": {
      "resolved": "apps/realtime",
      "link": true
    },
    "node_modules/@uno/web": {
      "resolved": "apps/web",
      "link": true
    },
    "node_modules/@vitest/expect": {
      "version": "4.1.12",
      "resolved": "https://registry.npmjs.org/@vitest/expect/-/expect-4.1.12.tgz",
      "integrity": "sha512-vFlTt+YEu9WBpNjdGayNmlMVzrWPi1+sv853/7t2FU7hpO5gAFBKHzQmkCq5Xjpr+evegF2994LQT3hF3mRlqQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@standard-schema/spec": "^1.1.0",
        "@types/chai": "^5.2.2",
        "@vitest/spy": "4.1.12",
        "@vitest/utils": "4.1.12",
        "chai": "^6.2.2",
        "tinyrainbow": "^3.1.0"
      },
      "funding": {
        "url": "https://opencollective.com/vitest"
      }
    },
    "node_modules/@vitest/expect/node_modules/@vitest/spy": {
      "version": "4.1.12",
      "resolved": "https://registry.npmjs.org/@vitest/spy/-/spy-4.1.12.tgz",
      "integrity": "sha512-RGq9x4JNGNTZHEJxvN0oSiJjeSCExm0n2gZKKJZHY9cX5AVA6M7VJILBT3ZJ/tJ/0J9uWT7fETV9/btoi//vSg==",
      "dev": true,
      "license": "MIT",
      "funding": {
        "url": "https://opencollective.com/vitest"
      }
    },
    "node_modules/@vitest/pretty-format": {
      "version": "4.1.12",
      "resolved": "https://registry.npmjs.org/@vitest/pretty-format/-/pretty-format-4.1.12.tgz",
      "integrity": "sha512-XW9O8+Mxx4VpCtkYdMJLZQQwsVryP9wk7cPKDxtXFfwSak6yRh5+2fep/Y0XF/ElBvJHq8bcYdi6aeuai0opZA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "tinyrainbow": "^3.1.0"
      },
      "funding": {
        "url": "https://opencollective.com/vitest"
      }
    },
    "node_modules/@vitest/runner": {
      "version": "4.1.12",
      "resolved": "https://registry.npmjs.org/@vitest/runner/-/runner-4.1.12.tgz",
      "integrity": "sha512-NKlVKCr5QnCe8jijdMnmkpHHU+WTqiLFR6G0pHji9uRjXK9xJl1k1nTw6F3pOOj2PDcsDt2GKQMI7wIsaT491w==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@vitest/utils": "4.1.12",
        "pathe": "^2.0.3"
      },
      "funding": {
        "url": "https://opencollective.com/vitest"
      }
    },
    "node_modules/@vitest/snapshot": {
      "version": "4.1.12",
      "resolved": "https://registry.npmjs.org/@vitest/snapshot/-/snapshot-4.1.12.tgz",
      "integrity": "sha512-ko1y1Qgb/slzQ9mr+b89Cuqud8WG1TKtsPD8r7ZUBdvVOGt85Af2HwCqHujrhwJq95hs/9RM7fcAPg57o1vlzw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@vitest/pretty-format": "4.1.12",
        "@vitest/utils": "4.1.12",
        "magic-string": "^0.30.21",
        "pathe": "^2.0.3"
      },
      "funding": {
        "url": "https://opencollective.com/vitest"
      }
    },
    "node_modules/@vitest/utils": {
      "version": "4.1.12",
      "resolved": "https://registry.npmjs.org/@vitest/utils/-/utils-4.1.12.tgz",
      "integrity": "sha512-Q3awXrwOfEV+qc3WmO5ONyE0yO7Q1gQ9/oyHxGLZ/pl7N3NO/ZztqQwKLuwMkV+CA1JYSIeO3gkHnRDIo4AVaA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@vitest/pretty-format": "4.1.12",
        "convert-source-map": "^2.0.0",
        "tinyrainbow": "^3.1.0"
      },
      "funding": {
        "url": "https://opencollective.com/vitest"
      }
    },
    "node_modules/abstract-logging": {
      "version": "2.0.1",
      "resolved": "https://registry.npmjs.org/abstract-logging/-/abstract-logging-2.0.1.tgz",
      "integrity": "sha512-2BjRTZxTPvheOvGbBslFSYOUkr+SjPtOnrLP33f+VIWLzezQpZcqVg7ja3L4dBXmzzgwT+a029jRx5PCi3JuiA==",
      "license": "MIT"
    },
    "node_modules/accepts": {
      "version": "1.3.8",
      "resolved": "https://registry.npmjs.org/accepts/-/accepts-1.3.8.tgz",
      "integrity": "sha512-PYAthTa2m2VKxuvSD3DPC/Gy+U+sOA1LAuT8mkmRuvw+NACSaeXEQ+NHcVF7rONl6qcaxV3Uuemwawk+7+SJLw==",
      "license": "MIT",
      "dependencies": {
        "mime-types": "~2.1.34",
        "negotiator": "0.6.3"
      },
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/ajv": {
      "version": "8.20.0",
      "resolved": "https://registry.npmjs.org/ajv/-/ajv-8.20.0.tgz",
      "integrity": "sha512-Thbli+OlOj+iMPYFBVBfJ3OmCAnaSyNn4M1vz9T6Gka5Jt9ba/HIR56joy65tY6kx/FCF5VXNB819Y7/GUrBGA==",
      "license": "MIT",
      "dependencies": {
        "fast-deep-equal": "^3.1.3",
        "fast-uri": "^3.0.1",
        "json-schema-traverse": "^1.0.0",
        "require-from-string": "^2.0.2"
      },
      "funding": {
        "type": "github",
        "url": "https://github.com/sponsors/epoberezkin"
      }
    },
    "node_modules/ajv-formats": {
      "version": "3.0.1",
      "resolved": "https://registry.npmjs.org/ajv-formats/-/ajv-formats-3.0.1.tgz",
      "integrity": "sha512-8iUql50EUR+uUcdRQ3HDqa6EVyo3docL8g5WJ3FNcWmu62IbkGUue/pEyLBW8VGKKucTPgqeks4fIU1DA4yowQ==",
      "license": "MIT",
      "dependencies": {
        "ajv": "^8.0.0"
      },
      "peerDependencies": {
        "ajv": "^8.0.0"
      },
      "peerDependenciesMeta": {
        "ajv": {
          "optional": true
        }
      }
    },
    "node_modules/ajv/node_modules/fast-uri": {
      "version": "3.1.9",
      "resolved": "https://registry.npmjs.org/fast-uri/-/fast-uri-3.1.9.tgz",
      "integrity": "sha512-hS/0Wt3Ya043oKXs0sIxrMpKQITXhMLIrVAKKXi4gozGC9v7YRWVnXIZzjNPTO02M9BdxLCWqK1yRXgNziVyJQ==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "BSD-3-Clause"
    },
    "node_modules/assertion-error": {
      "version": "2.0.1",
      "resolved": "https://registry.npmjs.org/assertion-error/-/assertion-error-2.0.1.tgz",
      "integrity": "sha512-Izi8RQcffqCeNVgFigKli1ssklIbpHnCYc6AknXGYoB6grJqyeby7jv12JUQgmTAnIDnbck1uxksT4dzN3PWBA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=12"
      }
    },
    "node_modules/atomic-sleep": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/atomic-sleep/-/atomic-sleep-1.0.0.tgz",
      "integrity": "sha512-kNOjDqAh7px0XWNI+4QbzoiR/nTkHAWNud2uvnJquD1/x5a7EQZMJT0AczqK0Qn67oY/TTQ1LbUKajZpp3I9tQ==",
      "license": "MIT",
      "engines": {
        "node": ">=8.0.0"
      }
    },
    "node_modules/avvio": {
      "version": "9.3.1",
      "resolved": "https://registry.npmjs.org/avvio/-/avvio-9.3.1.tgz",
      "integrity": "sha512-QyTKW61/qlba+cUQBm/sT9X8lri4UdomqSDwCnrnj1IvLVDRRiXRkz4CgBRWB+/cmfC7SK5WQc8T1vSdGvaUcQ==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "@fastify/error": "^4.0.0",
        "fastq": "^1.17.1"
      }
    },
    "node_modules/baseline-browser-mapping": {
      "version": "2.11.32",
      "resolved": "https://registry.npmjs.org/baseline-browser-mapping/-/baseline-browser-mapping-2.11.32.tgz",
      "integrity": "sha512-UvuxFU9P3hM29LrQdwu0cD6w6/+SFr+UlB9s/knI7+O2rK9xFxKUwSDWxGdbbqQ9/V7BJ5s0NI5nQAE4uJp3gQ==",
      "license": "Apache-2.0",
      "bin": {
        "baseline-browser-mapping": "dist/cli.cjs"
      },
      "engines": {
        "node": ">=6.0.0"
      }
    },
    "node_modules/caniuse-lite": {
      "version": "1.0.30001819",
      "resolved": "https://registry.npmjs.org/caniuse-lite/-/caniuse-lite-1.0.30001819.tgz",
      "integrity": "sha512-LFUqIIAwpzsIuevnKnsR9qnStBcgzPShTX61lBwN9uFkkf8o8zLiebEjbW8AYtZiF+1YKDWfdt/pWDtMuG8Xwg==",
      "funding": [
        {
          "type": "opencollective",
          "url": "https://opencollective.com/browserslist"
        },
        {
          "type": "tidelift",
          "url": "https://tidelift.com/funding/github/npm/caniuse-lite"
        },
        {
          "type": "github",
          "url": "https://github.com/sponsors/ai"
        }
      ],
      "license": "CC-BY-4.0"
    },
    "node_modules/chai": {
      "version": "6.3.0",
      "resolved": "https://registry.npmjs.org/chai/-/chai-6.3.0.tgz",
      "integrity": "sha512-XWAtwJ6OHO+tj0EKCs0Y2UamnyOxseZWltU4x2U2wh8g4AigdjwvtUjvLP2tqkA/avxHEtzxNaqGq/YGNwckKg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/client-only": {
      "version": "0.0.1",
      "resolved": "https://registry.npmjs.org/client-only/-/client-only-0.0.1.tgz",
      "integrity": "sha512-IV3Ou0jSMzZrd3pZ48nLkT9DA7Ag1pnPzaiQhpW7c3RbcqqzvzzVu+L8gfqMp/8IM2MQtSiqaCxrrcfu8I8rMA==",
      "license": "MIT"
    },
    "node_modules/convert-source-map": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/convert-source-map/-/convert-source-map-2.0.0.tgz",
      "integrity": "sha512-Kvp459HrV2FEJ1CAsi1Ku+MY3kasH19TFykTz2xWmMeq6bk2NU3XXvfJ+Q61m0xktWwt+1HSYf3JZsTms3aRJg==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/cookie": {
      "version": "2.0.1",
      "resolved": "https://registry.npmjs.org/cookie/-/cookie-2.0.1.tgz",
      "integrity": "sha512-yuToqVvRrj6pfDXREyQAAv8SkAEk/8GS3jQRTiUMm66TVtBYmqQeoEjL2Lmq8Rpo6271vH76InTChTitEAm65w==",
      "license": "MIT",
      "engines": {
        "node": ">=22"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/cors": {
      "version": "2.8.6",
      "resolved": "https://registry.npmjs.org/cors/-/cors-2.8.6.tgz",
      "integrity": "sha512-tJtZBBHA6vjIAaF6EnIaq6laBBP9aq/Y3ouVJjEfoHbRBcHBAHYcMh/w8LDrk2PvIMMq8gmopa5D4V8RmbrxGw==",
      "license": "MIT",
      "dependencies": {
        "object-assign": "^4",
        "vary": "^1"
      },
      "engines": {
        "node": ">= 0.10"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/express"
      }
    },
    "node_modules/csstype": {
      "version": "3.2.3",
      "resolved": "https://registry.npmjs.org/csstype/-/csstype-3.2.3.tgz",
      "integrity": "sha512-z1HGKcYy2xA8AGQfwrn0PAy+PB7X/GSj3UVJW9qKyn43xWa+gl5nXmU4qqLMRzWVLFC8KusUX8T/0kCiOYpAIQ==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/debug": {
      "version": "4.4.3",
      "resolved": "https://registry.npmjs.org/debug/-/debug-4.4.3.tgz",
      "integrity": "sha512-RGwwWnwQvkVfavKVt22FGLw+xYSdzARwm0ru6DhTVA3umU5hZc28V3kO4stgYryrTlLpuvgI9GiijltAjNbcqA==",
      "license": "MIT",
      "dependencies": {
        "ms": "^2.1.3"
      },
      "engines": {
        "node": ">=6.0"
      },
      "peerDependenciesMeta": {
        "supports-color": {
          "optional": true
        }
      }
    },
    "node_modules/dequal": {
      "version": "2.0.3",
      "resolved": "https://registry.npmjs.org/dequal/-/dequal-2.0.3.tgz",
      "integrity": "sha512-0je+qPKHEMohvfRTCEo3CrPG6cAzAYgmzKyxRiYSSDkS6eGJdyVJm7WaYA5ECaAD9wLB2T4EEeymA5aFVcYXCA==",
      "license": "MIT",
      "engines": {
        "node": ">=6"
      }
    },
    "node_modules/detect-libc": {
      "version": "2.1.2",
      "resolved": "https://registry.npmjs.org/detect-libc/-/detect-libc-2.1.2.tgz",
      "integrity": "sha512-Btj2BOOO83o3WyH59e8MgXsxEQVcarkUOpEYrubB0urwnN10yQ364rsiByU11nZlqWYZm05i/of7io4mzihBtQ==",
      "devOptional": true,
      "license": "Apache-2.0",
      "engines": {
        "node": ">=8"
      }
    },
    "node_modules/engine.io": {
      "version": "6.6.11",
      "resolved": "https://registry.npmjs.org/engine.io/-/engine.io-6.6.11.tgz",
      "integrity": "sha512-z34mGpLoY/82ZbkX1LqGMIaf3wjVMPL6gVC681QDqnmzJ26synI8qAE32P+a7UazmpJZ8UGrFIeAavgRfXzYrg==",
      "license": "MIT",
      "dependencies": {
        "@types/cors": "^2.8.12",
        "@types/node": ">=10.0.0",
        "@types/ws": "^8.5.12",
        "accepts": "~1.3.4",
        "cookie": "~0.7.2",
        "cors": "~2.8.5",
        "debug": "~4.4.1",
        "engine.io-parser": "~5.2.1",
        "ws": "~8.21.0"
      },
      "engines": {
        "node": ">=10.2.0"
      }
    },
    "node_modules/engine.io-client": {
      "version": "6.6.7",
      "resolved": "https://registry.npmjs.org/engine.io-client/-/engine.io-client-6.6.7.tgz",
      "integrity": "sha512-GyAvmPA7gnRCpDQbYACAy79Lg4ewevrmaPzySZz0OVvgyZc3gEfLLqPTYk8wVBScjOEpM9ZO4KryyFpVItjGEA==",
      "license": "MIT",
      "dependencies": {
        "@socket.io/component-emitter": "~3.1.0",
        "debug": "~4.4.1",
        "engine.io-parser": "~5.2.1",
        "ws": "~8.21.0",
        "xmlhttprequest-ssl": "~2.1.1"
      }
    },
    "node_modules/engine.io-parser": {
      "version": "5.2.3",
      "resolved": "https://registry.npmjs.org/engine.io-parser/-/engine.io-parser-5.2.3.tgz",
      "integrity": "sha512-HqD3yTBfnBxIrbnM1DoD6Pcq8NECnh8d4As1Qgh0z5Gg3jRRIqijury0CL3ghu/edArpUYiYqQiDUQBIs4np3Q==",
      "license": "MIT",
      "engines": {
        "node": ">=10.0.0"
      }
    },
    "node_modules/engine.io/node_modules/cookie": {
      "version": "0.7.2",
      "resolved": "https://registry.npmjs.org/cookie/-/cookie-0.7.2.tgz",
      "integrity": "sha512-yki5XnKuf750l50uGTllt6kKILY4nQ1eNIQatoXEByZ5dWgnKqbnqmTrBE5B4N7lrMJKQ2ytWMiTO2o0v6Ew/w==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/enhanced-resolve": {
      "version": "5.26.0",
      "resolved": "https://registry.npmjs.org/enhanced-resolve/-/enhanced-resolve-5.26.0.tgz",
      "integrity": "sha512-9vhedylFonb2YGogzUKX6+Ja72gOJbN1QHAqdrvqLwhdl/QWbKopzoUC9EbQNVsAns/bx/4uyqalrQAoy1IByw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "graceful-fs": "^4.2.4",
        "tapable": "^2.3.3"
      },
      "engines": {
        "node": ">=10.13.0"
      }
    },
    "node_modules/es-module-lexer": {
      "version": "2.3.2",
      "resolved": "https://registry.npmjs.org/es-module-lexer/-/es-module-lexer-2.3.2.tgz",
      "integrity": "sha512-poHGpORABojJJucnV9KbOavETW8lBVnphkW77ER5/BQ5Fz7oXSoCNek7IH3vR5nRjdsEz926ibFYX8KtLQmdyw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/esbuild": {
      "version": "0.28.2",
      "resolved": "https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz",
      "integrity": "sha512-HKVLS8dvII+xoKW9kmqxbRKrnWEXfJJr/FZhhJmiqIB0e053QNYFqOBouTMO/k5sID4MvCiUCvv8b9M4h32wIA==",
      "dev": true,
      "hasInstallScript": true,
      "license": "MIT",
      "peer": true,
      "bin": {
        "esbuild": "bin/esbuild"
      },
      "engines": {
        "node": ">=18"
      },
      "optionalDependencies": {
        "@esbuild/aix-ppc64": "0.28.2",
        "@esbuild/android-arm": "0.28.2",
        "@esbuild/android-arm64": "0.28.2",
        "@esbuild/android-x64": "0.28.2",
        "@esbuild/darwin-arm64": "0.28.2",
        "@esbuild/darwin-x64": "0.28.2",
        "@esbuild/freebsd-arm64": "0.28.2",
        "@esbuild/freebsd-x64": "0.28.2",
        "@esbuild/linux-arm": "0.28.2",
        "@esbuild/linux-arm64": "0.28.2",
        "@esbuild/linux-ia32": "0.28.2",
        "@esbuild/linux-loong64": "0.28.2",
        "@esbuild/linux-mips64el": "0.28.2",
        "@esbuild/linux-ppc64": "0.28.2",
        "@esbuild/linux-riscv64": "0.28.2",
        "@esbuild/linux-s390x": "0.28.2",
        "@esbuild/linux-x64": "0.28.2",
        "@esbuild/netbsd-arm64": "0.28.2",
        "@esbuild/netbsd-x64": "0.28.2",
        "@esbuild/openbsd-arm64": "0.28.2",
        "@esbuild/openbsd-x64": "0.28.2",
        "@esbuild/openharmony-arm64": "0.28.2",
        "@esbuild/sunos-x64": "0.28.2",
        "@esbuild/win32-arm64": "0.28.2",
        "@esbuild/win32-ia32": "0.28.2",
        "@esbuild/win32-x64": "0.28.2"
      }
    },
    "node_modules/estree-walker": {
      "version": "3.0.3",
      "resolved": "https://registry.npmjs.org/estree-walker/-/estree-walker-3.0.3.tgz",
      "integrity": "sha512-7RUKfXgSMMkzt6ZuXmqapOurLGPPfgj6l9uRZ7lRGolvk0y2yocc35LdcxKC5PQZdn2DMqioAQ2NoWcrTKmm6g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@types/estree": "^1.0.0"
      }
    },
    "node_modules/expect-type": {
      "version": "1.4.0",
      "resolved": "https://registry.npmjs.org/expect-type/-/expect-type-1.4.0.tgz",
      "integrity": "sha512-KfYbmpRm0VbLjEvVa9yGwCi9GI34xvi7A/HXYWQO65CSD2u3MczUJSuwXKFIxlGsgBQizV9q5J9NHj4VG0n+pA==",
      "dev": true,
      "license": "Apache-2.0",
      "engines": {
        "node": ">=12.0.0"
      }
    },
    "node_modules/fast-decode-uri-component": {
      "version": "1.0.1",
      "resolved": "https://registry.npmjs.org/fast-decode-uri-component/-/fast-decode-uri-component-1.0.1.tgz",
      "integrity": "sha512-WKgKWg5eUxvRZGwW8FvfbaH7AXSh2cL+3j5fMGzUMCxWBJ3dV3a7Wz8y2f/uQ0e3B6WmodD3oS54jTQ9HVTIIg==",
      "license": "MIT"
    },
    "node_modules/fast-deep-equal": {
      "version": "3.1.3",
      "resolved": "https://registry.npmjs.org/fast-deep-equal/-/fast-deep-equal-3.1.3.tgz",
      "integrity": "sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q==",
      "license": "MIT"
    },
    "node_modules/fast-json-stringify": {
      "version": "7.2.0",
      "resolved": "https://registry.npmjs.org/fast-json-stringify/-/fast-json-stringify-7.2.0.tgz",
      "integrity": "sha512-q18imgm9fEdQVfvJbRJALE9VP/A5HGme0+NUnWcmFYM9rbQbLkZZk20FyIp1LQ8gDOauQKwqMc52YozqFaQyOw==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "@fastify/merge-json-schemas": "^0.2.0",
        "ajv": "^8.12.0",
        "ajv-formats": "^3.0.1",
        "fast-uri": "^4.0.0",
        "json-schema-ref-resolver": "^3.0.0",
        "rfdc": "^1.2.0"
      }
    },
    "node_modules/fast-querystring": {
      "version": "1.1.2",
      "resolved": "https://registry.npmjs.org/fast-querystring/-/fast-querystring-1.1.2.tgz",
      "integrity": "sha512-g6KuKWmFXc0fID8WWH0jit4g0AGBoJhCkJMb1RmbsSEUNvQ+ZC8D6CUZ+GtF8nMzSPXnhiePyyqqipzNNEnHjg==",
      "license": "MIT",
      "dependencies": {
        "fast-decode-uri-component": "^1.0.1"
      }
    },
    "node_modules/fast-uri": {
      "version": "4.2.3",
      "resolved": "https://registry.npmjs.org/fast-uri/-/fast-uri-4.2.3.tgz",
      "integrity": "sha512-I1PXwP5eAhlNlcdpjt9CgB59op2ZvZfxw+BkqGFVIUOgNpCVTcTqp3HhTX7brxj5vsip+nSY4nTvff+eIA76hg==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "BSD-3-Clause"
    },
    "node_modules/fastify": {
      "version": "5.12.7",
      "resolved": "https://registry.npmjs.org/fastify/-/fastify-5.12.7.tgz",
      "integrity": "sha512-v4pEPsTRPuqlDIYiQFB+BHjVN4SdHX9u0ABk0ZDUKbbdY1vsNryUd1j4Z+jQEZajvYIVk047Kimva9/AJ79GYw==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "@fastify/ajv-compiler": "^4.0.5",
        "@fastify/error": "^4.0.0",
        "@fastify/fast-json-stringify-compiler": "^5.0.0",
        "@fastify/proxy-addr": "^5.0.0",
        "abstract-logging": "^2.0.1",
        "avvio": "^9.0.0",
        "fast-json-stringify": "^7.0.0",
        "find-my-way": "^9.6.0",
        "light-my-request": "^6.0.0",
        "pino": "^9.14.0 || ^10.1.0",
        "process-warning": "^5.1.0",
        "rfdc": "^1.3.1",
        "secure-json-parse": "^4.0.0",
        "semver": "^7.6.0",
        "toad-cache": "^3.7.0"
      }
    },
    "node_modules/fastify-plugin": {
      "version": "6.0.1",
      "resolved": "https://registry.npmjs.org/fastify-plugin/-/fastify-plugin-6.0.1.tgz",
      "integrity": "sha512-4wW4RxSmvPXLrh5mgQEiu43qU3bw44N2ss4FTkTkQIbprUhE+/s43QX0j/ttcztdWK7PEkHqVthdc5GdEGDvjA==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT"
    },
    "node_modules/fastq": {
      "version": "1.20.3",
      "resolved": "https://registry.npmjs.org/fastq/-/fastq-1.20.3.tgz",
      "integrity": "sha512-XKv5nnLs6nLF71NgiKJLIZFLkPyIEuOselLG7ujZnGrRfQK8HpvY+WqKhAJUAdLomwVHErVS4LfxFlPq0/FTAw==",
      "license": "ISC",
      "dependencies": {
        "reusify": "^1.0.4"
      }
    },
    "node_modules/fdir": {
      "version": "6.5.0",
      "resolved": "https://registry.npmjs.org/fdir/-/fdir-6.5.0.tgz",
      "integrity": "sha512-tIbYtZbucOs0BRGqPJkshJUYdL+SDH7dVM8gjy+ERp3WAUjLEFJE+02kanyHtwjWOnwrKYBiwAmM0p4kLJAnXg==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=12.0.0"
      },
      "peerDependencies": {
        "picomatch": "^3 || ^4"
      },
      "peerDependenciesMeta": {
        "picomatch": {
          "optional": true
        }
      }
    },
    "node_modules/find-my-way": {
      "version": "9.10.0",
      "resolved": "https://registry.npmjs.org/find-my-way/-/find-my-way-9.10.0.tgz",
      "integrity": "sha512-eru+uCPQ2g+nLBkf84MHP/KyNNMar0BDy0j+i8Fb72GF9/YHBZ58q7FODUtfVV7XU9nfRUHXSmaM8NmZcIbZ4Q==",
      "license": "MIT",
      "dependencies": {
        "fast-deep-equal": "^3.1.3",
        "fast-querystring": "^1.0.0",
        "safe-regex2": "^5.0.0"
      },
      "engines": {
        "node": ">=20"
      }
    },
    "node_modules/fsevents": {
      "version": "2.3.3",
      "resolved": "https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz",
      "integrity": "sha512-5xoDfX+fL7faATnagmWPpbFtwh/R77WmMMqqHGS65C3vvB0YHrgF+B1YmZ3441tMj5n63k0212XNoJwzlhffQw==",
      "dev": true,
      "hasInstallScript": true,
      "license": "MIT",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": "^8.16.0 || ^10.6.0 || >=11.0.0"
      }
    },
    "node_modules/graceful-fs": {
      "version": "4.2.11",
      "resolved": "https://registry.npmjs.org/graceful-fs/-/graceful-fs-4.2.11.tgz",
      "integrity": "sha512-RbJ5/jmFcNNCcDV5o9eTnBLJ/HszWV0P73bc+Ff4nS/rJj+YaS6IGyiOL0VoBYX+l1Wrl3k63h/KrH+nhJ0XvQ==",
      "dev": true,
      "license": "ISC"
    },
    "node_modules/ipaddr.js": {
      "version": "2.5.0",
      "resolved": "https://registry.npmjs.org/ipaddr.js/-/ipaddr.js-2.5.0.tgz",
      "integrity": "sha512-aq+t5NAc+cS6rZQQVWC2x98CPqGtKKTMDd4Gaodv0wShnItdKg/51djkGJ1hqH+Oy0ivDftCbSLCQob8zso01w==",
      "license": "MIT",
      "engines": {
        "node": ">= 10"
      }
    },
    "node_modules/jiti": {
      "version": "2.7.0",
      "resolved": "https://registry.npmjs.org/jiti/-/jiti-2.7.0.tgz",
      "integrity": "sha512-AC/7JofJvZGrrneWNaEnJeOLUx+JlGt7tNa0wZiRPT4MY1wmfKjt2+6O2p2uz2+skll8OZZmJMNqeke7kKbNgQ==",
      "dev": true,
      "license": "MIT",
      "bin": {
        "jiti": "lib/jiti-cli.mjs"
      }
    },
    "node_modules/json-schema-ref-resolver": {
      "version": "3.0.1",
      "resolved": "https://registry.npmjs.org/json-schema-ref-resolver/-/json-schema-ref-resolver-3.0.1.tgz",
      "integrity": "sha512-w+HwgljXpVwZ3IidoUR1qPZxSOQ+NRQWuVe6a5pe8XbHsNZE4UAwVPUvzZagn7yBKbJtt6UJnRFYbNTRPZI45Q==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "dequal": "^2.0.3"
      }
    },
    "node_modules/json-schema-traverse": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/json-schema-traverse/-/json-schema-traverse-1.0.0.tgz",
      "integrity": "sha512-NM8/P9n3XjXhIZn1lLhkFaACTOURQXjWhV4BA/RnOv8xvgqtqpAX9IO4mRQxSx1Rlo4tqzeqb0sOlruaOy3dug==",
      "license": "MIT"
    },
    "node_modules/light-my-request": {
      "version": "6.8.0",
      "resolved": "https://registry.npmjs.org/light-my-request/-/light-my-request-6.8.0.tgz",
      "integrity": "sha512-5Q8PjoSEdtGIB8fikZsTem5vgRo4F2mR6vUKTDW/H1g6MtAt8e3duQbg/QxL5yzg6BZhor2KOUm3hhWMWLTZwg==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "BSD-3-Clause",
      "dependencies": {
        "@fastify/deepmerge": "^3.1.0",
        "cookie": "^2.0.0",
        "process-warning": "^5.0.0",
        "set-cookie-parser": "^3.0.1"
      }
    },
    "node_modules/lightningcss": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss/-/lightningcss-1.33.0.tgz",
      "integrity": "sha512-WkUDrojuJs0xkgGf2udWxa3yGBRxPtxUkB79i6aCZLRgc7PM8fZe9TosfPDcvEpQZbuFASnHYmRLBLUbmLOIIA==",
      "dev": true,
      "license": "MPL-2.0",
      "dependencies": {
        "detect-libc": "^2.0.3"
      },
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      },
      "optionalDependencies": {
        "lightningcss-android-arm64": "1.33.0",
        "lightningcss-darwin-arm64": "1.33.0",
        "lightningcss-darwin-x64": "1.33.0",
        "lightningcss-freebsd-x64": "1.33.0",
        "lightningcss-linux-arm-gnueabihf": "1.33.0",
        "lightningcss-linux-arm64-gnu": "1.33.0",
        "lightningcss-linux-arm64-musl": "1.33.0",
        "lightningcss-linux-x64-gnu": "1.33.0",
        "lightningcss-linux-x64-musl": "1.33.0",
        "lightningcss-win32-arm64-msvc": "1.33.0",
        "lightningcss-win32-x64-msvc": "1.33.0"
      }
    },
    "node_modules/lightningcss-android-arm64": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-android-arm64/-/lightningcss-android-arm64-1.33.0.tgz",
      "integrity": "sha512-gEpRTalKdosp4Bb8qWtc2iOgE5SeIHlpS1up9bFq2wAyYhl1UdTObYiHe98zEM9SQvSoqQZ1IQD0JNpg3Ml5pg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "android"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-darwin-arm64": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-darwin-arm64/-/lightningcss-darwin-arm64-1.33.0.tgz",
      "integrity": "sha512-Sciaz8eenNTKn9b3t7+xr0ipTp9YxKQY4npwQ3mrRuL0BAVHBLyZxofhaKBAVtzmtRZ/zTyo0/to4B1uWG/Djg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-darwin-x64": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-darwin-x64/-/lightningcss-darwin-x64-1.33.0.tgz",
      "integrity": "sha512-Z5UPAxzrjlWNNyGy6i65cJzzvgJ5D3T6wMvs+gWpY9d7qRhANrxqAp6LhxIgZhWEw18RfJTGcRxjuLIBr+m8XQ==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "darwin"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-freebsd-x64": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-freebsd-x64/-/lightningcss-freebsd-x64-1.33.0.tgz",
      "integrity": "sha512-QQM/Ti/hQajJwCY+RiWuCZ9sdtI/XQk7nDK5vC8kkdwixezOlDgvDx7+RT+QjK6FcFT4MpsuoBnHIo/O3StRRg==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "freebsd"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-linux-arm-gnueabihf": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-arm-gnueabihf/-/lightningcss-linux-arm-gnueabihf-1.33.0.tgz",
      "integrity": "sha512-N7FVBe6iS24MlM6R/4RBTxGhQheZGs7tiQ9U32UtF75NzP5Q7xWPRqLBCKxlRQRk3rY1jCIPLzx7WzOhuUIRLQ==",
      "cpu": [
        "arm"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-linux-arm64-gnu": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-arm64-gnu/-/lightningcss-linux-arm64-gnu-1.33.0.tgz",
      "integrity": "sha512-j2v/itmy4HlNxlc6voKXYgBqNi0Ng2LShg4z7GufpEgs05P+2suBVyi9I6YHq5uoVFx9ETin3eCEhLVyXGQnKg==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-linux-arm64-musl": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-arm64-musl/-/lightningcss-linux-arm64-musl-1.33.0.tgz",
      "integrity": "sha512-yiO5ROMuYQgXbC60yjZU5CYSFZGKXL0HFATXt9mHJn1+zW55oCtMI9NfcVhYLMFDL7gV7oBPon/EmMMGg2OvtQ==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-linux-x64-gnu": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-x64-gnu/-/lightningcss-linux-x64-gnu-1.33.0.tgz",
      "integrity": "sha512-ar+Ju7LmcN0Jo4FpL4hpFybwNG9/3A/Br5KW2n2jyODg3MEZXaDYADdemoNS+BDNfMgKvylJLj4S5tyRActuAg==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-linux-x64-musl": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-linux-x64-musl/-/lightningcss-linux-x64-musl-1.33.0.tgz",
      "integrity": "sha512-RYiYbkokw0trfKqqzfF55lginwEPrD3OJDfTuJzFs1MK6iFnDenaz1fqLLtX4ITG3OktJQXOeTaw1awrBAlZPw==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "linux"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-win32-arm64-msvc": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-win32-arm64-msvc/-/lightningcss-win32-arm64-msvc-1.33.0.tgz",
      "integrity": "sha512-1K+MPfLSFVpphzpdbfkhlWk6wBrTObBzS2T6db10PNOZgR9GoVsAWzwNyuhUYYbTp23j+4RrncfujZ4uAzXvwA==",
      "cpu": [
        "arm64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/lightningcss-win32-x64-msvc": {
      "version": "1.33.0",
      "resolved": "https://registry.npmjs.org/lightningcss-win32-x64-msvc/-/lightningcss-win32-x64-msvc-1.33.0.tgz",
      "integrity": "sha512-OlEICDx/Xl0FqSp4bry8zFnCvGpig3Gl4gCquvYwHuqJKEC1+n9NgDniFvqHGmMv1ZkqDJrDqKKSykTDX+ehuA==",
      "cpu": [
        "x64"
      ],
      "dev": true,
      "license": "MPL-2.0",
      "optional": true,
      "os": [
        "win32"
      ],
      "engines": {
        "node": ">= 12.0.0"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/parcel"
      }
    },
    "node_modules/magic-string": {
      "version": "0.30.21",
      "resolved": "https://registry.npmjs.org/magic-string/-/magic-string-0.30.21.tgz",
      "integrity": "sha512-vd2F4YUyEXKGcLHoq+TEyCjxueSeHnFxyyjNp80yg0XV4vUhnDer/lvvlqM/arB5bXQN5K2/3oinyCRyx8T2CQ==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@jridgewell/sourcemap-codec": "^1.5.5"
      }
    },
    "node_modules/mime-db": {
      "version": "1.52.0",
      "resolved": "https://registry.npmjs.org/mime-db/-/mime-db-1.52.0.tgz",
      "integrity": "sha512-sPU4uV7dYlvtWJxwwxHD0PuihVNiE7TyAbQ5SWxDCB9mUYvOgroQOwYQQOKPJ8CIbE+1ETVlOoK1UC2nU3gYvg==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/mime-types": {
      "version": "2.1.35",
      "resolved": "https://registry.npmjs.org/mime-types/-/mime-types-2.1.35.tgz",
      "integrity": "sha512-ZDY+bPm5zTTF+YpCrAU9nK0UgICYPT0QtT1NZWFv4s++TNkcgVaT0g6+4R2uI4MjQjzysHB1zxuWL50hzaeXiw==",
      "license": "MIT",
      "dependencies": {
        "mime-db": "1.52.0"
      },
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/ms": {
      "version": "2.1.3",
      "resolved": "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz",
      "integrity": "sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==",
      "license": "MIT"
    },
    "node_modules/nanoid": {
      "version": "3.3.20",
      "resolved": "https://registry.npmjs.org/nanoid/-/nanoid-3.3.20.tgz",
      "integrity": "sha512-uKdg2G3GNCKQn9byYOpxbGqrT2fGO5KRt5J/8b3pok8rT6qxGWF6hxMyJiEYtAf+FVyYuD9hRaDqX5uPFYJ4ZQ==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/ai"
        }
      ],
      "license": "MIT",
      "bin": {
        "nanoid": "bin/nanoid.cjs"
      },
      "engines": {
        "node": "^10 || ^12 || ^13.7 || ^14 || >=15.0.1"
      }
    },
    "node_modules/negotiator": {
      "version": "0.6.3",
      "resolved": "https://registry.npmjs.org/negotiator/-/negotiator-0.6.3.tgz",
      "integrity": "sha512-+EUsqGPLsM+j/zdChZjsnX51g4XrHFOIXwfnCVPGlQk/k5giakcKsuxCObBRu6DSm9opw/O6slWbJdghQM4bBg==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.6"
      }
    },
    "node_modules/next": {
      "version": "16.4.3",
      "resolved": "https://registry.npmjs.org/next/-/next-16.4.3.tgz",
      "integrity": "sha512-OqxKTGi9u80FydydsMNYNjnuje9Au+kvHlt2GZ//ftdpDHm1dxKqAaENoOOTX5wKzn+9vaKUNIfZeyZUuLhCnA==",
      "license": "MIT",
      "dependencies": {
        "@next/env": "16.4.3",
        "@swc/helpers": "0.5.23",
        "baseline-browser-mapping": "^2.9.19",
        "caniuse-lite": "^1.0.30001579",
        "postcss": "8.5.23",
        "styled-jsx": "5.1.6"
      },
      "bin": {
        "next": "dist/bin/next"
      },
      "engines": {
        "node": ">=20.9.0"
      },
      "optionalDependencies": {
        "@next/swc-darwin-arm64": "16.4.3",
        "@next/swc-darwin-x64": "16.4.3",
        "@next/swc-linux-arm64-gnu": "16.4.3",
        "@next/swc-linux-arm64-musl": "16.4.3",
        "@next/swc-linux-x64-gnu": "16.4.3",
        "@next/swc-linux-x64-musl": "16.4.3",
        "@next/swc-win32-arm64-msvc": "16.4.3",
        "@next/swc-win32-x64-msvc": "16.4.3",
        "sharp": "^0.35.5"
      },
      "peerDependencies": {
        "@opentelemetry/api": "^1.1.0",
        "@playwright/test": "^1.51.1",
        "babel-plugin-react-compiler": "*",
        "react": "^18.2.0 || 19.0.0-rc-de68d2f4-20241204 || ^19.0.0",
        "react-dom": "^18.2.0 || 19.0.0-rc-de68d2f4-20241204 || ^19.0.0",
        "sass": "^1.3.0"
      },
      "peerDependenciesMeta": {
        "@opentelemetry/api": {
          "optional": true
        },
        "@playwright/test": {
          "optional": true
        },
        "babel-plugin-react-compiler": {
          "optional": true
        },
        "sass": {
          "optional": true
        }
      }
    },
    "node_modules/object-assign": {
      "version": "4.1.1",
      "resolved": "https://registry.npmjs.org/object-assign/-/object-assign-4.1.1.tgz",
      "integrity": "sha512-rJgTQnkUnH1sFw8yT6VSU3zD3sWmu6sZhIseY8VX+GRu3P6F7Fu+JNDoXfklElbLJSnc3FUQHVe4cU5hj+BcUg==",
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/on-exit-leak-free": {
      "version": "2.1.2",
      "resolved": "https://registry.npmjs.org/on-exit-leak-free/-/on-exit-leak-free-2.1.2.tgz",
      "integrity": "sha512-0eJJY6hXLGf1udHwfNftBqH+g73EU4B504nZeKpz1sYRKafAghwxEJunB2O7rDZkL4PGfsMVnTXZ2EjibbqcsA==",
      "license": "MIT",
      "engines": {
        "node": ">=14.0.0"
      }
    },
    "node_modules/pathe": {
      "version": "2.0.3",
      "resolved": "https://registry.npmjs.org/pathe/-/pathe-2.0.3.tgz",
      "integrity": "sha512-WUjGcAqP1gQacoQe+OBJsFA7Ld4DyXuUIjZ5cc75cLHvJ7dtNsTugphxIADwspS+AraAUePCKrSVtPLFj/F88w==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/picocolors": {
      "version": "1.1.1",
      "resolved": "https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz",
      "integrity": "sha512-xceH2snhtb5M9liqDsmEw56le376mTZkEX/jEb/RxNFyegNul7eNslCXP9FDj/Lcu0X8KEyMceP2ntpaHrDEVA==",
      "license": "ISC"
    },
    "node_modules/picomatch": {
      "version": "4.0.7",
      "resolved": "https://registry.npmjs.org/picomatch/-/picomatch-4.0.7.tgz",
      "integrity": "sha512-qcJu88Q2IWqJsDD529JKMdwGm/dvInW4HvQnRwiH9JtihJvzGOscDtHE3x1pBKeUOTysQ8kVmLnJ2kJu7yhcGA==",
      "dev": true,
      "license": "MIT",
      "peer": true,
      "engines": {
        "node": ">=12"
      },
      "funding": {
        "url": "https://github.com/sponsors/jonschlinkert"
      }
    },
    "node_modules/pino": {
      "version": "10.4.0",
      "resolved": "https://registry.npmjs.org/pino/-/pino-10.4.0.tgz",
      "integrity": "sha512-bk1ZMTwG/Vymx+zPoa28MhNzucFvXJWp3csrSuxuHPSMeUettaCoQ5Jvg07mtC4JGNpcfTwz41oVCnNgBK9+vA==",
      "license": "MIT",
      "dependencies": {
        "@pinojs/redact": "^0.4.0",
        "atomic-sleep": "^1.0.0",
        "on-exit-leak-free": "^2.1.0",
        "pino-abstract-transport": "^3.0.0",
        "pino-std-serializers": "^7.0.0",
        "process-warning": "^5.0.0",
        "quick-format-unescaped": "^4.0.3",
        "real-require": "^1.0.0",
        "safe-stable-stringify": "^2.3.1",
        "sonic-boom": "^4.0.1",
        "thread-stream": "^4.0.0"
      },
      "bin": {
        "pino": "bin.js"
      }
    },
    "node_modules/pino-abstract-transport": {
      "version": "3.0.0",
      "resolved": "https://registry.npmjs.org/pino-abstract-transport/-/pino-abstract-transport-3.0.0.tgz",
      "integrity": "sha512-wlfUczU+n7Hy/Ha5j9a/gZNy7We5+cXp8YL+X+PG8S0KXxw7n/JXA3c46Y0zQznIJ83URJiwy7Lh56WLokNuxg==",
      "license": "MIT",
      "dependencies": {
        "split2": "^4.0.0"
      }
    },
    "node_modules/pino-std-serializers": {
      "version": "7.1.0",
      "resolved": "https://registry.npmjs.org/pino-std-serializers/-/pino-std-serializers-7.1.0.tgz",
      "integrity": "sha512-BndPH67/JxGExRgiX1dX0w1FvZck5Wa4aal9198SrRhZjH3GxKQUKIBnYJTdj2HDN3UQAS06HlfcSbQj2OHmaw==",
      "license": "MIT"
    },
    "node_modules/playwright": {
      "version": "1.64.1",
      "resolved": "https://registry.npmjs.org/playwright/-/playwright-1.64.1.tgz",
      "integrity": "sha512-HCrVhHr5QQuwYoswEUGTb7gGp522yflbv/ST8nF4sFWGuLjQCt17Q/EubpGGSNKYn1tsTCPZxqHhHCfVURu7UA==",
      "devOptional": true,
      "license": "Apache-2.0",
      "dependencies": {
        "playwright-core": "1.64.1"
      },
      "bin": {
        "playwright": "cli.js"
      },
      "engines": {
        "node": ">=20"
      }
    },
    "node_modules/playwright-core": {
      "version": "1.64.1",
      "resolved": "https://registry.npmjs.org/playwright-core/-/playwright-core-1.64.1.tgz",
      "integrity": "sha512-BC4s8y6SEVA6Q1rSxZTto8hI1KUI3xXlHGZgvGqP4IqPdI/a6FX9H29IDNz7vKo9l21b6LfYosScPL6M3xxyDQ==",
      "devOptional": true,
      "license": "Apache-2.0",
      "bin": {
        "playwright-core": "cli.js"
      },
      "engines": {
        "node": ">=20"
      }
    },
    "node_modules/postcss": {
      "version": "8.5.23",
      "resolved": "https://registry.npmjs.org/postcss/-/postcss-8.5.23.tgz",
      "integrity": "sha512-g50586zr4bZmwFiTlflMu8E0bDTb5I5gertgwAKmsdUlTQIhZtunzUlD1WSzwcVWPoAVpsrA6vlfCD7oXvRwgg==",
      "funding": [
        {
          "type": "opencollective",
          "url": "https://opencollective.com/postcss/"
        },
        {
          "type": "tidelift",
          "url": "https://tidelift.com/funding/github/npm/postcss"
        },
        {
          "type": "github",
          "url": "https://github.com/sponsors/ai"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "nanoid": "^3.3.16",
        "picocolors": "^1.1.1",
        "source-map-js": "^1.2.1"
      },
      "engines": {
        "node": "^10 || ^12 || >=14"
      }
    },
    "node_modules/process-warning": {
      "version": "5.1.1",
      "resolved": "https://registry.npmjs.org/process-warning/-/process-warning-5.1.1.tgz",
      "integrity": "sha512-oCkNVj4OKnKEcocVBcDfiIugN1/cE6rgfT3nCtzeqZPA8+rIxMaQ0xXzIkGP8Gj2qUaP1UR7uhJ1VD8lUCpzCg==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT"
    },
    "node_modules/quick-format-unescaped": {
      "version": "4.0.4",
      "resolved": "https://registry.npmjs.org/quick-format-unescaped/-/quick-format-unescaped-4.0.4.tgz",
      "integrity": "sha512-tYC1Q1hgyRuHgloV/YXs2w15unPVh8qfu/qCTfhTYamaw7fyhumKa2yGpdSo87vY32rIclj+4fWYQXUMs9EHvg==",
      "license": "MIT"
    },
    "node_modules/react": {
      "version": "19.3.1",
      "resolved": "https://registry.npmjs.org/react/-/react-19.3.1.tgz",
      "integrity": "sha512-QNhWdt7nrgVWWQG58QuGsAR3jv3Hbe4mb4vz7w2csnHavciZJgda1CPNaldF6eVxv90ud3jUXpKlHL69gO38yw==",
      "license": "MIT",
      "peer": true,
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/react-dom": {
      "version": "19.3.1",
      "resolved": "https://registry.npmjs.org/react-dom/-/react-dom-19.3.1.tgz",
      "integrity": "sha512-Y0bARz53lhEC1NMCASs0/j+faB/zqt3R8hpvg1e8+61ZVJ4UL0UdC4cBbXfZMcIuhrfgeILTLe+ZeBCavQPtKQ==",
      "license": "MIT",
      "peer": true,
      "dependencies": {
        "scheduler": "^0.28.0"
      },
      "peerDependencies": {
        "react": "^19.3.1"
      }
    },
    "node_modules/real-require": {
      "version": "1.0.0",
      "resolved": "https://registry.npmjs.org/real-require/-/real-require-1.0.0.tgz",
      "integrity": "sha512-P4nbQYQfePJxRSmY+v/KINxVucm4NF3p3s7pJveMTtom52FR4YGltUQLB8idDXwDDWW+eYrWDFbuzUnjoWHF7g==",
      "license": "MIT"
    },
    "node_modules/require-from-string": {
      "version": "2.0.2",
      "resolved": "https://registry.npmjs.org/require-from-string/-/require-from-string-2.0.2.tgz",
      "integrity": "sha512-Xf0nWe6RseziFMu+Ap9biiUbmplq6S9/p+7w7YXP/JBHhrUDDUhwa+vANyubuqfZWTveU//DYVGsDG7RKL/vEw==",
      "license": "MIT",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/ret": {
      "version": "0.5.1",
      "resolved": "https://registry.npmjs.org/ret/-/ret-0.5.1.tgz",
      "integrity": "sha512-Z/nyvABwcRnRD2mMP7Kz6G1dFZZqX1mNErOnxF42OCQKE07b9k9hK9SQxHL3LFEZUdzQaLM4dId1E/E6Vm4WhA==",
      "license": "MIT",
      "engines": {
        "node": ">=10"
      }
    },
    "node_modules/reusify": {
      "version": "1.1.0",
      "resolved": "https://registry.npmjs.org/reusify/-/reusify-1.1.0.tgz",
      "integrity": "sha512-g6QUff04oZpHs0eG5p83rFLhHeV00ug/Yf9nZM6fLeUrPguBTkTQOdpAWWspMh55TZfVQDPaN3NQJfbVRAxdIw==",
      "license": "MIT",
      "engines": {
        "iojs": ">=1.0.0",
        "node": ">=0.10.0"
      }
    },
    "node_modules/rfdc": {
      "version": "1.4.1",
      "resolved": "https://registry.npmjs.org/rfdc/-/rfdc-1.4.1.tgz",
      "integrity": "sha512-q1b3N5QkRUWUl7iyylaaj3kOpIT0N2i9MqIEQXP73GVsN9cw3fdx8X63cEmWhJGi2PPCF23Ijp7ktmd39rawIA==",
      "license": "MIT"
    },
    "node_modules/rolldown": {
      "version": "1.2.15",
      "resolved": "https://registry.npmjs.org/rolldown/-/rolldown-1.2.15.tgz",
      "integrity": "sha512-6odND+fel5zVw3I4Yc2e69gvguDnX0CAAGiNDZSq4ik5WUcaLrkD2GLuog0XcODbor31hZ5ayEMgVDno+KPV5g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@oxc-project/types": "=0.155.0",
        "@rolldown/pluginutils": "^1.0.0"
      },
      "bin": {
        "rolldown": "bin/cli.mjs"
      },
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      },
      "optionalDependencies": {
        "@rolldown/binding-android-arm-eabi": "1.2.15",
        "@rolldown/binding-android-arm64": "1.2.15",
        "@rolldown/binding-darwin-arm64": "1.2.15",
        "@rolldown/binding-darwin-x64": "1.2.15",
        "@rolldown/binding-freebsd-x64": "1.2.15",
        "@rolldown/binding-linux-arm-gnueabihf": "1.2.15",
        "@rolldown/binding-linux-arm64-gnu": "1.2.15",
        "@rolldown/binding-linux-arm64-musl": "1.2.15",
        "@rolldown/binding-linux-ppc64-gnu": "1.2.15",
        "@rolldown/binding-linux-s390x-gnu": "1.2.15",
        "@rolldown/binding-linux-x64-gnu": "1.2.15",
        "@rolldown/binding-linux-x64-musl": "1.2.15",
        "@rolldown/binding-openharmony-arm64": "1.2.15",
        "@rolldown/binding-win32-arm64-msvc": "1.2.15",
        "@rolldown/binding-win32-x64-msvc": "1.2.15"
      }
    },
    "node_modules/safe-regex2": {
      "version": "5.1.2",
      "resolved": "https://registry.npmjs.org/safe-regex2/-/safe-regex2-5.1.2.tgz",
      "integrity": "sha512-tAtCGFPPP02VroDVzp4daGi6bC7jWG+41D47GKf18FeH/ubvKQHT9VmhAkvtjNOmJwqtApzWeUpEhkyEYULvmw==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "ret": "~0.5.0"
      },
      "bin": {
        "safe-regex2": "bin/safe-regex2.js"
      }
    },
    "node_modules/safe-stable-stringify": {
      "version": "2.5.0",
      "resolved": "https://registry.npmjs.org/safe-stable-stringify/-/safe-stable-stringify-2.5.0.tgz",
      "integrity": "sha512-b3rppTKm9T+PsVCBEOUR46GWI7fdOs00VKZ1+9c1EWDaDMvjQc6tUwuFyIprgGgTcWoVHSKrU8H31ZHA2e0RHA==",
      "license": "MIT",
      "engines": {
        "node": ">=10"
      }
    },
    "node_modules/scheduler": {
      "version": "0.28.0",
      "resolved": "https://registry.npmjs.org/scheduler/-/scheduler-0.28.0.tgz",
      "integrity": "sha512-juorfCmIkIw8tT+p5BXSm6PJjQF/ycEYmKyzURCIt/RaZIhL+PulbQ9Yu2z1HdOJDdqDTlxA1+xKBmHXJsczAw==",
      "license": "MIT"
    },
    "node_modules/secure-json-parse": {
      "version": "4.1.1",
      "resolved": "https://registry.npmjs.org/secure-json-parse/-/secure-json-parse-4.1.1.tgz",
      "integrity": "sha512-lnd81MQEZKjhW/Gd2TQqdd4XP6QYNdDW/EP+I7nTrFHP9y2LmaGPIHk9xsnzcOiEr1c39c/e84xFgGviQKBTRw==",
      "funding": [
        {
          "type": "github",
          "url": "https://github.com/sponsors/fastify"
        },
        {
          "type": "opencollective",
          "url": "https://opencollective.com/fastify"
        }
      ],
      "license": "BSD-3-Clause"
    },
    "node_modules/semver": {
      "version": "7.8.5",
      "resolved": "https://registry.npmjs.org/semver/-/semver-7.8.5.tgz",
      "integrity": "sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA==",
      "license": "ISC",
      "bin": {
        "semver": "bin/semver.js"
      },
      "engines": {
        "node": ">=10"
      }
    },
    "node_modules/set-cookie-parser": {
      "version": "3.2.1",
      "resolved": "https://registry.npmjs.org/set-cookie-parser/-/set-cookie-parser-3.2.1.tgz",
      "integrity": "sha512-Npd1Pt+4zb3BrSZDPd2qFwRpS6b1EUEasRrO8xS0zMJi0fApXXK5YuzP0minyJnxwnFHoVoJwA55q0A0cu63gQ==",
      "license": "MIT"
    },
    "node_modules/sharp": {
      "version": "0.35.5",
      "resolved": "https://registry.npmjs.org/sharp/-/sharp-0.35.5.tgz",
      "integrity": "sha512-Ywn4OnzGukp7CDMrp08RQ50YKmuwG47brZgIVPTvBaaAfQlRlygrRqSrxdCiL9M+LlzLBiJ68IR1QqvzHyjC7g==",
      "license": "Apache-2.0",
      "optional": true,
      "dependencies": {
        "@img/colour": "^1.1.0",
        "detect-libc": "^2.1.2",
        "semver": "^7.8.5"
      },
      "engines": {
        "node": ">=20.9.0"
      },
      "funding": {
        "url": "https://opencollective.com/libvips"
      },
      "optionalDependencies": {
        "@img/sharp-darwin-arm64": "0.35.5",
        "@img/sharp-darwin-x64": "0.35.5",
        "@img/sharp-freebsd-wasm32": "0.35.5",
        "@img/sharp-libvips-darwin-arm64": "1.3.4",
        "@img/sharp-libvips-darwin-x64": "1.3.4",
        "@img/sharp-libvips-linux-arm": "1.3.4",
        "@img/sharp-libvips-linux-arm64": "1.3.4",
        "@img/sharp-libvips-linux-ppc64": "1.3.4",
        "@img/sharp-libvips-linux-riscv64": "1.3.4",
        "@img/sharp-libvips-linux-s390x": "1.3.4",
        "@img/sharp-libvips-linux-x64": "1.3.4",
        "@img/sharp-libvips-linuxmusl-arm64": "1.3.4",
        "@img/sharp-libvips-linuxmusl-x64": "1.3.4",
        "@img/sharp-linux-arm": "0.35.5",
        "@img/sharp-linux-arm64": "0.35.5",
        "@img/sharp-linux-ppc64": "0.35.5",
        "@img/sharp-linux-riscv64": "0.35.5",
        "@img/sharp-linux-s390x": "0.35.5",
        "@img/sharp-linux-x64": "0.35.5",
        "@img/sharp-linuxmusl-arm64": "0.35.5",
        "@img/sharp-linuxmusl-x64": "0.35.5",
        "@img/sharp-webcontainers-wasm32": "0.35.5",
        "@img/sharp-win32-arm64": "0.35.5",
        "@img/sharp-win32-ia32": "0.35.5",
        "@img/sharp-win32-x64": "0.35.5"
      },
      "peerDependenciesMeta": {
        "@types/node": {
          "optional": true
        }
      }
    },
    "node_modules/siginfo": {
      "version": "2.0.0",
      "resolved": "https://registry.npmjs.org/siginfo/-/siginfo-2.0.0.tgz",
      "integrity": "sha512-ybx0WO1/8bSBLEWXZvEd7gMW3Sn3JFlW3TvX1nREbDLRNQNaeNN8WK0meBwPdAaOI7TtRRRJn/Es1zhrrCHu7g==",
      "dev": true,
      "license": "ISC"
    },
    "node_modules/socket.io": {
      "version": "4.8.4",
      "resolved": "https://registry.npmjs.org/socket.io/-/socket.io-4.8.4.tgz",
      "integrity": "sha512-9ZV9zg8vN8hO3Y25DhR7nUkJ1VDnBhq5O/JrXhFT9s6+F0gqytSASTHVfCFc2mJXaTfARroErplXlzFWwETZqQ==",
      "license": "MIT",
      "dependencies": {
        "accepts": "~1.3.4",
        "cors": "~2.8.5",
        "debug": "~4.4.1",
        "engine.io": "~6.6.0",
        "socket.io-adapter": "~2.5.2",
        "socket.io-parser": "~4.2.4"
      },
      "engines": {
        "node": ">=10.2.0"
      }
    },
    "node_modules/socket.io-adapter": {
      "version": "2.5.8",
      "resolved": "https://registry.npmjs.org/socket.io-adapter/-/socket.io-adapter-2.5.8.tgz",
      "integrity": "sha512-6Oy52pbg+kvdCVvjcN+FnY7BvxZ7cIHNScbvztT/It5d0vbwoJoVZmF2gjJmnV0/4WlXRfG15zc45ySk9Ah8bw==",
      "license": "MIT",
      "dependencies": {
        "debug": "~4.4.1",
        "ws": "~8.21.0"
      }
    },
    "node_modules/socket.io-client": {
      "version": "4.8.4",
      "resolved": "https://registry.npmjs.org/socket.io-client/-/socket.io-client-4.8.4.tgz",
      "integrity": "sha512-7wjKAvVXYOJsbmUgkWbnhPD4bFpkqrUR0++XOjpGFmqDqsqV1CI93VTraeExLxpjxEqrWgFoSRZu1ihjLWfkAA==",
      "license": "MIT",
      "dependencies": {
        "@socket.io/component-emitter": "~3.1.0",
        "debug": "~4.4.1",
        "engine.io-client": "~6.6.1",
        "socket.io-parser": "~4.2.4"
      },
      "engines": {
        "node": ">=10.0.0"
      }
    },
    "node_modules/socket.io-parser": {
      "version": "4.2.7",
      "resolved": "https://registry.npmjs.org/socket.io-parser/-/socket.io-parser-4.2.7.tgz",
      "integrity": "sha512-IH/iSeO9T6gz1KkFleGDWkG9N3dl4jXVYUtMhIqH10Md0ttMer8nUNWiP1DKuNrybD2xBrixLJdCC9J6ECoYkg==",
      "license": "MIT",
      "dependencies": {
        "@socket.io/component-emitter": "~3.1.0",
        "debug": "~4.4.1"
      },
      "engines": {
        "node": ">=10.0.0"
      }
    },
    "node_modules/sonic-boom": {
      "version": "4.2.1",
      "resolved": "https://registry.npmjs.org/sonic-boom/-/sonic-boom-4.2.1.tgz",
      "integrity": "sha512-w6AxtubXa2wTXAUsZMMWERrsIRAdrK0Sc+FUytWvYAhBJLyuI4llrMIC1DtlNSdI99EI86KZum2MMq3EAZlF9Q==",
      "license": "MIT",
      "dependencies": {
        "atomic-sleep": "^1.0.0"
      }
    },
    "node_modules/source-map-js": {
      "version": "1.2.2",
      "resolved": "https://registry.npmjs.org/source-map-js/-/source-map-js-1.2.2.tgz",
      "integrity": "sha512-KGj/8Y43x35aZVDtt+J4mK1hoLGHULMYfSkODJNQjNDC3oW1PqPoxMwo0pLUsWM/UEGzON/NxeHywEfNXNP3Vw==",
      "license": "BSD-3-Clause",
      "engines": {
        "node": ">=0.10.0"
      }
    },
    "node_modules/split2": {
      "version": "4.2.0",
      "resolved": "https://registry.npmjs.org/split2/-/split2-4.2.0.tgz",
      "integrity": "sha512-UcjcJOWknrNkF6PLX83qcHM6KHgVKNkV62Y8a5uYDVv9ydGQVwAHMKqHdJje1VTWpljG0WYpCDhrCdAOYH4TWg==",
      "license": "ISC",
      "engines": {
        "node": ">= 10.x"
      }
    },
    "node_modules/stackback": {
      "version": "0.0.2",
      "resolved": "https://registry.npmjs.org/stackback/-/stackback-0.0.2.tgz",
      "integrity": "sha512-1XMJE5fQo1jGH6Y/7ebnwPOBEkIEnT4QF32d5R1+VXdXveM0IBMJt8zfaxX1P3QhVwrYe+576+jkANtSS2mBbw==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/std-env": {
      "version": "4.3.0",
      "resolved": "https://registry.npmjs.org/std-env/-/std-env-4.3.0.tgz",
      "integrity": "sha512-OtU/EgQ1kIm5KwqQpBC6ZEMXrZRui11w8zgfTWp8cdO9B8OaPsbA8bTHO2P+HNo1VlUTGMVBwPhydu6poeXiag==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/styled-jsx": {
      "version": "5.1.6",
      "resolved": "https://registry.npmjs.org/styled-jsx/-/styled-jsx-5.1.6.tgz",
      "integrity": "sha512-qSVyDTeMotdvQYoHWLNGwRFJHC+i+ZvdBRYosOFgC+Wg1vx4frN2/RG/NA7SYqqvKNLf39P2LSRA2pu6n0XYZA==",
      "license": "MIT",
      "dependencies": {
        "client-only": "0.0.1"
      },
      "engines": {
        "node": ">= 12.0.0"
      },
      "peerDependencies": {
        "react": ">= 16.8.0 || 17.x.x || ^18.0.0-0 || ^19.0.0-0"
      },
      "peerDependenciesMeta": {
        "@babel/core": {
          "optional": true
        },
        "babel-plugin-macros": {
          "optional": true
        }
      }
    },
    "node_modules/tailwindcss": {
      "version": "4.3.3",
      "resolved": "https://registry.npmjs.org/tailwindcss/-/tailwindcss-4.3.3.tgz",
      "integrity": "sha512-gOhV3P7ufE62QDGg1zVaTgCR+EtPv92k2nIhVcVKcLmxT1sUBsQGhnZj175j+MqRt4zLF7ic+sCYjfhxMxj7YQ==",
      "dev": true,
      "license": "MIT"
    },
    "node_modules/tapable": {
      "version": "2.3.3",
      "resolved": "https://registry.npmjs.org/tapable/-/tapable-2.3.3.tgz",
      "integrity": "sha512-uxc/zpqFg6x7C8vOE7lh6Lbda8eEL9zmVm/PLeTPBRhh1xCgdWaQ+J1CUieGpIfm2HdtsUpRv+HshiasBMcc6A==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=6"
      },
      "funding": {
        "type": "opencollective",
        "url": "https://opencollective.com/webpack"
      }
    },
    "node_modules/thread-stream": {
      "version": "4.2.0",
      "resolved": "https://registry.npmjs.org/thread-stream/-/thread-stream-4.2.0.tgz",
      "integrity": "sha512-e2zZ96wSChazBsbENf/Pcm/4swHt2cEKQ92rhUjkL9GCKiTDJIaTBenjE/m9DXi0QBmTMDkFDdOomUy20A1tDQ==",
      "license": "MIT",
      "dependencies": {
        "real-require": "^1.0.0"
      },
      "engines": {
        "node": ">=20"
      }
    },
    "node_modules/tinyexec": {
      "version": "1.3.1",
      "resolved": "https://registry.npmjs.org/tinyexec/-/tinyexec-1.3.1.tgz",
      "integrity": "sha512-GCvB3aoys96IuDFBMcTB46JOR6mdMtAToqwiW8JlWhsoh1mhHi/xn9ss/Dg7N555GiJyEt2qzoG/NHCwM6h1EA==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=18"
      }
    },
    "node_modules/tinyglobby": {
      "version": "0.2.17",
      "resolved": "https://registry.npmjs.org/tinyglobby/-/tinyglobby-0.2.17.tgz",
      "integrity": "sha512-wXR/dYpcqKmfWpEdZjiKJOwCNFndD0DMnrW/cYjVGttEkBfVgcLFHoNrlj47mjOVic9yyNu65alsgF4NQyTa2g==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "fdir": "^6.5.0",
        "picomatch": "^4.0.4"
      },
      "engines": {
        "node": ">=12.0.0"
      },
      "funding": {
        "url": "https://github.com/sponsors/SuperchupuDev"
      }
    },
    "node_modules/tinyrainbow": {
      "version": "3.2.0",
      "resolved": "https://registry.npmjs.org/tinyrainbow/-/tinyrainbow-3.2.0.tgz",
      "integrity": "sha512-LgO3D9yZJjApUiuUfl9iFAwrtaX4+lok3wJIqttGoKCHlWUqHqbQpnxCf82L8FjgKsh4iGo78hqJwgL8F6To2A==",
      "dev": true,
      "license": "MIT",
      "engines": {
        "node": ">=14.0.0"
      }
    },
    "node_modules/toad-cache": {
      "version": "3.7.4",
      "resolved": "https://registry.npmjs.org/toad-cache/-/toad-cache-3.7.4.tgz",
      "integrity": "sha512-m1TdR/rvT7kgGJZhspNtXdsdYk0fddFpJJFlG5s+UkPFo6lkLoZ3YLOaovPYjq1R75NP5JfeTlSHaOsE09peCg==",
      "license": "MIT",
      "engines": {
        "node": ">=20"
      }
    },
    "node_modules/tslib": {
      "version": "2.8.1",
      "resolved": "https://registry.npmjs.org/tslib/-/tslib-2.8.1.tgz",
      "integrity": "sha512-oJFu94HQb+KVduSUQL7wnpmqnfmLsOA/nAh6b6EH0wCEoK0/mPeXU6c3wKDV83MkOuHPRHtSXKKU99IBazS/2w==",
      "license": "0BSD"
    },
    "node_modules/tsx": {
      "version": "4.23.15",
      "resolved": "https://registry.npmjs.org/tsx/-/tsx-4.23.15.tgz",
      "integrity": "sha512-Yiex1Ovn8z2xPpOWckIiysV1SSyRMY9BkLF++q0yKiDxCqRhosKfMg3janKkiLBwZ5c/YryloKwGZcrEmtwxKw==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "esbuild": "~0.28.0"
      },
      "bin": {
        "tsx": "dist/cli.mjs"
      },
      "engines": {
        "node": ">=18.0.0"
      },
      "optionalDependencies": {
        "fsevents": "~2.3.3"
      }
    },
    "node_modules/typescript": {
      "version": "5.9.3",
      "resolved": "https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz",
      "integrity": "sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==",
      "dev": true,
      "license": "Apache-2.0",
      "bin": {
        "tsc": "bin/tsc",
        "tsserver": "bin/tsserver"
      },
      "engines": {
        "node": ">=14.17"
      }
    },
    "node_modules/undici-types": {
      "version": "7.24.6",
      "resolved": "https://registry.npmjs.org/undici-types/-/undici-types-7.24.6.tgz",
      "integrity": "sha512-WRNW+sJgj5OBN4/0JpHFqtqzhpbnV0GuB+OozA9gCL7a993SmU+1JBZCzLNxYsbMfIeDL+lTsphD5jN5N+n0zg==",
      "license": "MIT"
    },
    "node_modules/vary": {
      "version": "1.1.2",
      "resolved": "https://registry.npmjs.org/vary/-/vary-1.1.2.tgz",
      "integrity": "sha512-BNGbWLfd0eUPabhkXUVm0j8uuvREyTh5ovRa/dyow/BqAbZJyC+5fU+IzQOzmAKzYqYRAISoRhdQr3eIZ/PXqg==",
      "license": "MIT",
      "engines": {
        "node": ">= 0.8"
      }
    },
    "node_modules/vite": {
      "version": "8.3.5",
      "resolved": "https://registry.npmjs.org/vite/-/vite-8.3.5.tgz",
      "integrity": "sha512-z1YpjieJ9g0ebTmQpLBv/oq9E3F9EIlOe+7LahW8SrE3LTiG3udBRUXQOlYXP9b+IC2q2phHeVxj9xGlw34OEQ==",
      "dev": true,
      "license": "MIT",
      "peer": true,
      "dependencies": {
        "lightningcss": "^1.33.0",
        "picomatch": "^4.0.7",
        "postcss": "^8.5.30",
        "rolldown": "~1.2.14",
        "tinyglobby": "^0.2.17"
      },
      "bin": {
        "vite": "bin/vite.js"
      },
      "engines": {
        "node": "^20.19.0 || >=22.12.0"
      },
      "funding": {
        "url": "https://github.com/vitejs/vite?sponsor=1"
      },
      "optionalDependencies": {
        "fsevents": "~2.3.3"
      },
      "peerDependencies": {
        "@types/node": "^20.19.0 || >=22.12.0",
        "@vitejs/devtools": "^0.7.1 || ^0.8.0",
        "esbuild": "^0.27.0 || ^0.28.0",
        "jiti": ">=1.21.0",
        "less": "^4.0.0",
        "sass": "^1.70.0",
        "sass-embedded": "^1.70.0",
        "stylus": ">=0.54.8",
        "sugarss": "^5.0.0",
        "terser": "^5.16.0",
        "tsx": "^4.8.1",
        "yaml": "^2.4.2"
      },
      "peerDependenciesMeta": {
        "@types/node": {
          "optional": true
        },
        "@vitejs/devtools": {
          "optional": true
        },
        "esbuild": {
          "optional": true
        },
        "jiti": {
          "optional": true
        },
        "less": {
          "optional": true
        },
        "sass": {
          "optional": true
        },
        "sass-embedded": {
          "optional": true
        },
        "stylus": {
          "optional": true
        },
        "sugarss": {
          "optional": true
        },
        "terser": {
          "optional": true
        },
        "tsx": {
          "optional": true
        },
        "yaml": {
          "optional": true
        }
      }
    },
    "node_modules/vite/node_modules/postcss": {
      "version": "8.5.31",
      "resolved": "https://registry.npmjs.org/postcss/-/postcss-8.5.31.tgz",
      "integrity": "sha512-YUbWYCgErwnMAVkjUnYa+KlMBzGpHwiIt/DE7f0G33AuX2LH9UcTk6KgWxd3zRU+pN3u/C+Xl3EnMLM4Hea7Sg==",
      "dev": true,
      "funding": [
        {
          "type": "opencollective",
          "url": "https://opencollective.com/postcss/"
        },
        {
          "type": "tidelift",
          "url": "https://tidelift.com/funding/github/npm/postcss"
        },
        {
          "type": "github",
          "url": "https://github.com/sponsors/ai"
        }
      ],
      "license": "MIT",
      "dependencies": {
        "nanoid": "^3.3.20",
        "picocolors": "^1.1.1",
        "source-map-js": "^1.2.2"
      },
      "engines": {
        "node": "^10 || ^12 || >=14"
      }
    },
    "node_modules/ws": {
      "version": "8.21.3",
      "resolved": "https://registry.npmjs.org/ws/-/ws-8.21.3.tgz",
      "integrity": "sha512-201TZ/kPWxoPr/OKWjquZR1SWKXcvxdH+e1xrx89b3YbmzLMFCLfnaG1HFIgWzJOEWZ7MvpK++odZufgYR50Rw==",
      "license": "MIT",
      "engines": {
        "node": ">=10.0.0"
      },
      "peerDependencies": {
        "bufferutil": "^4.0.1",
        "utf-8-validate": ">=5.0.2"
      },
      "peerDependenciesMeta": {
        "bufferutil": {
          "optional": true
        },
        "utf-8-validate": {
          "optional": true
        }
      }
    },
    "node_modules/xmlhttprequest-ssl": {
      "version": "2.1.2",
      "resolved": "https://registry.npmjs.org/xmlhttprequest-ssl/-/xmlhttprequest-ssl-2.1.2.tgz",
      "integrity": "sha512-TEU+nJVUUnA4CYJFLvK5X9AOeH4KvDvhIfm0vV1GaQRtchnG0hgK5p8hw/xjv8cunWYCsiPCSDzObPyhEwq3KQ==",
      "engines": {
        "node": ">=0.4.0"
      }
    },
    "node_modules/zod": {
      "version": "4.6.7",
      "resolved": "https://registry.npmjs.org/zod/-/zod-4.6.7.tgz",
      "integrity": "sha512-g8W2D2kU6a8untc053fX1uVBKzM7yqAxW/3zwk83+6RyF2+SKOuV+c0wBDhUwzV1PaGapmZH+rmcUzPf+3CGwg==",
      "license": "MIT",
      "funding": {
        "url": "https://github.com/sponsors/colinhacks"
      }
    },
    "packages/game-engine": {
      "name": "@uno/game-engine",
      "version": "0.1.0",
      "devDependencies": {
        "typescript": "^5.0.5",
        "vitest": "^4.1.12"
      }
    },
    "packages/game-engine/node_modules/@vitest/spy": {
      "version": "4.1.12",
      "resolved": "https://registry.npmjs.org/@vitest/spy/-/spy-4.1.12.tgz",
      "integrity": "sha512-RGq9x4JNGNTZHEJxvN0oSiJjeSCExm0n2gZKKJZHY9cX5AVA6M7VJILBT3ZJ/tJ/0J9uWT7fETV9/btoi//vSg==",
      "dev": true,
      "license": "MIT",
      "funding": {
        "url": "https://opencollective.com/vitest"
      }
    },
    "packages/game-engine/node_modules/obug": {
      "version": "2.2.1",
      "resolved": "https://registry.npmjs.org/obug/-/obug-2.2.1.tgz",
      "integrity": "sha512-XrsrhT5sybtKI6wakr2SPOlGZWWYbUXZ7a0jT8/QOeAPau+1X/bSegNe5YR75oJmEZQbKningirmGOEJCIk61Q==",
      "dev": true,
      "funding": [
        "https://github.com/sponsors/sxzz",
        "https://opencollective.com/debug"
      ],
      "license": "MIT",
      "engines": {
        "node": ">=12.20.0"
      }
    },
    "packages/game-engine/node_modules/tinybench": {
      "version": "2.9.0",
      "resolved": "https://registry.npmjs.org/tinybench/-/tinybench-2.9.0.tgz",
      "integrity": "sha512-0+DUvqWMValLmha6lr4kD8iAMK1HzV0/aKnCtWb9v9641TnP/MFb7Pc2bxoxQjTXAErryXVgUOfv2YqNllqGeg==",
      "dev": true,
      "license": "MIT"
    },
    "packages/game-engine/node_modules/vitest": {
      "version": "4.1.12",
      "resolved": "https://registry.npmjs.org/vitest/-/vitest-4.1.12.tgz",
      "integrity": "sha512-5eWdz2yb3ajxWF3C8C4TjkXl7FGm3n2E/VlazALrQHzK7nYMSGFnCZto0bbPNl77AwkOZVLk0YnBAejUu0NiWA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@vitest/expect": "4.1.12",
        "@vitest/mocker": "4.1.12",
        "@vitest/pretty-format": "4.1.12",
        "@vitest/runner": "4.1.12",
        "@vitest/snapshot": "4.1.12",
        "@vitest/spy": "4.1.12",
        "@vitest/utils": "4.1.12",
        "es-module-lexer": "^2.0.0",
        "expect-type": "^1.3.0",
        "magic-string": "^0.30.21",
        "obug": "^2.1.1",
        "pathe": "^2.0.3",
        "picomatch": "^4.0.3",
        "std-env": "^4.0.0-rc.1",
        "tinybench": "^2.9.0",
        "tinyexec": "^1.0.2",
        "tinyglobby": "^0.2.15",
        "tinyrainbow": "^3.1.0",
        "vite": "^6.0.0 || ^7.0.0 || ^8.0.0",
        "why-is-node-running": "^2.3.0"
      },
      "bin": {
        "vitest": "vitest.mjs"
      },
      "engines": {
        "node": "^20.0.0 || ^22.0.0 || >=24.0.0"
      },
      "funding": {
        "url": "https://opencollective.com/vitest"
      },
      "peerDependencies": {
        "@edge-runtime/vm": "*",
        "@opentelemetry/api": "^1.9.0",
        "@types/node": "^20.0.0 || ^22.0.0 || >=24.0.0",
        "@vitest/browser-playwright": "4.1.12",
        "@vitest/browser-preview": "4.1.12",
        "@vitest/browser-webdriverio": "^4.1.11",
        "@vitest/coverage-istanbul": "4.1.12",
        "@vitest/coverage-v8": "4.1.12",
        "@vitest/ui": "4.1.12",
        "happy-dom": "*",
        "jsdom": "*",
        "vite": "^6.0.0 || ^7.0.0 || ^8.0.0"
      },
      "peerDependenciesMeta": {
        "@edge-runtime/vm": {
          "optional": true
        },
        "@opentelemetry/api": {
          "optional": true
        },
        "@types/node": {
          "optional": true
        },
        "@vitest/browser-playwright": {
          "optional": true
        },
        "@vitest/browser-preview": {
          "optional": true
        },
        "@vitest/browser-webdriverio": {
          "optional": true
        },
        "@vitest/coverage-istanbul": {
          "optional": true
        },
        "@vitest/coverage-v8": {
          "optional": true
        },
        "@vitest/ui": {
          "optional": true
        },
        "happy-dom": {
          "optional": true
        },
        "jsdom": {
          "optional": true
        },
        "vite": {
          "optional": false
        }
      }
    },
    "packages/game-engine/node_modules/vitest/node_modules/@vitest/mocker": {
      "version": "4.1.12",
      "resolved": "https://registry.npmjs.org/@vitest/mocker/-/mocker-4.1.12.tgz",
      "integrity": "sha512-fKShNpKZzupWZuY0z7egydvL0sqW4INEZBEExMBMAa6izlENEVHwoXgdaTCaBZ5fwlr4xf2o1wXC83n9RpO+NA==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "@vitest/spy": "4.1.12",
        "estree-walker": "^3.0.3",
        "magic-string": "^0.30.21"
      },
      "funding": {
        "url": "https://opencollective.com/vitest"
      },
      "peerDependencies": {
        "msw": "^2.4.9",
        "vite": "^6.0.0 || ^7.0.0 || ^8.0.0"
      },
      "peerDependenciesMeta": {
        "msw": {
          "optional": true
        },
        "vite": {
          "optional": true
        }
      }
    },
    "packages/game-engine/node_modules/why-is-node-running": {
      "version": "2.3.0",
      "resolved": "https://registry.npmjs.org/why-is-node-running/-/why-is-node-running-2.3.0.tgz",
      "integrity": "sha512-hUrmaWBdVDcxvYqnyh09zunKzROWjbZTiNy8dBEjkS7ehEDQibXJ7XvlmtbwuTclUiIyN+CyXQD4Vmko8fNm8w==",
      "dev": true,
      "license": "MIT",
      "dependencies": {
        "siginfo": "^2.0.0",
        "stackback": "0.0.2"
      },
      "bin": {
        "why-is-node-running": "cli.js"
      },
      "engines": {
        "node": ">=8"
      }
    },
    "packages/protocol": {
      "name": "@uno/protocol",
      "version": "0.1.0",
      "dependencies": {
        "zod": "^4.6.7"
      },
      "devDependencies": {
        "typescript": "^5.0.5"
      }
    }
  }
}
```

## `package.json`

```text
{
  "name": "uno-multiplayer",
  "private": true,
  "version": "0.1.0",
  "description": "Anonymous multiplayer UNO game",
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "dev:web": "npm run dev --workspace @uno/web",
    "dev:realtime": "npm run dev --workspace @uno/realtime",
    "build:packages": "npm run build --workspace @uno/protocol && npm run build --workspace @uno/game-engine",
    "build:apps": "npm run build --workspace @uno/realtime && npm run build --workspace @uno/web",
    "build": "npm run build:packages && npm run build:apps",
    "smoke:realtime": "node --conditions=development --import tsx/esm scripts/uno-realtime-smoke.mts",
    "proof:ui": "node --conditions=development --import tsx/esm scripts/uno-ui-proof.mts",
    "test": "npm run test --workspaces --if-present",
    "typecheck": "npm run typecheck --workspaces --if-present"
  },
  "engines": {
    "node": ">=20.9.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.64.1",
    "tsx": "^4.20.6"
  }
}
```

## `packages/game-engine/src/index.ts`

```text
export type CardColor = "red" | "yellow" | "green" | "blue" | "wild";
export type CardKind = "number" | "skip" | "reverse" | "draw2" | "wild" | "wildDraw4";

export interface Card {
  id: string;
  color: CardColor;
  kind: CardKind;
  value?: number;
}

export interface GamePlayer {
  id: string;
  displayName: string;
  hand: Card[];
}

export interface GameState {
  status: "playing" | "finished";
  rulesetVersion: string;
  players: GamePlayer[];
  drawPile: Card[];
  discardPile: Card[];
  currentColor: CardColor;
  currentPlayerIndex: number;
  direction: 1 | -1;
  drewThisTurn: boolean;
  nextCardId: number;
  random?: () => number;
  version: number;
  winnerId?: string;
}

export interface MoveResult {
  state: GameState;
  playedCard: Card;
  nextPlayerId?: string;
  penaltyPlayerId?: string;
  penaltyAmount?: number;
  skippedPlayerId?: string;
}

const COLORS: Exclude<CardColor, "wild">[] = ["red", "yellow", "green", "blue"];

function shuffle<T>(items: T[], random: () => number): T[] {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index]!, result[swapIndex]!] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

export function createDeck(startingId = 0): Card[] {
  const cards: Card[] = [];
  let id = startingId;

  for (const color of COLORS) {
    cards.push({ id: `card-${id++}`, color, kind: "number", value: 0 });
    for (let value = 1; value <= 9; value += 1) {
      cards.push({ id: `card-${id++}`, color, kind: "number", value });
      cards.push({ id: `card-${id++}`, color, kind: "number", value });
    }
    for (const kind of ["skip", "reverse", "draw2"] as const) {
      cards.push({ id: `card-${id++}`, color, kind });
      cards.push({ id: `card-${id++}`, color, kind });
    }
  }

  for (let index = 0; index < 4; index += 1) {
    cards.push({ id: `card-${id++}`, color: "wild", kind: "wild" });
    cards.push({ id: `card-${id++}`, color: "wild", kind: "wildDraw4" });
  }

  return cards;
}

export function createGame(
  players: Array<Pick<GamePlayer, "id" | "displayName">>,
  options: { random?: () => number; rulesetVersion?: string } = {},
): GameState {
  if (players.length < 2 || players.length > 8) {
    throw new Error("A game requires between 2 and 8 players");
  }

  const random = options.random ?? Math.random;
  let drawPile = shuffle(createDeck(), random);
  const gamePlayers: GamePlayer[] = players.map((player) => ({ ...player, hand: [] }));

  for (let cardIndex = 0; cardIndex < 7; cardIndex += 1) {
    for (const player of gamePlayers) {
      const card = drawPile.pop();
      if (!card) throw new Error("Deck ran out while dealing");
      player.hand.push(card);
    }
  }

  let firstCard = drawPile.pop();
  while (firstCard && firstCard.kind !== "number") {
    drawPile.push(firstCard);
    drawPile = shuffle(drawPile, random);
    firstCard = drawPile.pop();
  }
  if (!firstCard) throw new Error("Deck ran out while starting game");

  return {
    status: "playing",
    rulesetVersion: options.rulesetVersion ?? "standard-v1",
    players: gamePlayers,
    drawPile,
    discardPile: [firstCard],
    currentColor: firstCard.color,
    currentPlayerIndex: 0,
    direction: 1,
    drewThisTurn: false,
    nextCardId: 108,
    random,
    version: 1,
  };
}

export function getCurrentPlayer(state: GameState): GamePlayer {
  const player = state.players[state.currentPlayerIndex];
  if (!player) throw new Error("Current player does not exist");
  return player;
}

export function isPlayable(card: Card, state: GameState): boolean {
  const topCard = state.discardPile[state.discardPile.length - 1];
  if (!topCard) return false;
  return canPlay(card, topCard, state.currentColor);
}

// Optional public helper used by the client to calculate legal-card styling.
export function canPlay(card: Card, topCard: Card, currentColor: CardColor): boolean {
  if (topCard.kind === "draw2" && card.kind === "draw2") return false;
  return (
    card.color === "wild" ||
    card.color === currentColor ||
    card.kind === topCard.kind && card.value === topCard.value
  );
}

function nextIndex(state: GameState, steps = 1): number {
  const count = state.players.length;
  return (state.currentPlayerIndex + state.direction * steps + count * 10) % count;
}

function refillDrawPile(state: GameState, requiredCount: number): void {
  if (state.drawPile.length >= requiredCount) return;

  const topCard = state.discardPile[state.discardPile.length - 1];
  if (state.discardPile.length > 1) {
    const recycled = state.discardPile.slice(0, -1);
    state.discardPile = topCard ? [topCard] : [];
    state.drawPile.push(...shuffle(recycled, state.random ?? Math.random));
  }

  while (state.drawPile.length < requiredCount) {
    const freshDeck = shuffle(createDeck(state.nextCardId), state.random ?? Math.random);
    state.nextCardId += freshDeck.length;
    state.drawPile.push(...freshDeck);
  }
}

function advanceTurn(state: GameState): void {
  state.currentPlayerIndex = nextIndex(state);
  state.drewThisTurn = false;
}

export function drawOne(state: GameState, playerId: string): Card {
  if (state.status !== "playing") throw new Error("The game has finished");
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error("Player does not exist");
  if (getCurrentPlayer(state).id !== playerId) throw new Error("It is not this player's turn");
  if (state.drewThisTurn) throw new Error("You may draw only once per turn");

  refillDrawPile(state, 1);
  const card = state.drawPile.pop();
  if (!card) throw new Error("There are no cards left to draw");
  const playable = isPlayable(card, state);
  player.hand.push(card);
  state.drewThisTurn = true;
  if (!playable) advanceTurn(state);
  state.version += 1;
  return card;
}

export function passTurn(state: GameState, playerId: string): void {
  if (state.status !== "playing") throw new Error("The game has finished");
  if (getCurrentPlayer(state).id !== playerId) throw new Error("It is not this player's turn");
  if (!state.drewThisTurn) throw new Error("You must draw before passing");
  advanceTurn(state);
  state.version += 1;
}

export function drawCards(state: GameState, playerId: string, count: number): Card[] {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error("Player does not exist");
  const amount = Math.floor(count);
  if (amount < 1) return [];

  refillDrawPile(state, amount);
  const drawn: Card[] = [];
  for (let index = 0; index < amount; index += 1) {
    const card = state.drawPile.pop();
    if (!card) throw new Error("There are no cards left to draw");
    player.hand.push(card);
    drawn.push(card);
  }
  state.version += 1;
  return drawn;
}

export function playCard(
  state: GameState,
  playerId: string,
  cardId: string,
  chosenColor?: Exclude<CardColor, "wild">,
): MoveResult {
  if (state.status !== "playing") throw new Error("The game has finished");
  const playerIndex = state.players.findIndex((player) => player.id === playerId);
  if (playerIndex < 0) throw new Error("Player does not exist");
  if (playerIndex !== state.currentPlayerIndex) throw new Error("It is not this player's turn");

  const player = state.players[playerIndex];
  if (!player) throw new Error("Player does not exist");
  const cardIndex = player.hand.findIndex((card) => card.id === cardId);
  if (cardIndex < 0) throw new Error("Card is not in the player's hand");
  const card = player.hand[cardIndex];
  if (!card || !isPlayable(card, state)) throw new Error("Card cannot be played");
  if (card.color === "wild" && !chosenColor) throw new Error("A color must be chosen");

  player.hand.splice(cardIndex, 1);
  state.discardPile.push(card);
  state.currentColor = card.color === "wild" ? chosenColor ?? "red" : card.color;

  const penaltyAmount = card.kind === "draw2" ? 2 : card.kind === "wildDraw4" ? 4 : undefined;
  const skippedIndex = card.kind === "skip" || penaltyAmount !== undefined || card.kind === "reverse" && state.players.length === 2
    ? nextIndex(state)
    : undefined;
  const skippedPlayerId = skippedIndex === undefined ? undefined : state.players[skippedIndex]?.id;
  const penaltyPlayerId = penaltyAmount === undefined ? undefined : skippedPlayerId;
  if (penaltyAmount !== undefined && penaltyPlayerId) {
    drawCards(state, penaltyPlayerId, penaltyAmount);
  }

  if (player.hand.length === 0) {
    state.status = "finished";
    state.winnerId = player.id;
    state.drewThisTurn = false;
  } else {
    if (card.kind === "reverse") state.direction = state.direction === 1 ? -1 : 1;
    const steps = card.kind === "skip" || penaltyAmount !== undefined || card.kind === "reverse" && state.players.length === 2 ? 2 : 1;
    state.currentPlayerIndex = nextIndex(state, steps);
    state.drewThisTurn = false;
  }

  state.version += 1;
  return {
    state,
    playedCard: card,
    nextPlayerId: state.status === "playing" ? getCurrentPlayer(state).id : undefined,
    penaltyPlayerId,
    penaltyAmount,
    skippedPlayerId,
  };
}

export function publicGameState(
  state: GameState,
  options: number | { turnEndsAt?: number; serverTime?: number; unoWindow?: { playerId: string; endsAt: number } } = {},
): Pick<GameState, "status" | "currentColor" | "version" | "winnerId"> & {
  currentPlayerId: string;
  topCard: Card;
  drawPileCount: number;
  direction?: 1 | -1;
  drewThisTurn?: boolean;
  turnEndsAt?: number;
  serverTime?: number;
  unoWindow?: { playerId: string; endsAt: number };
} {
  const currentPlayer = getCurrentPlayer(state);
  const topCard = state.discardPile[state.discardPile.length - 1];
  if (!topCard) throw new Error("Game has no top card");
  const metadata = typeof options === "number" ? { turnEndsAt: options } : options;
  return {
    status: state.status,
    currentColor: state.currentColor,
    version: state.version,
    winnerId: state.winnerId,
    currentPlayerId: currentPlayer.id,
    topCard,
    drawPileCount: state.drawPile.length,
    direction: state.direction,
    drewThisTurn: state.drewThisTurn,
    turnEndsAt: metadata.turnEndsAt,
    serverTime: metadata.serverTime ?? Date.now(),
    unoWindow: metadata.unoWindow,
  };
}
```

## `packages/game-engine/test/game-engine.test.ts`

```text
import { describe, expect, it } from "vitest";
import {
  canPlay,
  createGame,
  createDeck,
  drawCards,
  drawOne,
  isPlayable,
  passTurn,
  playCard,
  type Card,
  type GameState,
} from "../src/index.js";

function testState(playerOneHand: Card[], playerTwoHand: Card[] = []): GameState {
  const state = createGame([
    { id: "p1", displayName: "A" },
    { id: "p2", displayName: "B" },
  ], { random: () => 0.5 });
  state.players[0]!.hand = playerOneHand;
  state.players[1]!.hand = playerTwoHand;
  state.drawPile = [];
  state.discardPile = [{ id: "top", color: "red", kind: "number", value: 5 }];
  state.currentColor = "red";
  state.currentPlayerIndex = 0;
  state.direction = 1;
  state.drewThisTurn = false;
  return state;
}

function seededRandom(seed: number): () => number {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

describe("UNO game engine", () => {
  it("creates a 108-card deck", () => {
    expect(createDeck()).toHaveLength(108);
  });

  it("deals seven cards to each player and starts with a public card", () => {
    const state = createGame([
      { id: "p1", displayName: "A" },
      { id: "p2", displayName: "B" },
    ], { random: () => 0.5 });

    expect(state.players.map((player) => player.hand)).toHaveLength(2);
    expect(state.players.every((player) => player.hand.length === 7)).toBe(true);
    expect(state.discardPile).toHaveLength(1);
  });

  it("rejects an illegal card", () => {
    const state = createGame([
      { id: "p1", displayName: "A" },
      { id: "p2", displayName: "B" },
    ], { random: () => 0.5 });
    const card = state.players[0]?.hand.find((candidate) => !isPlayable(candidate, state));

    if (!card) return;
    expect(() => playCard(state, "p1", card.id)).toThrow("Card cannot be played");
  });

  it("shares the same legality rule through canPlay", () => {
    const topCard = { id: "top", color: "blue" as const, kind: "number" as const, value: 7 };
    expect(canPlay({ id: "same-color", color: "blue", kind: "number", value: 2 }, topCard, "blue")).toBe(true);
    expect(canPlay({ id: "same-value", color: "red", kind: "number", value: 7 }, topCard, "blue")).toBe(true);
    expect(canPlay({ id: "wild", color: "wild", kind: "wild" }, topCard, "blue")).toBe(true);
    expect(canPlay({ id: "blocked", color: "red", kind: "number", value: 2 }, topCard, "blue")).toBe(false);
  });

  it("never starts with a non-number discard card", () => {
    for (let shuffle = 0; shuffle < 500; shuffle += 1) {
      const state = createGame([
        { id: "p1", displayName: "A" },
        { id: "p2", displayName: "B" },
      ], { random: seededRandom(shuffle + 1) });
      expect(state.discardPile[0]?.kind).toBe("number");
    }
  });

  it("deals two cards for Draw Two and skips the victim", () => {
    const state = testState([
      { id: "draw2", color: "red", kind: "draw2" },
      { id: "spare", color: "blue", kind: "number", value: 1 },
    ]);
    const before = state.players[1]!.hand.length;

    const result = playCard(state, "p1", "draw2");

    expect(result.penaltyAmount).toBe(2);
    expect(state.players[1]!.hand).toHaveLength(before + 2);
    expect(state.currentPlayerIndex).toBe(0);
    expect(state.drewThisTurn).toBe(false);
  });

  it("deals four cards for Wild Draw Four and skips the victim", () => {
    const state = testState([
      { id: "wild4", color: "wild", kind: "wildDraw4" },
      { id: "spare", color: "blue", kind: "number", value: 1 },
    ]);
    const before = state.players[1]!.hand.length;

    const result = playCard(state, "p1", "wild4", "green");

    expect(result.penaltyAmount).toBe(4);
    expect(state.players[1]!.hand).toHaveLength(before + 4);
    expect(state.currentPlayerIndex).toBe(0);
    expect(state.currentColor).toBe("green");
  });

  it("treats Reverse as Skip with exactly two players", () => {
    const state = testState([
      { id: "reverse", color: "red", kind: "reverse" },
      { id: "spare", color: "blue", kind: "number", value: 1 },
    ]);

    playCard(state, "p1", "reverse");

    expect(state.direction).toBe(-1);
    expect(state.currentPlayerIndex).toBe(0);
  });

  it("draws 1000 cards without failing and never reuses an id", () => {
    const state = createGame([
      { id: "p1", displayName: "A" },
      { id: "p2", displayName: "B" },
    ], { random: seededRandom(42) });

    const drawn = drawCards(state, "p1", 1000);
    const allCards = state.players.flatMap((player) => player.hand).concat(state.drawPile, state.discardPile);
    const ids = allCards.map((card) => card.id);

    expect(drawn).toHaveLength(1000);
    expect(new Set(drawn.map((card) => card.id)).size).toBe(1000);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("allows only one draw during a turn", () => {
    const state = testState([
      { id: "spare", color: "blue", kind: "number", value: 1 },
    ]);
    state.drawPile = [{ id: "draw", color: "red", kind: "number", value: 9 }];

    drawOne(state, "p1");

    expect(state.drewThisTurn).toBe(true);
    expect(() => drawOne(state, "p1")).toThrow("You may draw only once per turn");
  });

  it("allows pass only after a playable draw", () => {
    const state = testState([
      { id: "spare", color: "blue", kind: "number", value: 1 },
    ]);
    state.drawPile = [{ id: "draw", color: "red", kind: "number", value: 9 }];

    expect(() => passTurn(state, "p1")).toThrow("You must draw before passing");
    drawOne(state, "p1");
    passTurn(state, "p1");

    expect(state.currentPlayerIndex).toBe(1);
    expect(state.drewThisTurn).toBe(false);
  });
});
```

## `packages/game-engine/test/realtime-server.test.ts`

```text
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
```

## `packages/protocol/src/index.ts`

```text
import { z } from "zod";

export const roomCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z0-9]{6}$/);

export const displayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[\p{L}\p{N} _-]+$/u);

export const createRoomSchema = z.object({
  displayName: displayNameSchema,
});

export const joinRoomSchema = z.object({
  roomCode: roomCodeSchema,
  displayName: displayNameSchema,
});

export const transferHostSchema = z.object({
  playerId: z.string().min(1),
});

export const reactionSchema = z.object({
  messageId: z.enum(["Nice!", "Dang!", "GG", "Hurry up!", "Oops", "Wow!", "Your turn", "Good game"]),
});

export const callUnoSchema = z.object({
  targetPlayerId: z.string().min(1),
});

export type CreateRoomInput = z.infer<typeof createRoomSchema>;
export type JoinRoomInput = z.infer<typeof joinRoomSchema>;
export type ReactionInput = z.infer<typeof reactionSchema>;
export type QuickMessage = ReactionInput["messageId"];
export type NoticeType = "draw_penalty" | "skip" | "reverse" | "timeout" | "uno_called" | "uno_penalty";

export interface GameNotice {
  id: number;
  type: NoticeType;
  playerId: string;
  amount?: number;
  text: string;
}

export type RoomStatus = "open" | "locked" | "in_game" | "finished";

export interface PublicPlayer {
  id: string;
  displayName: string;
  isHost: boolean;
  connected: boolean;
  cardCount: number;
  unoCalled: boolean;
  reaction?: QuickMessage;
}

export interface PublicRoom {
  code: string;
  status: RoomStatus;
  players: PublicPlayer[];
  maxPlayers: number;
  rulesetVersion: string;
  turnSeconds: number;
  game?: {
    currentPlayerId: string;
    currentColor: string;
    topCard: { color: string; kind: string; value?: number };
    drawPileCount: number;
    version: number;
    winnerId?: string;
    direction?: 1 | -1;
    drewThisTurn?: boolean;
    turnEndsAt?: number;
    serverTime?: number;
    unoWindow?: { playerId: string; endsAt: number };
  };
}

export type ServerErrorCode =
  | "INVALID_INPUT"
  | "ROOM_NOT_FOUND"
  | "ROOM_FULL"
  | "NAME_TAKEN"
  | "NOT_HOST"
  | "ROOM_NOT_READY"
  | "NOT_YOUR_TURN"
  | "INVALID_MOVE"
  | "RATE_LIMITED"
  | "NOT_IN_ROOM";
```

## `scripts/uno-realtime-smoke.mts`

```text
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
```

## `scripts/uno-ui-proof.mts`

```text
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";

type Viewport = { width: number; height: number };
type PlayerPage = { id: string; name: string; context: BrowserContext; page: Page };
type ProofRow = {
  viewport: string;
  screen: "lobby" | "game";
  players: number;
  handSize: number | "—";
  overlapsFound: number;
  scroll: "none" | "present";
  screenshot: string;
};

const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
const OUTPUT_ROOT = path.resolve("artifacts", "uno-ui-proof");
const VIEWPORTS: Viewport[] = [
  { width: 1920, height: 880 },
  { width: 1366, height: 650 },
  { width: 1280, height: 587 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 640, height: 360 },
  { width: 360, height: 640 },
];
const ACTIVE_VIEWPORTS = process.env.UI_PROOF_VIEWPORT
  ? VIEWPORTS.filter((viewport) => viewportName(viewport) === process.env.UI_PROOF_VIEWPORT)
  : VIEWPORTS;
const results: ProofRow[] = [];

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function viewportName(viewport: Viewport): string {
  return `${viewport.width}x${viewport.height}`;
}

function pageName(viewport: Viewport, fileName: string): string {
  return path.join(OUTPUT_ROOT, viewportName(viewport), fileName);
}

async function createPlayer(browser: Browser, viewport: Viewport, id: string, name: string): Promise<PlayerPage> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript(({ guestId }) => {
    window.localStorage.setItem("uno-guest-id", guestId);
  }, { guestId: id });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  return { id, name, context, page };
}

async function closePlayers(players: PlayerPage[]): Promise<void> {
  await Promise.all(players.map(async (player) => {
    await player.context.close();
  }));
}

async function createRoom(player: PlayerPage): Promise<string> {
  await player.page.goto(WEB_URL);
  await player.page.getByRole("button", { name: /Create room/ }).first().click();
  await player.page.getByLabel("Your name").fill(player.name);
  await player.page.getByRole("button", { name: "Create room", exact: true }).click();
  await player.page.waitForURL(/\/room\/[A-Z0-9]{6}/);
  await player.page.locator('[data-screen="lobby"]').waitFor();
  return new URL(player.page.url()).pathname.split("/").pop() ?? "";
}

async function joinRoom(player: PlayerPage, roomCode: string): Promise<void> {
  await player.page.goto(WEB_URL);
  await player.page.getByRole("button", { name: /Join room/ }).first().click();
  await player.page.getByLabel("Your name").fill(player.name);
  await player.page.getByLabel("Room code").fill(roomCode);
  await player.page.getByRole("button", { name: "Join room", exact: true }).click();
  await player.page.waitForURL(/\/room\/[A-Z0-9]{6}/);
  await player.page.locator('[data-screen="lobby"]').waitFor();
}

async function waitForPlayers(players: PlayerPage[], count: number): Promise<void> {
  await Promise.all(players.map((player) => player.page.waitForFunction((expected) => Number(document.querySelector("main")?.getAttribute("data-players")) === expected, count)));
}

async function startGame(players: PlayerPage[]): Promise<void> {
  await players[0]!.page.getByRole("button", { name: "Start game", exact: false }).click();
  await Promise.all(players.map((player) => player.page.locator('[data-screen="game"]').waitFor()));
  await sleep(120);
}

async function currentPlayerId(players: PlayerPage[]): Promise<string> {
  for (const player of players) {
    const value = await player.page.locator("main").getAttribute("data-current-player");
    if (value) return value;
  }
  throw new Error("The game has no current player in the public DOM state.");
}

async function handSize(player: PlayerPage): Promise<number> {
  return Number(await player.page.locator("main").getAttribute("data-hand-size"));
}

async function drawOrPassCurrent(players: PlayerPage[]): Promise<void> {
  const id = await currentPlayerId(players);
  const current = players.find((player) => player.id === id);
  if (!current) throw new Error(`No page is connected for current player ${id}`);
  const button = current.page.getByTestId("draw-action");
  await button.waitFor({ state: "visible" });
  await button.click();
  await current.page.waitForTimeout(90);
  if ((await button.textContent())?.trim() === "Pass" && await button.isEnabled()) {
    await button.click();
  }
  await current.page.waitForTimeout(120);
}

async function advanceTo(players: PlayerPage[], targetId: string): Promise<void> {
  for (let attempt = 0; attempt < 240; attempt += 1) {
    if (await currentPlayerId(players) === targetId) return;
    await drawOrPassCurrent(players);
  }
  throw new Error(`Could not reach turn for ${targetId}`);
}

async function growHand(players: PlayerPage[], targetId: string, targetSize: number): Promise<void> {
  const target = players.find((player) => player.id === targetId);
  if (!target) throw new Error(`Missing target page ${targetId}`);
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (await handSize(target) >= targetSize) return;
    await advanceTo(players, targetId);
    await drawOrPassCurrent(players);
  }
  throw new Error(`Could not grow ${targetId} to ${targetSize} cards`);
}

async function legalCardTarget(page: Page): Promise<{ id: string; x: number; y: number }> {
  const target = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-card-legal="true"]'));
    if (!cards.length) return undefined;
    const ordered = [...cards.filter((card) => !(card.getAttribute("aria-label") ?? "").startsWith("Wild")), ...cards.filter((card) => (card.getAttribute("aria-label") ?? "").startsWith("Wild"))];
    const card = ordered[0]!;
    const rect = card.getBoundingClientRect();
    return { id: card.dataset.cardId ?? "", x: rect.width / 2, y: rect.height / 2 };
  });
  if (!target?.id) throw new Error("The current player has no visible legal card to play.");
  return target;
}

async function playOneLegalCard(player: PlayerPage): Promise<void> {
  const target = await legalCardTarget(player.page);
  const id = target.id;
  const card = player.page.locator(`button[data-card-id="${id}"]`);
  const before = await handSize(player);
  await card.focus();
  await card.press("Enter");
  await player.page.waitForTimeout(45);
  const selected = player.page.locator(`button[data-card-id="${id}"]`);
  if ((await selected.getAttribute("aria-pressed")) !== "true") await selected.press("Enter");
  await selected.press("Enter");
  const picker = player.page.locator('[role="dialog"]');
  if (await picker.isVisible().catch(() => false)) {
    await picker.locator("button").filter({ hasText: /^red$/i }).evaluate((element) => (element as HTMLButtonElement).click());
    await picker.waitFor({ state: "hidden" });
  }
  try {
    await player.page.waitForFunction((expected) => Number(document.querySelector("main")?.getAttribute("data-hand-size")) < expected, before, { timeout: 2_000 });
  } catch (error) {
    await player.page.screenshot({ path: path.join(OUTPUT_ROOT, "debug-play.png"), fullPage: false });
    console.error("[ui-proof] play-debug", {
      before,
      after: await handSize(player),
      current: await player.page.locator("main").getAttribute("data-current-player"),
      targetId: id,
      pressed: await player.page.locator(`button[data-card-id="${id}"]`).getAttribute("aria-pressed").catch(() => null),
      errorText: await player.page.locator("body").innerText().then((text) => text.slice(-500)),
    });
    throw error;
  }
  await player.page.waitForTimeout(120);
}

async function reduceHand(players: PlayerPage[], targetId: string, targetSize: number): Promise<void> {
  const target = players.find((player) => player.id === targetId);
  if (!target) throw new Error(`Missing target page ${targetId}`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const size = await handSize(target);
    if (size <= targetSize) return;
    await advanceTo(players, targetId);
    if (await target.page.locator('button[data-card-legal="true"]').count() === 0) {
      await drawOrPassCurrent(players);
      continue;
    }
    try {
      await playOneLegalCard(target);
    } catch (error) {
      if (error instanceof Error && error.message.includes("no visible legal card")) {
        await drawOrPassCurrent(players);
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Could not reduce ${targetId} to ${targetSize} cards`);
}

async function capture(viewport: Viewport, player: PlayerPage, fileName: string, screen: ProofRow["screen"], players: number, hand: number | "—"): Promise<void> {
  const screenshot = pageName(viewport, fileName);
  await mkdir(path.dirname(screenshot), { recursive: true });
  await player.page.waitForTimeout(150);
  await player.page.screenshot({ path: screenshot, fullPage: false });
  await player.page.waitForFunction(() => Boolean(document.documentElement.dataset.layoutIssues));
  const raw = await player.page.locator("html").getAttribute("data-layout-issues");
  const report = raw ? JSON.parse(raw) as { overlaps: string[]; outside: string[]; scroll: boolean } : { overlaps: [], outside: [], scroll: true };
  if (report.overlaps.length || report.outside.length || report.scroll) {
    console.error("[ui-proof] layout-debug", await player.page.evaluate(() => {
      const names = [".game-table-shell", ".game-table", ".table-center-zone", ".play-piles", "[data-layout-role='draw-pile']", "[data-layout-role='discard-pile']", "[data-layout-role='status-line']", "[data-layout-role='opponent-seat']"];
      return Object.fromEntries(names.map((selector) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element) return [selector, null];
        const rect = element.getBoundingClientRect();
        const styles = getComputedStyle(element);
        return [selector, { rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height }, display: styles.display, gridArea: styles.gridArea, gridTemplateColumns: styles.gridTemplateColumns, gridTemplateAreas: styles.gridTemplateAreas }];
      }));
    }));
    throw new Error(`${fileName} failed layout check: ${JSON.stringify(report)}`);
  }
  results.push({ viewport: viewportName(viewport), screen, players, handSize: hand, overlapsFound: report.overlaps.length, scroll: report.scroll ? "present" : "none", screenshot: path.relative(process.cwd(), screenshot).replaceAll("\\", "/") });
}

async function createPlayers(browser: Browser, viewport: Viewport, count: number, prefix: string): Promise<PlayerPage[]> {
  const players: PlayerPage[] = [];
  for (let index = 0; index < count; index += 1) {
    players.push(await createPlayer(browser, viewport, `${prefix}-${index + 1}`, `${prefix.slice(0, 1).toUpperCase()}${index + 1}`));
  }
  return players;
}

async function lobbyProof(browser: Browser, viewport: Viewport): Promise<void> {
  const players = await createPlayers(browser, viewport, 8, `lobby-${viewport.width}-${viewport.height}`);
  try {
    const roomCode = await createRoom(players[0]!);
    await capture(viewport, players[0]!, "lobby-1p.png", "lobby", 1, "—");
    for (const player of players.slice(1)) await joinRoom(player, roomCode);
    await waitForPlayers(players, 8);
    await capture(viewport, players[0]!, "lobby-8p.png", "lobby", 8, "—");
  } finally {
    await closePlayers(players);
  }
}

async function gameProof(browser: Browser, viewport: Viewport, playerCount: number): Promise<void> {
  const prefix = `game-${viewport.width}-${viewport.height}-${playerCount}`;
  const players = await createPlayers(browser, viewport, playerCount, prefix);
  try {
    const roomCode = await createRoom(players[0]!);
    for (const player of players.slice(1)) await joinRoom(player, roomCode);
    await waitForPlayers(players, playerCount);
    await startGame(players);
    const target = players[0]!;
    await growHand(players, target.id, 7);
    await capture(viewport, target, `game-${playerCount}p-hand-7.png`, "game", playerCount, 7);

    if (playerCount === 2) {
      const messagePlayer = players[1]!;
      await reduceHand(players, messagePlayer.id, 2);
      await messagePlayer.page.getByTestId("chat-button").click();
      await messagePlayer.page.getByRole("button", { name: "Dang!", exact: true }).click();
      await advanceTo(players, messagePlayer.id);
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if (await messagePlayer.page.locator('button[data-card-legal="true"]').count() > 0) {
          await playOneLegalCard(messagePlayer);
          break;
        }
        await drawOrPassCurrent(players);
        await advanceTo(players, messagePlayer.id);
      }
      await capture(viewport, target, "game-2p-bubbles-uno.png", "game", playerCount, await handSize(target));
    }

    for (const targetSize of [15, 25]) {
      await growHand(players, target.id, targetSize);
      await capture(viewport, target, `game-${playerCount}p-hand-${targetSize}.png`, "game", playerCount, targetSize);
    }
  } finally {
    await closePlayers(players);
  }
}

function resultsMarkdown(): string {
  const lines = [
    "| viewport | screen | players | hand size | overlaps found | scroll | screenshot |",
    "|---|---:|---:|---:|---:|---|---|",
    ...results.map((row) => `| ${row.viewport} | ${row.screen} | ${row.players} | ${row.handSize} | ${row.overlapsFound} | ${row.scroll} | ${row.screenshot} |`),
  ];
  return `${lines.join("\n")}\n`;
}

async function run(): Promise<void> {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const resultLabel = ACTIVE_VIEWPORTS.length === 1 ? viewportName(ACTIVE_VIEWPORTS[0]!) : "all";
  try {
    for (const viewport of ACTIVE_VIEWPORTS) {
      console.log(`[ui-proof] ${viewportName(viewport)} lobby`);
      await lobbyProof(browser, viewport);
      for (const playerCount of [2, 4, 8]) {
        console.log(`[ui-proof] ${viewportName(viewport)} game ${playerCount} players`);
        await gameProof(browser, viewport, playerCount);
      }
    }
    await writeFile(path.join(OUTPUT_ROOT, `results-${resultLabel}.json`), JSON.stringify(results, null, 2));
    await writeFile(path.join(OUTPUT_ROOT, `results-${resultLabel}.md`), resultsMarkdown());
    await writeFile(path.join(OUTPUT_ROOT, "results.md"), resultsMarkdown());
    console.log(resultsMarkdown());
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error("[ui-proof] failed", error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
```

