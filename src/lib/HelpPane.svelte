<script lang="ts">
  import { helpOpen } from './stores/mode';
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
        <div class="help-section">
          <div class="section-title">MODE</div>
          <div class="help-row"><span class="hkey">i</span><span class="hdesc">enter input mode</span></div>
          <div class="help-row"><span class="hkey">Shift+Esc</span><span class="hdesc">back to command mode</span></div>
          <div class="help-row"><span class="hkey">:</span><span class="hdesc">open command bar</span></div>
          <div class="help-row"><span class="hkey">?</span><span class="hdesc">toggle help</span></div>
          <div class="help-row"><span class="hkey">b</span><span class="hdesc">toggle tmux tree sidebar</span></div>
          <div class="help-row"><span class="hkey">d</span><span class="hdesc">toggle debug pane</span></div>
        </div>

        <div class="help-section">
          <div class="section-title">NAVIGATION</div>
          <div class="help-row"><span class="hkey">h</span><span class="hdesc">focus left</span></div>
          <div class="help-row"><span class="hkey">j</span><span class="hdesc">focus down</span></div>
          <div class="help-row"><span class="hkey">k</span><span class="hdesc">focus up</span></div>
          <div class="help-row"><span class="hkey">l</span><span class="hdesc">focus right</span></div>
          <div class="help-row"><span class="hkey">n</span><span class="hdesc">next window (cycle)</span></div>
          <div class="help-row"><span class="hkey">p</span><span class="hdesc">prev window (cycle)</span></div>
          <div class="help-row"><span class="hkey">Ctrl+h/j/k/l</span><span class="hdesc">move selected window</span></div>
          <div class="help-row"><span class="hkey">Ctrl+Shift+h/j/k/l</span><span class="hdesc">move selected window 2x</span></div>
          <div class="help-row"><span class="hkey">N</span><span class="hdesc">next tab</span></div>
          <div class="help-row"><span class="hkey">P</span><span class="hdesc">prev tab</span></div>
        </div>

        <div class="help-section">
          <div class="section-title">VIEW</div>
          <div class="help-row"><span class="hkey">z</span><span class="hdesc">toggle zoom to window</span></div>
          <div class="help-row"><span class="hkey">Shift+Z</span><span class="hdesc">toggle full-screen zoom</span></div>
          <div class="help-row"><span class="hkey">Shift+-</span><span class="hdesc">zoom canvas out</span></div>
          <div class="help-row"><span class="hkey">Shift++</span><span class="hdesc">zoom canvas in</span></div>
          <div class="help-row"><span class="hkey">Shift+H/J/K/L</span><span class="hdesc">pan canvas</span></div>
          <div class="help-row"><span class="hkey">f</span><span class="hdesc">fit all in view</span></div>
          <div class="help-row"><span class="hkey">0</span><span class="hdesc">reset zoom/pan</span></div>
          <div class="help-row"><span class="hkey">a</span><span class="hdesc">auto-arrange shells</span></div>
        </div>

        <div class="help-section">
          <div class="section-title">WINDOWS</div>
          <div class="help-row"><span class="hkey">s</span><span class="hdesc">new shell</span></div>
          <div class="help-row"><span class="hkey">x</span><span class="hdesc">close selected pane</span></div>
        </div>

        <div class="help-section">
          <div class="section-title">TABS</div>
          <div class="help-row"><span class="hkey">t</span><span class="hdesc">new tab</span></div>
          <div class="help-row"><span class="hkey">Shift+X</span><span class="hdesc">close tab</span></div>
        </div>

        <div class="help-section">
          <div class="section-title">COMMAND BAR</div>
          <div class="help-row"><span class="hkey">:sh</span><span class="hdesc">new shell</span></div>
          <div class="help-row"><span class="hkey">:q</span><span class="hdesc">close window</span></div>
          <div class="help-row"><span class="hkey">:qa</span><span class="hdesc">close all</span></div>
          <div class="help-row"><span class="hkey">:rename &lt;n&gt;</span><span class="hdesc">rename window</span></div>
          <div class="help-row"><span class="hkey">:tn</span><span class="hdesc">new tab</span></div>
          <div class="help-row"><span class="hkey">:tc</span><span class="hdesc">close tab</span></div>
          <div class="help-row"><span class="hkey">:tr &lt;n&gt;</span><span class="hdesc">rename tab</span></div>
          <div class="help-row"><span class="hkey">:z</span><span class="hdesc">zoom to window</span></div>
          <div class="help-row"><span class="hkey">:fit</span><span class="hdesc">fit all</span></div>
          <div class="help-row"><span class="hkey">:reset</span><span class="hdesc">reset view</span></div>
        </div>
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
    width: 520px;
    max-height: 80vh;
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
    grid-template-columns: 1fr 1fr;
    gap: 12px;
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
    align-items: center;
    gap: 8px;
    padding: 1px 0;
  }

  .hkey {
    font-size: 10px;
    color: var(--phosphor-green);
    background: rgba(51, 255, 51, 0.06);
    border: 1px solid var(--component-border);
    padding: 0 4px;
    min-width: 20px;
    text-align: center;
    flex-shrink: 0;
    font-family: var(--font-mono);
  }

  .hdesc {
    font-size: 9px;
    color: var(--silk-dim);
  }
</style>
