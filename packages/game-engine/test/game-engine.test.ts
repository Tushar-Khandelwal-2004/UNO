import { describe, expect, it } from "vitest";
import { canPlay, createGame, createDeck, isPlayable, playCard } from "../src/index.js";

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
});
