import { writable, get, derived } from 'svelte/store';
import { invoke } from '@tauri-apps/api/core';
import { terminals, selectedTerminalId } from './terminals';
import type { Tab, TerminalInfo } from '../types';

let nextTabId = 0;

function createTab(name?: string): Tab {
  const id = `tab-${nextTabId++}`;
  return { id, name: name || `Tab ${nextTabId}` };
}

const initialTab = createTab('Main');

export const tabs = writable<Tab[]>([initialTab]);
export const activeTabId = writable<string>(initialTab.id);

export const activeTabTerminals = derived(
  [terminals, activeTabId],
  ([$terminals, $activeTabId]) => $terminals.filter(t => t.tabId === $activeTabId)
);

/** Create a new tab backed by a tmux window */
export async function addTab(name?: string): Promise<Tab> {
  const tab = createTab(name);
  tabs.update(list => [...list, tab]);
  activeTabId.set(tab.id);
  // Create a tmux window for this tab — the shell-spawned event
  // will assign the new pane to the active tab (which is now this one)
  try {
    await invoke('create_pty', { cols: 80, rows: 24 });
  } catch {}
  return tab;
}

export function removeTab(id: string) {
  const allTabs = get(tabs);
  if (allTabs.length <= 1) return;

  // Kill all panes belonging to this tab
  const tabTerms = get(terminals).filter(t => t.tabId === id);
  for (const t of tabTerms) {
    if (t.sessionId) {
      invoke('destroy_pty', { sessionId: t.sessionId }).catch(() => {});
    }
  }

  tabs.update(list => list.filter(t => t.id !== id));
  terminals.update(list => list.filter(t => t.tabId !== id));
  if (get(activeTabId) === id) {
    activeTabId.set(get(tabs)[0].id);
  }
}

export function nextTab() {
  const allTabs = get(tabs);
  const idx = allTabs.findIndex(t => t.id === get(activeTabId));
  const next = (idx + 1) % allTabs.length;
  activeTabId.set(allTabs[next].id);
}

export function prevTab() {
  const allTabs = get(tabs);
  const idx = allTabs.findIndex(t => t.id === get(activeTabId));
  const prev = (idx - 1 + allTabs.length) % allTabs.length;
  activeTabId.set(allTabs[prev].id);
}

export function selectNextTerminal() {
  const tabTerms = get(activeTabTerminals);
  if (tabTerms.length === 0) return;
  const currentId = get(selectedTerminalId);
  const idx = tabTerms.findIndex(t => t.id === currentId);
  const next = (idx + 1) % tabTerms.length;
  selectedTerminalId.set(tabTerms[next].id);
}

export function selectPrevTerminal() {
  const tabTerms = get(activeTabTerminals);
  if (tabTerms.length === 0) return;
  const currentId = get(selectedTerminalId);
  const idx = tabTerms.findIndex(t => t.id === currentId);
  const prev = (idx - 1 + tabTerms.length) % tabTerms.length;
  selectedTerminalId.set(tabTerms[prev].id);
}

export function selectDirectional(direction: 'h' | 'j' | 'k' | 'l') {
  const tabTerms = get(activeTabTerminals);
  if (tabTerms.length === 0) return;
  const currentId = get(selectedTerminalId);
  const current = tabTerms.find(t => t.id === currentId);
  if (!current) {
    selectedTerminalId.set(tabTerms[0].id);
    return;
  }

  const cx = current.x + current.width / 2;
  const cy = current.y + current.height / 2;

  let best: typeof current | null = null;
  let bestDist = Infinity;

  for (const t of tabTerms) {
    if (t.id === current.id) continue;
    const tx = t.x + t.width / 2;
    const ty = t.y + t.height / 2;
    const dx = tx - cx;
    const dy = ty - cy;

    let valid = false;
    switch (direction) {
      case 'h': valid = dx < -20; break;
      case 'l': valid = dx > 20; break;
      case 'k': valid = dy < -20; break;
      case 'j': valid = dy > 20; break;
    }
    if (!valid) continue;

    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestDist) {
      bestDist = dist;
      best = t;
    }
  }

  if (best) {
    selectedTerminalId.set(best.id);
  }
}
