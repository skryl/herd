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

describe('pong', () => {
  it('plays a full deterministic match through visible controls only', async () => {
    await withBrowserContext(async (context) => {
      const roomId = nextRoomId('shared-pong');
      const leftPage = await openGamePage(context, 'extensions/browser/pong/index.html');
      const rightPage = await openGamePage(context, 'extensions/browser/pong/index.html');

      await joinGame(leftPage, { roomId, seat: 'left', name: 'Left', seed: roomId });
      await joinGame(rightPage, { roomId, seat: 'right', name: 'Right', seed: roomId });
      await waitForTexts(leftPage, '#players .player-card', (players) =>
        players.includes('left: Left') && players.includes('right: Right'),
      );

      await click(leftPage, '#start');
      await waitForText(leftPage, '#status', (value) => value.includes('left') || value.includes('right'), 15_000);
      await click(leftPage, '#intent-up');
      await click(leftPage, '#intent-stop');
      await click(rightPage, '#intent-stop');

      expect(await waitForText(rightPage, '#winner', (value) => value === 'Winner: left', 30_000)).toBe('Winner: left');
      expect(await waitForText(leftPage, '#winner', (value) => value === 'Winner: left', 30_000)).toBe('Winner: left');
    });
  }, 45_000);
});
