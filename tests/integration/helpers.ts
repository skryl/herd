import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'vitest';

import type { TerminalInfo, TestDriverProjection } from '../../src/lib/types';
import { HerdTestClient } from './client';
import type { HerdIntegrationRuntime } from './runtime';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface ClaudeSettings {
  hooks?: {
    PreToolUse?: Array<{
      matcher?: string;
      hooks?: Array<{
        type?: string;
        command?: string;
      }>;
    }>;
  };
}

export function rootDir(): string {
  return ROOT_DIR;
}

export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(
  label: string,
  producer: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 20_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() <= deadline) {
    lastValue = await producer();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}: ${JSON.stringify(lastValue)}`);
}

export function terminalById(terminals: TerminalInfo[], paneId: string): TerminalInfo {
  const terminal = terminals.find((item) => item.id === paneId);
  if (!terminal) {
    throw new Error(`missing terminal for pane ${paneId}`);
  }
  return terminal;
}

export async function createIsolatedTab(client: HerdTestClient, name: string): Promise<TestDriverProjection> {
  const created = await client.toolbarAddTab(name);
  expect(created).toBeTruthy();
  await client.waitForIdle(30_000, 250);
  await client.toolbarSelectTab(created!.id);
  return waitFor(
    `tab ${name} to become active`,
    () => client.getProjection(),
    (projection) => projection.active_tab_id === created!.id && projection.active_tab_terminals.length >= 1,
    30_000,
    150,
  );
}

export async function accumulatePaneOutput(
  client: HerdTestClient,
  paneId: string,
  matcher: RegExp,
  timeoutMs = 20_000,
): Promise<string> {
  let collected = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const result = await client.readOutput(paneId);
    collected += result.output;
    if (matcher.test(collected)) {
      return collected;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for pane ${paneId} output to match ${matcher}: ${collected}`);
}

export async function configuredPreToolUseCommand(matcher: string): Promise<string> {
  const settingsPath = path.join(ROOT_DIR, '.claude', 'settings.json');
  const raw = await fs.readFile(settingsPath, 'utf8');
  const settings = JSON.parse(raw) as ClaudeSettings;
  const configured = settings.hooks?.PreToolUse ?? [];
  const entry = configured.find((item) => item.matcher === matcher);
  const command = entry?.hooks?.find((item) => item.type === 'command')?.command?.trim();
  if (!command) {
    throw new Error(`missing configured PreToolUse command for matcher ${matcher}`);
  }
  return command;
}

export async function runShellHook(
  command: string,
  payload: Record<string, unknown>,
  env: Record<string, string>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const trimmed = command.trim();
    const useShell = /[\s|&;<>()$`"'\\]/.test(trimmed);
    const child = useShell
      ? spawn('/bin/bash', ['-lc', trimmed], {
          cwd: ROOT_DIR,
          env: {
            ...process.env,
            ...env,
          },
          stdio: ['pipe', 'ignore', 'ignore'],
        })
      : spawn(trimmed, {
          cwd: ROOT_DIR,
          env: {
            ...process.env,
            ...env,
          },
          stdio: ['pipe', 'ignore', 'ignore'],
        });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`hook command exited with code ${code ?? 'null'} signal ${signal ?? 'null'}: ${command}`));
    });

    child.stdin.end(`${JSON.stringify(payload)}\n`);
  });
}

export async function runConfiguredPreToolUseHook(
  matcher: string,
  payload: Record<string, unknown>,
  env: Record<string, string>,
): Promise<void> {
  const command = await configuredPreToolUseCommand(matcher);
  await runShellHook(command, payload, env);
}

export function runTmux(runtime: HerdIntegrationRuntime, args: string[]): string {
  const result = spawnSync('tmux', ['-f', '/dev/null', '-L', runtime.runtimeName, ...args], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `tmux command failed (${args.join(' ')}): ${result.stderr?.trim() || result.stdout?.trim() || 'unknown error'}`,
    );
  }
  return result.stdout.trim();
}
