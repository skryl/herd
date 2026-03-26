import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

import { HerdTestClient } from './client';
import { attachFixtureRootAgent, attachFixtureWorkerByTitle } from './fixture-agents';
import { backingPaneIdForTile, createIsolatedTab, runTmux, waitFor } from './helpers';
import { startIntegrationRuntime, type HerdIntegrationRuntime } from './runtime';

function paneProcessCommand(runtime: HerdIntegrationRuntime, paneId: string): string {
  const pid = runTmux(runtime, [
    'display-message',
    '-p',
    '-t',
    paneId,
    '#{pane_pid}',
  ]).trim();
  expect(pid).toMatch(/^\d+$/);
  return execFileSync('ps', ['-p', pid, '-o', 'command='], {
    encoding: 'utf8',
  }).trim();
}

async function tileProcessCommand(
  runtime: HerdIntegrationRuntime,
  client: HerdTestClient,
  tileId: string,
): Promise<string> {
  const paneId = await backingPaneIdForTile(client, tileId);
  return paneProcessCommand(runtime, paneId);
}

describe.sequential('fixture agent integration', () => {
  let runtime: HerdIntegrationRuntime;
  let client: HerdTestClient;

  beforeAll(async () => {
    runtime = await startIntegrationRuntime({ fixtureAgents: true });
    client = runtime.client;
  });

  afterAll(async () => {
    await runtime.stop();
  });

  it('creates fixture root and worker agents without launching claude and drives a browser through the scripted worker channel', async () => {
    const projection = await createIsolatedTab(client, 'fixture-agents');
    const sessionId = projection.active_tab_id!;
    const root = await attachFixtureRootAgent(runtime, client, sessionId);

    expect(root.controller.agent.agent_type).toBe('fixture');
    expect(root.controller.agent.agent_role).toBe('root');
    const rootProcess = await tileProcessCommand(runtime, client, root.context.tileId);
    expect(rootProcess).not.toContain('claude');

    const workerAttachment = attachFixtureWorkerByTitle(
      runtime,
      client,
      sessionId,
      'fixture-worker',
      async (worker) => {
        await worker.waitForDirectMessage('check-browser');
        await worker.browserEval<string>(
          'fixture-browser',
          "document.body.dataset.workerChecked = document.title; return document.body.dataset.workerChecked;",
        );
      },
    );

    const workerTile = await root.context.tileCreate('agent', {
      title: 'fixture-worker',
      parentSessionId: sessionId,
      parentTileId: root.context.tileId,
    });
    const browserTile = await root.context.tileCreate('browser', {
      parentSessionId: sessionId,
      parentTileId: root.context.tileId,
    });
    await root.context.tileRename(browserTile.tile_id, 'fixture-browser');
    await root.context.browserLoad(browserTile.tile_id, 'tests/fixtures/browser-drive.html');
    await waitFor(
      'fixture browser load',
      () => root.context.browserEval<string>(browserTile.tile_id, 'return document.title;'),
      (value) => value === 'browser-drive-fixture',
      30_000,
      250,
    );
    await root.context.networkConnect(workerTile.tile_id, 'left', browserTile.tile_id, 'left');

    const worker = await workerAttachment;
    expect(worker.controller.agent.agent_type).toBe('fixture');
    expect(worker.controller.agent.agent_role).toBe('worker');
    const workerProcess = await tileProcessCommand(runtime, client, worker.context.tileId);
    expect(workerProcess).not.toContain('claude');

    await root.context.messageDirect(worker.controller.agent.agent_id, 'check-browser');
    await waitFor(
      'worker browser eval marker',
      () => root.context.browserEval<string>(browserTile.tile_id, "return document.body.dataset.workerChecked ?? '';"),
      (value) => value === 'browser-drive-fixture',
      30_000,
      250,
    );
    await worker.controller.waitForCompletion();
  }, 180_000);
});
