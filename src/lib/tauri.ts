import { invoke } from '@tauri-apps/api/core';

export async function createPty(cols: number, rows: number): Promise<string> {
  return invoke<string>('create_pty', { cols, rows });
}

export async function destroyPty(sessionId: string): Promise<void> {
  return invoke('destroy_pty', { sessionId });
}

export async function writePty(sessionId: string, data: string): Promise<void> {
  return invoke('write_pty', { sessionId, data });
}

export async function readPtyOutput(sessionId: string): Promise<string> {
  return invoke<string>('read_pty_output', { sessionId });
}

export async function resizePty(sessionId: string, cols: number, rows: number): Promise<void> {
  return invoke('resize_pty', { sessionId, cols, rows });
}

export async function saveTileState(
  sessionId: string, x: number, y: number,
  width: number, height: number, title: string,
): Promise<void> {
  return invoke('save_tile_state', { sessionId, x, y, width, height, title });
}
