import { describe, expect, it } from 'vitest';

import {
  click,
  joinGame,
  openGamePage,
  waitForText,
  waitForTexts,
  withBrowserContext,
} from '../../../tests/browser-game-helpers';

let roomSequence = 0;

function nextRoomId(prefix: string) {
  roomSequence += 1;
  return `${prefix}-${roomSequence}`;
}

describe('draw poker', () => {
  it('plays a full four-player hand through visible controls only', async () => {
    await withBrowserContext(async (context) => {
      const roomId = nextRoomId('shared-poker');
      const pages = await Promise.all([
        openGamePage(context, 'extensions/browser/draw-poker/index.html'),
        openGamePage(context, 'extensions/browser/draw-poker/index.html'),
        openGamePage(context, 'extensions/browser/draw-poker/index.html'),
        openGamePage(context, 'extensions/browser/draw-poker/index.html'),
      ]);

      await joinGame(pages[0], { roomId, seat: 'north', name: 'North', seed: roomId });
      await joinGame(pages[1], { roomId, seat: 'east', name: 'East', seed: roomId });
      await joinGame(pages[2], { roomId, seat: 'south', name: 'South', seed: roomId });
      await joinGame(pages[3], { roomId, seat: 'west', name: 'West', seed: roomId });
      await waitForTexts(pages[0], '#players .player-card', (players) =>
        players.length === 4 && players.every((entry) => !entry.endsWith(': open')),
      );

      await click(pages[0], '#start');
      await waitForText(pages[0], '#status', (value) => value.includes('north'), 15_000);

      await click(pages[0], '#action-raise');
      await click(pages[1], '#action-fold');
      await click(pages[2], '#action-fold');
      await click(pages[3], '#action-fold');

      expect(await waitForText(pages[1], '#winner', (value) => value === 'Winner: north', 20_000)).toBe('Winner: north');
      expect(await waitForText(pages[0], '#winner', (value) => value === 'Winner: north', 20_000)).toBe('Winner: north');
    });
  }, 30_000);
});
