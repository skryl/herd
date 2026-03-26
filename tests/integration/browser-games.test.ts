import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CHECKERS_DOM_CHECKPOINTS, CHECKERS_FULL_GAME_SEQUENCE } from '../browser-game-scenarios';
import { attachFixtureRootAgent, attachFixtureWorkerByTitle, type FixtureRootContext, type FixtureWorkerContext } from './fixture-agents';
import { createIsolatedTab } from './helpers';
import { startIntegrationRuntime, type HerdIntegrationRuntime } from './runtime';

interface RunningWorker {
  controller: {
    waitForCompletion: () => Promise<void>;
    close: () => void;
    agent: { agent_id: string };
  };
}

let roomSequence = 0;
const roomRunId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function uniqueRoomId(prefix: string) {
  roomSequence += 1;
  return `${prefix}-${roomRunId}-${roomSequence}`;
}

function workerTitle(gameName: string, seat: string) {
  return `${gameName}-${seat}-worker`;
}

function browserTitle(gameName: string, seat: string) {
  return `${gameName}-${seat}-browser`;
}

function capitalize(value: string) {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

async function waitForWorkerCompletions(workers: Record<string, Promise<RunningWorker>>) {
  const handles = await Promise.all(Object.values(workers));
  await Promise.all(handles.map((worker) => worker.controller.waitForCompletion()));
  handles.forEach((worker) => worker.controller.close());
}

async function joinLobby(
  worker: FixtureWorkerContext,
  browser: string,
  roomId: string,
  seat: string,
  name: string,
) {
  await worker.browserType(browser, '#room-id', roomId);
  await worker.browserType(browser, '#player-name', name);
  await worker.browserSelect(browser, '#seat', seat);
  await worker.browserType(browser, '#seed', roomId);
  await worker.browserClick(browser, '#join');
}

async function clickCheckersMove(
  worker: FixtureWorkerContext,
  browser: string,
  from: readonly [number, number],
  to: readonly [number, number],
) {
  await worker.browserClick(browser, `[data-cell="${from[0]}-${from[1]}"]`);
  await worker.browserClick(browser, `[data-cell="${to[0]}-${to[1]}"]`);
}

function checkersCellSelector(row: number, col: number) {
  return `[data-cell="${row}-${col}"]`;
}

async function waitForCheckersMoveApplied(
  ctx: FixtureRootContext,
  browserTileId: string,
  moveNumber: number,
  from: readonly [number, number],
  to: readonly [number, number],
) {
  await ctx.waitForBrowserText(
    browserTileId,
    `checkers move ${moveNumber} source cleared`,
    checkersCellSelector(from[0], from[1]),
    (value) => value === '',
    30_000,
  );
  await ctx.waitForBrowserText(
    browserTileId,
    `checkers move ${moveNumber} destination filled`,
    checkersCellSelector(to[0], to[1]),
    (value) => value.length > 0,
    30_000,
  );
}

async function assertCheckersCheckpoint(
  ctx: FixtureRootContext,
  browserTileId: string,
  moveNumber: number,
) {
  const checkpoint = CHECKERS_DOM_CHECKPOINTS.find((entry) => entry.moveNumber === moveNumber);
  if (!checkpoint) {
    return;
  }

  expect(
    await ctx.waitForBrowserText(
      browserTileId,
      `checkers status after move ${moveNumber}`,
      '#status',
      (value) => value === checkpoint.status,
      30_000,
    ),
  ).toBe(checkpoint.status);

  for (const cell of checkpoint.cells) {
    expect(
      await ctx.browserText(browserTileId, checkersCellSelector(cell.row, cell.col)),
      `unexpected board state after checkers move ${moveNumber} at ${cell.row}-${cell.col}`,
    ).toBe(cell.value);
  }
}

function createCheckersWorkerScript(
  seat: 'red' | 'black',
  roomId: string,
  browser: string,
) {
  const name = capitalize(seat);
  const scriptedMoves = CHECKERS_FULL_GAME_SEQUENCE
    .map((move, index) => ({ ...move, moveNumber: index + 1 }))
    .filter((move) => move.seat === seat);
  return async (worker: FixtureWorkerContext) => {
    await worker.waitForDirectMessage('join', 120_000);
    await joinLobby(worker, browser, roomId, seat, name);
    await worker.waitForBrowserText(
      browser,
      `${seat} lobby joined`,
      '#status',
      (value) => value.startsWith('Lobby:'),
      30_000,
    );

    if (seat === 'red') {
      await worker.waitForDirectMessage('start', 120_000);
      await worker.browserClick(browser, '#start');
    }

    const turnPrefix = capitalize(seat);
    for (const move of scriptedMoves) {
      await worker.waitForDirectMessage(`move:${move.moveNumber}`, 120_000);
      await worker.waitForBrowserText(
        browser,
        `${seat} turn ${move.moveNumber}`,
        '#status',
        (value) => value.startsWith(turnPrefix),
        180_000,
      );
      await clickCheckersMove(worker, browser, move.from, move.to);
    }

    await worker.waitForBrowserText(
      browser,
      `${seat} winner observed`,
      '#winner',
      (value) => value === 'Winner: red',
      180_000,
    );
  };
}

describe.sequential('browser games scripted fixture integration', () => {
  let runtime: HerdIntegrationRuntime;

  beforeEach(async () => {
    runtime = await startIntegrationRuntime({ fixtureAgents: true });
  });

  afterEach(async () => {
    await runtime.stop();
  });

  it('plays a deterministic checkers finish through scripted fixture agents', async () => {
    const client = runtime.client;
    const roomId = uniqueRoomId('fixture-checkers-room');
    const projection = await createIsolatedTab(client, 'checkers-match');
    const sessionId = projection.active_tab_id!;
    const root = await attachFixtureRootAgent(runtime, client, sessionId);

    const workers = {
      red: attachFixtureWorkerByTitle(
        runtime,
        client,
        sessionId,
        workerTitle('checkers', 'red'),
        createCheckersWorkerScript('red', roomId, browserTitle('checkers', 'red')),
      ),
      black: attachFixtureWorkerByTitle(
        runtime,
        client,
        sessionId,
        workerTitle('checkers', 'black'),
        createCheckersWorkerScript('black', roomId, browserTitle('checkers', 'black')),
      ),
    };

    let hostBrowserTileId = '';
    const rootRun = root.controller.run(async (ctx: FixtureRootContext) => {
      const redWorker = await ctx.tileCreate('agent', {
        title: workerTitle('checkers', 'red'),
        parentSessionId: sessionId,
        parentTileId: ctx.tileId,
      });
      const blackWorker = await ctx.tileCreate('agent', {
        title: workerTitle('checkers', 'black'),
        parentSessionId: sessionId,
        parentTileId: ctx.tileId,
      });
      const redBrowser = await ctx.tileCreate('browser', {
        title: browserTitle('checkers', 'red'),
        parentSessionId: sessionId,
        parentTileId: ctx.tileId,
      });
      const blackBrowser = await ctx.tileCreate('browser', {
        title: browserTitle('checkers', 'black'),
        parentSessionId: sessionId,
        parentTileId: ctx.tileId,
      });
      hostBrowserTileId = redBrowser.tile_id;

      await ctx.browserLoad(redBrowser.tile_id, 'extensions/browser/checkers/index.html');
      await ctx.waitForBrowserReady(redBrowser.tile_id);
      await ctx.browserLoad(blackBrowser.tile_id, 'extensions/browser/checkers/index.html');
      await ctx.waitForBrowserReady(blackBrowser.tile_id);

      await ctx.networkConnect(redWorker.tile_id, 'left', redBrowser.tile_id, 'left');
      await ctx.networkConnect(blackWorker.tile_id, 'left', blackBrowser.tile_id, 'left');
      await ctx.networkConnect(redWorker.tile_id, 'top', blackWorker.tile_id, 'bottom');

      const [redHandle, blackHandle] = await Promise.all([workers.red, workers.black]);

      await ctx.messageDirect(redHandle.controller.agent.agent_id, 'join');
      await ctx.messageDirect(blackHandle.controller.agent.agent_id, 'join');
      await ctx.waitForBrowserTexts(
        hostBrowserTileId,
        'checkers players joined',
        '#players .player-card',
        (players) => players.length === 2 && players.every((entry) => !entry.endsWith(': open')),
      );

      await ctx.messageDirect(redHandle.controller.agent.agent_id, 'start');
      await ctx.waitForBrowserText(
        hostBrowserTileId,
        'checkers game starts',
        '#status',
        (value) => value === 'Red to move',
      );

      for (const [index, move] of CHECKERS_FULL_GAME_SEQUENCE.entries()) {
        const moveNumber = index + 1;
        const targetHandle = move.seat === 'red' ? redHandle : blackHandle;
        await ctx.messageDirect(targetHandle.controller.agent.agent_id, `move:${moveNumber}`);
        await waitForCheckersMoveApplied(ctx, hostBrowserTileId, moveNumber, move.from, move.to);
        await assertCheckersCheckpoint(ctx, hostBrowserTileId, moveNumber);
      }

      expect(
        await ctx.waitForBrowserText(
          hostBrowserTileId,
          'checkers winner',
          '#winner',
          (value) => value === 'Winner: red',
          240_000,
        ),
      ).toBe('Winner: red');
      expect(await ctx.browserText(hostBrowserTileId, checkersCellSelector(0, 3))).toBe('');
      expect(await ctx.browserText(hostBrowserTileId, checkersCellSelector(3, 0))).toBe('r');
    }, root.context);

    await rootRun;
    await waitForWorkerCompletions(workers);
    root.controller.close();
  }, 300_000);

  it('plays a deterministic pong match through scripted fixture agents', async () => {
    const client = runtime.client;
    const roomId = uniqueRoomId('fixture-pong-room');
    const projection = await createIsolatedTab(client, 'pong-match');
    const sessionId = projection.active_tab_id!;
    const root = await attachFixtureRootAgent(runtime, client, sessionId);

    const workers = {
      left: attachFixtureWorkerByTitle(
        runtime,
        client,
        sessionId,
        workerTitle('pong', 'left'),
        async (worker: FixtureWorkerContext) => {
          const browser = browserTitle('pong', 'left');
          await worker.waitForDirectMessage('join', 120_000);
          await joinLobby(worker, browser, roomId, 'left', 'Left');
          await worker.waitForDirectMessage('start', 120_000);
          await worker.browserClick(browser, '#start');
          await worker.waitForDirectMessage('play', 120_000);
          await worker.browserClick(browser, '#intent-up');
          await worker.browserClick(browser, '#intent-stop');
          await worker.waitForBrowserText(browser, 'left pong winner', '#winner', (value) => value === 'Winner: left', 120_000);
        },
      ),
      right: attachFixtureWorkerByTitle(
        runtime,
        client,
        sessionId,
        workerTitle('pong', 'right'),
        async (worker: FixtureWorkerContext) => {
          const browser = browserTitle('pong', 'right');
          await worker.waitForDirectMessage('join', 120_000);
          await joinLobby(worker, browser, roomId, 'right', 'Right');
          await worker.waitForDirectMessage('play', 120_000);
          await worker.browserClick(browser, '#intent-stop');
          await worker.waitForBrowserText(browser, 'right pong winner', '#winner', (value) => value === 'Winner: left', 120_000);
        },
      ),
    };

    const rootRun = root.controller.run(async (ctx: FixtureRootContext) => {
      const leftWorker = await ctx.tileCreate('agent', {
        title: workerTitle('pong', 'left'),
        parentSessionId: sessionId,
        parentTileId: ctx.tileId,
      });
      const rightWorker = await ctx.tileCreate('agent', {
        title: workerTitle('pong', 'right'),
        parentSessionId: sessionId,
        parentTileId: ctx.tileId,
      });
      const leftBrowser = await ctx.tileCreate('browser', {
        title: browserTitle('pong', 'left'),
        parentSessionId: sessionId,
        parentTileId: ctx.tileId,
      });
      const rightBrowser = await ctx.tileCreate('browser', {
        title: browserTitle('pong', 'right'),
        parentSessionId: sessionId,
        parentTileId: ctx.tileId,
      });

      await ctx.browserLoad(leftBrowser.tile_id, 'extensions/browser/pong/index.html');
      await ctx.waitForBrowserReady(leftBrowser.tile_id);
      await ctx.browserLoad(rightBrowser.tile_id, 'extensions/browser/pong/index.html');
      await ctx.waitForBrowserReady(rightBrowser.tile_id);

      await ctx.networkConnect(leftWorker.tile_id, 'left', leftBrowser.tile_id, 'left');
      await ctx.networkConnect(rightWorker.tile_id, 'left', rightBrowser.tile_id, 'left');
      await ctx.networkConnect(leftWorker.tile_id, 'top', rightWorker.tile_id, 'bottom');

      const [leftHandle, rightHandle] = await Promise.all([workers.left, workers.right]);

      await ctx.messageDirect(leftHandle.controller.agent.agent_id, 'join');
      await ctx.messageDirect(rightHandle.controller.agent.agent_id, 'join');
      await ctx.waitForBrowserTexts(
        leftBrowser.tile_id,
        'pong players joined',
        '#players .player-card',
        (players) => players.length === 2 && players.every((entry) => !entry.endsWith(': open')),
      );

      await ctx.messageDirect(leftHandle.controller.agent.agent_id, 'start');
      await ctx.waitForBrowserText(leftBrowser.tile_id, 'pong started', '#status', (value) => value.length > 0 && value !== 'No room joined');
      await ctx.messageDirect(leftHandle.controller.agent.agent_id, 'play');
      await ctx.messageDirect(rightHandle.controller.agent.agent_id, 'play');

      expect(await ctx.waitForBrowserText(leftBrowser.tile_id, 'pong winner', '#winner', (value) => value === 'Winner: left', 180_000)).toBe('Winner: left');
    }, root.context);

    await rootRun;
    await waitForWorkerCompletions(workers);
    root.controller.close();
  }, 240_000);

  it('runs a scripted four-player draw poker hand through fixture agents', async () => {
    const client = runtime.client;
    const roomId = uniqueRoomId('fixture-poker-room');
    const projection = await createIsolatedTab(client, 'draw-poker-match');
    const sessionId = projection.active_tab_id!;
    const root = await attachFixtureRootAgent(runtime, client, sessionId);

    const workers = {
      north: attachFixtureWorkerByTitle(
        runtime,
        client,
        sessionId,
        workerTitle('draw-poker', 'north'),
        async (worker: FixtureWorkerContext) => {
          const browser = browserTitle('draw-poker', 'north');
          await worker.waitForDirectMessage('join', 120_000);
          await joinLobby(worker, browser, roomId, 'north', 'North');
          await worker.waitForDirectMessage('start', 120_000);
          await worker.browserClick(browser, '#start');
          await worker.waitForDirectMessage('raise', 120_000);
          await worker.browserClick(browser, '#action-raise');
          await worker.waitForBrowserText(browser, 'north poker winner', '#winner', (value) => value === 'Winner: north', 120_000);
        },
      ),
      east: attachFixtureWorkerByTitle(
        runtime,
        client,
        sessionId,
        workerTitle('draw-poker', 'east'),
        async (worker: FixtureWorkerContext) => {
          const browser = browserTitle('draw-poker', 'east');
          await worker.waitForDirectMessage('join', 120_000);
          await joinLobby(worker, browser, roomId, 'east', 'East');
          await worker.waitForDirectMessage('fold', 120_000);
          await worker.browserClick(browser, '#action-fold');
        },
      ),
      south: attachFixtureWorkerByTitle(
        runtime,
        client,
        sessionId,
        workerTitle('draw-poker', 'south'),
        async (worker: FixtureWorkerContext) => {
          const browser = browserTitle('draw-poker', 'south');
          await worker.waitForDirectMessage('join', 120_000);
          await joinLobby(worker, browser, roomId, 'south', 'South');
          await worker.waitForDirectMessage('fold', 120_000);
          await worker.browserClick(browser, '#action-fold');
        },
      ),
      west: attachFixtureWorkerByTitle(
        runtime,
        client,
        sessionId,
        workerTitle('draw-poker', 'west'),
        async (worker: FixtureWorkerContext) => {
          const browser = browserTitle('draw-poker', 'west');
          await worker.waitForDirectMessage('join', 120_000);
          await joinLobby(worker, browser, roomId, 'west', 'West');
          await worker.waitForDirectMessage('fold', 120_000);
          await worker.browserClick(browser, '#action-fold');
        },
      ),
    };

    const rootRun = root.controller.run(async (ctx: FixtureRootContext) => {
      const workerTiles = await Promise.all(
        ['north', 'east', 'south', 'west'].map((seat) =>
          ctx.tileCreate('agent', {
            title: workerTitle('draw-poker', seat),
            parentSessionId: sessionId,
            parentTileId: ctx.tileId,
          })),
      );
      const browserTiles = await Promise.all(
        ['north', 'east', 'south', 'west'].map((seat) =>
          ctx.tileCreate('browser', {
            title: browserTitle('draw-poker', seat),
            parentSessionId: sessionId,
            parentTileId: ctx.tileId,
          })),
      );

      for (const tile of browserTiles) {
        await ctx.browserLoad(tile.tile_id, 'extensions/browser/draw-poker/index.html');
        await ctx.waitForBrowserReady(tile.tile_id);
      }

      for (let index = 0; index < workerTiles.length; index += 1) {
        await ctx.networkConnect(workerTiles[index].tile_id, 'left', browserTiles[index].tile_id, 'left');
        if (index < workerTiles.length - 1) {
          await ctx.networkConnect(workerTiles[index].tile_id, 'top', workerTiles[index + 1].tile_id, 'bottom');
        }
      }

      const attachments = {
        north: await workers.north,
        east: await workers.east,
        south: await workers.south,
        west: await workers.west,
      };

      for (const seat of ['north', 'east', 'south', 'west'] as const) {
        await ctx.messageDirect(attachments[seat].controller.agent.agent_id, 'join');
      }
      await ctx.waitForBrowserTexts(
        browserTiles[0].tile_id,
        'poker players joined',
        '#players .player-card',
        (players) => players.length === 4 && players.every((entry) => !entry.endsWith(': open')),
      );

      await ctx.messageDirect(attachments.north.controller.agent.agent_id, 'start');
      await ctx.waitForBrowserText(browserTiles[0].tile_id, 'poker started', '#status', (value) => value.includes('north'), 60_000);
      await ctx.messageDirect(attachments.north.controller.agent.agent_id, 'raise');
      await ctx.waitForBrowserText(browserTiles[0].tile_id, 'east turn', '#status', (value) => value.includes('east'), 60_000);
      await ctx.messageDirect(attachments.east.controller.agent.agent_id, 'fold');
      await ctx.messageDirect(attachments.south.controller.agent.agent_id, 'fold');
      await ctx.messageDirect(attachments.west.controller.agent.agent_id, 'fold');

      expect(await ctx.waitForBrowserText(browserTiles[0].tile_id, 'poker winner', '#winner', (value) => value === 'Winner: north', 120_000)).toBe('Winner: north');
    }, root.context);

    await rootRun;
    await waitForWorkerCompletions(workers);
    root.controller.close();
  }, 240_000);

  it('runs a shared-view texas holdem match through one browser tile and turn-taking extension calls', async () => {
    const client = runtime.client;
    const projection = await createIsolatedTab(client, 'texas-holdem-match');
    const sessionId = projection.active_tab_id!;
    const root = await attachFixtureRootAgent(runtime, client, sessionId);
    const tableBrowserTitle = browserTitle('texas-holdem', 'table');

    const workers = {
      north: attachFixtureWorkerByTitle(
        runtime,
        client,
        sessionId,
        workerTitle('texas-holdem', 'north'),
        async (worker: FixtureWorkerContext) => {
          await worker.waitForDirectMessage('claim', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'claim_seat', { seat: 'north', name: 'North' });
          await worker.waitForDirectMessage('start', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'start_match', { seed: 'fixture-holdem-seed' });
          await worker.waitForDirectMessage('hand1-raise', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'act', { type: 'raise' });
          await worker.waitForDirectMessage('hand2-call', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'act', { type: 'call' });
          await worker.waitForDirectMessage('hand2-fold', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'act', { type: 'fold' });
          await worker.waitForDirectMessage('done', 120_000);
        },
      ),
      east: attachFixtureWorkerByTitle(
        runtime,
        client,
        sessionId,
        workerTitle('texas-holdem', 'east'),
        async (worker: FixtureWorkerContext) => {
          await worker.waitForDirectMessage('claim', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'claim_seat', { seat: 'east', name: 'East' });
          await worker.waitForDirectMessage('hand1-fold', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'act', { type: 'fold' });
          await worker.waitForDirectMessage('hand2-call', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'act', { type: 'call' });
          await worker.waitForDirectMessage('hand2-fold', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'act', { type: 'fold' });
          await worker.waitForDirectMessage('done', 120_000);
        },
      ),
      south: attachFixtureWorkerByTitle(
        runtime,
        client,
        sessionId,
        workerTitle('texas-holdem', 'south'),
        async (worker: FixtureWorkerContext) => {
          await worker.waitForDirectMessage('claim', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'claim_seat', { seat: 'south', name: 'South' });
          await worker.waitForDirectMessage('hand1-fold', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'act', { type: 'fold' });
          await worker.waitForDirectMessage('hand2-call', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'act', { type: 'call' });
          await worker.waitForDirectMessage('hand2-raise', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'act', { type: 'raise' });
          await worker.waitForDirectMessage('done', 120_000);
        },
      ),
      west: attachFixtureWorkerByTitle(
        runtime,
        client,
        sessionId,
        workerTitle('texas-holdem', 'west'),
        async (worker: FixtureWorkerContext) => {
          await worker.waitForDirectMessage('claim', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'claim_seat', { seat: 'west', name: 'West' });
          await worker.waitForDirectMessage('hand1-fold', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'act', { type: 'fold' });
          await worker.waitForDirectMessage('hand2-check', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'act', { type: 'check' });
          await worker.waitForDirectMessage('hand2-fold', 120_000);
          await worker.browserExtensionCall(tableBrowserTitle, 'act', { type: 'fold' });
          await worker.waitForDirectMessage('done', 120_000);
        },
      ),
    };

    const rootRun = root.controller.run(async (ctx: FixtureRootContext) => {
      const workerSeats = ['north', 'east', 'south', 'west'] as const;
      const workerTiles = await Promise.all(
        workerSeats.map((seat) =>
          ctx.tileCreate('agent', {
            title: workerTitle('texas-holdem', seat),
            parentSessionId: sessionId,
            parentTileId: ctx.tileId,
          })),
      );
      const browserTile = await ctx.tileCreate('browser', {
        title: tableBrowserTitle,
        parentSessionId: sessionId,
        parentTileId: ctx.tileId,
      });

      await ctx.browserLoad(browserTile.tile_id, 'extensions/browser/texas-holdem/index.html');
      await ctx.waitForBrowserText(
        browserTile.tile_id,
        'texas holdem page ready',
        '#status',
        (value) => value === 'Claim all four seats to start the match',
        60_000,
      );

      await ctx.networkConnect(workerTiles[0].tile_id, 'left', browserTile.tile_id, 'left');
      await ctx.networkConnect(workerTiles[1].tile_id, 'right', browserTile.tile_id, 'right');
      await ctx.networkConnect(workerTiles[2].tile_id, 'top', browserTile.tile_id, 'top');
      await ctx.networkConnect(workerTiles[3].tile_id, 'bottom', browserTile.tile_id, 'bottom');

      const attachments = {
        north: await workers.north,
        east: await workers.east,
        south: await workers.south,
        west: await workers.west,
      };

      await ctx.browserExtensionCall(browserTile.tile_id, 'register_commentator', { name: 'Booth' });
      expect(
        await ctx.waitForBrowserText(
          browserTile.tile_id,
          'commentator registered',
          '#commentator',
          (value) => value === 'Booth',
          30_000,
        ),
      ).toBe('Booth');

      for (const seat of workerSeats) {
        await ctx.messageDirect(attachments[seat].controller.agent.agent_id, 'claim');
      }

      await ctx.waitForBrowserTexts(
        browserTile.tile_id,
        'holdem seats claimed',
        '.seat-name',
        (names) => names.includes('North') && names.includes('East') && names.includes('South') && names.includes('West'),
        60_000,
      );

      await ctx.messageDirect(attachments.north.controller.agent.agent_id, 'start');
      await ctx.waitForBrowserText(
        browserTile.tile_id,
        'hand one starts',
        '#status',
        (value) => value === 'West to act on preflop',
        60_000,
      );

      const allHands = await ctx.browserExtensionCall<{ hands: Record<string, string[]> }>(browserTile.tile_id, 'reveal_all');
      expect(Object.keys(allHands.hands).sort()).toEqual([...workerSeats].sort());

      await ctx.messageDirect(attachments.west.controller.agent.agent_id, 'hand1-fold');
      await ctx.waitForBrowserText(browserTile.tile_id, 'north turn hand one', '#status', (value) => value === 'North to act on preflop', 60_000);
      await ctx.messageDirect(attachments.north.controller.agent.agent_id, 'hand1-raise');
      await ctx.waitForBrowserText(browserTile.tile_id, 'east turn hand one', '#status', (value) => value === 'East to act on preflop', 60_000);
      await ctx.messageDirect(attachments.east.controller.agent.agent_id, 'hand1-fold');
      await ctx.waitForBrowserText(browserTile.tile_id, 'south turn hand one', '#status', (value) => value === 'South to act on preflop', 60_000);
      await ctx.messageDirect(attachments.south.controller.agent.agent_id, 'hand1-fold');

      expect(
        await ctx.waitForBrowserText(
          browserTile.tile_id,
          'north wins hand one',
          '#status',
          (value) => value === 'north wins the pot by fold',
          60_000,
        ),
      ).toBe('north wins the pot by fold');
      expect(await ctx.browserText(browserTile.tile_id, '[data-seat="north"] .seat-stack')).toBe('43 chips');

      await ctx.browserExtensionCall(browserTile.tile_id, 'start_next_hand');
      await ctx.waitForBrowserText(
        browserTile.tile_id,
        'hand two starts',
        '#status',
        (value) => value === 'North to act on preflop',
        60_000,
      );

      const sharedBody = await ctx.browserDomQuery<string>(
        browserTile.tile_id,
        'document.body.innerText',
      );
      expect(sharedBody).not.toContain(allHands.hands.north[0] ?? '');
      expect(sharedBody).not.toContain(allHands.hands.north[1] ?? '');

      await ctx.messageDirect(attachments.north.controller.agent.agent_id, 'hand2-call');
      await ctx.waitForBrowserText(browserTile.tile_id, 'east turn hand two', '#status', (value) => value === 'East to act on preflop', 60_000);
      await ctx.messageDirect(attachments.east.controller.agent.agent_id, 'hand2-call');
      await ctx.waitForBrowserText(browserTile.tile_id, 'south turn hand two', '#status', (value) => value === 'South to act on preflop', 60_000);
      await ctx.messageDirect(attachments.south.controller.agent.agent_id, 'hand2-call');
      await ctx.waitForBrowserText(browserTile.tile_id, 'west turn hand two', '#status', (value) => value === 'West to act on preflop', 60_000);
      await ctx.messageDirect(attachments.west.controller.agent.agent_id, 'hand2-check');

      await ctx.waitForBrowserText(browserTile.tile_id, 'flop dealt hand two', '#status', (value) => value === 'South to act on flop', 60_000);
      expect(await ctx.browserTexts(browserTile.tile_id, '#board .card')).toHaveLength(3);

      await ctx.messageDirect(attachments.south.controller.agent.agent_id, 'hand2-raise');
      await ctx.waitForBrowserText(browserTile.tile_id, 'west turn on flop', '#status', (value) => value === 'West to act on flop', 60_000);
      await ctx.messageDirect(attachments.west.controller.agent.agent_id, 'hand2-fold');
      await ctx.waitForBrowserText(browserTile.tile_id, 'north turn on flop', '#status', (value) => value === 'North to act on flop', 60_000);
      await ctx.messageDirect(attachments.north.controller.agent.agent_id, 'hand2-fold');
      await ctx.waitForBrowserText(browserTile.tile_id, 'east turn on flop', '#status', (value) => value === 'East to act on flop', 60_000);
      await ctx.messageDirect(attachments.east.controller.agent.agent_id, 'hand2-fold');

      expect(
        await ctx.waitForBrowserText(
          browserTile.tile_id,
          'south wins hand two',
          '#status',
          (value) => value === 'south wins the pot by fold',
          60_000,
        ),
      ).toBe('south wins the pot by fold');
      expect(await ctx.browserText(browserTile.tile_id, '[data-seat="south"] .seat-stack')).toBe('44 chips');
      expect(await ctx.browserText(browserTile.tile_id, '[data-seat="north"] .seat-stack')).toBe('41 chips');

      for (const seat of workerSeats) {
        await ctx.messageDirect(attachments[seat].controller.agent.agent_id, 'done');
      }
    }, root.context);

    await rootRun;
    await waitForWorkerCompletions(workers);
    root.controller.close();
  }, 240_000);

  it('runs a scripted snake arena round through fixture agents', async () => {
    const client = runtime.client;
    const roomId = uniqueRoomId('fixture-snake-room');
    const projection = await createIsolatedTab(client, 'snake-arena-match');
    const sessionId = projection.active_tab_id!;
    const root = await attachFixtureRootAgent(runtime, client, sessionId);

    const workers = {
      north: attachFixtureWorkerByTitle(
        runtime,
        client,
        sessionId,
        workerTitle('snake-arena', 'north'),
        async (worker: FixtureWorkerContext) => {
          const browser = browserTitle('snake-arena', 'north');
          await worker.waitForDirectMessage('join', 120_000);
          await joinLobby(worker, browser, roomId, 'north', 'North');
          await worker.waitForDirectMessage('start', 120_000);
          await worker.browserClick(browser, '#start');
          await worker.waitForBrowserText(browser, 'north snake winner', '#winner', (value) => value === 'Winner: north', 180_000);
        },
      ),
      east: attachFixtureWorkerByTitle(
        runtime,
        client,
        sessionId,
        workerTitle('snake-arena', 'east'),
        async (worker: FixtureWorkerContext) => {
          const browser = browserTitle('snake-arena', 'east');
          await worker.waitForDirectMessage('join', 120_000);
          await joinLobby(worker, browser, roomId, 'east', 'East');
          await worker.waitForDirectMessage('play', 120_000);
          await worker.browserClick(browser, '#direction-up');
        },
      ),
      south: attachFixtureWorkerByTitle(
        runtime,
        client,
        sessionId,
        workerTitle('snake-arena', 'south'),
        async (worker: FixtureWorkerContext) => {
          const browser = browserTitle('snake-arena', 'south');
          await worker.waitForDirectMessage('join', 120_000);
          await joinLobby(worker, browser, roomId, 'south', 'South');
          await worker.waitForDirectMessage('play', 120_000);
          await worker.browserClick(browser, '#direction-right');
        },
      ),
      west: attachFixtureWorkerByTitle(
        runtime,
        client,
        sessionId,
        workerTitle('snake-arena', 'west'),
        async (worker: FixtureWorkerContext) => {
          const browser = browserTitle('snake-arena', 'west');
          await worker.waitForDirectMessage('join', 120_000);
          await joinLobby(worker, browser, roomId, 'west', 'West');
          await worker.waitForDirectMessage('play', 120_000);
          await worker.browserClick(browser, '#direction-down');
        },
      ),
    };

    const rootRun = root.controller.run(async (ctx: FixtureRootContext) => {
      const workerTiles = await Promise.all(
        ['north', 'east', 'south', 'west'].map((seat) =>
          ctx.tileCreate('agent', {
            title: workerTitle('snake-arena', seat),
            parentSessionId: sessionId,
            parentTileId: ctx.tileId,
          })),
      );
      const browserTiles = await Promise.all(
        ['north', 'east', 'south', 'west'].map((seat) =>
          ctx.tileCreate('browser', {
            title: browserTitle('snake-arena', seat),
            parentSessionId: sessionId,
            parentTileId: ctx.tileId,
          })),
      );

      for (const tile of browserTiles) {
        await ctx.browserLoad(tile.tile_id, 'extensions/browser/snake-arena/index.html');
        await ctx.waitForBrowserReady(tile.tile_id);
      }

      for (let index = 0; index < workerTiles.length; index += 1) {
        await ctx.networkConnect(workerTiles[index].tile_id, 'left', browserTiles[index].tile_id, 'left');
        if (index < workerTiles.length - 1) {
          await ctx.networkConnect(workerTiles[index].tile_id, 'top', workerTiles[index + 1].tile_id, 'bottom');
        }
      }

      const attachments = {
        north: await workers.north,
        east: await workers.east,
        south: await workers.south,
        west: await workers.west,
      };

      for (const seat of ['north', 'east', 'south', 'west'] as const) {
        await ctx.messageDirect(attachments[seat].controller.agent.agent_id, 'join');
      }
      await ctx.waitForBrowserTexts(
        browserTiles[0].tile_id,
        'snake players joined',
        '#players .player-card',
        (players) => players.length === 4 && players.every((entry) => !entry.endsWith(': open')),
      );

      await ctx.messageDirect(attachments.north.controller.agent.agent_id, 'start');
      await ctx.waitForBrowserText(browserTiles[0].tile_id, 'snake started', '#status', (value) => value.length > 0 && value !== 'No room joined', 60_000);
      await ctx.messageDirect(attachments.east.controller.agent.agent_id, 'play');
      await ctx.messageDirect(attachments.south.controller.agent.agent_id, 'play');
      await ctx.messageDirect(attachments.west.controller.agent.agent_id, 'play');

      expect(await ctx.waitForBrowserText(browserTiles[0].tile_id, 'snake winner', '#winner', (value) => value === 'Winner: north', 180_000)).toBe('Winner: north');
    }, root.context);

    await rootRun;
    await waitForWorkerCompletions(workers);
    root.controller.close();
  }, 240_000);
});
