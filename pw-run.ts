// Usage: echo "cmd1\ncmd2\n..." | npx tsx pw-run.ts
// Or: npx tsx pw-run.ts "cmd1" "cmd2" ...

import { chromium, type Page } from 'playwright';
import * as net from 'net';
import * as readline from 'readline';

const VITE_URL = 'http://localhost:5173';
const HERD_SOCK = '/tmp/herd.sock';

async function sockCmd(cmd: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(HERD_SOCK);
    sock.on('connect', () => sock.write(JSON.stringify(cmd) + '\n'));
    const rl = readline.createInterface({ input: sock });
    rl.on('line', (line) => {
      try { resolve(JSON.parse(line)); } catch { reject('bad json'); }
      rl.close(); sock.destroy();
    });
    sock.on('error', reject);
    setTimeout(() => { sock.destroy(); reject('timeout'); }, 5000);
  });
}

async function run(page: Page, line: string): Promise<string> {
  if (line === 'mode') {
    return 'Mode: ' + await page.$eval('.mode-badge', (el: any) => el.textContent).catch(() => '?');
  } else if (line === 'tiles') {
    const tiles = await page.$$('.pcb-component');
    let out = `${tiles.length} tile(s)`;
    for (let i = 0; i < tiles.length; i++) {
      const cls = await tiles[i].getAttribute('class') || '';
      const sel = cls.includes('selected') ? ' [SEL]' : '';
      out += `\n  tile${i}${sel}`;
    }
    return out;
  } else if (line === 'debug') {
    return await page.$eval('#herd-debug', (el: any) => el.textContent).catch(() => '(none)');
  } else if (line === 'shells') {
    const resp = await sockCmd({ command: 'list_shells' });
    return resp.data.map((s: any) => `${s.pane_id} sid=${s.id.slice(0, 8)}`).join('\n');
  } else if (line === 'screenshot') {
    await page.screenshot({ path: '/tmp/herd-pw.png' });
    return 'saved /tmp/herd-pw.png';
  } else if (line.startsWith('press ')) {
    await page.keyboard.press(line.slice(6));
    await page.waitForTimeout(300);
    return `pressed ${line.slice(6)}`;
  } else if (line.startsWith('type ')) {
    await page.keyboard.type(line.slice(5), { delay: 50 });
    await page.waitForTimeout(200);
    return `typed "${line.slice(5)}"`;
  } else if (line.startsWith('wait ')) {
    const ms = parseInt(line.slice(5));
    await page.waitForTimeout(ms);
    return `waited ${ms}ms`;
  } else if (line.startsWith('text ')) {
    return await page.$eval(line.slice(5), (el: any) => el.textContent).catch(() => '(not found)');
  } else if (line.startsWith('tmux ')) {
    const { execSync } = await import('child_process');
    return execSync(`tmux -L herd ${line.slice(5)}`, { encoding: 'utf8', timeout: 5000 }).trim();
  } else if (line.startsWith('sock ')) {
    const resp = await sockCmd(JSON.parse(line.slice(5)));
    return JSON.stringify(resp);
  } else if (line.startsWith('sleep ')) {
    await new Promise(r => setTimeout(r, parseInt(line.slice(6)) * 1000));
    return `slept ${line.slice(6)}s`;
  } else {
    return `unknown: ${line}`;
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        if (cmd === 'tmux_status') return { server: true, cc: true };
        if (cmd === 'tmux_tree') return [];
        return null;
      },
      metadata: { currentWebview: { label: 'main' }, currentWindow: { label: 'main' } },
    };
  });

  await page.goto(VITE_URL);
  await page.waitForTimeout(3000);

  // Get commands from args or stdin
  const commands = process.argv.slice(2);

  if (commands.length > 0) {
    for (const cmd of commands) {
      console.log(`> ${cmd}`);
      console.log(await run(page, cmd));
    }
  } else {
    // Read from stdin
    const rl = readline.createInterface({ input: process.stdin });
    for await (const line of rl) {
      if (line.trim() === 'quit') break;
      if (line.trim() === '') continue;
      console.log(`> ${line.trim()}`);
      console.log(await run(page, line.trim()));
    }
  }

  await browser.close();
}

main().catch(e => { console.error(e); process.exit(1); });
