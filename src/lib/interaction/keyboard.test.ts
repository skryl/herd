import { beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

import * as appStateStore from '../stores/appState';
import { handleGlobalKeyInput } from './keyboard';

describe('handleGlobalKeyInput arrange shortcuts', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    appStateStore.appState.set(JSON.parse(JSON.stringify(appStateStore.initialAppState)));
    appStateStore.appState.update((state) => ({
      ...state,
      tmux: {
        ...state.tmux,
        activeSessionId: '$1',
      },
    }));
  });

  it('routes lowercase a to grid alignment instead of the anchored arrange cycle', async () => {
    const alignSpy = vi.spyOn(appStateStore, 'alignSessionToGrid').mockResolvedValue();
    const cycleSpy = vi.spyOn(appStateStore, 'autoArrange').mockResolvedValue();
    const elkSpy = vi.spyOn(appStateStore, 'autoArrangeWithElk').mockResolvedValue();
    const fitSpy = vi.spyOn(appStateStore, 'fitCanvasToActiveTab').mockImplementation(() => undefined);

    const handled = await handleGlobalKeyInput(
      { key: 'a' },
      { viewportWidth: 1280, viewportHeight: 720 },
    );

    expect(handled).toBe(true);
    expect(alignSpy).toHaveBeenCalledWith('$1');
    expect(cycleSpy).not.toHaveBeenCalled();
    expect(elkSpy).not.toHaveBeenCalled();
    expect(fitSpy).not.toHaveBeenCalled();
  });

  it('routes Shift+A to the ELK arrangement path first', async () => {
    const cycleSpy = vi.spyOn(appStateStore, 'autoArrange').mockResolvedValue();
    const elkSpy = vi.spyOn(appStateStore, 'autoArrangeWithElk').mockResolvedValue();
    const fitSpy = vi.spyOn(appStateStore, 'fitCanvasToActiveTab').mockImplementation(() => undefined);

    const handled = await handleGlobalKeyInput(
      { key: 'A', shift_key: true },
      { viewportWidth: 1280, viewportHeight: 720 },
    );

    expect(handled).toBe(true);
    expect(elkSpy).toHaveBeenCalledWith('$1');
    expect(cycleSpy).not.toHaveBeenCalled();
    expect(fitSpy).toHaveBeenCalledWith(1280, 720);
  });

  it('routes Shift+A to the anchored arrange cycle after ELK has already run', async () => {
    appStateStore.appState.update((state) => ({
      ...state,
      ui: {
        ...state.ui,
        arrangementModeBySession: { ...state.ui.arrangementModeBySession, '$1': 'elk' },
      },
    }));
    const cycleSpy = vi.spyOn(appStateStore, 'autoArrange').mockResolvedValue();
    const elkSpy = vi.spyOn(appStateStore, 'autoArrangeWithElk').mockResolvedValue();

    const handled = await handleGlobalKeyInput(
      { key: 'A', shift_key: true },
      { viewportWidth: 1280, viewportHeight: 720 },
    );

    expect(handled).toBe(true);
    expect(cycleSpy).toHaveBeenCalledWith('$1');
    expect(elkSpy).not.toHaveBeenCalled();
  });

  it('routes Shift+A back to ELK after the anchored cycle wraps', async () => {
    appStateStore.appState.update((state) => ({
      ...state,
      ui: {
        ...state.ui,
        arrangementModeBySession: { ...state.ui.arrangementModeBySession, '$1': 'spiral' },
        arrangementCycleBySession: { ...state.ui.arrangementCycleBySession, '$1': 0 },
      },
    }));
    const cycleSpy = vi.spyOn(appStateStore, 'autoArrange').mockResolvedValue();
    const elkSpy = vi.spyOn(appStateStore, 'autoArrangeWithElk').mockResolvedValue();

    const handled = await handleGlobalKeyInput(
      { key: 'A', shift_key: true },
      { viewportWidth: 1280, viewportHeight: 720 },
    );

    expect(handled).toBe(true);
    expect(elkSpy).toHaveBeenCalledWith('$1');
    expect(cycleSpy).not.toHaveBeenCalled();
  });

  it('toggles the settings sidebar with comma and closes the tree sidebar when it opens', async () => {
    appStateStore.appState.update((state) => ({
      ...state,
      ui: {
        ...state.ui,
        sidebarOpen: true,
        settingsSidebarOpen: false,
      },
    }));

    const handled = await handleGlobalKeyInput({ key: ',' });
    const state = get(appStateStore.appState);

    expect(handled).toBe(true);
    expect(state.ui.sidebarOpen).toBe(false);
    expect(state.ui.settingsSidebarOpen).toBe(true);
  });
});
