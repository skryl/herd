(() => {
const {
  BUTTON_NAMES,
  JSNES_EXTENSION_MANIFEST,
  createJsnesController,
} = globalThis.JsnesExtensionLogic;

const romFileEl = document.querySelector('#rom-file');
const bundledRomButtonEl = document.querySelector('#load-bundled-rom');
const fullscreenButtonEl = document.querySelector('#fullscreen-toggle');
const resetButtonEl = document.querySelector('#reset-rom');
const pauseButtonEl = document.querySelector('#toggle-pause');
const statusEl = document.querySelector('#status');
const romNameEl = document.querySelector('#rom-name');
const screenHostEl = document.querySelector('#screen-host');
const playerCardsEl = document.querySelector('#player-cards');
const apiMethodsEl = document.querySelector('#api-methods');
const fullscreenButtonAnchor = document.createComment('fullscreen-toggle-anchor');

fullscreenButtonEl?.after(fullscreenButtonAnchor);

const jsnesApi = globalThis.jsnes;
const BUTTON_TO_CONSTANT = Object.freeze({
  up: jsnesApi.Controller.BUTTON_UP,
  down: jsnesApi.Controller.BUTTON_DOWN,
  left: jsnesApi.Controller.BUTTON_LEFT,
  right: jsnesApi.Controller.BUTTON_RIGHT,
  a: jsnesApi.Controller.BUTTON_A,
  b: jsnesApi.Controller.BUTTON_B,
  start: jsnesApi.Controller.BUTTON_START,
  select: jsnesApi.Controller.BUTTON_SELECT,
});

let browser = null;
let running = false;
let resizeObserver = null;
let gameScreenFullscreen = false;

const controller = createJsnesController({
  onChange(view) {
    render(view);
  },
});

function updateFullscreenButton() {
  fullscreenButtonEl.textContent = gameScreenFullscreen ? 'Exit Full Screen' : 'Full Screen';
  fullscreenButtonEl.classList.toggle('is-active', gameScreenFullscreen);
}

function syncFullscreenButtonPlacement() {
  if (!fullscreenButtonEl || !fullscreenButtonAnchor.parentNode) {
    return;
  }
  if (gameScreenFullscreen) {
    if (fullscreenButtonEl.parentNode !== document.body) {
      document.body.appendChild(fullscreenButtonEl);
    }
    return;
  }
  if (fullscreenButtonEl.parentNode !== fullscreenButtonAnchor.parentNode) {
    fullscreenButtonAnchor.parentNode.insertBefore(fullscreenButtonEl, fullscreenButtonAnchor);
  }
}

function setGameScreenFullscreen(nextFullscreen) {
  gameScreenFullscreen = Boolean(nextFullscreen);
  document.body.classList.toggle('game-screen-fullscreen', gameScreenFullscreen);
  screenHostEl.classList.toggle('game-fullscreen', gameScreenFullscreen);
  syncFullscreenButtonPlacement();
  updateFullscreenButton();
}

function toggleGameScreenFullscreen() {
  setGameScreenFullscreen(!gameScreenFullscreen);
}

function handleWindowKeyDown(event) {
  if (event.key === 'Escape' && gameScreenFullscreen) {
    setGameScreenFullscreen(false);
  }
}

function defaultBundledRom(view = controller.getPublicState()) {
  return view.available_roms?.[0] ?? null;
}

function setRunning(nextRunning) {
  if (!browser || running === nextRunning) {
    return;
  }
  running = nextRunning;
  if (running) {
    browser.start();
  } else {
    browser.stop();
  }
}

function emulatorCanvas() {
  const canvas = screenHostEl.querySelector('canvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('NES screen canvas is unavailable');
  }
  return canvas;
}

function screenshotSource() {
  if (!browser) {
    throw new Error('jsnes is not ready');
  }
  const dataUrl = emulatorCanvas().toDataURL('image/png');
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) {
    throw new Error('NES screen capture did not produce a PNG data URL');
  }
  return {
    kind: 'png_base64',
    mime_type: 'image/png',
    data_base64: dataUrl.slice(prefix.length),
  };
}

function createEmulatorAdapter() {
  browser = new jsnesApi.Browser({
    container: screenHostEl,
    onError(error) {
      controller.reportError(error);
    },
  });
  running = false;

  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => {
      browser.fitInParent();
    });
    resizeObserver.observe(screenHostEl);
  } else {
    window.addEventListener('resize', () => browser.fitInParent());
  }

  return {
    loadRom(bytes) {
      browser.loadROM(bytes);
      running = true;
      browser.fitInParent();
    },
    reset() {
      browser.nes.reset();
      setRunning(true);
    },
    setPaused(paused) {
      setRunning(!paused);
    },
    setButton(player, button, pressed) {
      const constant = BUTTON_TO_CONSTANT[button];
      if (pressed) {
        browser.nes.buttonDown(player, constant);
        return;
      }
      browser.nes.buttonUp(player, constant);
    },
    releaseAllButtons(player) {
      for (const button of BUTTON_NAMES) {
        browser.nes.buttonUp(player, BUTTON_TO_CONSTANT[button]);
      }
    },
    screenshot() {
      return screenshotSource();
    },
  };
}

function renderMethods() {
  apiMethodsEl.innerHTML = '';
  for (const method of JSNES_EXTENSION_MANIFEST.methods) {
    const item = document.createElement('li');
    item.textContent = method.name;
    apiMethodsEl.appendChild(item);
  }
}

function formatHeldButtons(player) {
  const held = BUTTON_NAMES.filter((button) => player.buttons?.[button]);
  return held.length ? held.join(', ') : 'none';
}

function renderPlayers(view) {
  playerCardsEl.innerHTML = '';
  for (const player of view.players) {
    const article = document.createElement('article');
    article.className = 'player-card';
    if (player.claimed) {
      article.dataset.claimed = 'true';
    }

    const heading = document.createElement('div');
    heading.className = 'player-heading';

    const title = document.createElement('strong');
    title.textContent = `Player ${player.player}`;

    const badge = document.createElement('span');
    badge.className = 'player-badge';
    badge.textContent = player.claimed ? 'claimed' : 'open';

    heading.append(title, badge);

    const owner = document.createElement('p');
    owner.className = 'player-meta';
    owner.textContent = player.claimed
      ? `${player.name} via ${player.owner_tile_id}`
      : 'Available to claim through extension_call';

    const buttons = document.createElement('p');
    buttons.className = 'player-meta';
    buttons.textContent = `Held: ${formatHeldButtons(player)}`;

    article.append(heading, owner, buttons);
    playerCardsEl.appendChild(article);
  }
}

function render(view = controller.getPublicState()) {
  statusEl.textContent = view.status;
  statusEl.dataset.tone = view.status_tone ?? 'info';
  romNameEl.textContent = view.rom
    ? `${view.rom.filename} · ${view.rom.size} bytes · ${view.paused ? 'paused' : 'running'}`
    : 'No ROM loaded.';
  resetButtonEl.disabled = !view.loaded;
  pauseButtonEl.disabled = !view.loaded;
  pauseButtonEl.textContent = view.paused ? 'Resume' : 'Pause';
  const bundledRom = defaultBundledRom(view);
  bundledRomButtonEl.disabled = !view.core_ready || !bundledRom;
  bundledRomButtonEl.textContent = bundledRom ? `Load ${bundledRom.label}` : 'No Bundled ROMs';
  renderPlayers(view);
}

romFileEl.addEventListener('change', async (event) => {
  const input = event.currentTarget;
  const file = input.files?.[0] ?? null;
  if (!file) {
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    controller.loadRomBytes(bytes, {
      filename: file.name,
      source: 'local',
    });
  } catch (error) {
    controller.reportError(error);
  } finally {
    input.value = '';
  }
});

bundledRomButtonEl.addEventListener('click', () => {
  const bundledRom = defaultBundledRom();
  if (!bundledRom) {
    return;
  }
  try {
    controller.call('load_bundled_rom', { rom: bundledRom.filename });
  } catch (error) {
    controller.reportError(error);
  }
});

fullscreenButtonEl.addEventListener('click', () => {
  toggleGameScreenFullscreen();
});

resetButtonEl.addEventListener('click', () => {
  try {
    controller.call('reset');
  } catch (error) {
    controller.reportError(error);
  }
});

pauseButtonEl.addEventListener('click', () => {
  try {
    controller.call('toggle_pause');
  } catch (error) {
    controller.reportError(error);
  }
});

controller.attachEmulator(createEmulatorAdapter());

globalThis.HerdBrowserExtension = {
  manifest: JSNES_EXTENSION_MANIFEST,
  call(method, args, context) {
    try {
      return controller.call(method, args, context);
    } catch (error) {
      controller.reportError(error);
      throw error;
    }
  },
};

window.addEventListener('keydown', handleWindowKeyDown);

renderMethods();
updateFullscreenButton();
render();
})();
