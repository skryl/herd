import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type BrowserContext, type Page } from 'playwright';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface JoinGameOptions {
  roomId: string;
  name: string;
  seat: string;
  seed?: string;
}

export function gameFileUrl(relativePath: string): string {
  return `file://${path.join(ROOT_DIR, relativePath)}`;
}

export async function withBrowserContext<T>(
  run: (context: BrowserContext) => Promise<T>,
): Promise<T> {
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'herd-browser-game-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
  });
  try {
    return await run(context);
  } finally {
    await context.close();
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
}

export async function openGamePage(context: BrowserContext, relativePath: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(gameFileUrl(relativePath));
  await page.locator('#join').waitFor({ state: 'visible' });
  await page.locator('#status').waitFor({ state: 'visible' });
  return page;
}

export async function typeInto(page: Page, selector: string, value: string): Promise<void> {
  const locator = page.locator(selector);
  await locator.waitFor({ state: 'visible' });
  await locator.fill(value);
}

export async function selectValue(page: Page, selector: string, value: string): Promise<void> {
  const locator = page.locator(selector);
  await locator.waitFor({ state: 'visible' });
  await locator.selectOption(value);
}

export async function click(page: Page, selector: string): Promise<void> {
  const locator = page.locator(selector);
  await locator.waitFor({ state: 'visible' });
  await locator.click();
}

export async function textContent(page: Page, selector: string): Promise<string> {
  const locator = page.locator(selector);
  await locator.waitFor({ state: 'attached' });
  return (await locator.textContent()) ?? '';
}

export async function allTextContents(page: Page, selector: string): Promise<string[]> {
  const locator = page.locator(selector);
  const count = await locator.count();
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(((await locator.nth(index).textContent()) ?? '').trim());
  }
  return values;
}

export async function waitForText(
  page: Page,
  selector: string,
  predicate: (value: string) => boolean,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastValue = '';
  while (Date.now() <= deadline) {
    lastValue = (await textContent(page, selector)).trim();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for ${selector}: ${JSON.stringify(lastValue)}`);
}

export async function waitForTexts(
  page: Page,
  selector: string,
  predicate: (value: string[]) => boolean,
  timeoutMs = 10_000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: string[] = [];
  while (Date.now() <= deadline) {
    lastValue = await allTextContents(page, selector);
    if (predicate(lastValue)) {
      return lastValue;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for ${selector}: ${JSON.stringify(lastValue)}`);
}

export async function joinGame(page: Page, options: JoinGameOptions): Promise<void> {
  await typeInto(page, '#room-id', options.roomId);
  await typeInto(page, '#player-name', options.name);
  await selectValue(page, '#seat', options.seat);
  await typeInto(page, '#seed', options.seed ?? options.roomId);
  await click(page, '#join');
}

export async function playCheckersMove(
  page: Page,
  from: readonly [number, number],
  to: readonly [number, number],
): Promise<void> {
  await click(page, `[data-cell="${from[0]}-${from[1]}"]`);
  await click(page, `[data-cell="${to[0]}-${to[1]}"]`);
}

export async function readBoardCell(
  page: Page,
  row: number,
  col: number,
): Promise<string> {
  return textContent(page, `[data-cell="${row}-${col}"]`);
}
