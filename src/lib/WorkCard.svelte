<script lang="ts">
  import { approveWorkItem, improveWorkItem, readWorkStagePreview } from './tauri';
  import TileActivityDrawer from './TileActivityDrawer.svelte';
  import TilePorts from './TilePorts.svelte';
  import {
    agentInfos,
    canvasState,
    clientDeltaToWorldDelta,
    deleteWorkCard,
    persistWorkCardLayout,
    refreshWorkItems,
    selectedWorkId,
    selectWorkItem,
    tileActivityById,
    toggleWorkCardMinimized,
    updateWorkCardLayout,
  } from './stores/appState';
  import type { WorkCanvasCard, WorkItem } from './types';

  let { item, layout }: { item: WorkItem; layout: WorkCanvasCard } = $props();

  let preview = $state('');
  let previewBusy = $state(false);
  let previewError = $state<string | null>(null);
  let improveComment = $state('');
  let actionBusy = $state(false);
  let deleteBusy = $state(false);
  let loadVersion = 0;
  let isDragging = $state(false);
  let dragStartX = 0;
  let dragStartY = 0;
  let originX = 0;
  let originY = 0;
  let activityOpen = $state(false);

  const currentStage = $derived(item.stages.find((stage) => stage.stage === item.current_stage) ?? null);
  const needsReview = $derived(currentStage?.status === 'completed');
  const isSelected = $derived($selectedWorkId === item.work_id);
  const ownerName = $derived(labelForAgent(item.owner_agent_id));
  const activityEntries = $derived($tileActivityById[item.tile_id] ?? []);
  const previewText = $derived.by(() => {
    const lines = preview.trimEnd().split('\n');
    if (lines.length <= 16) {
      return preview.trim();
    }
    return `${lines.slice(0, 16).join('\n')}\n…`;
  });

  function labelForAgent(agentId: string | null | undefined) {
    if (!agentId) return 'unowned';
    return $agentInfos.find((agent) => agent.agent_id === agentId)?.display_name ?? agentId;
  }

  function stageDocumentName(stage: WorkItem['stages'][number]['stage']) {
    return `${stage}.md`;
  }

  async function loadPreview() {
    const version = ++loadVersion;
    previewBusy = true;
    previewError = null;
    try {
      const nextPreview = await readWorkStagePreview(item.work_id);
      if (version === loadVersion) {
        preview = nextPreview;
      }
    } catch (error) {
      if (version === loadVersion) {
        preview = '';
        previewError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (version === loadVersion) {
        previewBusy = false;
      }
    }
  }

  async function handleApprove(event: MouseEvent) {
    event.stopPropagation();
    if (!needsReview || actionBusy) return;

    actionBusy = true;
    try {
      await approveWorkItem(item.work_id);
      await refreshWorkItems(item.session_id);
      await loadPreview();
    } catch (error) {
      console.error('approve_work_item failed:', error);
    } finally {
      actionBusy = false;
    }
  }

  async function handleImprove(event: MouseEvent) {
    event.stopPropagation();
    if (!needsReview || actionBusy || !improveComment.trim()) return;

    actionBusy = true;
    try {
      await improveWorkItem(item.work_id, improveComment.trim());
      improveComment = '';
      await refreshWorkItems(item.session_id);
      await loadPreview();
    } catch (error) {
      console.error('improve_work_item failed:', error);
    } finally {
      actionBusy = false;
    }
  }

  async function handleDelete(event: MouseEvent) {
    event.stopPropagation();
    event.preventDefault();
    if (deleteBusy) return;

    deleteBusy = true;
    try {
      await deleteWorkCard(item.work_id, item.session_id);
    } catch (error) {
      console.error('delete_work_item failed:', error);
    } finally {
      deleteBusy = false;
    }
  }

  function handleTitlebarMouseDown(event: MouseEvent) {
    if (event.button !== 0) return;
    selectWorkItem(item.work_id);
    isDragging = true;
    dragStartX = event.clientX;
    dragStartY = event.clientY;
    originX = layout.x;
    originY = layout.y;
    event.preventDefault();
    event.stopPropagation();
  }

  function handleWindowMouseMove(event: MouseEvent) {
    if (!isDragging) return;
    const { dx, dy } = clientDeltaToWorldDelta(
      event.clientX - dragStartX,
      event.clientY - dragStartY,
      $canvasState.zoom,
    );
    updateWorkCardLayout(item.work_id, { x: originX + dx, y: originY + dy });
  }

  function handleWindowMouseUp() {
    if (!isDragging) return;
    isDragging = false;
    void persistWorkCardLayout(item.work_id);
  }

  $effect(() => {
    item.work_id;
    void loadPreview();
  });
</script>

<svelte:window onmousemove={handleWindowMouseMove} onmouseup={handleWindowMouseUp} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="work-card"
  class:selected-work-card={isSelected}
  class:needs-review={needsReview}
  data-work-id={item.work_id}
  style={`left: ${layout.x}px; top: ${layout.y}px; width: ${layout.width}px; height: ${layout.height}px; z-index: ${isSelected ? 10 : 1};`}
  onmousedown={(event) => {
    event.stopPropagation();
    selectWorkItem(item.work_id);
  }}
  onwheel={(event) => event.stopPropagation()}
>
  <TilePorts tileId={item.tile_id} />
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="work-card-titlebar" onmousedown={handleTitlebarMouseDown}>
    <div class="work-card-header">
      <div class="work-card-title-group">
        <div class="work-card-id">{item.work_id}</div>
        <div class="work-card-title">{item.title}</div>
      </div>
      <div class="work-card-stage">
        <span>{item.current_stage}</span>
        <span>{currentStage?.status ?? 'unknown'}</span>
      </div>
    </div>
    <div class="work-card-actions">
      <button
        class="work-card-minimize"
        type="button"
        aria-label="Minimize work item"
        title="Minimize work item"
        onmousedown={(event) => {
          event.stopPropagation();
        }}
        onclick={() => toggleWorkCardMinimized(item.work_id)}
      >
        _
      </button>
      <button
        class="work-card-close"
        type="button"
        aria-label="Delete work item"
        title="Delete work item"
        onmousedown={(event) => {
          event.stopPropagation();
        }}
        onclick={handleDelete}
        disabled={deleteBusy}
      >
        ×
      </button>
    </div>
  </div>

  <div class="work-card-meta">
    <div><span class="meta-label">TOPIC</span> <span>{item.topic}</span></div>
    <div><span class="meta-label">OWNER</span> <span>{ownerName}</span></div>
  </div>

  <div class="work-card-files">
    {#each item.stages as stage (stage.stage)}
      <div class="file-chip" class:active-file={stage.stage === item.current_stage}>
        <span>{stage.stage}</span>
        <span>{stageDocumentName(stage.stage)}</span>
      </div>
    {/each}
  </div>

  <div class="work-card-preview">
    <div class="preview-label">CURRENT STAGE</div>
    {#if previewBusy}
      <div class="preview-status">Loading preview…</div>
    {:else if previewError}
      <div class="preview-status error">{previewError}</div>
    {:else if previewText}
      <pre>{previewText}</pre>
    {:else}
      <div class="preview-status">No preview content.</div>
    {/if}
  </div>

  {#if needsReview}
    <div class="work-card-review">
      <textarea
        bind:value={improveComment}
        class="review-comment"
        placeholder="Improve comment"
        onmousedown={(event) => event.stopPropagation()}
      ></textarea>
      <div class="review-actions">
        <button
          class="review-button approve"
          type="button"
          onclick={handleApprove}
          disabled={actionBusy}
        >
          {actionBusy ? 'Working…' : 'Approve'}
        </button>
        <button
          class="review-button improve"
          type="button"
          onclick={handleImprove}
          disabled={actionBusy || !improveComment.trim()}
        >
          Improve
        </button>
      </div>
    </div>
  {/if}

  {#if activityOpen}
    <TileActivityDrawer entries={activityEntries} emptyText="No activity yet" />
  {/if}

  <div class="work-card-footer">
    <span class="footer-label">TILE:{item.tile_id}</span>
    <div class="footer-actions">
      <button
        class="activity-toggle-btn"
        class:active={activityOpen}
        type="button"
        title={activityOpen ? 'Hide activity log' : 'Show activity log'}
        aria-label={activityOpen ? 'Hide activity log' : 'Show activity log'}
        onmousedown={(event) => event.stopPropagation()}
        onclick={(event) => {
          event.stopPropagation();
          activityOpen = !activityOpen;
        }}
      >
        ACT {activityEntries.length}
      </button>
      <span class="footer-label">{currentStage?.status ?? 'unknown'}</span>
    </div>
  </div>
</div>

<style>
  .work-card {
    position: absolute;
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 0 12px 12px;
    box-sizing: border-box;
    background: rgba(7, 12, 17, 0.94);
    border: 1px solid rgba(110, 188, 255, 0.22);
    box-shadow: 0 10px 36px rgba(0, 0, 0, 0.5);
    color: var(--silk-white);
    overflow: hidden;
    cursor: pointer;
    --tile-port-contour: rgba(110, 188, 255, 0.22);
    --activity-border: rgba(110, 188, 255, 0.22);
    --activity-border-soft: rgba(110, 188, 255, 0.16);
    --activity-accent: #6ebcff;
    --activity-text: var(--silk-dim);
    --activity-empty: rgba(110, 188, 255, 0.62);
    --activity-bg: rgba(7, 12, 17, 0.98);
  }

  .work-card.selected-work-card {
    border-color: #6ebcff;
    --tile-port-contour: #6ebcff;
    box-shadow:
      0 0 0 1px rgba(110, 188, 255, 0.4),
      0 12px 36px rgba(0, 0, 0, 0.5);
  }

  .work-card.needs-review {
    border-color: var(--copper);
    --tile-port-contour: var(--copper);
    box-shadow:
      inset 3px 0 0 var(--copper),
      0 10px 36px rgba(0, 0, 0, 0.5);
  }

  .work-card-titlebar {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    margin: 0 -12px;
    padding: 10px 12px 8px;
    border-bottom: 1px solid rgba(110, 188, 255, 0.16);
    background:
      linear-gradient(180deg, rgba(13, 22, 31, 0.96), rgba(9, 15, 22, 0.92));
    cursor: move;
    user-select: none;
  }

  .work-card-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    min-width: 0;
    flex: 1;
  }

  .work-card-title-group {
    min-width: 0;
    flex: 1;
  }

  .work-card-id {
    font-size: 9px;
    letter-spacing: 1.5px;
    color: #6ebcff;
    margin-bottom: 4px;
  }

  .work-card-title {
    font-size: 12px;
    line-height: 1.4;
    word-break: break-word;
  }

  .work-card-stage {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-end;
    font-size: 9px;
    color: var(--silk-dim);
    text-transform: uppercase;
    white-space: nowrap;
  }

  .work-card-close {
    border: 0;
    background: transparent;
    color: var(--silk-dim);
    font: inherit;
    font-size: 18px;
    line-height: 1;
    padding: 0;
    margin-top: -1px;
    cursor: pointer;
  }

  .work-card-actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .work-card-minimize {
    border: 0;
    background: transparent;
    color: var(--silk-dim);
    font: inherit;
    font-size: 16px;
    line-height: 1;
    padding: 0;
    cursor: pointer;
  }

  .work-card-minimize:hover {
    color: #6ebcff;
  }

  .work-card-close:hover:enabled {
    color: #ff6b6b;
  }

  .work-card-close:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .work-card-meta {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 9px;
    line-height: 1.4;
    color: var(--silk-dim);
    word-break: break-word;
  }

  .meta-label {
    color: var(--copper);
    letter-spacing: 1px;
    margin-right: 6px;
  }

  .work-card-files {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .file-chip {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 4px 6px;
    border: 1px solid rgba(110, 188, 255, 0.16);
    background: rgba(110, 188, 255, 0.05);
    font-size: 8px;
    color: var(--silk-dim);
  }

  .file-chip.active-file {
    border-color: rgba(110, 188, 255, 0.38);
    color: var(--silk-white);
  }

  .work-card-preview {
    min-height: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .preview-label {
    font-size: 9px;
    color: var(--silk-dim);
    letter-spacing: 1px;
  }

  .work-card-preview pre,
  .preview-status {
    margin: 0;
    padding: 8px;
    flex: 1;
    overflow: auto;
    background: rgba(0, 0, 0, 0.22);
    border: 1px solid rgba(110, 188, 255, 0.14);
    color: var(--silk-white);
    font-family: var(--font-mono);
    font-size: 9px;
    line-height: 1.5;
    white-space: pre-wrap;
    word-break: break-word;
    box-sizing: border-box;
  }

  .preview-status {
    color: var(--silk-dim);
  }

  .preview-status.error {
    color: var(--phosphor-red);
  }

  .work-card-review {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .review-comment {
    min-height: 54px;
    resize: vertical;
    background: rgba(0, 0, 0, 0.18);
    border: 1px solid var(--component-border);
    color: var(--silk-white);
    font-family: var(--font-mono);
    font-size: 9px;
    padding: 6px;
    box-sizing: border-box;
  }

  .review-comment:focus {
    outline: none;
    border-color: var(--copper);
  }

  .review-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .review-button {
    border: 1px solid var(--component-border);
    background: rgba(0, 0, 0, 0.16);
    color: var(--silk-white);
    font-family: var(--font-mono);
    font-size: 9px;
    padding: 5px 8px;
    cursor: pointer;
  }

  .review-button.approve:hover:not(:disabled) {
    border-color: var(--phosphor-green);
    color: var(--phosphor-green);
  }

  .review-button.improve:hover:not(:disabled) {
    border-color: var(--copper);
    color: var(--copper);
  }

  .review-button:disabled {
    opacity: 0.5;
    cursor: default;
  }

  .work-card-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: 0 -12px -12px;
    padding: 6px 12px;
    border-top: 1px solid rgba(110, 188, 255, 0.16);
    background: rgba(8, 14, 20, 0.92);
    flex-shrink: 0;
  }

  .footer-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    min-width: 0;
  }

  .activity-toggle-btn {
    height: 18px;
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

  .footer-label {
    font-size: 8px;
    color: var(--silk-dim);
    letter-spacing: 0.8px;
    text-transform: uppercase;
  }
</style>
