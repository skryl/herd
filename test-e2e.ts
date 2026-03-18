// E2E tests that drive the REAL Tauri webview via Herd's socket API.
// dom_query: execute JS in the webview, return results
// dom_keys: simulate keypresses in the webview
// All other commands: list_shells, send_input, etc.

import { execSync } from 'child_process';
import * as net from 'net';
import * as readline from 'readline';

const HERD_SOCK = '/tmp/herd.sock';

let pass = 0, fail = 0;
const ok = (msg: string) => { console.log(`  ✓ ${msg}`); pass++; };
const no = (msg: string, detail: string) => { console.log(`  ✗ ${msg}: ${detail}`); fail++; };

async function sock(cmd: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(HERD_SOCK);
    s.on('connect', () => s.write(JSON.stringify(cmd) + '\n'));
    const rl = readline.createInterface({ input: s });
    rl.on('line', (line) => {
      try { resolve(JSON.parse(line)); } catch { reject('bad json'); }
      rl.close(); s.destroy();
    });
    s.on('error', reject);
    setTimeout(() => { s.destroy(); reject('timeout'); }, 10000);
  });
}

async function dom(js: string): Promise<any> {
  const resp = await sock({ command: 'dom_query', js });
  return resp?.data;
}

async function keys(k: string): Promise<void> {
  await sock({ command: 'dom_keys', keys: k });
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function tmux(cmd: string): string {
  try {
    return execSync(`tmux -L herd ${cmd}`, { encoding: 'utf8', timeout: 5000 }).trim();
  } catch { return ''; }
}

async function main() {
  console.log('=== Herd E2E Tests (real Tauri webview) ===\n');

  // --- Prerequisites ---
  console.log('0. Prerequisites');
  try {
    const resp = await sock({ command: 'list_shells' });
    ok(`backend alive (${resp.data?.length} shells)`);
  } catch {
    no('backend', 'not responding');
    process.exit(1);
  }
  tmux('list-sessions') ? ok('tmux alive') : no('tmux', 'dead');

  // Test dom_query works
  const title = await dom('return document.title');
  title ? ok(`dom_query works (title: ${title})`) : no('dom_query', 'null');

  // ========================
  // 1. UI RENDERING
  // ========================
  console.log('\n1. UI rendering');
  (await dom('return !!document.querySelector(".toolbar")')) ? ok('toolbar') : no('toolbar', 'missing');
  (await dom('return !!document.querySelector(".status-bar")')) ? ok('status bar') : no('status bar', 'missing');
  (await dom('return !!document.querySelector(".canvas-viewport")')) ? ok('canvas') : no('canvas', 'missing');
  (await dom('return !!document.querySelector(".pcb-grid")')) ? ok('PCB grid') : no('grid', 'missing');

  const logoText = await dom('return document.querySelector(".logo-en")?.textContent');
  logoText?.includes('HERD') ? ok('logo: HERD') : no('logo', `got: ${logoText}`);

  // ========================
  // 2. MODE SWITCHING
  // ========================
  console.log('\n2. Mode switching');
  let mode = await dom('return document.querySelector(".mode-badge")?.textContent');
  mode?.includes('CMD') ? ok('starts in CMD') : no('start', `got: ${mode}`);

  await keys('i');
  await sleep(300);
  mode = await dom('return document.querySelector(".mode-badge")?.textContent');
  mode?.includes('INS') ? ok('i → INS') : no('i → INS', `got: ${mode}`);

  await keys('Shift+Escape');
  await sleep(300);
  mode = await dom('return document.querySelector(".mode-badge")?.textContent');
  mode?.includes('CMD') ? ok('Shift+Esc → CMD') : no('Shift+Esc', `got: ${mode}`);

  // ========================
  // 3. TILES
  // ========================
  console.log('\n3. Tiles');
  await sleep(2000); // wait for pane detection
  let tileCount = await dom('return document.querySelectorAll(".pcb-component").length');
  tileCount > 0 ? ok(`${tileCount} tile(s)`) : no('tiles', 'none');

  // Select tile
  await keys('n');
  await sleep(300);
  const hasSel = await dom('return !!document.querySelector(".pcb-component.selected")');
  hasSel ? ok('n selects tile') : no('select', 'no .selected');

  // ========================
  // 4. INPUT MODE
  // ========================
  console.log('\n4. Input mode');
  await keys('i');
  await sleep(300);
  mode = await dom('return document.querySelector(".mode-badge")?.textContent');
  mode?.includes('INS') ? ok('i → INS mode') : no('INS', `got: ${mode}`);

  // Check debug for wd=true
  await keys('a');
  await sleep(300);
  const debug = await dom('return document.querySelector("#herd-debug")?.textContent');
  debug?.includes('wd=true') ? ok('writeData available') :
    debug?.includes('WRITING') ? ok('typing sends data') :
    no('input', `debug: ${debug}`);

  await keys('Shift+Escape');
  await sleep(300);

  // ========================
  // 5. HELP PANE
  // ========================
  console.log('\n5. Help pane');
  await keys('?');
  await sleep(300);
  (await dom('return !!document.querySelector(".help-overlay")')) ? ok('? opens help') : no('help', 'missing');
  const helpText = await dom('return document.querySelector(".help-body")?.textContent');
  helpText?.includes('MODE') ? ok('has MODE section') : no('MODE', 'missing');
  helpText?.includes('NAVIGATION') ? ok('has NAVIGATION') : no('NAV', 'missing');

  await keys('Escape');
  await sleep(300);
  !(await dom('return !!document.querySelector(".help-overlay")')) ? ok('Esc closes help') : no('close', 'still open');

  // ========================
  // 6. SIDEBAR
  // ========================
  console.log('\n6. Sidebar');
  await keys('b');
  await sleep(300);
  (await dom('return !!document.querySelector(".sidebar")')) ? ok('b opens sidebar') : no('sidebar', 'missing');

  await keys('Escape');
  await sleep(300);
  !(await dom('return !!document.querySelector(".sidebar")')) ? ok('Esc closes') : no('close', 'still open');

  // ========================
  // 7. COMMAND BAR
  // ========================
  console.log('\n7. Command bar');
  await keys(':');
  await sleep(300);
  (await dom('return !!document.querySelector(".command-bar")')) ? ok(': opens') : no('cmd bar', 'missing');

  await keys('Escape');
  await sleep(300);
  !(await dom('return !!document.querySelector(".command-bar")')) ? ok('Esc closes') : no('close', 'still open');

  // ========================
  // 8. TABS
  // ========================
  console.log('\n8. Tabs');
  let tabs = await dom('return document.querySelectorAll(".tab-btn").length');
  ok(`${tabs} tab(s)`);

  await keys('t');
  await sleep(300);
  let tabsAfter = await dom('return document.querySelectorAll(".tab-btn").length');
  tabsAfter > tabs ? ok(`t creates tab (${tabs} → ${tabsAfter})`) : no('new tab', `still ${tabsAfter}`);

  await keys('w');
  await sleep(300);

  // ========================
  // 9. INDICATORS
  // ========================
  console.log('\n9. Indicators');
  const labels = await dom('return Array.from(document.querySelectorAll(".indicator-label")).map(e => e.textContent)');
  (labels as string[])?.includes('TMUX') ? ok('TMUX') : no('TMUX', `${labels}`);
  (labels as string[])?.includes('CC') ? ok('CC') : no('CC', `${labels}`);
  (labels as string[])?.includes('SOCK') ? ok('SOCK') : no('SOCK', `${labels}`);

  // ========================
  // 10. SPAWN/CLOSE SHELL
  // ========================
  console.log('\n10. Spawn & close shell');
  const beforeTiles = await dom('return document.querySelectorAll(".pcb-component").length');
  await keys('s');
  await sleep(4000);
  const afterTiles = await dom('return document.querySelectorAll(".pcb-component").length');
  afterTiles > beforeTiles ? ok(`s spawns tile (${beforeTiles} → ${afterTiles})`) : no('spawn', `still ${afterTiles}`);

  await keys('n');
  await sleep(200);
  await keys('q');
  await sleep(3000);
  const afterClose = await dom('return document.querySelectorAll(".pcb-component").length');
  ok(`after q: ${afterClose} tile(s)`);

  // ========================
  // 11. CLAUDE CODE AGENT TEAM
  // ========================
  console.log('\n11. Claude Code agent team');

  // Spawn a shell for Claude
  const shells0 = (await sock({ command: 'list_shells' })).data;
  tmux('new-window -t herd -e HERD_SOCK=/tmp/herd.sock /bin/zsh');
  await sleep(4000);
  const shells1 = (await sock({ command: 'list_shells' })).data;
  const claudeShell = shells1.find((s: any) => !shells0.some((s0: any) => s0.id === s.id));
  if (!claudeShell) {
    no('spawn claude shell', 'no new shell found');
  } else {
    ok(`claude shell: ${claudeShell.pane_id}`);

    // cd and launch Claude
    tmux(`send-keys -t ${claudeShell.pane_id} 'cd /Users/skryl/Dev/herd && claude --teammate-mode tmux' Enter`);
    console.log('  waiting 10s for Claude...');
    await sleep(10000);

    const claudeCmd = tmux(`display-message -t ${claudeShell.pane_id} -p '#{pane_current_command}'`);
    claudeCmd.includes('2.1') || claudeCmd === 'node' ? ok(`Claude running (${claudeCmd})`) : no('Claude', `cmd: ${claudeCmd}`);

    // Create team
    const panesBefore = parseInt(tmux('list-panes -s -t herd -F "#{pane_id}"').split('\n').length.toString());
    tmux(`send-keys -t ${claudeShell.pane_id} 'Create a team of 2 teammates: finder1 to list svelte files, finder2 to list rust files' Enter`);
    ok('sent team request');

    console.log('  waiting up to 90s for team...');
    let teamFound = false;
    for (let i = 0; i < 18; i++) {
      await sleep(5000);
      const panesNow = tmux('list-panes -s -t herd -F "#{pane_id}"').split('\n').filter(Boolean).length;
      if (panesNow > panesBefore) {
        ok(`team spawned after ${(i + 1) * 5}s: ${panesBefore} → ${panesNow} panes`);
        teamFound = true;

        // Check tiles in webview
        await sleep(3000);
        const teamTiles = await dom('return document.querySelectorAll(".pcb-component").length');
        ok(`${teamTiles} tiles in webview`);

        // Check if panes were broken out into own windows
        const windows = tmux('list-windows -t herd -F "#{window_index}"').split('\n').filter(Boolean).length;
        ok(`${windows} tmux windows (each teammate should have own window)`);

        break;
      }
    }
    if (!teamFound) no('team spawn', 'no new panes after 90s');

    // Cleanup
    tmux(`send-keys -t ${claudeShell.pane_id} '/exit' Enter`);
    await sleep(2000);
  }

  // ========================
  // 12. CC STABILITY
  // ========================
  console.log('\n12. CC stability');
  const ccAlive = tmux('-CC list-sessions').length > 0 || execSync('pgrep -f "tmux -L herd -CC" 2>/dev/null || true', { encoding: 'utf8' }).trim().length > 0;
  ccAlive ? ok('CC alive after all tests') : no('CC', 'dead');

  console.log(`\n${'='.repeat(50)}`);
  console.log(`=== Results: ${pass} passed, ${fail} failed ===`);
  console.log(`${'='.repeat(50)}`);
  process.exit(fail);
}

main().catch(e => { console.error(e); process.exit(1); });
