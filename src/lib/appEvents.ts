import { get } from 'svelte/store';
import { autoArrangeWithElk, fitCanvasToActiveTab } from './stores/appState';
import { activeTabId } from './stores/tabs';

export type ArrangeElkEventPayload = {
  session_id?: string | null;
};

export async function handleArrangeElkEvent(payload: ArrangeElkEventPayload) {
  const sessionId = payload.session_id ?? null;
  await autoArrangeWithElk(sessionId);
  if (
    sessionId
    && get(activeTabId) === sessionId
    && typeof window !== 'undefined'
  ) {
    fitCanvasToActiveTab(window.innerWidth, window.innerHeight - 54);
  }
}
