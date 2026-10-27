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

export const targetPlayerSchema = z.object({
  targetPlayerId: z.string().min(1),
}).strict();

export const roomSettingsSchema = z.object({
  startingHand: z.number().int().min(5).max(10).optional(),
  turnSeconds: z.union([z.literal(0), z.literal(15), z.literal(30), z.literal(45), z.literal(60)]).optional(),
  stackDrawCards: z.boolean().optional(),
  unoPenaltyCards: z.union([z.literal(2), z.literal(4)]).optional(),
  drawUntilPlayable: z.boolean().optional(),
  sevenZero: z.boolean().optional(),
}).strict();

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
export type TargetPlayerInput = z.infer<typeof targetPlayerSchema>;
export type RoomSettings = {
  startingHand: number;
  turnSeconds: 0 | 15 | 30 | 45 | 60;
  stackDrawCards: boolean;
  unoPenaltyCards: 2 | 4;
  drawUntilPlayable: boolean;
  sevenZero: boolean;
};
export type RoomSettingsPatch = z.infer<typeof roomSettingsSchema>;
export interface KickedPayload {
  roomCode: string;
  reason: string;
}
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
  settings: RoomSettings;
  turnSeconds: RoomSettings["turnSeconds"];
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
      pendingDraw?: number;
      pendingSwapPlayerId?: string;
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
