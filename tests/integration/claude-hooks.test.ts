import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { HerdTestClient } from './client';
import {
  accumulatePaneOutput,
  backingPaneIdForTile,
  createIsolatedTab,
  runConfiguredPreToolUseHook,
  runTmux,
  sleep,
  waitFor,
} from './helpers';
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

function capturePane(runtime: HerdIntegrationRuntime, paneId: string): string {
  return runTmux(runtime, [
    'capture-pane',
    '-p',
    '-t',
    paneId,
  ]);
}

async function appendTaskNotification(
  transcriptPath: string,
  toolUseId: string,
  status: string,
  taskId: string,
): Promise<void> {
  const line = JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    sessionId: 'test-session',
    content: `<task-notification>
<task-id>${taskId}</task-id>
<tool-use-id>${toolUseId}</tool-use-id>
<output-file>/tmp/${taskId}.output</output-file>
<status>${status}</status>
<summary>Agent finished</summary>
</task-notification>`,
  });
  await fs.appendFile(transcriptPath, `${line}\n`, 'utf8');
}

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
    const rootTileId = projection.selected_tile_id;
    const rootPaneId = rootTileId ? await backingPaneIdForTile(client, rootTileId) : null;
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
    const activeWindowLines = runTmux(runtime, [
      'list-windows',
      '-t',
      withChild.active_tab_id!,
      '-F',
      '#{window_id}\t#{window_active}',
    ]).split('\n');
    expect(activeWindowLines).toContain(`${rootWindowId}\t1`);
    expect(activeWindowLines).toContain(`${childTile?.windowId}\t0`);

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

  it('spawns a normal tile for generic Agent payloads and resolves the agent id from the transcript', async () => {
    const projection = await createIsolatedTab(client, 'hook-generic-agent');
    const rootTileId = projection.selected_tile_id;
    const rootPaneId = rootTileId ? await backingPaneIdForTile(client, rootTileId) : null;
    const rootWindowId = projection.active_tab_terminals[0]?.windowId;
    expect(rootPaneId).toBeTruthy();
    expect(rootWindowId).toBeTruthy();

    const fakeAgentPath = path.join(os.tmpdir(), 'herd-fake-claude-generic-agent.sh');
    await fs.writeFile(
      fakeAgentPath,
      `#!/bin/bash
sleep 30
`,
      'utf8',
    );
    await fs.chmod(fakeAgentPath, 0o755);

    const transcriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'herd-generic-agent-'));
    const transcriptPath = path.join(transcriptDir, 'parent.jsonl');
    const toolUseId = 'toolu_generic_agent_12345678';
    const resolvedAgentId = 'agent-generic-abcdef12';
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'progress',
        parentToolUseID: toolUseId,
        data: {
          type: 'hook_progress',
          hookEvent: 'PreToolUse',
        },
      })}\n`
        + `${JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: [
                  {
                    type: 'text',
                    text: `Async agent launched successfully.\nagentId: ${resolvedAgentId} (internal ID - do not mention to user.)\nThe agent is working in the background.`,
                  },
                ],
              },
            ],
          },
        })}\n`,
      'utf8',
    );

    await runConfiguredPreToolUseHook(
      'Agent',
      {
        session_id: '33333333-3333-3333-3333-333333333333',
        transcript_path: transcriptPath,
        tool_use_id: toolUseId,
        permission_mode: 'bypassPermissions',
        tool_input: {
          description: 'Explore the project structure of this Rust/Tauri application',
          prompt: 'Explore the project structure and summarize it.',
          subagent_type: 'Explore',
        },
      },
      {
        HERD_SOCK: runtime.socketPath,
        TMUX_PANE: rootPaneId!,
        HERD_CLAUDE_AGENT_BIN: fakeAgentPath,
      },
    );

    const withChild = await waitFor(
      'generic agent hook tile',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_terminals.length === 2
        && nextProjection.active_tab_connections.length === 1
        && nextProjection.active_tab_terminals.some((term) => term.title.startsWith('Explore: ')),
      30_000,
      150,
    );

    const childTile = withChild.active_tab_terminals.find((term) => term.id !== rootPaneId);
    expect(childTile).toBeTruthy();
    expect(childTile?.readOnly ?? false).toBe(false);
    expect(childTile?.parentWindowId).toBe(rootWindowId);
    expect(childTile?.title.startsWith('Explore: ')).toBe(true);
    expect(withChild.active_tab_connections[0]?.parent_window_id).toBe(rootWindowId);

    const paneText = await waitFor(
      'generic agent pane output',
      async () => capturePane(runtime, childTile!.id),
      (text) =>
        text.includes('Waiting for agent session id...')
        && text.includes('__HERD_AGENT_LAUNCH__ generic')
        && text.includes(resolvedAgentId),
      30_000,
      150,
    );
    expect(paneText).toContain(resolvedAgentId);
    const processCommand = paneProcessCommand(runtime, childTile!.id);
    expect(processCommand).toContain(fakeAgentPath);
    expect(processCommand).toContain('--agent-name explore-12345678');
  });

  it('spawns a normal tile for prompt-only Agent payloads without subagent_type', async () => {
    const projection = await createIsolatedTab(client, 'hook-prompt-agent');
    const rootTileId = projection.selected_tile_id;
    const rootPaneId = rootTileId ? await backingPaneIdForTile(client, rootTileId) : null;
    const rootWindowId = projection.active_tab_terminals[0]?.windowId;
    expect(rootPaneId).toBeTruthy();
    expect(rootWindowId).toBeTruthy();

    const fakeAgentPath = path.join(os.tmpdir(), 'herd-fake-claude-prompt-agent.sh');
    await fs.writeFile(
      fakeAgentPath,
      `#!/bin/bash
sleep 30
`,
      'utf8',
    );
    await fs.chmod(fakeAgentPath, 0o755);

    const transcriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'herd-prompt-agent-'));
    const transcriptPath = path.join(transcriptDir, 'parent.jsonl');
    const toolUseId = 'toolu_prompt_agent_12345678';
    const resolvedAgentId = 'agent-prompt-abcdef12';
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'progress',
        parentToolUseID: toolUseId,
        data: {
          type: 'hook_progress',
          hookEvent: 'PreToolUse',
        },
      })}\n`
        + `${JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: [
                  {
                    type: 'text',
                    text: `Async agent launched successfully.\nagentId: ${resolvedAgentId} (internal ID - do not mention to user.)\nThe agent is working in the background.`,
                  },
                ],
              },
            ],
          },
        })}\n`,
      'utf8',
    );

    await runConfiguredPreToolUseHook(
      'Agent',
      {
        session_id: '44444444-4444-4444-4444-444444444444',
        transcript_path: transcriptPath,
        tool_use_id: toolUseId,
        permission_mode: 'bypassPermissions',
        tool_input: {
          description: 'Run `git log --oneline -10` in the current directory and report back',
          prompt: 'Run `git log --oneline -10` in the current directory and report back',
        },
      },
      {
        HERD_SOCK: runtime.socketPath,
        TMUX_PANE: rootPaneId!,
        HERD_CLAUDE_AGENT_BIN: fakeAgentPath,
      },
    );

    const withChild = await waitFor(
      'prompt-only agent hook tile',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_terminals.length === 2
        && nextProjection.active_tab_connections.length === 1
        && nextProjection.active_tab_terminals.some((term) => term.title.startsWith('Agent: ')),
      30_000,
      150,
    );

    const childTile = withChild.active_tab_terminals.find((term) => term.id !== rootPaneId);
    expect(childTile).toBeTruthy();
    expect(childTile?.readOnly ?? false).toBe(false);
    expect(childTile?.parentWindowId).toBe(rootWindowId);
    expect(childTile?.title).toContain('Agent: Run `git log --oneline -10`');
    expect(withChild.active_tab_connections[0]?.parent_window_id).toBe(rootWindowId);

    const paneText = await waitFor(
      'prompt-only agent pane output',
      async () => capturePane(runtime, childTile!.id),
      (text) =>
        text.includes('Waiting for agent session id...')
        && text.includes('__HERD_AGENT_LAUNCH__ generic')
        && text.includes(resolvedAgentId),
      30_000,
      150,
    );
    expect(paneText).toContain(resolvedAgentId);
    const processCommand = paneProcessCommand(runtime, childTile!.id);
    expect(processCommand).toContain(fakeAgentPath);
    expect(processCommand).toContain('--agent-name run-git-log-oneline-10-in-the-current-di-12345678');
  });

  it('streams the output file for background generic Agent payloads instead of attaching to a blank Claude UI', async () => {
    const projection = await createIsolatedTab(client, 'hook-bg-generic-agent');
    const rootTileId = projection.selected_tile_id;
    const rootPaneId = rootTileId ? await backingPaneIdForTile(client, rootTileId) : null;
    const rootWindowId = projection.active_tab_terminals[0]?.windowId;
    expect(rootPaneId).toBeTruthy();
    expect(rootWindowId).toBeTruthy();

    const transcriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'herd-bg-generic-agent-'));
    const transcriptPath = path.join(transcriptDir, 'parent.jsonl');
    const outputFile = path.join(transcriptDir, 'agent-output.log');
    const toolUseId = 'toolu_bg_generic_agent_12345678';
    const resolvedAgentId = 'agent-bg-generic-abcdef12';
    const fakeAgentPath = path.join(os.tmpdir(), 'herd-fake-claude-bg-generic-agent.sh');
    await fs.writeFile(
      fakeAgentPath,
      `#!/bin/bash
echo "attach path should not run"
exit 99
`,
      'utf8',
    );
    await fs.chmod(fakeAgentPath, 0o755);

    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'toolu_other_background_agent_12345678',
              content: [
                {
                  type: 'text',
                  text: 'Async agent launched successfully.\nagentId: agent-other-abcdef12\noutput_file: /tmp/other-agent.output',
                },
              ],
            },
          ],
        },
        toolUseResult: {
          agentId: 'agent-other-abcdef12',
          outputFile: '/tmp/other-agent.output',
        },
      })}\n`
        + `${JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: [
                  {
                    type: 'text',
                    text: `Async agent launched successfully.\nagentId: ${resolvedAgentId} (internal ID - do not mention to user.)\noutput_file: ${outputFile}`,
                  },
                ],
              },
            ],
          },
          toolUseResult: {
            agentId: resolvedAgentId,
            outputFile,
          },
        })}\n`,
      'utf8',
    );

    await runConfiguredPreToolUseHook(
      'Agent',
      {
        session_id: '45454545-4545-4545-4545-454545454545',
        transcript_path: transcriptPath,
        tool_use_id: toolUseId,
        permission_mode: 'bypassPermissions',
        tool_input: {
          description: 'Background generic agent output stream',
          prompt: 'Background generic agent output stream',
          subagent_type: 'Explore',
          run_in_background: true,
        },
      },
      {
        HERD_SOCK: runtime.socketPath,
        TMUX_PANE: rootPaneId!,
        HERD_CLAUDE_AGENT_BIN: fakeAgentPath,
      },
    );

    const withChild = await waitFor(
      'background generic agent hook tile',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_terminals.length === 2
        && nextProjection.active_tab_connections.length === 1
        && nextProjection.active_tab_terminals.some((term) => term.title.startsWith('Explore: ')),
      30_000,
      150,
    );

    const childTile = withChild.active_tab_terminals.find((term) => term.id !== rootPaneId);
    expect(childTile).toBeTruthy();
    expect(childTile?.readOnly ?? false).toBe(false);
    expect(childTile?.parentWindowId).toBe(rootWindowId);
    expect(withChild.active_tab_connections[0]?.parent_window_id).toBe(rootWindowId);

    await waitFor(
      'background generic waiting output',
      async () => capturePane(runtime, childTile!.id),
      (text) => text.includes('Waiting for agent output file...') && text.includes('Following agent output:'),
      30_000,
      150,
    );

    await fs.writeFile(
      outputFile,
      `${JSON.stringify({
        parentUuid: null,
        isSidechain: true,
        agentId: resolvedAgentId,
        type: 'user',
        message: {
          role: 'user',
          content: 'Run the background test command.',
        },
      })}\n`
        + `${JSON.stringify({
          parentUuid: 'root-1',
          isSidechain: true,
          agentId: resolvedAgentId,
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'toolu_bg_agent_bash_123',
                name: 'Bash',
                input: {
                  command: 'printf "first line\\nsecond line\\n"',
                  description: 'Emit two lines',
                },
              },
            ],
          },
        })}\n`
        + `${JSON.stringify({
          parentUuid: 'tool-1',
          isSidechain: true,
          agentId: resolvedAgentId,
          type: 'user',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_bg_agent_bash_123',
                content: 'first line\nsecond line',
                is_error: false,
              },
            ],
          },
        })}\n`
        + `${JSON.stringify({
          parentUuid: 'result-1',
          isSidechain: true,
          agentId: resolvedAgentId,
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: 'Agent finished.',
              },
            ],
          },
        })}\n`,
      'utf8',
    );

    const paneText = await waitFor(
      'background generic tailed output',
      async () => capturePane(runtime, childTile!.id),
      (text) =>
        text.includes('Prompt: Run the background test command.')
        && text.includes('[Bash] printf "first line\\nsecond line\\n"')
        && text.includes('first line')
        && text.includes('second line')
        && text.includes('Agent finished.'),
      30_000,
      150,
    );
    expect(paneText).toContain('Prompt: Run the background test command.');
    expect(paneText).toContain('[Bash] printf "first line\\nsecond line\\n"');
    expect(paneText).toContain('first line');
    expect(paneText).toContain('second line');
    expect(paneText).toContain('Agent finished.');
    expect(paneText).not.toContain('"parentUuid"');

    const processCommand = paneProcessCommand(runtime, childTile!.id);
    expect(processCommand).toContain('stream-agent-output.py');
    expect(processCommand).not.toContain(fakeAgentPath);

    await appendTaskNotification(transcriptPath, toolUseId, 'completed', resolvedAgentId);

    const withoutChild = await waitFor(
      'background generic agent tile to close',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_terminals.length === 1,
      30_000,
      150,
    );
    expect(withoutChild.active_tab_terminals[0]?.id).toBe(rootPaneId);
  });

  it('retries generic agent attach when the child command exits immediately', async () => {
    const projection = await createIsolatedTab(client, 'hook-retry-agent');
    const rootTileId = projection.selected_tile_id;
    const rootPaneId = rootTileId ? await backingPaneIdForTile(client, rootTileId) : null;
    const rootWindowId = projection.active_tab_terminals[0]?.windowId;
    expect(rootPaneId).toBeTruthy();
    expect(rootWindowId).toBeTruthy();

    const transcriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'herd-retry-agent-'));
    const transcriptPath = path.join(transcriptDir, 'parent.jsonl');
    const toolUseId = 'toolu_retry_agent_12345678';
    const resolvedAgentId = 'agent-retry-abcdef12';
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: [
                {
                  type: 'text',
                  text: `Async agent launched successfully.\nagentId: ${resolvedAgentId} (internal ID - do not mention to user.)`,
                },
              ],
            },
          ],
        },
      })}\n`,
      'utf8',
    );

    const counterPath = path.join(transcriptDir, 'attach-count.txt');
    const fakeAgentPath = path.join(os.tmpdir(), 'herd-fake-claude-retry-agent.sh');
    await fs.writeFile(
      fakeAgentPath,
      `#!/bin/bash
count=0
if [ -f ${JSON.stringify(counterPath)} ]; then
  count=$(cat ${JSON.stringify(counterPath)})
fi
count=$((count + 1))
printf '%s' "$count" > ${JSON.stringify(counterPath)}
if [ "$count" -lt 3 ]; then
  exit 1
fi
sleep 30
`,
      'utf8',
    );
    await fs.chmod(fakeAgentPath, 0o755);

    await runConfiguredPreToolUseHook(
      'Agent',
      {
        session_id: '55555555-5555-5555-5555-555555555555',
        transcript_path: transcriptPath,
        tool_use_id: toolUseId,
        permission_mode: 'bypassPermissions',
        tool_input: {
          description: 'Retry attach test',
          prompt: 'Retry attach test',
        },
      },
      {
        HERD_SOCK: runtime.socketPath,
        TMUX_PANE: rootPaneId!,
        HERD_CLAUDE_AGENT_BIN: fakeAgentPath,
      },
    );

    const withChild = await waitFor(
      'retry agent hook tile',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_terminals.length === 2
        && nextProjection.active_tab_terminals.some((term) => term.title.startsWith('Agent: Retry attach test')),
      30_000,
      150,
    );

    const childTile = withChild.active_tab_terminals.find((term) => term.id !== rootPaneId);
    expect(childTile).toBeTruthy();
    expect(childTile?.readOnly ?? false).toBe(false);
    expect(childTile?.parentWindowId).toBe(rootWindowId);

    await waitFor(
      'attach retry counter',
      async () => Number.parseInt(await fs.readFile(counterPath, 'utf8'), 10),
      (count) => count >= 3,
      30_000,
      150,
    );

    const paneText = await waitFor(
      'retry pane output',
      async () => capturePane(runtime, childTile!.id),
      (text) => text.includes('Retrying agent attach...'),
      30_000,
      150,
    );
    expect(paneText).toContain('Retrying agent attach...');
    const processCommand = paneProcessCommand(runtime, childTile!.id);
    expect(processCommand).toContain(fakeAgentPath);
    expect(processCommand).toContain('--agent-name retry-attach-test-12345678');
  });

  it('closes a generic agent tile when Claude emits a completed task notification', async () => {
    const projection = await createIsolatedTab(client, 'hook-complete-agent');
    const rootTileId = projection.selected_tile_id;
    const rootPaneId = rootTileId ? await backingPaneIdForTile(client, rootTileId) : null;
    expect(rootPaneId).toBeTruthy();

    const transcriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'herd-complete-agent-'));
    const transcriptPath = path.join(transcriptDir, 'parent.jsonl');
    const toolUseId = 'toolu_complete_agent_12345678';
    const resolvedAgentId = 'agent-complete-abcdef12';
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: [
                {
                  type: 'text',
                  text: `Async agent launched successfully.\nagentId: ${resolvedAgentId} (internal ID - do not mention to user.)`,
                },
              ],
            },
          ],
        },
      })}\n`,
      'utf8',
    );

    const fakeAgentPath = path.join(os.tmpdir(), 'herd-fake-claude-complete-agent.sh');
    await fs.writeFile(
      fakeAgentPath,
      `#!/bin/bash
sleep 300
`,
      'utf8',
    );
    await fs.chmod(fakeAgentPath, 0o755);

    await runConfiguredPreToolUseHook(
      'Agent',
      {
        session_id: '66666666-6666-6666-6666-666666666666',
        transcript_path: transcriptPath,
        tool_use_id: toolUseId,
        permission_mode: 'bypassPermissions',
        tool_input: {
          description: 'Completion close test',
          prompt: 'Completion close test',
        },
      },
      {
        HERD_SOCK: runtime.socketPath,
        TMUX_PANE: rootPaneId!,
        HERD_CLAUDE_AGENT_BIN: fakeAgentPath,
      },
    );

    const withChild = await waitFor(
      'completion watcher agent tile',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_terminals.length === 2,
      30_000,
      150,
    );
    const childTile = withChild.active_tab_terminals.find((term) => term.id !== rootPaneId);
    expect(childTile).toBeTruthy();

    await appendTaskNotification(transcriptPath, toolUseId, 'completed', resolvedAgentId);

    const withoutChild = await waitFor(
      'completed agent tile to close',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_terminals.length === 1,
      30_000,
      150,
    );
    expect(withoutChild.active_tab_terminals[0]?.id).toBe(rootPaneId);
  });

  it('closes a generic agent tile when Claude emits a killed task notification', async () => {
    const projection = await createIsolatedTab(client, 'hook-killed-agent');
    const rootTileId = projection.selected_tile_id;
    const rootPaneId = rootTileId ? await backingPaneIdForTile(client, rootTileId) : null;
    expect(rootPaneId).toBeTruthy();

    const transcriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'herd-killed-agent-'));
    const transcriptPath = path.join(transcriptDir, 'parent.jsonl');
    const toolUseId = 'toolu_killed_agent_12345678';
    const resolvedAgentId = 'agent-killed-abcdef12';
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolUseId,
              content: [
                {
                  type: 'text',
                  text: `Async agent launched successfully.\nagentId: ${resolvedAgentId} (internal ID - do not mention to user.)`,
                },
              ],
            },
          ],
        },
      })}\n`,
      'utf8',
    );

    const fakeAgentPath = path.join(os.tmpdir(), 'herd-fake-claude-killed-agent.sh');
    await fs.writeFile(
      fakeAgentPath,
      `#!/bin/bash
sleep 300
`,
      'utf8',
    );
    await fs.chmod(fakeAgentPath, 0o755);

    await runConfiguredPreToolUseHook(
      'Agent',
      {
        session_id: '77777777-7777-7777-7777-777777777777',
        transcript_path: transcriptPath,
        tool_use_id: toolUseId,
        permission_mode: 'bypassPermissions',
        tool_input: {
          description: 'Killed close test',
          prompt: 'Killed close test',
        },
      },
      {
        HERD_SOCK: runtime.socketPath,
        TMUX_PANE: rootPaneId!,
        HERD_CLAUDE_AGENT_BIN: fakeAgentPath,
      },
    );

    const withChild = await waitFor(
      'killed watcher agent tile',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_terminals.length === 2,
      30_000,
      150,
    );
    const childTile = withChild.active_tab_terminals.find((term) => term.id !== rootPaneId);
    expect(childTile).toBeTruthy();

    await appendTaskNotification(transcriptPath, toolUseId, 'killed', resolvedAgentId);

    const withoutChild = await waitFor(
      'killed agent tile to close',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_terminals.length === 1,
      30_000,
      150,
    );
    expect(withoutChild.active_tab_terminals[0]?.id).toBe(rootPaneId);
  });

  it('creates a read-only background tool tile and skips foreground Bash hooks', async () => {
    const projection = await createIsolatedTab(client, 'hook-bash');
    const rootTileId = projection.selected_tile_id;
    const rootPaneId = rootTileId ? await backingPaneIdForTile(client, rootTileId) : null;
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
    const activeWindowLines = runTmux(runtime, [
      'list-windows',
      '-t',
      current.active_tab_id!,
      '-F',
      '#{window_id}\t#{window_active}',
    ]).split('\n');
    expect(activeWindowLines).toContain(`${rootWindowId}\t1`);
    expect(activeWindowLines).toContain(`${bgTile?.windowId}\t0`);

    const bgOutput = await accumulatePaneOutput(client, bgTile!.id, /Running: sleep 5 && echo done/);
    expect(bgOutput).toContain('Running: sleep 5 && echo done');
  });

  it('closes a background Bash tile when Claude emits a completed task notification', async () => {
    const projection = await createIsolatedTab(client, 'hook-bash-complete');
    const rootTileId = projection.selected_tile_id;
    const rootPaneId = rootTileId ? await backingPaneIdForTile(client, rootTileId) : null;
    expect(rootPaneId).toBeTruthy();

    const transcriptDir = await fs.mkdtemp(path.join(os.tmpdir(), 'herd-bg-complete-'));
    const transcriptPath = path.join(transcriptDir, 'parent.jsonl');
    const toolUseId = 'toolu_bg_complete_12345678';
    await fs.writeFile(transcriptPath, '', 'utf8');

    await runConfiguredPreToolUseHook(
      'Bash',
      {
        transcript_path: transcriptPath,
        tool_use_id: toolUseId,
        tool_input: {
          run_in_background: true,
          command: 'sleep 5 && echo done',
          description: 'BG completion test',
        },
      },
      {
        HERD_SOCK: runtime.socketPath,
        TMUX_PANE: rootPaneId!,
      },
    );

    const withChild = await waitFor(
      'background Bash completion tile',
      () => client.getProjection(),
      (nextProjection) =>
        nextProjection.active_tab_terminals.length === 2
        && nextProjection.active_tab_terminals.some((term) => term.title === 'BG: BG completion test'),
      30_000,
      150,
    );
    const bgTile = withChild.active_tab_terminals.find((term) => term.id !== rootPaneId);
    expect(bgTile).toBeTruthy();

    await appendTaskNotification(transcriptPath, toolUseId, 'completed', 'bg-complete-task');

    const withoutChild = await waitFor(
      'background Bash tile to close',
      () => client.getProjection(),
      (nextProjection) => nextProjection.active_tab_terminals.length === 1,
      30_000,
      150,
    );
    expect(withoutChild.active_tab_terminals[0]?.id).toBe(rootPaneId);
  });
});
