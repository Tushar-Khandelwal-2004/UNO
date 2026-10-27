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
