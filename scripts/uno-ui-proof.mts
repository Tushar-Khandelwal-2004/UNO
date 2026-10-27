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
