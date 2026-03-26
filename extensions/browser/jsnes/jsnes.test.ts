import { describe, expect, it, vi } from 'vitest';

import {
  gameFileUrl,
  textContent,
  withBrowserContext,
} from '../../../tests/browser-game-helpers';

import './logic.js';

const {
  BUTTON_NAMES,
  JSNES_EXTENSION_MANIFEST,
  createJsnesController,
} = (globalThis as any).JsnesExtensionLogic;

function ctx(senderTileId: string, senderAgentId = `${senderTileId}-agent`) {
  return {
    sender_tile_id: senderTileId,
    sender_agent_id: senderAgentId,
    sender_agent_role: 'worker',
  };
}

function tinyNesRomBase64() {
  const header = Uint8Array.from([
    0x4e, 0x45, 0x53, 0x1a,
    0x01,
    0x01,
    0x00,
    0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
  const prg = new Uint8Array(16 * 1024).fill(0xea);
  prg.set([0x78, 0xd8, 0x4c, 0x00, 0x80], 0);
  prg[0x3ffa] = 0x00;
  prg[0x3ffb] = 0x80;
  prg[0x3ffc] = 0x00;
  prg[0x3ffd] = 0x80;
  prg[0x3ffe] = 0x00;
  prg[0x3fff] = 0x80;
  const chr = new Uint8Array(8 * 1024);
  return Buffer.from(Uint8Array.from([...header, ...prg, ...chr])).toString('base64');
}

describe('jsnes extension controller', () => {
  it('claims one player per caller tile and routes button updates to the correct emulator controller', () => {
    const calls: Array<{ type: string; player?: number; button?: string; pressed?: boolean; paused?: boolean }> = [];
    const emulator = {
      loadRom(_bytes: Uint8Array) {
        calls.push({ type: 'load_rom' });
      },
      reset() {
        calls.push({ type: 'reset' });
      },
      setPaused(paused: boolean) {
        calls.push({ type: 'pause', paused });
      },
      setButton(player: number, button: string, pressed: boolean) {
        calls.push({ type: 'button', player, button, pressed });
      },
      releaseAllButtons(player: number) {
        calls.push({ type: 'release_all', player });
      },
    };

    const controller = createJsnesController();
    controller.attachEmulator(emulator);

    const claimedOne = controller.call('claim_player', { player: 1, name: 'North' }, ctx('tile-one'));
    const claimedTwo = controller.call('claim_player', { player: 2, name: 'South' }, ctx('tile-two'));
    controller.call('load_rom_base64', {
      filename: 'tiny-test.nes',
      data_base64: tinyNesRomBase64(),
    }, ctx('tile-one'));
    const pressedOne = controller.call('set_button', { button: 'start', pressed: true }, ctx('tile-one'));
    const pressedTwo = controller.call('set_button', { button: 'a', pressed: true }, ctx('tile-two'));
    const releasedTwo = controller.call('release_all_buttons', {}, ctx('tile-two'));

    expect(claimedOne.player.player).toBe(1);
    expect(claimedTwo.player.player).toBe(2);
    expect(pressedOne.state.players.find((player: any) => player.player === 1).buttons.start).toBe(true);
    expect(pressedTwo.state.players.find((player: any) => player.player === 2).buttons.a).toBe(true);
    expect(releasedTwo.state.players.find((player: any) => player.player === 2).buttons.a).toBe(false);
    expect(calls).toEqual([
      { type: 'load_rom' },
      { type: 'button', player: 1, button: 'start', pressed: true },
      { type: 'button', player: 2, button: 'a', pressed: true },
      { type: 'release_all', player: 2 },
    ]);
  });

  it('loads ROM data from base64 and rejects player stealing', () => {
    const loadedRoms: number[] = [];
    const controller = createJsnesController();
    controller.attachEmulator({
      loadRom(bytes: Uint8Array) {
        loadedRoms.push(bytes.length);
      },
      reset() {},
      setPaused() {},
      setButton() {},
      releaseAllButtons() {},
    });

    controller.call('claim_player', { player: 1, name: 'North' }, ctx('tile-one'));

    expect(() => controller.call('claim_player', { player: 1, name: 'Rival' }, ctx('tile-two'))).toThrow(/already claimed/i);
    const loaded = controller.call('load_rom_base64', {
      filename: 'tiny-test.nes',
      data_base64: tinyNesRomBase64(),
    }, ctx('tile-one'));

    expect(loaded.state.loaded).toBe(true);
    expect(loaded.state.rom).toMatchObject({
      filename: 'tiny-test.nes',
      source: 'api',
    });
    expect(loadedRoms[0]).toBeGreaterThan(16);
    expect(loaded.state.available_buttons).toEqual(BUTTON_NAMES);
  });

  it('loads a bundled ROM when the registry exposes one', () => {
    const loadedRoms: number[] = [];
    (globalThis as any).JsnesBundledRoms = {
      'contra.nes': {
        label: 'Contra',
        size: 1234,
        dataBase64: tinyNesRomBase64(),
      },
    };

    const controller = createJsnesController();
    controller.attachEmulator({
      loadRom(bytes: Uint8Array) {
        loadedRoms.push(bytes.length);
      },
      reset() {},
      setPaused() {},
      setButton() {},
      releaseAllButtons() {},
    });

    const loaded = controller.call('load_bundled_rom', { rom: 'contra.nes' }, ctx('tile-one'));

    expect(loaded.state.loaded).toBe(true);
    expect(loaded.state.rom).toMatchObject({
      filename: 'contra.nes',
      source: 'bundled',
    });
    expect(loaded.state.available_roms).toEqual([
      expect.objectContaining({
        filename: 'contra.nes',
        label: 'Contra',
      }),
    ]);
    expect(loadedRoms[0]).toBeGreaterThan(16);
  });

  it('plays scheduled button combos for the caller-owned player and cancels stale playback', async () => {
    vi.useFakeTimers();
    try {
      const calls: Array<{ type: string; player?: number; button?: string; pressed?: boolean }> = [];
      const controller = createJsnesController();
      controller.attachEmulator({
        loadRom() {},
        reset() {},
        setPaused() {},
        setButton(player: number, button: string, pressed: boolean) {
          calls.push({ type: 'button', player, button, pressed });
        },
        releaseAllButtons(player: number) {
          calls.push({ type: 'release_all', player });
        },
      });

      controller.call('claim_player', { player: 1, name: 'North' }, ctx('tile-one'));
      controller.call('load_rom_base64', {
        filename: 'tiny-test.nes',
        data_base64: tinyNesRomBase64(),
      }, ctx('tile-one'));

      const comboStarted = controller.call('button_combo', {
        sequence: [
          { buttons: ['a'] },
          { buttons: ['b'] },
        ],
        delay_ms: 30,
        hold_ms: 10,
      }, ctx('tile-one'));
      expect(comboStarted).toMatchObject({
        sequence_length: 2,
        delay_ms: 30,
        hold_ms: 10,
      });
      expect(comboStarted.player.buttons.a).toBe(true);
      expect(comboStarted.player.buttons.b).toBe(false);

      await vi.advanceTimersByTimeAsync(15);
      expect(controller.call('state').players.find((player: any) => player.player === 1).buttons.a).toBe(false);

      await vi.advanceTimersByTimeAsync(20);
      expect(controller.call('state').players.find((player: any) => player.player === 1).buttons.b).toBe(true);

      controller.call('button_combo', {
        sequence: [
          { buttons: ['start'] },
          { buttons: ['select'] },
        ],
        delay_ms: 40,
        hold_ms: 120,
      }, ctx('tile-one'));
      controller.call('release_all_buttons', {}, ctx('tile-one'));

      await vi.advanceTimersByTimeAsync(70);
      const player = controller.call('state').players.find((entry: any) => entry.player === 1);
      expect(player.buttons.start).toBe(false);
      expect(player.buttons.select).toBe(false);
      expect(calls).toEqual(
        expect.arrayContaining([
          { type: 'button', player: 1, button: 'a', pressed: true },
          { type: 'button', player: 1, button: 'a', pressed: false },
          { type: 'button', player: 1, button: 'b', pressed: true },
          { type: 'button', player: 1, button: 'start', pressed: true },
          { type: 'release_all', player: 1 },
        ]),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('jsnes browser page', () => {
  it('loads the page shell and exposes a discoverable extension API', async () => {
    await withBrowserContext(async (context) => {
      const page = await context.newPage();
      await page.goto(gameFileUrl('extensions/browser/jsnes/index.html'));

      await page.locator('#rom-file').waitFor({ state: 'visible' });
      await page.locator('#load-bundled-rom').waitFor({ state: 'visible' });
      await page.locator('#fullscreen-toggle').waitFor({ state: 'visible' });
      expect(await textContent(page, '#status')).toBe('Choose an NES ROM to begin.');
      expect(await textContent(page, '#rom-name')).toBe('No ROM loaded.');
      expect(await textContent(page, '#load-bundled-rom')).toBe('Load Contra');
      expect(await textContent(page, '#fullscreen-toggle')).toBe('Full Screen');
      expect(await page.locator('#reset-rom').isDisabled()).toBe(true);
      expect(await page.locator('#toggle-pause').isDisabled()).toBe(true);

      await page.click('#fullscreen-toggle');
      await page.waitForFunction(() => {
        return document.body.classList.contains('game-screen-fullscreen')
          && document.querySelector('#screen-host')?.classList.contains('game-fullscreen')
          && document.querySelector('#fullscreen-toggle')?.textContent === 'Exit Full Screen';
      });

      await page.click('#fullscreen-toggle');
      await page.waitForFunction(() => {
        return !document.body.classList.contains('game-screen-fullscreen')
          && !document.querySelector('#screen-host')?.classList.contains('game-fullscreen')
          && document.querySelector('#fullscreen-toggle')?.textContent === 'Full Screen';
      });

      await page.waitForFunction(() => {
        return globalThis.HerdBrowserExtension?.call('state')?.core_ready === true;
      }, undefined, { timeout: 20_000 });

      const manifest = await page.evaluate(() => globalThis.HerdBrowserExtension?.manifest);
      expect(manifest).toMatchObject({
        extension_id: JSNES_EXTENSION_MANIFEST.extension_id,
        label: JSNES_EXTENSION_MANIFEST.label,
      });
      expect(manifest.methods.map((method: { name: string }) => method.name)).toEqual(
        expect.arrayContaining([
          'state',
          'claim_player',
          'release_player',
          'load_bundled_rom',
          'load_rom_base64',
          'reset',
          'toggle_pause',
          'screenshot',
          'set_button',
          'button_combo',
          'release_all_buttons',
        ]),
      );

      await page.click('#load-bundled-rom');
      const loadResult = await page.evaluate(() => {
        return globalThis.HerdBrowserExtension.call('state');
      });
      expect(loadResult.loaded).toBe(true);
      expect(loadResult.rom).toMatchObject({
        filename: 'contra.nes',
        source: 'bundled',
      });
      expect(await textContent(page, '#status')).toBe('Loaded contra.nes.');
      expect(await page.locator('#reset-rom').isDisabled()).toBe(false);

      const screenshot = await page.evaluate(() => {
        return globalThis.HerdBrowserExtension.call('screenshot');
      });
      expect(screenshot).toMatchObject({
        kind: 'png_base64',
        mime_type: 'image/png',
      });
      expect(typeof screenshot.data_base64).toBe('string');
      expect(screenshot.data_base64.length).toBeGreaterThan(100);
    });
  }, 30_000);
});
