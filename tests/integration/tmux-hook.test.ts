import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { HerdTestClient } from './client';
import { backingPaneIdForTile, createIsolatedTab, runTmux, waitFor } from './helpers';
import { startIntegrationRuntime, type HerdIntegrationRuntime } from './runtime';

describe.sequential('tmux-created teammate integration coverage', () => {
  let runtime: HerdIntegrationRuntime;
  let client: HerdTestClient;

  beforeAll(async () => {
    runtime = await startIntegrationRuntime();
    client = runtime.client;
  });

  afterAll(async () => {
    await runtime.stop();
  });

  it('projects externally tmux-created panes as separate child tiles with root lineage', async () => {
    const projection = await createIsolatedTab(client, 'tmux-team');
    const rootTileId = projection.selected_tile_id;
    const rootPaneId = rootTileId ? await backingPaneIdForTile(client, rootTileId) : null;
    const rootWindowId = projection.active_tab_terminals[0]?.windowId;
    expect(rootPaneId).toBeTruthy();
    expect(rootWindowId).toBeTruthy();

    runTmux(runtime, ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', rootPaneId!, '/bin/zsh']);

    let current = await waitFor(
      'first tmux child tile',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_id === projection.active_tab_id
        && nextProjection.active_tab_terminals.length === 2
        && nextProjection.active_tab_connections.length === 1,
      30_000,
      150,
    );

    const firstChild = current.active_tab_terminals.find((term) => term.id !== rootTileId);
    expect(firstChild).toBeTruthy();
    expect(firstChild?.parentWindowId).toBe(rootWindowId);
    expect(firstChild?.readOnly ?? false).toBe(false);

    runTmux(runtime, ['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', await backingPaneIdForTile(client, firstChild!.id), '/bin/zsh']);

    current = await waitFor(
      'second tmux child tile',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_id === projection.active_tab_id
        && nextProjection.active_tab_terminals.length === 3
        && nextProjection.active_tab_connections.length === 2,
      30_000,
      150,
    );

    const childTiles = current.active_tab_terminals.filter((term) => term.id !== rootTileId);
    expect(childTiles).toHaveLength(2);
    expect(childTiles.every((term) => term.parentWindowId === rootWindowId)).toBe(true);
    expect(current.active_tab_connections.every((connection) => connection.parent_window_id === rootWindowId)).toBe(true);
    expect(current.active_tab_id).toBe(projection.active_tab_id);
  });
});
