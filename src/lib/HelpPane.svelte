<script lang="ts">
  import { helpOpen } from './stores/mode';

  interface HelpRow {
    key: string;
    desc: string;
  }

  interface HelpSection {
    title: string;
    rows: HelpRow[];
  }

  const sections: HelpSection[] = [
    {
      title: 'MODE',
      rows: [
        { key: '?', desc: 'open help; any key or click closes it' },
        { key: ':', desc: 'open command bar' },
        { key: 'i', desc: 'enter input mode for the selected shell' },
        { key: 'Shift+Esc', desc: 'leave input mode and return to command mode' },
        { key: 'b', desc: 'toggle the tmux tree sidebar' },
        { key: ',', desc: 'toggle the settings sidebar' },
        { key: 'd', desc: 'toggle the debug pane' },
      ],
    },
    {
      title: 'NAVIGATION',
      rows: [
        { key: 'h / j / k / l', desc: 'focus left / down / up / right' },
        { key: 'n / p', desc: 'select next / previous shell' },
        { key: 'N / P', desc: 'select next / previous tab' },
      ],
    },
    {
      title: 'MOVE + PAN',
      rows: [
        { key: 'Ctrl+h/j/k/l', desc: 'move the selected shell' },
        { key: 'Ctrl+Shift+h/j/k/l', desc: 'move the selected shell faster' },
        { key: 'H / J / K / L', desc: 'pan the canvas when the sidebar is not open' },
      ],
    },
    {
      title: 'VIEW',
      rows: [
        { key: 'z', desc: 'toggle zoom to the selected shell' },
        { key: 'Z', desc: 'toggle fullscreen zoom' },
        { key: 'Shift+-', desc: 'zoom the canvas out' },
        { key: 'Shift+=', desc: 'zoom the canvas in' },
        { key: 'f', desc: 'fit all shells in view' },
        { key: '0', desc: 'reset canvas zoom and pan' },
        { key: 'a', desc: 'align the current session to the nearest grid points using the current grid size' },
        { key: 'Shift+A', desc: 'arrange the current session with ELK first, then cycle circle, snowflake, stack-down, stack-right, and spiral' },
      ],
    },
    {
      title: 'SHELLS',
      rows: [
        { key: 's', desc: 'spawn a new shell' },
        { key: 'x', desc: 'close the selected shell' },
      ],
    },
    {
      title: 'TABS',
      rows: [
        { key: 't', desc: 'create a new tab' },
        { key: 'w', desc: 'close the active tab' },
        { key: 'X', desc: 'close the active tab' },
      ],
    },
    {
      title: 'TREE SIDEBAR',
      rows: [
        { key: 'Shift+j / Shift+k', desc: 'focus the next / previous sidebar section' },
        { key: 'j / k', desc: 'move within the focused sidebar section' },
        { key: 'i', desc: 'enter input mode for the selected shell' },
        { key: 'r', desc: 'prefill a rename command for the selected item' },
        { key: 'z', desc: 'zoom to the selected shell' },
        { key: 'Z', desc: 'fullscreen zoom the selected shell' },
        { key: 'Esc / b', desc: 'close the tree sidebar' },
      ],
    },
    {
      title: 'SETTINGS SIDEBAR',
      rows: [
        { key: ',', desc: 'toggle the settings sidebar' },
        { key: 'Esc / ,', desc: 'close the settings sidebar' },
      ],
    },
    {
      title: 'INPUT MODE',
      rows: [
        { key: 'typing', desc: 'send printable keys to the shell' },
        { key: 'Enter / Tab / Backspace', desc: 'send terminal control keys' },
        { key: 'Arrows / Home / End / Delete', desc: 'send navigation keys' },
        { key: 'Ctrl+A..Z', desc: 'send control characters' },
      ],
    },
    {
      title: 'COMMAND BAR',
      rows: [
        { key: 'Enter', desc: 'run the current command' },
        { key: 'Esc', desc: 'close the command bar' },
        { key: ':sh | :shell | :new', desc: 'spawn a new shell' },
        { key: ':q | :close', desc: 'close the selected shell' },
        { key: ':qa | :closeall', desc: 'close all shells in the active tab' },
        { key: ':rename <name>', desc: 'rename the selected shell' },
        { key: ':tn | :tabnew [name]', desc: 'create a new tab' },
        { key: ':tc | :tabclose', desc: 'close the active tab' },
        { key: ':tr | :tabrename <name>', desc: 'rename the active tab' },
        { key: ':z | :zoom', desc: 'zoom to the selected shell' },
        { key: ':fit', desc: 'fit all shells in view' },
        { key: ':reset', desc: 'reset the canvas' },
      ],
    },
    {
      title: 'CLOSE CONFIRM',
      rows: [
        { key: 'Enter / y / Y / X', desc: 'confirm closing the tab' },
        { key: 'Esc / n / N', desc: 'cancel closing the tab' },
      ],
    },
  ];
</script>

{#if $helpOpen}
  <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
  <div class="help-overlay" onclick={() => helpOpen.set(false)}>
    <!-- svelte-ignore a11y_no_static_element_interactions a11y_click_events_have_key_events -->
    <div class="help-pane" onclick={(e) => e.stopPropagation()}>
      <div class="help-header">
        <span class="help-title">SHORTCUTS</span>
        <button class="help-close" onclick={() => helpOpen.set(false)}>×</button>
      </div>

      <div class="help-body">
        {#each sections as section (section.title)}
          <div class="help-section">
            <div class="section-title">{section.title}</div>
            {#each section.rows as row}
              <div class="help-row">
                <span class="hkey">{row.key}</span>
                <span class="hdesc">{row.desc}</span>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .help-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 2000;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .help-pane {
    background: var(--pcb-base);
    border: 1px solid var(--copper-dim);
    width: min(760px, calc(100vw - 32px));
    max-height: min(82vh, 760px);
    display: flex;
    flex-direction: column;
    box-shadow: 0 8px 40px rgba(0, 0, 0, 0.8);
  }

  .help-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--copper-dim);
    background: var(--pcb-mask);
  }

  .help-title {
    font-size: 11px;
    color: var(--phosphor-green);
    letter-spacing: 2px;
  }

  .help-close {
    background: none;
    border: none;
    color: var(--silk-dim);
    font-size: 16px;
    cursor: pointer;
    font-family: var(--font-mono);
    padding: 0 4px;
  }

  .help-close:hover {
    color: var(--phosphor-red);
  }

  .help-body {
    padding: 8px 12px;
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 12px;
    align-content: start;
  }

  .help-section {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .section-title {
    font-size: 9px;
    color: var(--copper);
    letter-spacing: 1px;
    padding-bottom: 3px;
    border-bottom: 1px solid var(--component-border);
    margin-bottom: 2px;
  }

  .help-row {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 1px 0;
  }

  .hkey {
    font-size: 10px;
    color: var(--phosphor-green);
    background: rgba(51, 255, 51, 0.06);
    border: 1px solid var(--component-border);
    padding: 1px 4px;
    min-width: 96px;
    text-align: left;
    flex-shrink: 0;
    font-family: var(--font-mono);
    line-height: 1.3;
  }

  .hdesc {
    font-size: 9px;
    color: var(--silk-dim);
    line-height: 1.35;
  }
</style>
