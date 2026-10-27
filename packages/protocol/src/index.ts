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
