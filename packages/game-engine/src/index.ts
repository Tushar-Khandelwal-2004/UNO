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

export interface GameSettings {
  startingHand: number;
  turnSeconds: 0 | 15 | 30 | 45 | 60;
  stackDrawCards: boolean;
  unoPenaltyCards: 2 | 4;
  drawUntilPlayable: boolean;
  sevenZero: boolean;
}

export const DEFAULT_GAME_SETTINGS: GameSettings = {
  startingHand: 7,
  turnSeconds: 30,
  stackDrawCards: false,
  unoPenaltyCards: 4,
  drawUntilPlayable: false,
  sevenZero: false,
};

export interface GameState {
  status: "playing" | "finished";
  rulesetVersion: string;
  settings: GameSettings;
  players: GamePlayer[];
  drawPile: Card[];
  discardPile: Card[];
  currentColor: CardColor;
  currentPlayerIndex: number;
  direction: 1 | -1;
  drewThisTurn: boolean;
  pendingDraw?: number;
  pendingSwapPlayerId?: string;
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
  awaitingSwap?: boolean;
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

function normalizeSettings(settings: Partial<GameSettings> = {}): GameSettings {
  return { ...DEFAULT_GAME_SETTINGS, ...settings };
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
  options: { random?: () => number; rulesetVersion?: string; settings?: Partial<GameSettings> } = {},
): GameState {
  if (players.length < 2 || players.length > 8) throw new Error("A game requires between 2 and 8 players");
  const random = options.random ?? Math.random;
  const settings = normalizeSettings(options.settings);
  let drawPile = shuffle(createDeck(), random);
  const gamePlayers: GamePlayer[] = players.map((player) => ({ ...player, hand: [] }));

  for (let cardIndex = 0; cardIndex < settings.startingHand; cardIndex += 1) {
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
    settings,
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

export function canPlay(card: Card, topCard: Card, currentColor: CardColor, settings: Partial<GameSettings> = {}): boolean {
  const resolved = normalizeSettings(settings);
  if (resolved.stackDrawCards && topCard.kind === "draw2") return card.kind === "draw2";
  if (resolved.stackDrawCards && topCard.kind === "wildDraw4") return card.kind === "wildDraw4";
  return card.color === "wild" || card.color === currentColor || card.kind === topCard.kind && card.value === topCard.value;
}

export function isPlayable(card: Card, state: GameState): boolean {
  const topCard = state.discardPile[state.discardPile.length - 1];
  return Boolean(topCard && canPlay(card, topCard, state.currentColor, state.pendingDraw ? state.settings : { ...state.settings, stackDrawCards: false }));
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

function takeCards(state: GameState, player: GamePlayer, count: number): Card[] {
  refillDrawPile(state, count);
  const drawn: Card[] = [];
  for (let index = 0; index < count; index += 1) {
    const card = state.drawPile.pop();
    if (!card) throw new Error("There are no cards left to draw");
    player.hand.push(card);
    drawn.push(card);
  }
  return drawn;
}

export function drawOne(state: GameState, playerId: string): Card {
  if (state.status !== "playing") throw new Error("The game has finished");
  if (state.pendingSwapPlayerId) throw new Error("Choose a player to swap hands first");
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error("Player does not exist");
  if (getCurrentPlayer(state).id !== playerId) throw new Error("It is not this player's turn");
  if (state.drewThisTurn) throw new Error("You may draw only once per turn");

  if (state.pendingDraw) {
    const amount = state.pendingDraw;
    takeCards(state, player, amount);
    state.pendingDraw = undefined;
    advanceTurn(state);
    state.version += 1;
    return player.hand[player.hand.length - 1]!;
  }

  let lastCard: Card | undefined;
  do {
    lastCard = takeCards(state, player, 1)[0];
  } while (state.settings.drawUntilPlayable && lastCard && !isPlayable(lastCard, state));

  if (!lastCard) throw new Error("There are no cards left to draw");
  state.drewThisTurn = true;
  if (!isPlayable(lastCard, state)) advanceTurn(state);
  state.version += 1;
  return lastCard;
}

export function passTurn(state: GameState, playerId: string): void {
  if (state.status !== "playing") throw new Error("The game has finished");
  if (state.pendingSwapPlayerId) throw new Error("Choose a player to swap hands first");
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
  const drawn = takeCards(state, player, amount);
  state.version += 1;
  return drawn;
}

function rotateHands(state: GameState): void {
  const hands = state.players.map((player) => player.hand);
  for (let index = 0; index < state.players.length; index += 1) {
    const source = (index - state.direction + state.players.length) % state.players.length;
    state.players[index]!.hand = hands[source]!;
  }
}

export function swapHands(state: GameState, playerId: string, targetPlayerId: string): void {
  if (state.pendingSwapPlayerId !== playerId) throw new Error("This player is not choosing a hand swap");
  const player = state.players.find((candidate) => candidate.id === playerId);
  const target = state.players.find((candidate) => candidate.id === targetPlayerId);
  if (!player || !target) throw new Error("Swap target does not exist");
  if (player.id === target.id) throw new Error("You cannot swap hands with yourself");
  [player.hand, target.hand] = [target.hand, player.hand];
  state.pendingSwapPlayerId = undefined;
  advanceTurn(state);
  state.version += 1;
}

export function removePlayer(state: GameState, playerId: string): void {
  const removedIndex = state.players.findIndex((player) => player.id === playerId);
  if (removedIndex < 0) throw new Error("Player does not exist");
  const removed = state.players[removedIndex]!;
  state.discardPile.push(...removed.hand);
  state.players.splice(removedIndex, 1);
  if (state.players.length < 2) {
    state.status = "finished";
    state.winnerId = state.players[0]?.id;
    state.currentPlayerIndex = 0;
    state.pendingSwapPlayerId = undefined;
    state.pendingDraw = undefined;
    return;
  }
  if (state.pendingSwapPlayerId === playerId) state.pendingSwapPlayerId = undefined;
  if (removedIndex < state.currentPlayerIndex) state.currentPlayerIndex -= 1;
  if (state.currentPlayerIndex >= state.players.length) state.currentPlayerIndex = 0;
  state.version += 1;
}

export function playCard(
  state: GameState,
  playerId: string,
  cardId: string,
  chosenColor?: Exclude<CardColor, "wild">,
): MoveResult {
  if (state.status !== "playing") throw new Error("The game has finished");
  if (state.pendingSwapPlayerId) throw new Error("Choose a player to swap hands first");
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
  const skippedIndex = card.kind === "skip" || penaltyAmount !== undefined || card.kind === "reverse" && state.players.length === 2 ? nextIndex(state) : undefined;
  const skippedPlayerId = skippedIndex === undefined ? undefined : state.players[skippedIndex]?.id;
  const penaltyPlayerId = penaltyAmount === undefined ? undefined : skippedPlayerId;

  if (player.hand.length === 0) {
    state.status = "finished";
    state.winnerId = player.id;
    state.drewThisTurn = false;
  } else if (card.kind === "number" && card.value === 7 && state.settings.sevenZero) {
    state.pendingSwapPlayerId = player.id;
    state.drewThisTurn = false;
  } else {
    if (card.kind === "number" && card.value === 0 && state.settings.sevenZero) rotateHands(state);
    if (card.kind === "reverse") state.direction = state.direction === 1 ? -1 : 1;
    if (penaltyAmount !== undefined && state.settings.stackDrawCards) {
      state.pendingDraw = (state.pendingDraw ?? 0) + penaltyAmount;
      advanceTurn(state);
    } else {
      if (penaltyAmount !== undefined && penaltyPlayerId) drawCards(state, penaltyPlayerId, penaltyAmount);
      const steps = card.kind === "skip" || penaltyAmount !== undefined || card.kind === "reverse" && state.players.length === 2 ? 2 : 1;
      state.currentPlayerIndex = nextIndex(state, steps);
      state.drewThisTurn = false;
    }
  }

  state.version += 1;
  return {
    state,
    playedCard: card,
    nextPlayerId: state.status === "playing" && !state.pendingSwapPlayerId ? getCurrentPlayer(state).id : undefined,
    penaltyPlayerId: state.settings.stackDrawCards ? undefined : penaltyPlayerId,
    penaltyAmount: state.settings.stackDrawCards ? undefined : penaltyAmount,
    skippedPlayerId,
    awaitingSwap: Boolean(state.pendingSwapPlayerId),
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
  pendingDraw?: number;
  pendingSwapPlayerId?: string;
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
    pendingDraw: state.pendingDraw,
    pendingSwapPlayerId: state.pendingSwapPlayerId,
    turnEndsAt: metadata.turnEndsAt,
    serverTime: metadata.serverTime ?? Date.now(),
    unoWindow: metadata.unoWindow,
  };
}
