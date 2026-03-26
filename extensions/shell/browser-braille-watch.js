#!/usr/bin/env node

import net from 'node:net';
import { spawnSync } from 'node:child_process';

const DEFAULT_SOCKET_PATH = '/tmp/herd.sock';
const DEFAULT_COLUMNS = 80;
const MIN_COLUMNS = 10;
const MAX_COLUMNS = 200;
const SOCKET_TIMEOUT_MS = 10_000;
const TEXT_SCREENSHOT_FORMATS = new Set(['braille', 'ascii', 'ansi', 'text']);

function printHelp() {
  console.log(`Usage:
  browser-braille-watch.js [--socket <path>] [--format <braille|ascii|ansi|text>] [--columns <n>] [--sender-tile-id <tile-id>] [--sender-agent-id <agent-id>] <browser-tile-id> <interval>

Watches a browser tile and redraws a text screenshot every interval.

Arguments:
  <browser-tile-id>   Herd browser tile id to capture
  <interval>          Refresh interval. Bare numbers mean seconds.
                      Supported suffixes: ms, s, m, h

Options:
  --socket <path>     Herd socket path. Defaults to HERD_SOCK, then HERD_RUNTIME_ID,
                      then ${DEFAULT_SOCKET_PATH}
  --format <name>     Screenshot format: braille, ascii, ansi, or text. Defaults to braille
                      text uses the browser text renderer
  --columns <n>       Text screenshot width in columns (${MIN_COLUMNS}-${MAX_COLUMNS})
  --sender-tile-id    Sender shell tile id. Defaults to HERD_TILE_ID, then the current Herd tmux pane
  --sender-agent-id   Sender agent id. Defaults to HERD_AGENT_ID
  -h, --help          Show this help

Examples:
  ./extensions/shell/browser-braille-watch.js GGDCrI 2
  ./extensions/shell/browser-braille-watch.js GGDCrI 500ms
  ./extensions/shell/browser-braille-watch.js --format ascii GGDCrI 1s
  ./extensions/shell/browser-braille-watch.js --format ansi --columns 120 GGDCrI 1s
  ./extensions/shell/browser-braille-watch.js --format text GGDCrI 1s
  ./extensions/shell/browser-braille-watch.js --columns 120 GGDCrI 1s
  ./extensions/shell/browser-braille-watch.js --sender-tile-id AbCdEf GGDCrI 1s`);
}

function fail(message) {
  throw new Error(message);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function resolveDefaultSocketPath() {
  if (process.env.HERD_SOCK) return process.env.HERD_SOCK;
  const runtimeId = process.env.HERD_RUNTIME_ID?.trim();
  if (runtimeId) return `/tmp/herd-${runtimeId}.sock`;
  return DEFAULT_SOCKET_PATH;
}

function nonEmptyEnv(name) {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

function tmuxDisplay(format) {
  const result = spawnSync('tmux', ['display-message', '-p', format], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value ? value : null;
}

function parseInterval(rawValue) {
  const value = rawValue.trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i.exec(value);
  if (!match) {
    fail(`invalid interval "${rawValue}". Use values like 500ms, 2s, 1.5m, or 2`);
  }

  const amount = Number(match[1]);
  const unit = (match[2] ?? 's').toLowerCase();
  const multiplier = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
  }[unit];

  const intervalMs = Math.round(amount * multiplier);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    fail(`interval must be greater than zero, got "${rawValue}"`);
  }

  return intervalMs;
}

function parseColumns(rawValue) {
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value)) {
    fail(`columns must be an integer, got "${rawValue}"`);
  }
  if (value < MIN_COLUMNS || value > MAX_COLUMNS) {
    fail(`columns must be between ${MIN_COLUMNS} and ${MAX_COLUMNS}, got ${value}`);
  }
  return value;
}

function parseFormat(rawValue) {
  const value = rawValue.trim().toLowerCase();
  if (!TEXT_SCREENSHOT_FORMATS.has(value)) {
    fail(`format must be one of braille, ascii, ansi, or text, got "${rawValue}"`);
  }
  return value;
}

function formatLabel(format) {
  return format[0].toUpperCase() + format.slice(1);
}

function autoColumns() {
  const ttyWidth = typeof process.stdout.columns === 'number' ? process.stdout.columns : DEFAULT_COLUMNS;
  return clamp(ttyWidth - 1, MIN_COLUMNS, MAX_COLUMNS);
}

function parseArgs(argv) {
  let socketPath = resolveDefaultSocketPath();
  let format = 'braille';
  let explicitColumns = null;
  let senderTileId = nonEmptyEnv('HERD_TILE_ID');
  let senderAgentId = nonEmptyEnv('HERD_AGENT_ID');
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') {
      return { help: true };
    }
    if (arg === '--socket') {
      index += 1;
      const value = argv[index];
      if (!value) fail('--socket requires a value');
      socketPath = value;
      continue;
    }
    if (arg === '--format') {
      index += 1;
      const value = argv[index];
      if (!value) fail('--format requires a value');
      format = parseFormat(value);
      continue;
    }
    if (arg === '--columns') {
      index += 1;
      const value = argv[index];
      if (!value) fail('--columns requires a value');
      explicitColumns = parseColumns(value);
      continue;
    }
    if (arg === '--sender-tile-id') {
      index += 1;
      const value = argv[index];
      if (!value) fail('--sender-tile-id requires a value');
      senderTileId = value;
      continue;
    }
    if (arg === '--sender-agent-id') {
      index += 1;
      const value = argv[index];
      if (!value) fail('--sender-agent-id requires a value');
      senderAgentId = value;
      continue;
    }
    if (arg.startsWith('-')) {
      fail(`unknown option "${arg}"`);
    }
    positionals.push(arg);
  }

  if (positionals.length !== 2) {
    fail('expected <browser-tile-id> and <interval>');
  }

  return {
    help: false,
    socketPath,
    format,
    tileId: positionals[0],
    intervalMs: parseInterval(positionals[1]),
    intervalLabel: positionals[1],
    explicitColumns,
    senderTileId,
    senderAgentId,
  };
}

async function resolveSenderTileId(socketPath, explicitSenderTileId) {
  if (explicitSenderTileId) return explicitSenderTileId;

  const paneId = nonEmptyEnv('TMUX_PANE') ?? tmuxDisplay('#{pane_id}');
  const windowId = tmuxDisplay('#{window_id}');
  if (!paneId && !windowId) {
    fail('HERD_TILE_ID is required. Run this from a Herd shell or pass --sender-tile-id <tile-id>.');
  }

  const response = await requestJson(socketPath, {
    channel: 'cli',
    command: 'tile_list',
  });
  if (!response?.ok) {
    throw new Error(response?.error || 'tile_list failed while resolving sender tile');
  }

  const tiles = Array.isArray(response.data?.tiles) ? response.data.tiles : null;
  if (!tiles) {
    throw new Error('tile_list returned an unexpected payload while resolving sender tile');
  }

  const paneMatches = paneId ? tiles.filter((tile) => tile?.pane_id === paneId) : [];
  if (paneMatches.length === 1 && typeof paneMatches[0]?.tile_id === 'string') {
    return paneMatches[0].tile_id;
  }
  if (paneMatches.length > 1) {
    throw new Error(`current tmux pane ${paneId} matched multiple Herd tiles; pass --sender-tile-id explicitly`);
  }

  const windowMatches = windowId ? tiles.filter((tile) => tile?.window_id === windowId) : [];
  if (windowMatches.length === 1 && typeof windowMatches[0]?.tile_id === 'string') {
    return windowMatches[0].tile_id;
  }
  if (windowMatches.length > 1) {
    throw new Error(`current tmux window ${windowId} matched multiple Herd tiles; pass --sender-tile-id explicitly`);
  }

  const location = paneId ? `tmux pane ${paneId}` : `tmux window ${windowId}`;
  throw new Error(`could not resolve a Herd tile for ${location}; pass --sender-tile-id <tile-id>`);
}

function requestJson(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      fn(value);
    };

    const timeout = setTimeout(() => {
      finish(reject, new Error(`timed out waiting for Herd socket response from ${socketPath}`));
    }, SOCKET_TIMEOUT_MS);

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(payload)}\n`);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) return;

      const line = buffer.slice(0, newlineIndex);
      try {
        finish(resolve, JSON.parse(line));
      } catch (error) {
        finish(reject, new Error(`invalid JSON from Herd socket: ${error.message}`));
      }
    });

    socket.on('error', (error) => {
      finish(reject, new Error(`failed to connect to Herd socket at ${socketPath}: ${error.message}`));
    });

    socket.on('end', () => {
      if (!settled) {
        finish(reject, new Error('Herd socket closed before sending a full response'));
      }
    });
  });
}

async function fetchTextScreenshot(socketPath, tileId, format, columns, senderTileId, senderAgentId) {
  const response = await requestJson(socketPath, {
    channel: 'cli',
    command: 'browser_drive',
    tile_id: tileId,
    action: 'screenshot',
    sender_tile_id: senderTileId,
    sender_agent_id: senderAgentId,
    args: {
      format,
      columns,
    },
  });

  if (!response?.ok) {
    throw new Error(response?.error || 'browser_drive screenshot failed');
  }

  const result = response.data?.result ?? response.data;
  if (result?.format !== format || typeof result.text !== 'string') {
    throw new Error('browser_drive screenshot returned an unexpected payload');
  }

  return {
    format: result.format,
    text: result.text,
    columns: result.columns,
    rows: result.rows,
  };
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z');
}

let firstRedraw = true;

function redraw(text) {
  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[H\x1b[2J');
  } else if (!firstRedraw) {
    process.stdout.write('\n');
  }
  firstRedraw = false;
  process.stdout.write(text);
  if (!text.endsWith('\n')) {
    process.stdout.write('\n');
  }
}

function renderFrame({ format, tileId, intervalLabel, columns, rows, text }) {
  const header = `${formatLabel(format)} watch | tile ${tileId} | every ${intervalLabel} | ${columns}x${rows} | ${timestamp()}`;
  const body = format === 'ansi' ? `${text}\x1b[0m` : text;
  redraw(`${header}\n\n${body}`);
}

function renderError({ format, tileId, intervalLabel, socketPath, error }) {
  const message = [
    `${formatLabel(format)} watch | tile ${tileId} | every ${intervalLabel} | ${timestamp()}`,
    '',
    `socket: ${socketPath}`,
    `ERROR: ${error.message}`,
  ].join('\n');
  redraw(message);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const senderTileId = await resolveSenderTileId(options.socketPath, options.senderTileId);

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (process.stdout.isTTY) {
      process.stdout.write('\x1b[?25h');
    }
  };

  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });

  if (process.stdout.isTTY) {
    process.stdout.write('\x1b[?25l');
  }

  let nextTickAt = Date.now();
  for (;;) {
    const columns = options.explicitColumns ?? autoColumns();
    try {
      const frame = await fetchTextScreenshot(
        options.socketPath,
        options.tileId,
        options.format,
        columns,
        senderTileId,
        options.senderAgentId,
      );
      renderFrame({
        format: frame.format,
        tileId: options.tileId,
        intervalLabel: options.intervalLabel,
        columns: frame.columns,
        rows: frame.rows,
        text: frame.text,
      });
    } catch (error) {
      renderError({
        format: options.format,
        tileId: options.tileId,
        intervalLabel: options.intervalLabel,
        socketPath: options.socketPath,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }

    const now = Date.now();
    if (nextTickAt < now - options.intervalMs) {
      nextTickAt = now;
    }
    nextTickAt += options.intervalMs;
    const delayMs = Math.max(0, nextTickAt - now);
    await sleep(delayMs);
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
}
