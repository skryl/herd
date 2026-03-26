import { beforeEach, describe, expect, it, vi } from 'vitest';

const appStateMocks = vi.hoisted(() => ({
  autoArrangeWithElk: vi.fn(),
  fitCanvasToActiveTab: vi.fn(),
}));
const tabMocks = vi.hoisted(() => {
  const state: { value: string | null } = { value: '$1' };
  return {
    state,
    activeTabId: {
      subscribe(run: (value: string | null) => void) {
        run(state.value);
        return () => undefined;
      },
    },
  };
});

vi.mock('./stores/appState', () => appStateMocks);
vi.mock('./stores/tabs', () => ({ activeTabId: tabMocks.activeTabId }));

import { handleArrangeElkEvent } from './appEvents';

describe('handleArrangeElkEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tabMocks.state.value = '$1';
    Object.defineProperty(globalThis, 'window', {
      value: { innerWidth: 1280, innerHeight: 720 },
      configurable: true,
      writable: true,
    });
  });

  it('routes herd-arrange-elk events to the ELK arranger for the requested session', async () => {
    await handleArrangeElkEvent({ session_id: '$1' });

    expect(appStateMocks.autoArrangeWithElk).toHaveBeenCalledWith('$1');
    expect(appStateMocks.fitCanvasToActiveTab).toHaveBeenCalledWith(1280, 666);
  });

  it('passes null through when the payload omits a session id', async () => {
    await handleArrangeElkEvent({});

    expect(appStateMocks.autoArrangeWithElk).toHaveBeenCalledWith(null);
    expect(appStateMocks.fitCanvasToActiveTab).not.toHaveBeenCalled();
  });

  it('does not fit the canvas when arranging a non-active session', async () => {
    tabMocks.state.value = '$2';

    await handleArrangeElkEvent({ session_id: '$1' });

    expect(appStateMocks.autoArrangeWithElk).toHaveBeenCalledWith('$1');
    expect(appStateMocks.fitCanvasToActiveTab).not.toHaveBeenCalled();
  });
});
