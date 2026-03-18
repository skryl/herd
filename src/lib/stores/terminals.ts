import { writable, get } from 'svelte/store';
import type { TerminalInfo } from '../types';

export const terminals = writable<TerminalInfo[]>([]);
export const selectedTerminalId = writable<string | null>(null);

const GRID_SNAP = 20;
const GAP = 30;

let nextId = 0;

function rectsOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function snapToGrid(v: number): number {
  return Math.round(v / GRID_SNAP) * GRID_SNAP;
}

/** Find a position near (desiredX, desiredY) that doesn't overlap existing terminals in the same tab. */
function findOpenPosition(
  desiredX: number,
  desiredY: number,
  width: number,
  height: number,
  tabId: string,
): { x: number; y: number } {
  const existing = get(terminals).filter(t => t.tabId === tabId);

  let x = snapToGrid(desiredX);
  let y = snapToGrid(desiredY);

  // Check if desired position is free
  if (!existing.some(t => rectsOverlap(x, y, width, height, t.x, t.y, t.width, t.height))) {
    return { x, y };
  }

  // Spiral outward to find a free spot
  for (let ring = 1; ring <= 20; ring++) {
    const step = (width + GAP) * ring;
    const offsets = [
      { x: step, y: 0 },
      { x: -step, y: 0 },
      { x: 0, y: (height + GAP) * ring },
      { x: 0, y: -(height + GAP) * ring },
      { x: step, y: (height + GAP) * ring },
      { x: -step, y: (height + GAP) * ring },
      { x: step, y: -(height + GAP) * ring },
      { x: -step, y: -(height + GAP) * ring },
    ];
    for (const off of offsets) {
      const cx = snapToGrid(desiredX + off.x);
      const cy = snapToGrid(desiredY + off.y);
      if (!existing.some(t => rectsOverlap(cx, cy, width, height, t.x, t.y, t.width, t.height))) {
        return { x: cx, y: cy };
      }
    }
  }

  // Fallback: place below all existing
  const maxY = existing.reduce((m, t) => Math.max(m, t.y + t.height), 0);
  return { x: snapToGrid(desiredX), y: snapToGrid(maxY + GAP) };
}

export function spawnTerminal(
  x: number,
  y: number,
  width = 640,
  height = 400,
  sessionId?: string,
  tabId?: string,
  parentSessionId?: string,
  paneId?: string,
): TerminalInfo {
  const id = `term-${nextId++}`;
  const tab = tabId || 'tab-0';
  const pos = findOpenPosition(x, y, width, height, tab);
  const term: TerminalInfo = {
    id,
    x: pos.x,
    y: pos.y,
    width,
    height,
    title: 'shell',
    sessionId,
    paneId,
    tabId: tab,
    parentSessionId,
  };
  terminals.update(list => [...list, term]);
  selectedTerminalId.set(id);
  return term;
}

export function removeTerminal(id: string) {
  terminals.update(list => list.filter(t => t.id !== id));
  if (get(selectedTerminalId) === id) {
    selectedTerminalId.set(null);
  }
}

export function updateTerminal(id: string, updates: Partial<TerminalInfo>) {
  terminals.update(list =>
    list.map(t => t.id === id ? { ...t, ...updates } : t)
  );
}

export function updateTerminalBySessionId(sessionId: string, updates: Partial<TerminalInfo>) {
  terminals.update(list =>
    list.map(t => t.sessionId === sessionId ? { ...t, ...updates } : t)
  );
}

export function removeTerminalBySessionId(sessionId: string) {
  const term = get(terminals).find(t => t.sessionId === sessionId);
  if (term) removeTerminal(term.id);
}

/** Auto-arrange using ELK layout engine (layered/hierarchical).
 *  Falls back to grid layout if ELK fails. */
export async function autoArrange(tabId: string) {
  const all = get(terminals);
  const tabTerms = all.filter(t => t.tabId === tabId);
  if (tabTerms.length === 0) return;

  try {
    const ELK = (await import('elkjs/lib/elk.bundled.js')).default;
    const elk = new ELK();

    // Build ELK graph: nodes are terminals, edges are parent→child links
    const nodes = tabTerms.map(t => ({
      id: t.id,
      width: t.width,
      height: t.height,
    }));

    const edges: Array<{ id: string; sources: string[]; targets: string[] }> = [];
    for (const child of tabTerms) {
      if (!child.parentSessionId) continue;
      const parent = tabTerms.find(p => p.sessionId === child.parentSessionId);
      if (parent) {
        edges.push({
          id: `e-${parent.id}-${child.id}`,
          sources: [parent.id],
          targets: [child.id],
        });
      }
    }

    const graph = await elk.layout({
      id: 'root',
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.spacing.nodeNode': '40',
        'elk.layered.spacing.nodeNodeBetweenLayers': '60',
        'elk.padding': '[top=20,left=20,bottom=20,right=20]',
      },
      children: nodes,
      edges,
    });

    if (graph.children) {
      const posMap = new Map<string, { x: number; y: number }>();
      for (const node of graph.children) {
        posMap.set(node.id, {
          x: snapToGrid(node.x ?? 0),
          y: snapToGrid(node.y ?? 0),
        });
      }

      const arranged = tabTerms.map(t => {
        const pos = posMap.get(t.id);
        return pos ? { ...t, x: pos.x, y: pos.y } : t;
      });

      const otherTerms = all.filter(t => t.tabId !== tabId);
      terminals.set([...otherTerms, ...arranged]);
      return;
    }
  } catch (e) {
    console.error('ELK layout failed, using grid fallback:', e);
  }

  // Grid fallback
  const cellW = tabTerms[0].width;
  const cellH = tabTerms[0].height;
  const cols = Math.max(1, Math.floor(Math.sqrt(tabTerms.length)));

  const arranged = tabTerms.map((term, i) => ({
    ...term,
    x: snapToGrid((i % cols) * (cellW + GAP)),
    y: snapToGrid(Math.floor(i / cols) * (cellH + GAP)),
  }));

  const otherTerms = all.filter(t => t.tabId !== tabId);
  terminals.set([...otherTerms, ...arranged]);
}
