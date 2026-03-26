import { describe, expect, it } from 'vitest';

import {
  click,
  joinGame,
  openGamePage,
  textContent,
  waitForText,
  waitForTexts,
  withBrowserContext,
} from '../../../tests/browser-game-helpers';

let roomSequence = 0;

function nextRoomId(prefix: string) {
  roomSequence += 1;
  return `${prefix}-${roomSequence}`;
}

describe('snake arena', () => {
  it('plays a full round through visible controls only', async () => {
    await withBrowserContext(async (context) => {
      const roomId = nextRoomId('shared-snake');
      const pages = await Promise.all([
        openGamePage(context, 'extensions/browser/snake-arena/index.html'),
        openGamePage(context, 'extensions/browser/snake-arena/index.html'),
        openGamePage(context, 'extensions/browser/snake-arena/index.html'),
        openGamePage(context, 'extensions/browser/snake-arena/index.html'),
      ]);

      await joinGame(pages[0], { roomId, seat: 'north', name: 'North', seed: roomId });
      await joinGame(pages[1], { roomId, seat: 'east', name: 'East', seed: roomId });
      await joinGame(pages[2], { roomId, seat: 'south', name: 'South', seed: roomId });
      await joinGame(pages[3], { roomId, seat: 'west', name: 'West', seed: roomId });
      await waitForTexts(pages[0], '#players .player-card', (players) =>
        players.length === 4 && players.every((entry) => !entry.endsWith(': open')),
      );

      await click(pages[0], '#start');
      const initialArena = await textContent(pages[0], '#arena');
      await click(pages[1], '#direction-up');
      await click(pages[2], '#direction-right');
      await click(pages[3], '#direction-down');
      await waitForText(pages[0], '#arena', (value) => value !== initialArena, 15_000);

      expect(await waitForText(pages[3], '#winner', (value) => value === 'Winner: north', 20_000)).toBe('Winner: north');
      expect(await waitForText(pages[0], '#winner', (value) => value === 'Winner: north', 20_000)).toBe('Winner: north');
    });
  }, 30_000);
});
