import { writable } from 'svelte/store';
import type { HerdMode } from '../types';

export const mode = writable<HerdMode>('command');
export const commandBarOpen = writable(false);
export const commandText = writable('');
export const helpOpen = writable(false);
