<script lang="ts">
  import type { ContextMenuItem } from './types';
  import { contextMenuItems, contextMenuState, dismissContextMenu, selectContextMenuItem } from './stores/appState';

  let openSubmenuId = $state<string | null>(null);

  function handleItemClick(itemId: string, disabled: boolean) {
    if (disabled) return;
    void selectContextMenuItem(itemId);
  }

  function openSubmenu(item: ContextMenuItem) {
    openSubmenuId = item.kind === 'submenu' ? item.id : null;
  }

  function closeSubmenu(item: ContextMenuItem) {
    if (openSubmenuId === item.id) {
      openSubmenuId = null;
    }
  }
</script>

{#if $contextMenuState}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="context-menu-backdrop"
    tabindex="-1"
    onclick={() => { openSubmenuId = null; dismissContextMenu(); }}
    onkeydown={(e) => {
      if (e.key === 'Escape') {
        openSubmenuId = null;
        dismissContextMenu();
      }
    }}
  >
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="context-menu"
      tabindex="-1"
      style="left: {$contextMenuState.clientX}px; top: {$contextMenuState.clientY}px;"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      onmousedown={(e) => e.stopPropagation()}
      oncontextmenu={(e) => e.preventDefault()}
    >
      {#each $contextMenuItems as item (item.id)}
        {#if item.kind === 'separator'}
          <div class="context-separator"></div>
        {:else if item.kind === 'label'}
          <div class="context-label">{item.label}</div>
        {:else if item.kind === 'status'}
          <div class="context-status">{item.label}</div>
        {:else if item.kind === 'submenu'}
          <!-- svelte-ignore a11y_no_static_element_interactions a11y_mouse_events_have_key_events -->
          <div
            class="context-submenu-wrap"
            onmouseenter={() => openSubmenu(item)}
            onmouseleave={() => closeSubmenu(item)}
          >
            <button
              class="context-action context-submenu-trigger"
              class:disabled={item.disabled}
              disabled={item.disabled}
              onclick={(e) => e.preventDefault()}
            >
              <span>{item.label}</span>
              <span class="submenu-arrow">›</span>
            </button>

            {#if openSubmenuId === item.id && item.children}
              <div
                class="context-menu context-submenu"
                tabindex="-1"
                onclick={(e) => e.stopPropagation()}
                onkeydown={(e) => e.stopPropagation()}
                onmousedown={(e) => e.stopPropagation()}
                oncontextmenu={(e) => e.preventDefault()}
              >
                {#each item.children as child (child.id)}
                  {#if child.kind === 'separator'}
                    <div class="context-separator"></div>
                  {:else if child.kind === 'label'}
                    <div class="context-label">{child.label}</div>
                  {:else if child.kind === 'status'}
                    <div class="context-status">{child.label}</div>
                  {:else}
                    <button
                      class="context-action"
                      class:disabled={child.disabled}
                      disabled={child.disabled}
                      onclick={() => handleItemClick(child.id, child.disabled)}
                    >
                      {child.label}
                    </button>
                  {/if}
                {/each}
              </div>
            {/if}
          </div>
        {:else}
          <button
            class="context-action"
            class:disabled={item.disabled}
            disabled={item.disabled}
            onclick={() => handleItemClick(item.id, item.disabled)}
          >
            {item.label}
          </button>
        {/if}
      {/each}
    </div>
  </div>
{/if}

<style>
  .context-menu-backdrop {
    position: absolute;
    inset: 0;
    z-index: 5000;
  }

  .context-menu {
    position: absolute;
    min-width: 180px;
    max-width: min(320px, calc(100vw - 24px));
    display: flex;
    flex-direction: column;
    padding: 6px 0;
    background: rgba(8, 14, 8, 0.96);
    border: 1px solid var(--component-border);
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.75);
    backdrop-filter: blur(6px);
    z-index: 5001;
  }

  .context-action,
  .context-label,
  .context-status {
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.4;
    padding: 7px 12px;
    text-align: left;
  }

  .context-action {
    background: transparent;
    border: none;
    color: var(--silk-white);
    cursor: pointer;
  }

  .context-submenu-wrap {
    position: relative;
  }

  .context-submenu-trigger {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .context-submenu {
    top: -6px;
    left: calc(100% - 1px);
    z-index: 5002;
  }

  .submenu-arrow {
    color: var(--copper);
    margin-left: 16px;
  }

  .context-action:hover:not(.disabled) {
    background: rgba(51, 255, 51, 0.08);
    color: var(--phosphor-green);
  }

  .context-action.disabled,
  .context-action:disabled {
    color: var(--silk-dim);
    cursor: default;
  }

  .context-label {
    color: var(--copper);
    letter-spacing: 0.8px;
    text-transform: uppercase;
  }

  .context-status {
    color: var(--silk-dim);
  }

  .context-separator {
    height: 1px;
    margin: 4px 0;
    background: rgba(255, 255, 255, 0.08);
  }
</style>
