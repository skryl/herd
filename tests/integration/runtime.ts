import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HerdTestClient } from './client';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const START_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 15_000;

function sanitizeRuntimeId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_-]/g, '');
  return sanitized || 'itest';
}

function runtimeName(runtimeId: string): string {
  return `herd-${runtimeId}`;
}

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to reserve port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    try {
      await fs.access(socketPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`timed out waiting for socket ${socketPath}`);
}

async function removeIfExists(targetPath: string): Promise<void> {
  await fs.rm(targetPath, { force: true }).catch(() => undefined);
}

async function killProcessGroup(child: ChildProcess): Promise<void> {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    return;
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if (child.exitCode !== null) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    return;
  }
}

export interface HerdIntegrationRuntime {
  runtimeId: string;
  runtimeName: string;
  socketPath: string;
  client: HerdTestClient;
  stop: () => Promise<void>;
  getLogs: () => string;
}

export async function startIntegrationRuntime(): Promise<HerdIntegrationRuntime> {
  const runtimeId = sanitizeRuntimeId(`itest-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const name = runtimeName(runtimeId);
  const socketPath = `/tmp/${name}.sock`;
  const socketLogPath = path.join(ROOT_DIR, 'tmp', `${name}-socket.log`);
  const ccLogPath = path.join(ROOT_DIR, 'tmp', `${name}-cc.log`);
  const statePath = path.join(ROOT_DIR, 'tmp', `${name}-state.json`);
  const domResultPath = `/tmp/${name}-dom-result.json`;
  const configPath = path.join(os.tmpdir(), `${name}-tauri-dev.json`);
  const port = await reservePort();

  const config = {
    build: {
      devUrl: `http://127.0.0.1:${port}`,
      beforeDevCommand: `npm run dev -- --host 127.0.0.1 --port ${port} --strictPort`,
    },
  };
  await fs.writeFile(configPath, `${JSON.stringify(config)}\n`, 'utf8');

  let stdout = '';
  let stderr = '';
  const child = spawn('npm', ['run', 'tauri', '--', 'dev', '--no-watch', '--config', configPath], {
    cwd: ROOT_DIR,
    detached: true,
    env: {
      ...process.env,
      HERD_RUNTIME_ID: runtimeId,
      HERD_ENABLE_TEST_DRIVER: '1',
      HERD_CLAUDE_MENU_FIXTURE: '{"slash_commands":["clear","model","codex"],"skills":["codex"]}',
      CARGO_TERM_COLOR: 'never',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  const getLogs = () => `${stdout}${stderr}`;
  const client = new HerdTestClient(socketPath);

  try {
    await waitForSocket(socketPath, START_TIMEOUT_MS);
    await client.waitForReady(START_TIMEOUT_MS);
    await client.waitForBootstrap(START_TIMEOUT_MS);
  } catch (error) {
    await killProcessGroup(child);
    spawnSync('tmux', ['-f', '/dev/null', '-L', name, 'kill-server'], { cwd: ROOT_DIR });
    await Promise.all([
      removeIfExists(configPath),
      removeIfExists(socketPath),
      removeIfExists(socketLogPath),
      removeIfExists(ccLogPath),
      removeIfExists(statePath),
      removeIfExists(domResultPath),
    ]);
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n\n${getLogs()}`);
  }

  return {
    runtimeId,
    runtimeName: name,
    socketPath,
    client,
    getLogs,
    stop: async () => {
      await killProcessGroup(child);
      spawnSync('tmux', ['-f', '/dev/null', '-L', name, 'kill-server'], { cwd: ROOT_DIR });
      await Promise.all([
        removeIfExists(configPath),
        removeIfExists(socketPath),
        removeIfExists(socketLogPath),
        removeIfExists(ccLogPath),
        removeIfExists(statePath),
        removeIfExists(domResultPath),
      ]);
    },
  };
}
