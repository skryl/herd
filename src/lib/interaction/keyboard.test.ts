import { beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('keeps lowercase a on the existing auto-arrange cycle', async () => {
    const cycleSpy = vi.spyOn(appStateStore, 'autoArrange').mockResolvedValue();
    const elkSpy = vi.spyOn(appStateStore, 'autoArrangeWithElk').mockResolvedValue();
    const fitSpy = vi.spyOn(appStateStore, 'fitCanvasToActiveTab').mockImplementation(() => undefined);

    const handled = await handleGlobalKeyInput(
      { key: 'a' },
      { viewportWidth: 1280, viewportHeight: 720 },
    );

    expect(handled).toBe(true);
    expect(cycleSpy).toHaveBeenCalledWith('$1');
    expect(elkSpy).not.toHaveBeenCalled();
    expect(fitSpy).toHaveBeenCalledWith(1280, 720);
  });

  it('routes Shift+A to the ELK arrangement path instead of the lowercase cycle', async () => {
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
});
