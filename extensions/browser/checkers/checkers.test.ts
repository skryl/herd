import { describe, expect, it } from 'vitest';

import { CHECKERS_FULL_GAME_SEQUENCE } from '../../../tests/browser-game-scenarios';
import {
  click,
  joinGame,
  openGamePage,
  playCheckersMove,
  readBoardCell,
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

describe('checkers', () => {
  it('plays a full deterministic match through visible controls only', async () => {
    await withBrowserContext(async (context) => {
      const roomId = nextRoomId('shared-checkers');
      const redPage = await openGamePage(context, 'extensions/browser/checkers/index.html');
      const blackPage = await openGamePage(context, 'extensions/browser/checkers/index.html');

      await joinGame(redPage, { roomId, seat: 'red', name: 'Red', seed: roomId });
      await joinGame(blackPage, { roomId, seat: 'black', name: 'Black', seed: roomId });
      await waitForTexts(redPage, '#players .player-card', (players) =>
        players.includes('red: Red') && players.includes('black: Black'),
      );

      await click(redPage, '#start');
      await waitForText(redPage, '#status', (value) => value === 'Red to move', 15_000);
      await waitForText(blackPage, '#status', (value) => value === 'Red to move', 15_000);

      for (let index = 0; index < CHECKERS_FULL_GAME_SEQUENCE.length; index += 1) {
        const move = CHECKERS_FULL_GAME_SEQUENCE[index];
        const page = move.seat === 'red' ? redPage : blackPage;
        await playCheckersMove(page, move.from, move.to);

        if (index === 21) {
          await waitForText(redPage, '#status', (value) => value === 'Red must continue capturing', 15_000);
        }
        if (index === 30) {
          await waitForText(redPage, '#status', (value) => value === 'Black to move', 15_000);
          expect(await readBoardCell(redPage, 0, 3)).toBe('R');
        }
      }

      await waitForText(blackPage, '#winner', (value) => value === 'Winner: red', 20_000);
      expect(await waitForText(redPage, '#winner', (value) => value === 'Winner: red', 20_000)).toBe('Winner: red');
      expect(await readBoardCell(redPage, 3, 0)).toBe('r');
    });
  }, 60_000);

  it('does not mark the room abandoned when the host tab stays alive in the background', async () => {
    await withBrowserContext(async (context) => {
      const roomId = nextRoomId('background-host-checkers');
      const redPage = await openGamePage(context, 'extensions/browser/checkers/index.html');
      const blackPage = await openGamePage(context, 'extensions/browser/checkers/index.html');

      await joinGame(redPage, { roomId, seat: 'red', name: 'Red', seed: roomId });
      await joinGame(blackPage, { roomId, seat: 'black', name: 'Black', seed: roomId });
      await waitForTexts(redPage, '#players .player-card', (players) =>
        players.includes('red: Red') && players.includes('black: Black'),
      );

      await click(redPage, '#start');
      await waitForText(redPage, '#status', (value) => value === 'Red to move', 15_000);
      await playCheckersMove(redPage, [5, 0], [4, 1]);

      await blackPage.bringToFront();
      await blackPage.waitForTimeout(6_000);

      expect(await waitForText(blackPage, '#status', (value) => value === 'Black to move', 15_000)).toBe('Black to move');
      expect(await textContent(blackPage, '#winner')).toBe('');
    });
  }, 30_000);
});
