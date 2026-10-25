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
  version: number;
  winnerId?: string;
}

export interface MoveResult {
  state: GameState;
  playedCard: Card;
  nextPlayerId?: string;
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

export function createDeck(): Card[] {
  const cards: Card[] = [];
  let id = 0;

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
  const drawPile = shuffle(createDeck(), random);
  const gamePlayers: GamePlayer[] = players.map((player) => ({ ...player, hand: [] }));

  for (let cardIndex = 0; cardIndex < 7; cardIndex += 1) {
    for (const player of gamePlayers) {
      const card = drawPile.pop();
      if (!card) throw new Error("Deck ran out while dealing");
      player.hand.push(card);
    }
  }

  let firstCard = drawPile.pop();
  while (firstCard?.color === "wild") {
    drawPile.unshift(firstCard);
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

function refillDrawPile(state: GameState): void {
  if (state.drawPile.length > 0 || state.discardPile.length <= 1) return;
  const topCard = state.discardPile[state.discardPile.length - 1];
  const recycled = state.discardPile.slice(0, -1).map((card) => ({
    ...card,
    ...(card.color === "wild" ? { color: "wild" as const } : {}),
  }));
  state.discardPile = topCard ? [topCard] : [];
  state.drawPile = shuffle(recycled, Math.random);
}

export function drawOne(state: GameState, playerId: string): Card {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error("Player does not exist");
  if (getCurrentPlayer(state).id !== playerId) throw new Error("It is not this player's turn");

  refillDrawPile(state);
  const card = state.drawPile.pop();
  if (!card) throw new Error("There are no cards left to draw");
  player.hand.push(card);
  if (!isPlayable(card, state)) {
    state.currentPlayerIndex = nextIndex(state);
  }
  state.version += 1;
  return card;
}

export function drawCards(state: GameState, playerId: string, count: number): Card[] {
  const player = state.players.find((candidate) => candidate.id === playerId);
  if (!player) throw new Error("Player does not exist");
  if (count < 1) return [];

  const drawn: Card[] = [];
  for (let index = 0; index < count; index += 1) {
    refillDrawPile(state);
    const card = state.drawPile.pop();
    if (!card) break;
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

  if (player.hand.length === 0) {
    state.status = "finished";
    state.winnerId = player.id;
  } else {
    if (card.kind === "reverse") state.direction = state.direction === 1 ? -1 : 1;
    const steps = card.kind === "skip" || card.kind === "wildDraw4" || card.kind === "draw2" ? 2 : 1;
    state.currentPlayerIndex = nextIndex(state, steps);
  }

  state.version += 1;
  return {
    state,
    playedCard: card,
    nextPlayerId: state.status === "playing" ? getCurrentPlayer(state).id : undefined,
  };
}

export function publicGameState(state: GameState, turnEndsAt?: number): Pick<GameState, "status" | "currentColor" | "version" | "winnerId"> & {
  currentPlayerId: string;
  topCard: Card;
  drawPileCount: number;
  direction?: 1 | -1;
  turnEndsAt?: number;
} {
  const currentPlayer = getCurrentPlayer(state);
  const topCard = state.discardPile[state.discardPile.length - 1];
  if (!topCard) throw new Error("Game has no top card");
  return {
    status: state.status,
    currentColor: state.currentColor,
    version: state.version,
    winnerId: state.winnerId,
    currentPlayerId: currentPlayer.id,
    topCard,
    drawPileCount: state.drawPile.length,
    direction: state.direction,
    turnEndsAt,
  };
}
