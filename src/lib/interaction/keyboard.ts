import { get } from 'svelte/store';

import type { TestDriverKey } from '../types';
import {
  activeTabId,
  addTab,
  appState,
  autoArrange,
  beginSidebarRename,
  closeSidebar,
  closeTabConfirmation,
  commandBarOpen,
  dispatchIntent,
  fitCanvasToActiveTab,
  helpOpen,
  mode,
  moveSelectedTerminalBy,
  moveSidebarSelection,
  nextTab,
  panCanvasBy,
  prevTab,
  selectedTerminalId,
  selectDirectional,
  selectNextTerminal,
  selectPrevTerminal,
  sidebarOpen,
  zoomCanvasAtViewportCenter,
} from '../stores/appState';

const CANVAS_PAN_STEP = 80;
const WINDOW_MOVE_STEP = 10;

export interface KeyboardActionContext {
  viewportWidth?: number;
  viewportHeight?: number;
  onHandled?: () => void;
}

function viewportWidth(context?: KeyboardActionContext): number {
  return context?.viewportWidth ?? window.innerWidth;
}

function viewportHeight(context?: KeyboardActionContext): number {
  return context?.viewportHeight ?? (window.innerHeight - 54);
}

export function keyInputToData(input: TestDriverKey): string | null {
  if (input.meta_key || input.alt_key) return null;
  if (input.key === 'Enter') return '\r';
  if (input.key === 'Backspace') return '\x7f';
  if (input.key === 'Tab') return '\t';
  if (input.key === 'ArrowUp') return '\x1b[A';
  if (input.key === 'ArrowDown') return '\x1b[B';
  if (input.key === 'ArrowRight') return '\x1b[C';
  if (input.key === 'ArrowLeft') return '\x1b[D';
  if (input.key === 'Home') return '\x1b[H';
  if (input.key === 'End') return '\x1b[F';
  if (input.key === 'Delete') return '\x1b[3~';
  if (input.key === ' ' || input.key === 'Space') return ' ';
  if (input.key.length === 1) {
    if (input.ctrl_key) {
      const code = input.key.toLowerCase().charCodeAt(0) - 96;
      if (code >= 1 && code <= 26) return String.fromCharCode(code);
      return null;
    }
    return input.key;
  }
  return null;
}

export function keyboardEventToKeyInput(event: KeyboardEvent): TestDriverKey {
  return {
    key: event.key,
    shift_key: event.shiftKey,
    ctrl_key: event.ctrlKey,
    alt_key: event.altKey,
    meta_key: event.metaKey,
  };
}

export async function handleGlobalKeyInput(input: TestDriverKey, context?: KeyboardActionContext): Promise<boolean> {
  const handled = () => {
    context?.onHandled?.();
    return true;
  };
  const state = get(appState);
  const currentMode = get(mode);
  const pendingCloseTab = get(closeTabConfirmation);

  if (pendingCloseTab) {
    if (input.key === 'Escape' || input.key === 'n' || input.key === 'N') {
      handled();
      await dispatchIntent({ type: 'cancel-close-active-tab' });
      return true;
    }
    if (input.key === 'Enter' || input.key === 'y' || input.key === 'Y' || input.key === 'X') {
      handled();
      await dispatchIntent({ type: 'confirm-close-active-tab' });
      return true;
    }
    return false;
  }

  if (get(commandBarOpen)) {
    return false;
  }

  if (get(helpOpen)) {
    handled();
    helpOpen.set(false);
    return true;
  }

  if (input.key === 'Escape') {
    if (currentMode === 'input') {
      if (input.shift_key) {
        handled();
        await dispatchIntent({ type: 'exit-input-mode' });
        return true;
      }
      return false;
    }
    if (get(sidebarOpen)) {
      handled();
      closeSidebar();
      return true;
    }
    return handled();
  }

  if (currentMode === 'input') {
    const data = keyInputToData(input);
    if (data) {
      handled();
      await dispatchIntent({ type: 'send-input', data });
      return true;
    }
    return false;
  }

  const lowerKey = input.key.toLowerCase();

  if (input.ctrl_key && !input.meta_key && !input.alt_key && ['h', 'j', 'k', 'l'].includes(lowerKey)) {
    const distance = WINDOW_MOVE_STEP * (input.shift_key ? 2 : 1);
    const dx = lowerKey === 'h' ? -distance : lowerKey === 'l' ? distance : 0;
    const dy = lowerKey === 'k' ? -distance : lowerKey === 'j' ? distance : 0;
    const selectedId = get(selectedTerminalId);
    if (!selectedId) return true;
    handled();
    await moveSelectedTerminalBy(dx, dy);
    return true;
  }

  if (!input.ctrl_key && !input.meta_key && !input.alt_key && input.shift_key && ['h', 'j', 'k', 'l'].includes(lowerKey)) {
    const dx = lowerKey === 'h' ? -CANVAS_PAN_STEP : lowerKey === 'l' ? CANVAS_PAN_STEP : 0;
    const dy = lowerKey === 'k' ? -CANVAS_PAN_STEP : lowerKey === 'j' ? CANVAS_PAN_STEP : 0;
    handled();
    panCanvasBy(dx, dy);
    return true;
  }

  if (
    !input.ctrl_key &&
    !input.meta_key &&
    !input.alt_key &&
    input.shift_key &&
    (input.key === '_' || input.key === '-' || input.key === '+' || input.key === '=')
  ) {
    handled();
    zoomCanvasAtViewportCenter(input.key === '+' || input.key === '=' ? 1.05 : 0.95, viewportWidth(context), viewportHeight(context));
    return true;
  }

  if (!input.ctrl_key && !input.meta_key && !input.alt_key && !input.shift_key && input.key === 'b') {
    handled();
    await dispatchIntent({ type: 'toggle-sidebar' });
    return true;
  }

  if (!input.ctrl_key && !input.meta_key && !input.alt_key && !input.shift_key && input.key === 'd') {
    handled();
    await dispatchIntent({ type: 'toggle-debug' });
    return true;
  }

  if (input.meta_key || input.alt_key || input.ctrl_key) {
    return false;
  }

  if (get(sidebarOpen)) {
    if (input.key === 'j') {
      handled();
      moveSidebarSelection(1);
      return true;
    }
    if (input.key === 'k') {
      handled();
      moveSidebarSelection(-1);
      return true;
    }
    if (input.key === 'z') {
      handled();
      await dispatchIntent({
        type: 'toggle-selected-zoom',
        viewportWidth: viewportWidth(context),
        viewportHeight: viewportHeight(context),
      });
      return true;
    }
    if (input.key === 'Z') {
      handled();
      await dispatchIntent({
        type: 'toggle-selected-fullscreen-zoom',
        viewportWidth: viewportWidth(context),
        viewportHeight: viewportHeight(context),
      });
      return true;
    }
    if (input.key === 'r') {
      handled();
      beginSidebarRename();
      return true;
    }
    if (input.key === 'i') {
      const selectedId = get(selectedTerminalId);
      if (selectedId && !state.tmux.panes[selectedId]?.readOnly) {
        handled();
        closeSidebar();
        await dispatchIntent({ type: 'enter-input-mode' });
      }
      return true;
    }
  }

  switch (input.key) {
    case 'i':
      handled();
      await dispatchIntent({ type: 'enter-input-mode' });
      return true;
    case '?':
      handled();
      await dispatchIntent({ type: 'open-help' });
      return true;
    case ':':
      handled();
      await dispatchIntent({ type: 'open-command-bar' });
      return true;
    case 'h':
    case 'j':
    case 'k':
    case 'l':
      handled();
      selectDirectional(input.key as 'h' | 'j' | 'k' | 'l');
      return true;
    case 'n':
      handled();
      selectNextTerminal();
      return true;
    case 'p':
      handled();
      selectPrevTerminal();
      return true;
    case 'N':
      handled();
      nextTab();
      return true;
    case 'P':
      handled();
      prevTab();
      return true;
    case 'H':
    case 'J':
    case 'K':
    case 'L': {
      const dx = input.key === 'H' ? -CANVAS_PAN_STEP : input.key === 'L' ? CANVAS_PAN_STEP : 0;
      const dy = input.key === 'K' ? -CANVAS_PAN_STEP : input.key === 'J' ? CANVAS_PAN_STEP : 0;
      handled();
      panCanvasBy(dx, dy);
      return true;
    }
    case 'z':
      handled();
      await dispatchIntent({
        type: 'toggle-selected-zoom',
        viewportWidth: viewportWidth(context),
        viewportHeight: viewportHeight(context),
      });
      return true;
    case 'Z':
      handled();
      await dispatchIntent({
        type: 'toggle-selected-fullscreen-zoom',
        viewportWidth: viewportWidth(context),
        viewportHeight: viewportHeight(context),
      });
      return true;
    case 'f':
      handled();
      fitCanvasToActiveTab(viewportWidth(context), viewportHeight(context));
      return true;
    case '0':
      handled();
      await dispatchIntent({ type: 'reset-canvas' });
      return true;
    case 'a':
      handled();
      await autoArrange(get(activeTabId));
      fitCanvasToActiveTab(viewportWidth(context), viewportHeight(context));
      return true;
    case 's':
      handled();
      await dispatchIntent({ type: 'new-shell' });
      return true;
    case 'x':
      handled();
      await dispatchIntent({ type: 'close-selected-pane' });
      return true;
    case 'X':
    case 'w':
      handled();
      await dispatchIntent({ type: 'close-active-tab' });
      return true;
    case 't':
      handled();
      await addTab();
      return true;
    default:
      return false;
  }
}
