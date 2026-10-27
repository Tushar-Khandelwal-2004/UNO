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
