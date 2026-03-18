// Registry for terminal tile methods (scroll, focus, blur)
// Tiles register themselves on mount and deregister on destroy.

export interface TileMethods {
  scrollUp: () => void;
  scrollDown: () => void;
  focusTerminal: () => void;
  blurTerminal: () => void;
  writeData?: (data: string) => void;
}

const registry = new Map<string, TileMethods>();

export function registerTile(id: string, methods: TileMethods) {
  registry.set(id, methods);
}

export function unregisterTile(id: string) {
  registry.delete(id);
}

export function getTileMethods(id: string): TileMethods | undefined {
  return registry.get(id);
}
