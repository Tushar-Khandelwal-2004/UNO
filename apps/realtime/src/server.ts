import cors from "@fastify/cors";
import Fastify from "fastify";
import { Server, type Socket } from "socket.io";
import {
  createGame,
  drawCards,
  drawOne,
  playCard,
  publicGameState,
  type GameState,
} from "@uno/game-engine";
import {
  createRoomSchema,
  joinRoomSchema,
  callUnoSchema,
  reactionSchema,
  transferHostSchema,
  type PublicPlayer,
  type PublicRoom,
} from "@uno/protocol";

const PORT = Number(process.env.PORT ?? 4000);
const MAX_PLAYERS = 8;
const ROOM_RETENTION_MS = 5 * 60 * 1000;
const HOST_DISCONNECT_GRACE_MS = 5_000;
const TURN_SECONDS = 30;

type RoomPlayer = {
  id: string;
  socketId: string;
  displayName: string;
  connected: boolean;
  unoCalled: boolean;
  reaction?: string;
};

type Room = {
  code: string;
  status: PublicRoom["status"];
  hostId: string;
  players: RoomPlayer[];
  game?: GameState;
  cleanupTimer?: NodeJS.Timeout;
  hostTransferTimer?: NodeJS.Timeout;
};

type Ack = (result: { ok: true; room: PublicRoom } | { ok: false; code: string; message: string }) => void;

const app = Fastify({ logger: true });
const io = new Server(app.server, {
  cors: {
    origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
    credentials: true,
  },
});

const rooms = new Map<string, Room>();
const socketRooms = new Map<string, string>();

await app.register(cors, {
  origin: process.env.WEB_ORIGIN ?? "http://localhost:3000",
  credentials: true,
});

app.get("/health", async () => ({ ok: true, rooms: rooms.size }));

function randomRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function guestId(socket: Socket): string {
  const value = socket.handshake.auth?.guestId;
  return typeof value === "string" && value.length >= 8 ? value : socket.id;
}

function errorAck(ack: Ack, code: string, message: string): void {
  ack({ ok: false, code, message });
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
    turnSeconds: TURN_SECONDS,
    game: room.game ? publicGameState(room.game) : undefined,
  };
}

function emitRoom(room: Room): void {
  io.to(room.code).emit("room:state", publicRoom(room));
  for (const player of room.players) {
    const socket = io.sockets.sockets.get(player.socketId);
    if (socket && room.game) {
      const hand = room.game.players.find((gamePlayer) => gamePlayer.id === player.id)?.hand ?? [];
      socket.emit("player:hand", hand);
    }
  }
}

function clearRoomTimers(room: Room): void {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  if (room.hostTransferTimer) clearTimeout(room.hostTransferTimer);
}

function scheduleCleanup(room: Room): void {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    clearRoomTimers(room);
    rooms.delete(room.code);
  }, ROOM_RETENTION_MS);
}

function transferHost(room: Room): void {
  const candidates = room.players.filter((player) => player.id !== room.hostId);
  const nextHost = candidates[Math.floor(Math.random() * candidates.length)];
  if (!nextHost) {
    scheduleCleanup(room);
    return;
  }
  room.hostId = nextHost.id;
  room.hostTransferTimer = undefined;
  emitRoom(room);
}

function scheduleHostTransfer(room: Room): void {
  if (room.hostTransferTimer) clearTimeout(room.hostTransferTimer);
  room.hostTransferTimer = setTimeout(() => {
    const host = roomPlayer(room, room.hostId);
    if (!host?.connected) transferHost(room);
  }, HOST_DISCONNECT_GRACE_MS);
}

function joinSocketToRoom(socket: Socket, room: Room, player: RoomPlayer): void {
  socket.join(room.code);
  socketRooms.set(socket.id, room.code);
  player.socketId = socket.id;
  player.connected = true;
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = undefined;
  }
  if (room.hostTransferTimer && player.id === room.hostId) {
    clearTimeout(room.hostTransferTimer);
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
  };
  rooms.set(room.code, room);
  joinSocketToRoom(socket, room, room.players[0]!);
  return room;
}

function ensureRoomPlayer(socket: Socket, room: Room): RoomPlayer | undefined {
  return roomPlayer(room, guestId(socket));
}

io.on("connection", (socket) => {
  socket.on("room:create", (payload: unknown, ack: Ack) => {
    const parsed = createRoomSchema.safeParse(payload);
    if (!parsed.success) return errorAck(ack, "INVALID_INPUT", "Enter a valid display name.");
    const room = createRoom(socket, parsed.data.displayName);
    ack({ ok: true, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("room:join", (payload: unknown, ack: Ack) => {
    const parsed = joinRoomSchema.safeParse(payload);
    if (!parsed.success) return errorAck(ack, "INVALID_INPUT", "Enter a six-character room code and display name.");

    const room = rooms.get(parsed.data.roomCode);
    if (!room) return errorAck(ack, "ROOM_NOT_FOUND", "That room does not exist or has expired.");
    if (room.status !== "open") return errorAck(ack, "ROOM_NOT_READY", "This room is no longer accepting players.");

    const existing = ensureRoomPlayer(socket, room);
    if (existing) {
      joinSocketToRoom(socket, room, existing);
      ack({ ok: true, room: publicRoom(room) });
      emitRoom(room);
      return;
    }

    if (room.players.length >= MAX_PLAYERS) return errorAck(ack, "ROOM_FULL", "This room is full.");
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
    ack({ ok: true, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("room:start", (ack: Ack) => {
    const room = roomForSocket(socket);
    if (!room) return errorAck(ack, "NOT_IN_ROOM", "Join a room first.");
    const player = ensureRoomPlayer(socket, room);
    if (!player || player.id !== room.hostId) return errorAck(ack, "NOT_HOST", "Only the host can start the match.");
    if (room.players.length < 2) return errorAck(ack, "ROOM_NOT_READY", "At least two players are required.");

    room.status = "in_game";
    room.game = createGame(room.players.map(({ id, displayName }) => ({ id, displayName })));
    ack({ ok: true, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("room:transfer-host", (payload: unknown, ack: Ack) => {
    const room = roomForSocket(socket);
    if (!room) return errorAck(ack, "NOT_IN_ROOM", "Join a room first.");
    const player = ensureRoomPlayer(socket, room);
    const parsed = transferHostSchema.safeParse(payload);
    if (!player || player.id !== room.hostId) return errorAck(ack, "NOT_HOST", "Only the host can transfer ownership.");
    if (!parsed.success || !roomPlayer(room, parsed.data.playerId)) {
      return errorAck(ack, "INVALID_INPUT", "Choose a player in this room.");
    }
    room.hostId = parsed.data.playerId;
    emitRoom(room);
    ack({ ok: true, room: publicRoom(room) });
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
      playCard(room.game, player.id, cardId, chosenColor as "red" | "yellow" | "green" | "blue" | undefined);
      player.unoCalled = false;
      room.status = room.game.status === "finished" ? "finished" : "in_game";
      ack({ ok: true, room: publicRoom(room) });
      emitRoom(room);
      if (room.status === "finished") scheduleCleanup(room);
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
      drawOne(room.game, player.id);
      player.unoCalled = false;
      ack({ ok: true, room: publicRoom(room) });
      emitRoom(room);
    } catch (error) {
      errorAck(ack, "INVALID_MOVE", error instanceof Error ? error.message : "You cannot draw right now.");
    }
  });

  socket.on("game:call-uno", (payload: unknown, ack: Ack) => {
    const room = roomForSocket(socket);
    if (!room?.game) return errorAck(ack, "ROOM_NOT_READY", "The match has not started.");
    const caller = ensureRoomPlayer(socket, room);
    const parsed = callUnoSchema.safeParse(payload);
    if (!caller || !parsed.success) return errorAck(ack, "INVALID_INPUT", "Choose a player to call UNO on.");

    const target = roomPlayer(room, parsed.data.targetPlayerId);
    const targetGamePlayer = room.game.players.find((candidate) => candidate.id === parsed.data.targetPlayerId);
    if (!target || !targetGamePlayer) return errorAck(ack, "INVALID_INPUT", "That player is not in this match.");

    if (target.id === caller.id) {
      if (targetGamePlayer.hand.length !== 1) return errorAck(ack, "INVALID_MOVE", "You can call UNO when you have one card left.");
      target.unoCalled = true;
    } else {
      if (targetGamePlayer.hand.length !== 1 || target.unoCalled) {
        return errorAck(ack, "INVALID_MOVE", `${target.displayName} already called UNO or does not have one card.`);
      }
      drawCards(room.game, target.id, 2);
      target.reaction = "didn't-call-uno";
      setTimeout(() => {
        if (target.reaction === "didn't-call-uno") {
          target.reaction = undefined;
          emitRoom(room);
        }
      }, 3_000);
    }

    room.game.version += 1;
    ack({ ok: true, room: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("player:reaction", (payload: unknown, ack: Ack) => {
    const room = roomForSocket(socket);
    if (!room) return errorAck(ack, "NOT_IN_ROOM", "Join a room first.");
    const player = ensureRoomPlayer(socket, room);
    const parsed = reactionSchema.safeParse(payload);
    if (!player || !parsed.success) return errorAck(ack, "INVALID_INPUT", "That reaction is not available.");
    player.reaction = parsed.data.messageId;
    emitRoom(room);
    setTimeout(() => {
      if (player.reaction === parsed.data.messageId) {
        player.reaction = undefined;
        emitRoom(room);
      }
    }, 3_000);
    ack({ ok: true, room: publicRoom(room) });
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

await app.listen({ port: PORT, host: "0.0.0.0" });
app.log.info(`UNO realtime server listening on http://localhost:${PORT}`);
