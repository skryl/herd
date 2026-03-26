import { describe, expect, it } from 'vitest';

import {
  gameFileUrl,
  textContent,
  withBrowserContext,
} from '../../../tests/browser-game-helpers';

describe('game-boy', () => {
  it('keeps the game screen visible and the grid toggle usable in compact tile-sized viewports', async () => {
    await withBrowserContext(async (context) => {
      const page = await context.newPage();
      await page.setViewportSize({ width: 640, height: 400 });
      await page.goto(gameFileUrl('extensions/browser/game-boy/index.html'));

      await page.locator('#toggle-grid-overlay').waitFor({ state: 'visible' });

      const layout = await page.evaluate(() => {
        const rect = (selector) => {
          const element = document.querySelector(selector);
          if (!(element instanceof HTMLElement)) {
            return null;
          }
          const box = element.getBoundingClientRect();
          return {
            top: box.top,
            bottom: box.bottom,
            width: box.width,
            height: box.height,
          };
        };
        return {
          viewportHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
          toolbar: rect('.toolbar'),
          toggle: rect('#toggle-grid-overlay'),
          game: rect('#game'),
        };
      });

      expect(layout.toolbar).not.toBeNull();
      expect(layout.toggle).not.toBeNull();
      expect(layout.game).not.toBeNull();
      expect(layout.toggle?.bottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(layout.viewportHeight);
      expect(layout.game?.bottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(layout.viewportHeight);
      expect(layout.game?.height ?? 0).toBeGreaterThan(140);

      await page.locator('#toggle-grid-overlay').click();
      await page.waitForFunction(() => {
        return document.querySelector('#game')?.classList.contains('grid-overlay-visible')
          && document.querySelector('#toggle-grid-overlay')?.textContent === 'Hide Grid';
      });
    });
  });

  it('loads the ROM picker shell and exposes a discoverable extension API', async () => {
    await withBrowserContext(async (context) => {
      const page = await context.newPage();
      await page.goto(gameFileUrl('extensions/browser/game-boy/index.html'));

      await page.locator('#rom-file').waitFor({ state: 'visible' });
      await page.locator('#fullscreen-toggle').waitFor({ state: 'visible' });
      await page.locator('#toggle-grid-overlay').waitFor({ state: 'visible' });
      expect(await textContent(page, '#status')).toBe('Choose a Game Boy ROM to begin.');
      expect(await textContent(page, '#rom-name')).toBe('No ROM loaded.');
      expect(await textContent(page, '#fullscreen-toggle')).toBe('Full Screen');
      expect(await textContent(page, '#toggle-grid-overlay')).toBe('Show Grid');
      expect(await page.locator('#reset-rom').isDisabled()).toBe(true);
      expect(await page.locator('#toggle-pause').isDisabled()).toBe(true);

      await page.evaluate(() => {
        document.querySelector('#fullscreen-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForFunction(() => {
        return document.body.classList.contains('game-screen-fullscreen')
          && document.querySelector('#game')?.classList.contains('game-fullscreen')
          && document.querySelector('#fullscreen-toggle')?.textContent === 'Exit Full Screen';
      });

      await page.evaluate(() => {
        document.querySelector('#fullscreen-toggle')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForFunction(() => {
        return !document.body.classList.contains('game-screen-fullscreen')
          && !document.querySelector('#game')?.classList.contains('game-fullscreen')
          && document.querySelector('#fullscreen-toggle')?.textContent === 'Full Screen';
      });

      await page.waitForFunction(() => {
        return globalThis.HerdBrowserExtension?.call('state')?.core_ready === true;
      }, undefined, { timeout: 20_000 });

      const manifest = await page.evaluate(() => globalThis.HerdBrowserExtension?.manifest);
      expect(manifest).toMatchObject({
        extension_id: 'game-boy',
        label: 'Game Boy',
      });
      expect(manifest.methods.map((method: { name: string }) => method.name)).toEqual(
        expect.arrayContaining([
          'state',
          'load_bundled_rom',
          'screenshot',
          'set_grid_overlay',
          'set_button',
          'button_combo',
          'release_all_buttons',
        ]),
      );

      const stateBeforeLoad = await page.evaluate(() => globalThis.HerdBrowserExtension.call('state'));
      expect(stateBeforeLoad.available_roms).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ filename: 'pokemon_yellow.gb' }),
        ]),
      );
      expect(stateBeforeLoad.grid_overlay_enabled).toBe(false);
      expect(stateBeforeLoad.grid_overlay).toMatchObject({
        columns: 10,
        rows: 9,
        origin: 'bottom_left',
      });

      const loadResult = await page.evaluate(() => {
        return globalThis.HerdBrowserExtension.call('load_bundled_rom', { rom: 'pokemon_yellow.gb' });
      });
      expect(loadResult.state.loaded).toBe(true);
      expect(loadResult.state.rom).toMatchObject({
        filename: 'pokemon_yellow.gb',
        source: 'bundled',
      });
      expect(await textContent(page, '#status')).toBe('Loaded Pokemon Yellow.');
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

      await page.evaluate(() => {
        document.querySelector('#toggle-grid-overlay')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await page.waitForFunction(() => {
        return globalThis.HerdBrowserExtension.call('state').grid_overlay_enabled === true
          && document.querySelector('#game')?.classList.contains('grid-overlay-visible')
          && document.querySelector('#toggle-grid-overlay')?.textContent === 'Hide Grid';
      });

      const overlayCoverage = await page.evaluate(() => {
        const overlay = document.querySelector('#grid-overlay');
        if (!(overlay instanceof HTMLCanvasElement)) {
          return null;
        }
        const ctx = overlay.getContext('2d');
        if (!ctx) {
          return null;
        }
        const alphaPixels = (x: number, y: number, width: number, height: number) => {
          const pixels = ctx.getImageData(x, y, width, height).data;
          let count = 0;
          for (let index = 3; index < pixels.length; index += 4) {
            if (pixels[index] > 0) {
              count += 1;
            }
          }
          return count;
        };
        return {
          gridLine: alphaPixels(16, 68, 1, 8),
          cellLabel: alphaPixels(4, 132, 10, 8),
        };
      });
      expect(overlayCoverage).toMatchObject({
        gridLine: expect.any(Number),
        cellLabel: expect.any(Number),
      });
      expect(overlayCoverage?.gridLine ?? 0).toBeGreaterThan(0);
      expect(overlayCoverage?.cellLabel ?? 0).toBeGreaterThan(0);

      const overlayDisabled = await page.evaluate(() => {
        return globalThis.HerdBrowserExtension.call('set_grid_overlay', { enabled: false });
      });
      expect(overlayDisabled.state.grid_overlay_enabled).toBe(false);
      expect(await textContent(page, '#toggle-grid-overlay')).toBe('Show Grid');

      await page.evaluate(() => {
        globalThis.HerdBrowserExtension.call('toggle_pause');
      });
      const screenshotWithoutGrid = await page.evaluate(() => {
        return globalThis.HerdBrowserExtension.call('screenshot');
      });
      const overlayEnabled = await page.evaluate(() => {
        return globalThis.HerdBrowserExtension.call('set_grid_overlay', { enabled: true });
      });
      expect(overlayEnabled.state.grid_overlay_enabled).toBe(true);
      const screenshotWithGrid = await page.evaluate(() => {
        return globalThis.HerdBrowserExtension.call('screenshot');
      });
      expect(screenshotWithGrid.data_base64).not.toBe(screenshotWithoutGrid.data_base64);

      const comboStarted = await page.evaluate(() => {
        return globalThis.HerdBrowserExtension.call('button_combo', {
          sequence: [
            { buttons: ['start'] },
          ],
          delay_ms: 30,
          hold_ms: 10,
        });
      });
      expect(comboStarted).toMatchObject({
        sequence_length: 1,
        delay_ms: 30,
        hold_ms: 10,
      });
      expect(comboStarted.state.buttons.start).toBe(true);

      await page.waitForFunction(() => {
        return globalThis.HerdBrowserExtension.call('state').buttons.start === false;
      });

      await page.evaluate(() => {
        globalThis.HerdBrowserExtension.call('button_combo', {
          sequence: [
            { buttons: ['start'] },
            { buttons: ['select'] },
          ],
          delay_ms: 40,
          hold_ms: 120,
        });
        return globalThis.HerdBrowserExtension.call('release_all_buttons');
      });
      await page.waitForTimeout(70);
      const canceledState = await page.evaluate(() => {
        return globalThis.HerdBrowserExtension.call('state');
      });
      expect(canceledState.buttons.start).toBe(false);
      expect(canceledState.buttons.select).toBe(false);
    });
  }, 45_000);
});
