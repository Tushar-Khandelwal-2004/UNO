import { describe, expect, it } from "vitest";
import { createGame, createDeck, isPlayable, playCard } from "../src/index.js";

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
});
