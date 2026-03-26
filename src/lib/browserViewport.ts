export const DEFAULT_BROWSER_PAGE_ZOOM = 1;
export const MIN_BROWSER_PAGE_ZOOM = 0.25;
export const MAX_BROWSER_PAGE_ZOOM = 20;
const BROWSER_PAGE_ZOOM_STEP = 0.1;
const BROWSER_PAGE_ZOOM_PRECISION = 100;

export function clampBrowserPageZoom(pageZoom: number): number {
  if (!Number.isFinite(pageZoom) || pageZoom <= 0) {
    return DEFAULT_BROWSER_PAGE_ZOOM;
  }

  const clamped = Math.max(MIN_BROWSER_PAGE_ZOOM, Math.min(MAX_BROWSER_PAGE_ZOOM, pageZoom));
  return Math.round(clamped * BROWSER_PAGE_ZOOM_PRECISION) / BROWSER_PAGE_ZOOM_PRECISION;
}

export function stepBrowserPageZoom(current: number, direction: 'out' | 'in'): number {
  const base = clampBrowserPageZoom(current);
  const delta = direction === 'in' ? BROWSER_PAGE_ZOOM_STEP : -BROWSER_PAGE_ZOOM_STEP;
  return clampBrowserPageZoom(base + delta);
}

export function browserWebviewPageZoom(pageZoom: number, canvasZoom: number): number {
  const base = clampBrowserPageZoom(pageZoom);
  if (!Number.isFinite(canvasZoom) || canvasZoom <= 0) {
    return base;
  }
  return clampBrowserPageZoom(base * canvasZoom);
}

export function formatBrowserPageZoom(pageZoom: number): string {
  return `${Math.round(clampBrowserPageZoom(pageZoom) * 100)}%`;
}
