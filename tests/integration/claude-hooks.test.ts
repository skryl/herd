import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HerdTestClient } from './client';
import {
  accumulatePaneOutput,
  createIsolatedTab,
  runConfiguredPreToolUseHook,
  sleep,
  waitFor,
} from './helpers';
import { startIntegrationRuntime, type HerdIntegrationRuntime } from './runtime';

describe.sequential('Claude hook integration coverage', () => {
  let runtime: HerdIntegrationRuntime;
  let client: HerdTestClient;

  beforeAll(async () => {
    runtime = await startIntegrationRuntime();
    client = runtime.client;
  });

  afterAll(async () => {
    await runtime.stop();
  });

  it('spawns a normal agent tile and launches the tmux-style Claude child command', async () => {
    const projection = await createIsolatedTab(client, 'hook-agent');
    const rootPaneId = projection.selected_pane_id;
    const rootWindowId = projection.active_tab_terminals[0]?.windowId;
    expect(rootPaneId).toBeTruthy();
    expect(rootWindowId).toBeTruthy();

    const teamName = `hookagent${Date.now().toString(36)}`;
    const fakeAgentPath = path.join(os.tmpdir(), 'herd-fake-claude-agent.sh');
    await fs.writeFile(
      fakeAgentPath,
      `#!/bin/bash
sleep 30
`,
      'utf8',
    );
    await fs.chmod(fakeAgentPath, 0o755);

    await runConfiguredPreToolUseHook(
      'Agent',
      {
        session_id: '11111111-1111-1111-1111-111111111111',
        permission_mode: 'bypassPermissions',
        tool_input: {
          name: 'capture-1',
          team_name: teamName,
          prompt: 'You are capture-1 on the hook team. Say hello, then go idle.',
          description: 'Say hello then idle',
          run_in_background: true,
          model: 'claude-opus-4-6',
        },
      },
      {
        HERD_SOCK: runtime.socketPath,
        TMUX_PANE: rootPaneId!,
        HERD_CLAUDE_AGENT_BIN: fakeAgentPath,
      },
    );

    const withChild = await waitFor(
      'agent hook tile',
      () => client.getProjection(),
      (nextProjection) => {
        const titles = nextProjection.active_tab_terminals.map((term) => term.title);
        return nextProjection.active_tab_terminals.length === 2
          && nextProjection.active_tab_connections.length === 1
          && titles.includes(`capture-1@${teamName}`);
      },
      30_000,
      150,
    );

    const childTile = withChild.active_tab_terminals.find((term) => term.id !== rootPaneId);
    expect(childTile).toBeTruthy();
    expect(childTile?.readOnly ?? false).toBe(false);
    expect(childTile?.parentWindowId).toBe(rootWindowId);
    expect(childTile?.title).toBe(`capture-1@${teamName}`);
    expect(withChild.active_tab_connections[0]?.parent_window_id).toBe(rootWindowId);

    const initialOutput = await accumulatePaneOutput(
      client,
      childTile!.id,
      /__HERD_AGENT_LAUNCH__/,
    );
    await sleep(300);
    const trailingOutput = (await client.readOutput(childTile!.id)).output;
    const normalizedOutput = `${initialOutput}${trailingOutput}`
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/.\u0008/g, '')
      .replace(/\r/g, ' ')
      .replace(/\n/g, ' ')
      .replace(/\s+/g, ' ');
    expect(normalizedOutput).toContain(`__HERD_AGENT_LAUNCH__ capture-1@${teamName}`);
  });

  it('creates a read-only background tool tile and skips foreground Bash hooks', async () => {
    const projection = await createIsolatedTab(client, 'hook-bash');
    const rootPaneId = projection.selected_pane_id;
    const rootWindowId = projection.active_tab_terminals[0]?.windowId;
    expect(rootPaneId).toBeTruthy();
    expect(rootWindowId).toBeTruthy();

    await runConfiguredPreToolUseHook(
      'Bash',
      {
        tool_input: {
          run_in_background: false,
          command: 'echo foreground',
          description: 'Foreground command',
        },
      },
      {
        HERD_SOCK: runtime.socketPath,
        TMUX_PANE: rootPaneId!,
      },
    );

    await sleep(600);
    let current = await client.getProjection();
    expect(current.active_tab_terminals).toHaveLength(1);

    await runConfiguredPreToolUseHook(
      'Bash',
      {
        tool_input: {
          run_in_background: true,
          command: 'sleep 5 && echo done',
          description: 'Long Tool',
        },
      },
      {
        HERD_SOCK: runtime.socketPath,
        TMUX_PANE: rootPaneId!,
      },
    );

    current = await waitFor(
      'background Bash hook tile',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_terminals.length === 2
        && nextProjection.active_tab_connections.length === 1
        && nextProjection.active_tab_terminals.some((term) => term.title === 'BG: Long Tool'),
      30_000,
      150,
    );

    const bgTile = current.active_tab_terminals.find((term) => term.id !== rootPaneId);
    expect(bgTile).toBeTruthy();
    expect(bgTile?.readOnly).toBe(true);
    expect(bgTile?.parentWindowId).toBe(rootWindowId);
    expect(bgTile?.title).toBe('BG: Long Tool');
    expect(current.active_tab_connections[0]?.parent_window_id).toBe(rootWindowId);

    const bgOutput = await accumulatePaneOutput(client, bgTile!.id, /Running: sleep 5 && echo done/);
    expect(bgOutput).toContain('Running: sleep 5 && echo done');
  });
});
