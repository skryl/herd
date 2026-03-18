import { writable } from 'svelte/store';
import type { CanvasState } from '../types';

export const canvasState = writable<CanvasState>({
  panX: 0,
  panY: 0,
  zoom: 1,
});
