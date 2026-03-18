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

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Mock Tauri IPC
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
  console.log('Connected to Herd UI at ' + VITE_URL);
  console.log('Type commands: screenshot, press <key>, click <selector>, text <selector>, mode, tiles, shells, tmux <cmd>, quit');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: 'pw> ' });
  rl.prompt();

  rl.on('line', async (input) => {
    const line = input.trim();
    try {
      if (line === 'quit' || line === 'exit') {
        await browser.close();
        process.exit(0);
      } else if (line === 'screenshot') {
        await page.screenshot({ path: '/tmp/herd-pw.png' });
        console.log('Saved to /tmp/herd-pw.png');
      } else if (line.startsWith('press ')) {
        const key = line.slice(6);
        await page.keyboard.press(key);
        await page.waitForTimeout(300);
        console.log(`Pressed: ${key}`);
      } else if (line.startsWith('type ')) {
        const text = line.slice(5);
        await page.keyboard.type(text);
        await page.waitForTimeout(200);
        console.log(`Typed: ${text}`);
      } else if (line.startsWith('click ')) {
        const sel = line.slice(6);
        await page.click(sel);
        await page.waitForTimeout(300);
        console.log(`Clicked: ${sel}`);
      } else if (line.startsWith('text ')) {
        const sel = line.slice(5);
        const t = await page.$eval(sel, (el: any) => el.textContent);
        console.log(t);
      } else if (line === 'mode') {
        const m = await page.$eval('.mode-badge', (el: any) => el.textContent);
        console.log(`Mode: ${m}`);
      } else if (line === 'tiles') {
        const tiles = await page.$$('.pcb-component');
        console.log(`${tiles.length} tile(s)`);
        for (let i = 0; i < tiles.length; i++) {
          const cls = await tiles[i].getAttribute('class');
          const style = await tiles[i].getAttribute('style');
          const selected = cls?.includes('selected') ? ' [SELECTED]' : '';
          console.log(`  tile ${i}${selected}: ${style?.slice(0, 60)}`);
        }
      } else if (line === 'debug') {
        const d = await page.$eval('#herd-debug', (el: any) => el.textContent).catch(() => '(none)');
        console.log(`Debug: ${d}`);
      } else if (line === 'shells') {
        const resp = await sockCmd({ command: 'list_shells' });
        for (const s of resp.data) {
          console.log(`  ${s.pane_id} sid=${s.id.slice(0, 8)}`);
        }
      } else if (line.startsWith('tmux ')) {
        const args = line.slice(5).split(' ');
        const { execSync } = await import('child_process');
        const out = execSync(`tmux -L herd ${args.join(' ')}`, { encoding: 'utf8', timeout: 5000 }).trim();
        console.log(out);
      } else if (line.startsWith('sock ')) {
        const json = line.slice(5);
        const resp = await sockCmd(JSON.parse(json));
        console.log(JSON.stringify(resp, null, 2));
      } else if (line === 'help') {
        console.log('Commands: screenshot, press <key>, type <text>, click <sel>, text <sel>, mode, tiles, debug, shells, tmux <args>, sock <json>, quit');
      } else {
        console.log('Unknown command. Type "help".');
      }
    } catch (e) {
      console.error(String(e));
    }
    rl.prompt();
  });
}

main().catch(e => { console.error(e); process.exit(1); });
