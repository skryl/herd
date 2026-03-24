<script lang="ts">
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { onDestroy, onMount } from 'svelte';
  import TileActivityDrawer from './TileActivityDrawer.svelte';
  import TilePorts from './TilePorts.svelte';
  import type { TerminalInfo } from './types';
  import {
    backBrowserWebview,
    forwardBrowserWebview,
    hideBrowserWebview,
    navigateBrowserWebview,
    reloadBrowserWebview,
    syncBrowserWebview,
    type BrowserWebviewState,
    type BrowserWebviewViewport,
  } from './tauri';
  import {
    canvasState,
    clientDeltaToWorldDelta,
    openPaneContextMenu,
    persistPaneLayout,
    registerPaneDriverHandle,
    removeTerminal,
    selectTile,
    selectedTerminalId,
    tileActivityById,
    updateTerminal,
    zoomCanvasToTile,
  } from './stores/appState';

  interface Props {
    info: TerminalInfo;
  }

  interface BrowserUrlChangedEvent {
    paneId: string;
    url: string;
    loading: boolean;
  }

  const DEFAULT_BROWSER_URL = 'https://example.com/';
  const appWindow = getCurrentWindow();

  let { info }: Props = $props();

  let surfaceHostRef = $state<HTMLDivElement>();
  let urlInputRef = $state<HTMLInputElement>();
  let unregisterDriverHandle: (() => void) | null = null;
  let unlistenBrowserEvent: UnlistenFn | null = null;
  let unlistenScaleChanged: UnlistenFn | null = null;
  let unlistenWindowResized: UnlistenFn | null = null;
  let surfaceResizeObserver: ResizeObserver | null = null;
  let viewportResizeObserver: ResizeObserver | null = null;
  let syncFrame: number | null = null;
  let visualViewportRef = $state<VisualViewport | null>(null);

  let urlDraft = $state(DEFAULT_BROWSER_URL);
  let currentUrl = $state(DEFAULT_BROWSER_URL);
  let loading = $state(true);
  let isEditingUrl = false;
  let destroyed = false;
  let syncInFlight = false;
  let syncQueued = false;
  let lastViewportKey = '';
  let windowScaleFactor = $state(1);
  let windowLogicalWidth = $state(0);
  let windowLogicalHeight = $state(0);

  let isSelected = $derived($selectedTerminalId === info.id);
  let designator = $derived(`P${info.id.replace(/\D/g, '') || info.paneId.replace(/\D/g, '')}`);
  let displayTitle = $derived(info.title !== 'shell' ? info.title : designator);
  let componentTypeLabel = $derived(info.readOnly ? 'VIEW' : 'WEB');
  let locationLabel = $derived(browserLocationLabel(currentUrl));
  let activityEntries = $derived($tileActivityById[info.tileId] ?? []);
  let activityOpen = $state(false);

  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let origX = 0;
  let origY = 0;

  let isResizing = false;
  let resizeStartX = 0;
  let resizeStartY = 0;
  let origW = 0;
  let origH = 0;

  function browserLocationLabel(value: string) {
    try {
      const url = new URL(value);
      return url.host || value;
    } catch {
      return value;
    }
  }

  function normalizeBrowserUrl(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed === 'about:blank') return trimmed;

    const withProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;

    try {
      const url = new URL(withProtocol);
      if (!['http:', 'https:'].includes(url.protocol)) {
        return null;
      }
      return url.toString();
    } catch {
      return null;
    }
  }

  function intersectRects(
    target: DOMRect,
    clip: DOMRect,
  ): BrowserWebviewViewport {
    const left = Math.max(target.left, clip.left);
    const top = Math.max(target.top, clip.top);
    const right = Math.min(target.right, clip.right);
    const bottom = Math.min(target.bottom, clip.bottom);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    return {
      x: left,
      y: top,
      width,
      height,
      visible: width > 1 && height > 1 && document.visibilityState === 'visible',
    };
  }

  function viewportWidthCss() {
    return window.visualViewport?.width ?? window.innerWidth;
  }

  function viewportHeightCss() {
    return window.visualViewport?.height ?? window.innerHeight;
  }

  function pageZoomFactorX() {
    const viewportWidth = viewportWidthCss();
    const factor = viewportWidth > 0 && windowLogicalWidth > 0 ? windowLogicalWidth / viewportWidth : 1;
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
  }

  function pageZoomFactorY() {
    const viewportHeight = viewportHeightCss();
    const factor = viewportHeight > 0 && windowLogicalHeight > 0 ? windowLogicalHeight / viewportHeight : 1;
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
  }

  async function refreshWindowMetrics() {
    try {
      const scaleFactor = await appWindow.scaleFactor();
      const innerSize = await appWindow.innerSize();
      const logicalSize = innerSize.toLogical(scaleFactor);
      windowScaleFactor = scaleFactor;
      windowLogicalWidth = logicalSize.width;
      windowLogicalHeight = logicalSize.height;
    } catch (error) {
      console.error('failed to refresh window metrics:', error);
    }
  }

  function currentViewport(): BrowserWebviewViewport | null {
    if (!surfaceHostRef) return null;
    const hostRect = surfaceHostRef.getBoundingClientRect();
    const viewport = surfaceHostRef.closest('.canvas-viewport') as HTMLElement | null;
    const clipRect = viewport?.getBoundingClientRect();
    const zoomFactorX = pageZoomFactorX();
    const zoomFactorY = pageZoomFactorY();
    if (!clipRect) {
      return {
        x: hostRect.left * zoomFactorX,
        y: hostRect.top * zoomFactorY,
        width: hostRect.width * zoomFactorX,
        height: hostRect.height * zoomFactorY,
        visible: hostRect.width > 1 && hostRect.height > 1 && document.visibilityState === 'visible',
      };
    }
    const clipped = intersectRects(hostRect, clipRect);
    return {
      ...clipped,
      x: clipped.x * zoomFactorX,
      y: clipped.y * zoomFactorY,
      width: clipped.width * zoomFactorX,
      height: clipped.height * zoomFactorY,
    };
  }

  function applyBrowserState(state: BrowserWebviewState | null | undefined) {
    if (!state?.currentUrl) return;
    currentUrl = state.currentUrl;
    if (!isEditingUrl) {
      urlDraft = state.currentUrl;
    }
  }

  async function flushBrowserSync() {
    if (!surfaceHostRef || destroyed) return;
    if (syncInFlight) {
      syncQueued = true;
      return;
    }

    syncInFlight = true;
    try {
      do {
        syncQueued = false;
        const viewport = currentViewport();
        if (!viewport) continue;

        const viewportKey = [
          Math.round(viewport.x),
          Math.round(viewport.y),
          Math.round(viewport.width),
          Math.round(viewport.height),
          viewport.visible ? '1' : '0',
        ].join(':');
        if (viewportKey === lastViewportKey) {
          continue;
        }

        lastViewportKey = viewportKey;
        try {
          const state = await syncBrowserWebview(info.paneId, viewport, currentUrl);
          if (destroyed) return;
          applyBrowserState(state);
        } catch (error) {
          lastViewportKey = '';
          console.error('browser_webview_sync failed:', error);
        }
      } while (syncQueued && !destroyed);
    } finally {
      syncInFlight = false;
    }
  }

  function queueBrowserSync() {
    if (syncFrame !== null) {
      cancelAnimationFrame(syncFrame);
    }
    syncFrame = requestAnimationFrame(() => {
      syncFrame = null;
      void flushBrowserSync();
    });
  }

  async function navigate(nextValue = urlDraft) {
    const normalized = normalizeBrowserUrl(nextValue);
    if (!normalized) {
      return;
    }

    loading = true;
    currentUrl = normalized;
    urlDraft = normalized;
    try {
      await navigateBrowserWebview(info.paneId, normalized);
      queueBrowserSync();
    } catch (error) {
      loading = false;
      console.error('browser_webview_navigate failed:', error);
    }
  }

  async function refresh() {
    loading = true;
    try {
      await reloadBrowserWebview(info.paneId);
    } catch (error) {
      loading = false;
      console.error('browser_webview_reload failed:', error);
    }
  }

  async function goBack() {
    loading = true;
    try {
      await backBrowserWebview(info.paneId);
    } catch (error) {
      loading = false;
      console.error('browser_webview_back failed:', error);
    }
  }

  async function goForward() {
    loading = true;
    try {
      await forwardBrowserWebview(info.paneId);
    } catch (error) {
      loading = false;
      console.error('browser_webview_forward failed:', error);
    }
  }

  function handleTitleDblClick(e: MouseEvent) {
    zoomCanvasToTile(info.paneId, window.innerWidth, window.innerHeight - 32);
    e.stopPropagation();
  }

  function handleTitleMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    isDragging = true;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    origX = info.x;
    origY = info.y;
    e.preventDefault();
    e.stopPropagation();
  }

  function handleResizeMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    isResizing = true;
    resizeStartX = e.clientX;
    resizeStartY = e.clientY;
    origW = info.width;
    origH = info.height;
    e.preventDefault();
    e.stopPropagation();
  }

  function handleWindowMouseMove(e: MouseEvent) {
    if (isDragging) {
      const { dx, dy } = clientDeltaToWorldDelta(
        e.clientX - dragStartX,
        e.clientY - dragStartY,
        $canvasState.zoom,
      );
      updateTerminal(info.id, { x: origX + dx, y: origY + dy });
    } else if (isResizing) {
      const { dx, dy } = clientDeltaToWorldDelta(
        e.clientX - resizeStartX,
        e.clientY - resizeStartY,
        $canvasState.zoom,
      );
      updateTerminal(info.id, {
        width: Math.max(320, origW + dx),
        height: Math.max(240, origH + dy),
      });
    }
  }

  function handleWindowMouseUp() {
    const wasDragging = isDragging;
    const wasResizing = isResizing;

    if (wasDragging || wasResizing) {
      void persistPaneLayout(info.id);
      queueBrowserSync();
    }

    isDragging = false;
    isResizing = false;
  }

  function handleClose() {
    removeTerminal(info.id);
  }

  function handleContextMenu(e: MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    selectTile(info.id);
    const viewport = (e.currentTarget as HTMLElement).closest('.canvas-viewport') as HTMLElement | null;
    const rect = viewport?.getBoundingClientRect();
    const clientX = rect ? e.clientX - rect.left : e.clientX;
    const clientY = rect ? e.clientY - rect.top : e.clientY;
    openPaneContextMenu(info.id, clientX, clientY);
  }

  function handleVisibilityChange() {
    lastViewportKey = '';
    queueBrowserSync();
  }

  async function handleWindowMetricsChanged() {
    await refreshWindowMetrics();
    lastViewportKey = '';
    queueBrowserSync();
  }

  onMount(async () => {
    destroyed = false;
    await refreshWindowMetrics();
    unregisterDriverHandle = registerPaneDriverHandle(info.paneId, {
      focusInput() {
        urlInputRef?.focus();
      },
      async syncViewport() {
        lastViewportKey = '';
        await flushBrowserSync();
      },
    });

    unlistenBrowserEvent = await listen<BrowserUrlChangedEvent>('browser-url-changed', (event) => {
      if (event.payload.paneId !== info.paneId) return;
      loading = event.payload.loading;
      currentUrl = event.payload.url;
      if (!isEditingUrl) {
        urlDraft = event.payload.url;
      }
    });
    unlistenScaleChanged = await appWindow.onScaleChanged(() => {
      void handleWindowMetricsChanged();
    });

    if (surfaceHostRef) {
      surfaceResizeObserver = new ResizeObserver(() => {
        lastViewportKey = '';
        queueBrowserSync();
      });
      surfaceResizeObserver.observe(surfaceHostRef);

      const viewport = surfaceHostRef.closest('.canvas-viewport');
      if (viewport instanceof HTMLElement) {
        viewportResizeObserver = new ResizeObserver(() => {
          lastViewportKey = '';
          queueBrowserSync();
        });
        viewportResizeObserver.observe(viewport);
      }
    }

    visualViewportRef = window.visualViewport;
    window.addEventListener('resize', handleWindowMetricsChanged);
    visualViewportRef?.addEventListener('resize', queueBrowserSync);
    unlistenWindowResized = await appWindow.onResized(() => {
      void handleWindowMetricsChanged();
    });
    document.addEventListener('visibilitychange', handleVisibilityChange);
    queueBrowserSync();
  });

  onDestroy(() => {
    destroyed = true;
    if (syncFrame !== null) {
      cancelAnimationFrame(syncFrame);
    }
    if (surfaceResizeObserver) surfaceResizeObserver.disconnect();
    if (viewportResizeObserver) viewportResizeObserver.disconnect();
    if (unlistenBrowserEvent) unlistenBrowserEvent();
    if (unlistenScaleChanged) unlistenScaleChanged();
    if (unlistenWindowResized) unlistenWindowResized();
    if (unregisterDriverHandle) unregisterDriverHandle();
    window.removeEventListener('resize', handleWindowMetricsChanged);
    visualViewportRef?.removeEventListener('resize', queueBrowserSync);
    document.removeEventListener('visibilitychange', handleVisibilityChange);
    void hideBrowserWebview(info.paneId);
  });

  $effect(() => {
    info.x;
    info.y;
    info.width;
    info.height;
    $canvasState.panX;
    $canvasState.panY;
    $canvasState.zoom;
    windowScaleFactor;
    windowLogicalWidth;
    windowLogicalHeight;
    queueBrowserSync();
  });
</script>

<svelte:window onmousemove={handleWindowMouseMove} onmouseup={handleWindowMouseUp} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="pcb-component"
  class:selected={isSelected}
  class:kind-browser={true}
  data-tile-id={info.tileId}
  style="left: {info.x}px; top: {info.y}px; width: {info.width}px; height: {info.height}px; z-index: {isSelected ? 10 : 1};"
  onmousedown={(e) => {
    selectTile(info.id);
    e.stopPropagation();
  }}
  oncontextmenu={handleContextMenu}
>
  <TilePorts tileId={info.tileId} />
  <div class="component-body">
    <div class="ic-notch"></div>

    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="header-bar" onmousedown={handleTitleMouseDown} ondblclick={handleTitleDblClick}>
      <div class="header-left">
        <span class="browser-badge" title="Browser tile" aria-label="Browser tile">WEB</span>
        <span class="designator">{displayTitle}</span>
        <span class="component-type">{componentTypeLabel}</span>
      </div>
      <div class="header-right">
        <span class="coord-info">{Math.round(info.x)},{Math.round(info.y)}</span>
        <button class="close-btn" type="button" onclick={handleClose}>
          <span class="close-x">x</span>
        </button>
      </div>
    </div>

    <div class="browser-toolbar">
      <button
        class="nav-btn"
        type="button"
        onclick={(event) => {
          event.stopPropagation();
          void goBack();
        }}
      >
        BACK
      </button>
      <button
        class="nav-btn"
        type="button"
        onclick={(event) => {
          event.stopPropagation();
          void goForward();
        }}
      >
        FWD
      </button>
      <button
        class="nav-btn"
        type="button"
        onclick={(event) => {
          event.stopPropagation();
          void refresh();
        }}
      >
        RLD
      </button>
      <input
        bind:this={urlInputRef}
        bind:value={urlDraft}
        class="url-input"
        spellcheck="false"
        placeholder="https://example.com"
        onfocus={() => {
          isEditingUrl = true;
        }}
        onblur={() => {
          isEditingUrl = false;
          urlDraft = currentUrl;
        }}
        onmousedown={(event) => event.stopPropagation()}
        onkeydown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') {
            void navigate();
          }
        }}
      />
      <button
        class="go-btn"
        type="button"
        onclick={(event) => {
          event.stopPropagation();
          void navigate();
        }}
      >
        GO
      </button>
    </div>

    <div class="browser-frame-shell">
      <div class="screen-bezel">
        <div bind:this={surfaceHostRef} class="browser-surface-host"></div>
        <div class="browser-surface-placeholder" aria-hidden="true">
          <span class="placeholder-status">{loading ? 'Loading...' : 'Ready'}</span>
          <span class="placeholder-url">{currentUrl}</span>
        </div>
      </div>
    </div>

    {#if activityOpen}
      <TileActivityDrawer entries={activityEntries} emptyText="No activity yet" />
    {/if}

    <div class="info-strip">
      <div class="info-cluster info-cluster-left">
        <span class="info-item">
          <span class="info-label">PID:{info.paneId.slice(0, 8)}</span>
        </span>
        <span class="info-item">
          <span class="info-label">TILE:{info.tileId}</span>
        </span>
        <span class="info-item">
          <span class="status-dot" class:active={loading}></span>
          <span class="info-label">{loading ? 'NAV' : 'LIVE'}</span>
        </span>
        <span class="info-item location-item">
          <span class="info-label">{locationLabel}</span>
        </span>
      </div>
      <div class="info-cluster info-cluster-right">
        <span class="info-item">
          <span class="info-label">{Math.round(info.width)}x{Math.round(info.height)}</span>
        </span>
        <button
          class="activity-toggle-btn"
          class:active={activityOpen}
          type="button"
          title={activityOpen ? 'Hide activity log' : 'Show activity log'}
          aria-label={activityOpen ? 'Hide activity log' : 'Show activity log'}
          onclick={(event) => {
            event.stopPropagation();
            activityOpen = !activityOpen;
          }}
        >
          ACT {activityEntries.length}
        </button>
      </div>
    </div>
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="resize-handle" onmousedown={handleResizeMouseDown}>
    <svg width="10" height="10" viewBox="0 0 10 10">
      <line x1="9" y1="1" x2="1" y2="9" stroke="var(--copper-dim)" stroke-width="1" />
      <line x1="9" y1="4" x2="4" y2="9" stroke="var(--copper-dim)" stroke-width="1" />
      <line x1="9" y1="7" x2="7" y2="9" stroke="var(--copper-dim)" stroke-width="1" />
    </svg>
  </div>
</div>

<style>
  .pcb-component {
    position: absolute;
    display: flex;
    align-items: stretch;
    filter: drop-shadow(0 2px 8px rgba(0, 0, 0, 0.6));
    --tile-port-contour: rgba(102, 225, 255, 0.34);
  }

  .pcb-component.selected {
    filter: drop-shadow(0 0 8px rgba(102, 225, 255, 0.28));
    --tile-port-contour: rgba(102, 225, 255, 0.5);
  }

  .pcb-component.selected .component-body {
    border-color: rgba(102, 225, 255, 0.5);
  }

  .component-body {
    flex: 1;
    display: flex;
    flex-direction: column;
    background: var(--component-bg);
    border: 1px solid rgba(102, 225, 255, 0.34);
    position: relative;
    min-width: 0;
    --activity-border: rgba(102, 225, 255, 0.22);
    --activity-border-soft: rgba(102, 225, 255, 0.18);
    --activity-accent: #66e1ff;
    --activity-text: var(--silk-dim);
    --activity-empty: rgba(102, 225, 255, 0.62);
    --activity-bg: rgba(6, 15, 20, 0.96);
  }

  .ic-notch {
    position: absolute;
    top: -1px;
    left: 50%;
    transform: translateX(-50%);
    width: 16px;
    height: 8px;
    border-radius: 0 0 8px 8px;
    border: 1px solid var(--component-border);
    border-top: none;
    background: var(--pcb-dark);
  }

  .header-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 22px;
    padding: 0 8px;
    background: linear-gradient(180deg, rgba(12, 36, 44, 0.9), rgba(9, 25, 31, 0.92));
    border-bottom: 1px solid rgba(102, 225, 255, 0.34);
    cursor: move;
    user-select: none;
    -webkit-user-select: none;
    flex-shrink: 0;
  }

  .header-left,
  .header-right {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .browser-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 24px;
    height: 14px;
    padding: 0 4px;
    border: 1px solid rgba(102, 225, 255, 0.35);
    border-radius: 3px;
    background: rgba(102, 225, 255, 0.08);
    color: #66e1ff;
    font-family: var(--font-mono);
    font-size: 8px;
    letter-spacing: 0.6px;
    line-height: 1;
    text-transform: uppercase;
  }

  .designator {
    font-size: 11px;
    color: var(--silk-white);
    letter-spacing: 1px;
  }

  .component-type {
    font-size: 9px;
    color: var(--silk-dim);
    letter-spacing: 0.5px;
  }

  .coord-info {
    font-size: 8px;
    color: var(--copper-dim);
  }

  .close-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    background: none;
    border: 1px solid transparent;
    color: var(--silk-dim);
    cursor: pointer;
    padding: 0;
    text-transform: uppercase;
  }

  .close-btn:hover {
    color: var(--phosphor-red);
    border-color: rgba(255, 51, 51, 0.2);
  }

  .close-x {
    font-size: 10px;
    line-height: 1;
  }

  .browser-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 8px;
    background: rgba(7, 18, 22, 0.94);
    border-bottom: 1px solid rgba(102, 225, 255, 0.2);
    flex-shrink: 0;
  }

  .nav-btn,
  .go-btn {
    height: 22px;
    padding: 0 8px;
    border: 1px solid rgba(102, 225, 255, 0.2);
    background: rgba(102, 225, 255, 0.05);
    color: #9cecff;
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.6px;
    cursor: pointer;
  }

  .nav-btn:hover,
  .go-btn:hover {
    background: rgba(102, 225, 255, 0.12);
  }

  .url-input {
    flex: 1;
    min-width: 0;
    height: 22px;
    padding: 0 8px;
    border: 1px solid rgba(102, 225, 255, 0.22);
    background: rgba(4, 10, 13, 0.95);
    color: #e4fbff;
    font-family: var(--font-mono);
    font-size: 10px;
    outline: none;
  }

  .url-input:focus {
    border-color: rgba(102, 225, 255, 0.5);
    box-shadow: 0 0 0 1px rgba(102, 225, 255, 0.18);
  }

  .browser-frame-shell {
    position: relative;
    flex: 1;
    min-height: 0;
    background: linear-gradient(180deg, #0b1408 0%, #060d04 100%);
  }

  .screen-bezel {
    position: absolute;
    inset: 8px;
    border: 1px solid rgba(102, 225, 255, 0.18);
    background: #0b1218;
    overflow: hidden;
  }

  .browser-surface-host,
  .browser-surface-placeholder {
    position: absolute;
    inset: 0;
  }

  .browser-surface-placeholder {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    gap: 4px;
    padding: 10px;
    background:
      linear-gradient(180deg, rgba(6, 12, 16, 0.2), rgba(6, 12, 16, 0.85)),
      linear-gradient(135deg, rgba(102, 225, 255, 0.14), rgba(14, 24, 34, 0.02));
    color: rgba(228, 251, 255, 0.78);
    font-family: var(--font-mono);
    font-size: 9px;
    letter-spacing: 0.3px;
    pointer-events: none;
  }

  .placeholder-status {
    color: #9cecff;
  }

  .placeholder-url {
    opacity: 0.8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .info-strip {
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 8px;
    gap: 6px;
    border-top: 1px solid rgba(102, 225, 255, 0.18);
    background: rgba(7, 18, 22, 0.92);
    font-family: var(--font-mono);
    font-size: 8px;
    color: var(--silk-dim);
    flex-shrink: 0;
  }

  .info-cluster {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .info-cluster-left {
    flex: 1;
  }

  .info-cluster-right {
    justify-content: flex-end;
    flex-shrink: 0;
  }

  .info-item {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }

  .location-item {
    flex: 1;
  }

  .activity-toggle-btn {
    height: 16px;
    padding: 0 6px;
    border: 1px solid var(--activity-border);
    background: rgba(0, 0, 0, 0.18);
    color: var(--activity-accent);
    font-family: var(--font-mono);
    font-size: 8px;
    letter-spacing: 0.6px;
    cursor: pointer;
  }

  .activity-toggle-btn.active,
  .activity-toggle-btn:hover {
    border-color: var(--activity-accent);
    background: color-mix(in srgb, var(--activity-accent) 10%, rgba(0, 0, 0, 0.18));
  }

  .status-dot {
    width: 5px;
    height: 5px;
    border-radius: 50%;
    display: inline-block;
    background: rgba(120, 229, 164, 0.72);
    box-shadow: 0 0 5px rgba(120, 229, 164, 0.32);
  }

  .status-dot.active {
    background: rgba(102, 225, 255, 0.88);
    box-shadow: 0 0 5px rgba(102, 225, 255, 0.5);
  }

  .info-label {
    line-height: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .resize-handle {
    position: absolute;
    right: 2px;
    bottom: 2px;
    width: 14px;
    height: 14px;
    cursor: nwse-resize;
    display: flex;
    align-items: center;
    justify-content: center;
  }
</style>
