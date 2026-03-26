/*
 * Copyright (C) 2020 Ben Smith
 *
 * This software may be modified and distributed under the terms
 * of the MIT license.  See the LICENSE file for details.
 *
 *
 * Some code from GB-Studio, see LICENSE.gbstudio
 */
"use strict";

// User configurable.
const ENABLE_FAST_FORWARD = true;
const ENABLE_REWIND = true;
const ENABLE_PAUSE = true;
const ENABLE_SWITCH_PALETTES = true;
const OSGP_DEADZONE = 0.1;    // On screen gamepad deadzone range
const CGB_COLOR_CURVE = 2;    // 0: none, 1: Sameboy "Emulate Hardware" 2: Gambatte/Gameboy Online
const STORAGE_PREFIX = 'herd:binjgb';

// List of DMG palettes to switch between. By default it includes all 84
// built-in palettes. If you want to restrict this, change it to an array of
// the palettes you want to use and change DEFAULT_PALETTE_IDX to the index of the
// default palette in that list.
//
// Example: (only allow one palette with index 16):
//   const DEFAULT_PALETTE_IDX = 0;
//   const PALETTES = [16];
//
// Example: (allow three palettes, 16, 32, 64, with default 32):
//   const DEFAULT_PALETTE_IDX = 1;
//   const PALETTES = [16, 32, 64];
//
const DEFAULT_PALETTE_IDX = 79;
const PALETTES = [
  0,  1,  2,  3,  4,  5,  6,  7,  8,  9,  10, 11, 12, 13, 14, 15, 16,
  17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33,
  34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50,
  51, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66, 67,
  68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82, 83,
];

// It's probably OK to leave these alone. But you can tweak them to get better
// rewind performance.
const REWIND_FRAMES_PER_BASE_STATE = 45;  // How many delta frames until keyframe
const REWIND_BUFFER_CAPACITY = 4 * 1024 * 1024;  // Total rewind capacity
const REWIND_FACTOR = 1.5;    // How fast is rewind compared to normal speed
const REWIND_UPDATE_MS = 16;  // Rewind setInterval rate

// Probably OK to leave these alone too.
const AUDIO_FRAMES = 4096;      // Number of audio frames pushed per buffer
const AUDIO_LATENCY_SEC = 0.1;
const MAX_UPDATE_SEC = 5 / 60;  // Max. time to run emulator per step (== 5 frames)

// Constants
const RESULT_OK = 0;
const RESULT_ERROR = 1;
const SCREEN_WIDTH = 160;
const SCREEN_HEIGHT = 144;
const GRID_COLUMNS = 10;
const GRID_ROWS = 9;
const GRID_CELL_WIDTH = SCREEN_WIDTH / GRID_COLUMNS;
const GRID_CELL_HEIGHT = SCREEN_HEIGHT / GRID_ROWS;
const CPU_TICKS_PER_SECOND = 4194304;
const EVENT_NEW_FRAME = 1;
const EVENT_AUDIO_BUFFER_FULL = 2;
const EVENT_UNTIL_TICKS = 4;

const $ = document.querySelector.bind(document);
let emulator = null;

const controllerEl = $('#controller');
const dpadEl = $('#controller_dpad');
const selectEl = $('#controller_select');
const startEl = $('#controller_start');
const bEl = $('#controller_b');
const aEl = $('#controller_a');
const romFileEl = $('#rom-file');
const statusEl = $('#status');
const romNameEl = $('#rom-name');
const saveStatusEl = $('#save-status');
const bundledRomButtonEl = $('#load-bundled-rom');
const gridOverlayButtonEl = $('#toggle-grid-overlay');
const fullscreenButtonEl = $('#fullscreen-toggle');
const resetButtonEl = $('#reset-rom');
const pauseButtonEl = $('#toggle-pause');
const saveStateButtonEl = $('#save-state');
const loadStateButtonEl = $('#load-state');
const clearSaveButtonEl = $('#clear-save');
const gameSurfaceEl = $('#game');
const gridOverlayCanvasEl = $('#grid-overlay');
const fullscreenButtonAnchor = document.createComment('fullscreen-toggle-anchor');

fullscreenButtonEl?.after(fullscreenButtonAnchor);

let gameScreenFullscreen = false;

function decodeBase64ToBytes(base64) {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) {
    bytes[index] = text.charCodeAt(index);
  }
  return bytes;
}

const binjgbPromise = window.GameBoyWasmBase64
  ? Binjgb({ wasmBinary: decodeBase64ToBytes(window.GameBoyWasmBase64) })
  : Binjgb();
const BUNDLED_ROMS = Object.freeze(
  window.GameBoyBundledRoms && typeof window.GameBoyBundledRoms === 'object'
    ? window.GameBoyBundledRoms
    : {},
);
const BUNDLED_ROM_NAMES = Object.freeze(Object.keys(BUNDLED_ROMS).sort());
const BUTTON_NAMES = Object.freeze(['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select']);
const DEFAULT_BUNDLED_ROM = BUNDLED_ROM_NAMES[0] ?? null;
const DEFAULT_BUTTON_COMBO_DELAY_MS = 120;
const DEFAULT_BUTTON_COMBO_HOLD_MS = 80;
const SCREENSHOT_METHOD_ARGS = Object.freeze([
  {
    name: 'format',
    type: 'string',
    required: false,
    description: 'Screenshot output format.',
    enum_values: ['image', 'braille', 'ascii', 'ansi', 'text'],
  },
  {
    name: 'columns',
    type: 'integer',
    required: false,
    description: 'Requested output width in characters for text-based formats.',
  },
]);
const GRID_OVERLAY_METHOD_ARGS = Object.freeze([
  {
    name: 'enabled',
    type: 'boolean',
    required: true,
    description: 'Whether to show the navigation grid overlay.',
  },
]);
const BUTTON_COMBO_METHOD_ARGS = Object.freeze([
  {
    name: 'sequence',
    type: 'array',
    required: true,
    description: 'Ordered combo steps. Each step must be an object with a non-empty `buttons` string array.',
  },
  {
    name: 'delay_ms',
    type: 'integer',
    required: false,
    description: `Delay in milliseconds between combo step starts. Defaults to ${DEFAULT_BUTTON_COMBO_DELAY_MS}.`,
  },
  {
    name: 'hold_ms',
    type: 'integer',
    required: false,
    description: `How long to hold each combo step before release. Defaults to ${DEFAULT_BUTTON_COMBO_HOLD_MS}.`,
  },
]);
const GAME_BOY_EXTENSION_MANIFEST = {
  extension_id: 'game-boy',
  label: 'Game Boy',
  methods: [
    {
      name: 'state',
      description: 'Return the current emulator status, loaded ROM, and bundled cartridges.',
      args: [],
    },
    {
      name: 'load_bundled_rom',
      description: 'Load one of the ROMs bundled with this extension.',
      args: [
        {
          name: 'rom',
          type: 'string',
          required: false,
          description: 'Bundled ROM filename to load.',
          enum_values: BUNDLED_ROM_NAMES,
        },
      ],
    },
    {
      name: 'reset',
      description: 'Restart the current ROM from power-on state.',
      args: [],
    },
    {
      name: 'toggle_pause',
      description: 'Toggle paused state for the active ROM.',
      args: [],
    },
    {
      name: 'save_state',
      description: 'Persist the current save state in local browser storage.',
      args: [],
    },
    {
      name: 'load_state',
      description: 'Restore the saved state for the current ROM from local browser storage.',
      args: [],
    },
    {
      name: 'clear_save',
      description: 'Delete battery save and save state data for the current ROM.',
      args: [],
    },
    {
      name: 'screenshot',
      description: 'Capture the current emulator screen.',
      args: SCREENSHOT_METHOD_ARGS,
    },
    {
      name: 'set_grid_overlay',
      description: 'Show or hide the labeled navigation grid overlay.',
      args: GRID_OVERLAY_METHOD_ARGS,
    },
    {
      name: 'set_button',
      description: 'Press or release one Game Boy control button.',
      args: [
        {
          name: 'button',
          type: 'string',
          required: true,
          description: 'Button name.',
          enum_values: BUTTON_NAMES,
        },
        {
          name: 'pressed',
          type: 'boolean',
          required: false,
          description: 'Whether the button is currently pressed. Defaults to true.',
        },
      ],
    },
    {
      name: 'button_combo',
      description: 'Play an ordered button combo using timer-backed presses on the shared Game Boy controller.',
      args: BUTTON_COMBO_METHOD_ARGS,
    },
    {
      name: 'release_all_buttons',
      description: 'Release every currently held button.',
      args: [],
    },
  ],
};
let binjgbModule = null;
let currentRom = null;
let gridOverlayEnabled = false;
const buttonStates = Object.fromEntries(BUTTON_NAMES.map((button) => [button, false]));
const activeButtonCombo = {
  generation: 0,
  timers: new Set(),
};

function setStatus(message, tone = 'info') {
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function setRomName(message) {
  romNameEl.textContent = message;
}

function setSaveStatus(message) {
  saveStatusEl.textContent = message;
}

function bundledRomSummaries() {
  return BUNDLED_ROM_NAMES.map((filename) => ({
    filename,
    label: BUNDLED_ROMS[filename].label || filename,
    size: BUNDLED_ROMS[filename].size || 0,
  }));
}

function updateFullscreenButton() {
  if (!fullscreenButtonEl) {
    return;
  }
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
  gameSurfaceEl?.classList.toggle('game-fullscreen', gameScreenFullscreen);
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

function storageKey(rom, kind) {
  return rom ? `${STORAGE_PREFIX}:${rom.id}:${kind}` : null;
}

function readStoredBytes(rom, kind) {
  const key = storageKey(rom, kind);
  if (!key) {
    return null;
  }
  try {
    const raw = localStorage.getItem(key);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return null;
    }
    return new Uint8Array(parsed);
  } catch {
    return null;
  }
}

function writeStoredBytes(rom, kind, bytes) {
  const key = storageKey(rom, kind);
  if (!key) {
    return;
  }
  localStorage.setItem(key, JSON.stringify(Array.from(bytes)));
}

function deleteStoredBytes(rom, kind) {
  const key = storageKey(rom, kind);
  if (!key) {
    return;
  }
  localStorage.removeItem(key);
}

function hasStoredState(rom, kind) {
  const key = storageKey(rom, kind);
  return Boolean(key && localStorage.getItem(key));
}

function formatFileSize(size) {
  if (!Number.isFinite(size) || size <= 0) {
    return '0 B';
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

async function buildRomId(file, romBuffer) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return `${file.name}:${file.size}:${file.lastModified}`.replace(/[^\w.-]+/g, '-');
  }
  const digest = await subtle.digest('SHA-1', romBuffer);
  const hex = Array.from(new Uint8Array(digest))
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
  return `${file.name}:${hex.slice(0, 16)}`.replace(/[^\w.-]+/g, '-');
}

function decodeBase64(base64) {
  return decodeBase64ToBytes(base64).buffer;
}

function buildBundledRom(filename) {
  const bundled = BUNDLED_ROMS[filename];
  if (!bundled) {
    throw new Error(`unknown bundled ROM: ${filename}`);
  }
  return {
    id: bundled.id || filename,
    name: bundled.label || filename,
    filename,
    size: bundled.size || 0,
    source: 'bundled',
    buffer: decodeBase64(bundled.base64),
  };
}

function romSummary(rom) {
  if (!rom) {
    return null;
  }
  return {
    id: rom.id,
    name: rom.name,
    filename: rom.filename || rom.name,
    size: rom.size,
    source: rom.source,
  };
}

function currentState() {
  return {
    core_ready: Boolean(binjgbModule),
    loaded: Boolean(emulator && currentRom),
    paused: Boolean(emulator && vm.paused),
    status: statusEl.textContent.trim(),
    rom: romSummary(currentRom),
    available_roms: bundledRomSummaries(),
    has_save_state: hasStoredState(currentRom, 'saveState'),
    has_battery_save: hasStoredState(currentRom, 'extram'),
    grid_overlay_enabled: gridOverlayEnabled,
    grid_overlay: {
      columns: GRID_COLUMNS,
      rows: GRID_ROWS,
      origin: 'bottom_left',
      cell_label_format: 'row.col',
    },
    buttons: { ...buttonStates },
  };
}

function requireCoreReady() {
  if (!binjgbModule) {
    throw new Error('emulator core is still initializing');
  }
  return binjgbModule;
}

function requireCurrentRom() {
  if (!currentRom) {
    throw new Error('no ROM is loaded');
  }
  return currentRom;
}

function requireCurrentEmulator() {
  if (!emulator || !currentRom) {
    throw new Error('no ROM is loaded');
  }
  return emulator;
}

function emulatorCanvas() {
  const canvas = $('#mainCanvas');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('game screen canvas is unavailable');
  }
  return canvas;
}

function syncGridOverlayButton() {
  if (!gridOverlayButtonEl) {
    return;
  }
  gridOverlayButtonEl.textContent = gridOverlayEnabled ? 'Hide Grid' : 'Show Grid';
  gridOverlayButtonEl.classList.toggle('is-active', gridOverlayEnabled);
}

function drawOverlayLabel(context, text, centerX, centerY, fontSizePx, maxWidth, maxHeight) {
  context.save();
  context.font = `${fontSizePx}px "SFMono-Regular", Consolas, monospace`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = 'rgba(255, 245, 168, 0.98)';
  context.fillText(
    text,
    Math.max(0, Math.min(maxWidth, centerX)),
    Math.max(fontSizePx / 2, Math.min(maxHeight - fontSizePx / 2, centerY)) + 0.2,
  );
  context.restore();
}

function drawGridOverlay(context, width, height) {
  const cellWidth = width / GRID_COLUMNS;
  const cellHeight = height / GRID_ROWS;
  const cellFontSize = Math.max(4, Math.min(cellWidth, cellHeight) * 0.32);

  context.save();
  context.clearRect(0, 0, width, height);
  context.strokeStyle = 'rgba(255, 128, 192, 0.82)';
  context.lineWidth = Math.max(1, Math.min(cellWidth, cellHeight) * 0.07);
  context.beginPath();
  for (let column = 0; column <= GRID_COLUMNS; column += 1) {
    const x = Math.round(column * cellWidth) + 0.5;
    context.moveTo(x, 0);
    context.lineTo(x, height);
  }
  for (let row = 0; row <= GRID_ROWS; row += 1) {
    const y = Math.round(row * cellHeight) + 0.5;
    context.moveTo(0, y);
    context.lineTo(width, y);
  }
  context.stroke();
  context.restore();

  for (let row = 0; row < GRID_ROWS; row += 1) {
    const centerY = height - ((row + 0.5) * cellHeight);
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      const centerX = (column + 0.5) * cellWidth;
      drawOverlayLabel(context, `${row}.${column}`, centerX, centerY, cellFontSize, width, height);
    }
  }
}

function renderGridOverlay() {
  gameSurfaceEl?.classList.toggle('grid-overlay-visible', gridOverlayEnabled);
  syncGridOverlayButton();
  if (!(gridOverlayCanvasEl instanceof HTMLCanvasElement)) {
    return;
  }
  const context = gridOverlayCanvasEl.getContext('2d');
  if (!context) {
    return;
  }
  context.clearRect(0, 0, gridOverlayCanvasEl.width, gridOverlayCanvasEl.height);
  if (!gridOverlayEnabled) {
    return;
  }
  drawGridOverlay(context, gridOverlayCanvasEl.width, gridOverlayCanvasEl.height);
}

function setGridOverlayEnabled(enabled) {
  gridOverlayEnabled = Boolean(enabled);
  renderGridOverlay();
  return currentState();
}

function screenshotSource() {
  requireCurrentEmulator();
  const canvas = emulatorCanvas();
  const compositeCanvas = document.createElement('canvas');
  compositeCanvas.width = canvas.width;
  compositeCanvas.height = canvas.height;
  const compositeContext = compositeCanvas.getContext('2d');
  if (!compositeContext) {
    throw new Error('game screen capture context is unavailable');
  }
  compositeContext.drawImage(canvas, 0, 0);
  if (gridOverlayEnabled) {
    drawGridOverlay(compositeContext, compositeCanvas.width, compositeCanvas.height);
  }
  const dataUrl = compositeCanvas.toDataURL('image/png');
  const prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(prefix)) {
    throw new Error('game screen capture did not produce a PNG data URL');
  }
  return {
    kind: 'png_base64',
    mime_type: 'image/png',
    data_base64: dataUrl.slice(prefix.length),
  };
}

function normalizeComboDuration(value, fallback, name) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const duration = Number(value);
  if (!Number.isInteger(duration) || duration < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return duration;
}

function normalizeButtonComboSequence(sequence) {
  if (!Array.isArray(sequence) || sequence.length === 0) {
    throw new Error('button_combo sequence must be a non-empty array');
  }
  return sequence.map((step, index) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new Error(`button_combo step ${index + 1} must be an object`);
    }
    const buttons = step.buttons;
    if (!Array.isArray(buttons) || buttons.length === 0) {
      throw new Error(`button_combo step ${index + 1} requires a non-empty buttons array`);
    }
    const normalized = [];
    for (const rawButton of buttons) {
      const button = String(rawButton ?? '').trim().toLowerCase();
      if (!BUTTON_NAMES.includes(button)) {
        throw new Error(`button_combo step ${index + 1} uses invalid button: ${rawButton}`);
      }
      if (!normalized.includes(button)) {
        normalized.push(button);
      }
    }
    return normalized;
  });
}

function clearPendingButtonCombo() {
  activeButtonCombo.generation += 1;
  for (const timerId of activeButtonCombo.timers) {
    window.clearTimeout(timerId);
  }
  activeButtonCombo.timers.clear();
}

function scheduleButtonComboCallback(generation, delayMs, callback) {
  const timerId = window.setTimeout(() => {
    activeButtonCombo.timers.delete(timerId);
    if (activeButtonCombo.generation !== generation) {
      return;
    }
    callback();
  }, delayMs);
  activeButtonCombo.timers.add(timerId);
}

function clearButtonStates() {
  for (const button of BUTTON_NAMES) {
    buttonStates[button] = false;
  }
}

function applyButtonState(button, pressed) {
  const activeEmulator = requireCurrentEmulator();
  const nextPressed = Boolean(pressed);
  switch (button) {
    case 'up':
      activeEmulator.setJoypUp(nextPressed);
      break;
    case 'down':
      activeEmulator.setJoypDown(nextPressed);
      break;
    case 'left':
      activeEmulator.setJoypLeft(nextPressed);
      break;
    case 'right':
      activeEmulator.setJoypRight(nextPressed);
      break;
    case 'a':
      activeEmulator.setJoypA(nextPressed);
      break;
    case 'b':
      activeEmulator.setJoypB(nextPressed);
      break;
    case 'start':
      activeEmulator.setJoypStart(nextPressed);
      break;
    case 'select':
      activeEmulator.setJoypSelect(nextPressed);
      break;
    default:
      throw new Error(`invalid button: ${button}`);
  }
  buttonStates[button] = nextPressed;
}

function releaseAllButtons(options = {}) {
  if (options.cancelCombo !== false) {
    clearPendingButtonCombo();
  }
  if (emulator && currentRom) {
    for (const button of BUTTON_NAMES) {
      applyButtonState(button, false);
    }
  } else {
    clearButtonStates();
  }
}

function startButtonCombo(args = {}) {
  requireCurrentEmulator();
  const sequence = normalizeButtonComboSequence(args.sequence);
  const delayMs = normalizeComboDuration(args.delay_ms, DEFAULT_BUTTON_COMBO_DELAY_MS, 'delay_ms');
  const holdMs = normalizeComboDuration(args.hold_ms, DEFAULT_BUTTON_COMBO_HOLD_MS, 'hold_ms');

  clearPendingButtonCombo();
  releaseAllButtons({ cancelCombo: false });
  const generation = activeButtonCombo.generation;

  const runStep = (stepIndex) => {
    const buttons = sequence[stepIndex];
    releaseAllButtons({ cancelCombo: false });
    for (const button of buttons) {
      applyButtonState(button, true);
    }
    const releaseAfterMs = stepIndex === sequence.length - 1
      ? holdMs
      : Math.min(holdMs, delayMs);
    scheduleButtonComboCallback(generation, releaseAfterMs, () => {
      for (const button of buttons) {
        applyButtonState(button, false);
      }
    });
  };

  runStep(0);
  for (let index = 1; index < sequence.length; index += 1) {
    scheduleButtonComboCallback(generation, index * delayMs, () => {
      runStep(index);
    });
  }

  return {
    sequence_length: sequence.length,
    delay_ms: delayMs,
    hold_ms: holdMs,
    state: currentState(),
  };
}

function syncRuntimeButtons() {
  const loaded = Boolean(emulator && currentRom);
  if (bundledRomButtonEl) {
    bundledRomButtonEl.disabled = !DEFAULT_BUNDLED_ROM;
  }
  resetButtonEl.disabled = !loaded;
  pauseButtonEl.disabled = !loaded;
  saveStateButtonEl.disabled = !loaded;
  loadStateButtonEl.disabled = !loaded || !hasStoredState(currentRom, 'saveState');
  clearSaveButtonEl.disabled = !loaded && !hasStoredState(currentRom, 'extram') && !hasStoredState(currentRom, 'saveState');
  pauseButtonEl.textContent = vm.paused ? 'Resume' : 'Pause';
  syncGridOverlayButton();
}

function startRom(nextRom, module, verb = 'Loaded') {
  const extRam = readStoredBytes(nextRom, 'extram');
  releaseAllButtons();
  vm.paused = false;
  vm.palIdx = DEFAULT_PALETTE_IDX;
  Emulator.start(module, nextRom.buffer, extRam);
  currentRom = nextRom;
  emulator.setBuiltinPalette(vm.palIdx);
  setRomName(
    `${nextRom.name} • ${formatFileSize(nextRom.size)}${nextRom.source === 'bundled' ? ' • bundled ROM' : ''}`,
  );
  setStatus(`${verb} ${nextRom.name}.`, 'success');
  setSaveStatus(
    extRam
      ? 'Battery save restored from local storage for this ROM.'
      : 'No existing battery save found. Local save data will be created automatically.',
  );
  syncRuntimeButtons();
  return currentState();
}

async function loadRomFile(file) {
  if (!file) {
    return;
  }

  setStatus(`Loading ${file.name}...`);
  setRomName(`${file.name} • ${formatFileSize(file.size)}`);
  try {
    const romBuffer = await file.arrayBuffer();
    const nextRom = {
      id: await buildRomId(file, romBuffer),
      name: file.name,
      filename: file.name,
      size: file.size,
      source: 'local',
      buffer: romBuffer,
    };
    startRom(nextRom, await binjgbPromise);
  } catch (error) {
    Emulator.stop();
    currentRom = null;
    clearPendingButtonCombo();
    clearButtonStates();
    setStatus(error instanceof Error ? error.message : String(error), 'error');
    setRomName('No ROM loaded.');
    setSaveStatus('Load a local .gb or .gbc file, or use the bundled Pokemon Yellow ROM.');
    syncRuntimeButtons();
  }
}

async function restartCurrentRom() {
  const rom = requireCurrentRom();
  return startRom(rom, await binjgbPromise, 'Restarted');
}

function restartCurrentRomSync() {
  const rom = requireCurrentRom();
  return startRom(rom, requireCoreReady(), 'Restarted');
}

async function loadBundledRom(filename = DEFAULT_BUNDLED_ROM) {
  if (!filename) {
    throw new Error('no bundled ROMs are available');
  }
  return startRom(buildBundledRom(filename), await binjgbPromise);
}

function loadBundledRomSync(filename = DEFAULT_BUNDLED_ROM) {
  if (!filename) {
    throw new Error('no bundled ROMs are available');
  }
  return startRom(buildBundledRom(filename), requireCoreReady());
}

function togglePause() {
  requireCurrentEmulator();
  vm.togglePause();
  setStatus(vm.paused ? 'Emulation paused.' : 'Emulation resumed.', 'success');
  syncRuntimeButtons();
  return currentState();
}

function saveCurrentState() {
  const activeEmulator = requireCurrentEmulator();
  activeEmulator.saveState();
  setStatus(`Saved state for ${currentRom.name}.`, 'success');
  syncRuntimeButtons();
  return currentState();
}

function loadCurrentState() {
  const activeEmulator = requireCurrentEmulator();
  activeEmulator.loadState();
  setStatus(`Loaded save state for ${currentRom.name}.`, 'success');
  syncRuntimeButtons();
  return currentState();
}

function clearCurrentSave() {
  const rom = requireCurrentRom();
  deleteStoredBytes(rom, 'extram');
  deleteStoredBytes(rom, 'saveState');
  setSaveStatus('Cleared local battery save and save state for the current ROM.');
  setStatus(`Cleared stored data for ${rom.name}.`, 'success');
  if (emulator) {
    return restartCurrentRomSync();
  }
  syncRuntimeButtons();
  return currentState();
}

// Extract stuff from the vue.js implementation in demo.js.
class VM {
  constructor() {
    this.ticks = 0;
    this.extRamUpdated = false;
    this.paused_ = false;
    this.volume = 0.5;
    this.palIdx = DEFAULT_PALETTE_IDX;
    this.rewind = {
      minTicks: 0,
      maxTicks: 0,
    };
    setInterval(() => {
      if (this.extRamUpdated) {
        this.updateExtRam();
        this.extRamUpdated = false;
      }
    }, 1000);
  }

  get paused() { return this.paused_; }
  set paused(newPaused) {
    let oldPaused = this.paused_;
    this.paused_ = newPaused;
    if (!emulator) {
      syncRuntimeButtons();
      return;
    }
    if (newPaused == oldPaused) {
      syncRuntimeButtons();
      return;
    }
    if (newPaused) {
      emulator.pause();
      this.ticks = emulator.ticks;
      this.rewind.minTicks = emulator.rewind.oldestTicks;
      this.rewind.maxTicks = emulator.rewind.newestTicks;
    } else {
      emulator.resume();
    }
    syncRuntimeButtons();
  }

  togglePause() {
    this.paused = !this.paused;
  }

  updateExtRam() {
    if (!emulator || !currentRom) return;
    const extram = emulator.getExtRam();
    writeStoredBytes(currentRom, 'extram', extram);
    syncRuntimeButtons();
  }
};

const vm = new VM();

binjgbPromise
  .then((module) => {
    binjgbModule = module;
    syncRuntimeButtons();
    return module;
  })
  .catch((error) => {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
    setSaveStatus('The emulator core failed to initialize.');
  });


// Copied from demo.js
function makeWasmBuffer(module, ptr, size) {
  return new Uint8Array(module.HEAP8.buffer, ptr, size);
}

class Emulator {
  static start(module, romBuffer, extRamBuffer) {
    Emulator.stop();
    emulator = new Emulator(module, romBuffer, extRamBuffer);
    emulator.run();
  }

  static stop() {
    if (emulator) {
      emulator.destroy();
      emulator = null;
    }
  }

  constructor(module, romBuffer, extRamBuffer) {
    this.module = module;
    // Align size up to 32k.
    const size = (romBuffer.byteLength + 0x7fff) & ~0x7fff;
    this.romDataPtr = this.module._malloc(size);
    makeWasmBuffer(this.module, this.romDataPtr, size)
        .fill(0)
        .set(new Uint8Array(romBuffer));
    this.e = this.module._emulator_new_simple(
        this.romDataPtr, size, Audio.ctx.sampleRate, AUDIO_FRAMES,
        CGB_COLOR_CURVE);
    if (this.e == 0) {
      throw new Error('Invalid ROM.');
    }

    this.audio = new Audio(module, this.e);
    this.video = new Video(module, this.e, $('#mainCanvas'));
    this.rewind = new Rewind(module, this.e);
    this.rewindIntervalId = 0;

    this.lastRafSec = 0;
    this.leftoverTicks = 0;
    this.fps = 60;
    this.fastForward = false;

    if (extRamBuffer) {
      this.loadExtRam(extRamBuffer);
    }

    this.bindKeys();
    this.bindTouch();

    this.touchEnabled = 'ontouchstart' in document.documentElement;
    this.updateOnscreenGamepad();
  }

  destroy() {
    this.unbindTouch();
    this.unbindKeys();
    this.cancelAnimationFrame();
    clearInterval(this.rewindIntervalId);
    this.rewind.destroy();
    this.module._emulator_delete(this.e);
    this.module._free(this.romDataPtr);
  }

  withNewFileData(fileDataPtr, cb) {
    const buffer = makeWasmBuffer(
        this.module, this.module._get_file_data_ptr(fileDataPtr),
        this.module._get_file_data_size(fileDataPtr));
    const result = cb(fileDataPtr, buffer);
    this.module._file_data_delete(fileDataPtr);
    return result;
  }

  withNewExtRamFileData(cb) {
    return this.withNewFileData(this.module._ext_ram_file_data_new(this.e), cb);
  }

  withNewStateFileData(cb) {
    return this.withNewFileData(this.module._state_file_data_new(this.e), cb);
  }

  loadExtRam(extRamBuffer) {
    this.withNewExtRamFileData((fileDataPtr, buffer) => {
      if (buffer.byteLength === extRamBuffer.byteLength) {
        buffer.set(new Uint8Array(extRamBuffer));
        this.module._emulator_read_ext_ram(this.e, fileDataPtr);
      }
    });
  }

  getExtRam() {
    return this.withNewExtRamFileData((fileDataPtr, buffer) => {
      this.module._emulator_write_ext_ram(this.e, fileDataPtr);
      return new Uint8Array(buffer);
    });
  }

  loadState() {
    const saveStateBuffer = readStoredBytes(currentRom, 'saveState');
    if (!saveStateBuffer) {
      throw new Error('No saved state exists for this ROM yet.');
    }
    this.withNewStateFileData((fileDataPtr, buffer) => {
      if (buffer.byteLength === saveStateBuffer.byteLength) {
        buffer.set(new Uint8Array(saveStateBuffer));
        this.module._emulator_read_state(this.e, fileDataPtr);
      }
    });
  }

  saveState() {
    const saveStateBuffer = this.withNewStateFileData((fileDataPtr, buffer) => {
      this.module._emulator_write_state(this.e, fileDataPtr);
      return new Uint8Array(buffer);
    });
    writeStoredBytes(currentRom, 'saveState', saveStateBuffer);
    syncRuntimeButtons();
  }

  get isPaused() {
    return this.rafCancelToken === null;
  }

  pause() {
    if (!this.isPaused) {
      this.cancelAnimationFrame();
      this.audio.pause();
      this.beginRewind();
    }
  }

  resume() {
    if (this.isPaused) {
      this.endRewind();
      this.requestAnimationFrame();
      this.audio.resume();
    }
  }

  setBuiltinPalette(palIdx) {
    this.module._emulator_set_builtin_palette(this.e, PALETTES[palIdx]);
  }

  get isRewinding() {
    return ENABLE_REWIND && this.rewind.isRewinding;
  }

  beginRewind() {
    if (!ENABLE_REWIND) { return; }
    this.rewind.beginRewind();
  }

  rewindToTicks(ticks) {
    if (!ENABLE_REWIND) { return; }
    if (this.rewind.rewindToTicks(ticks)) {
      this.runUntil(ticks);
      this.video.renderTexture();
    }
  }

  endRewind() {
    if (!ENABLE_REWIND) { return; }
    this.rewind.endRewind();
    this.lastRafSec = 0;
    this.leftoverTicks = 0;
    this.audio.startSec = 0;
  }

  set autoRewind(enabled) {
    if (!ENABLE_REWIND) { return; }
    if (enabled) {
      this.rewindIntervalId = setInterval(() => {
        const oldest = this.rewind.oldestTicks;
        const start = this.ticks;
        const delta =
            REWIND_FACTOR * REWIND_UPDATE_MS / 1000 * CPU_TICKS_PER_SECOND;
        const rewindTo = Math.max(oldest, start - delta);
        this.rewindToTicks(rewindTo);
        vm.ticks = emulator.ticks;
      }, REWIND_UPDATE_MS);
    } else {
      clearInterval(this.rewindIntervalId);
      this.rewindIntervalId = 0;
    }
  }

  requestAnimationFrame() {
    this.rafCancelToken = requestAnimationFrame(this.rafCallback.bind(this));
  }

  cancelAnimationFrame() {
    cancelAnimationFrame(this.rafCancelToken);
    this.rafCancelToken = null;
  }

  run() {
    this.requestAnimationFrame();
  }

  get ticks() {
    return this.module._emulator_get_ticks_f64(this.e);
  }

  runUntil(ticks) {
    while (true) {
      const event = this.module._emulator_run_until_f64(this.e, ticks);
      if (event & EVENT_NEW_FRAME) {
        this.rewind.pushBuffer();
        this.video.uploadTexture();
      }
      if ((event & EVENT_AUDIO_BUFFER_FULL) && !this.isRewinding) {
        this.audio.pushBuffer();
      }
      if (event & EVENT_UNTIL_TICKS) {
        break;
      }
    }
    if (this.module._emulator_was_ext_ram_updated(this.e)) {
      vm.extRamUpdated = true;
    }
  }

  rafCallback(startMs) {
    this.requestAnimationFrame();
    let deltaSec = 0;
    if (!this.isRewinding) {
      const startSec = startMs / 1000;
      deltaSec = Math.max(startSec - (this.lastRafSec || startSec), 0);

      const startTimeMs = performance.now();
      const deltaTicks =
          Math.min(deltaSec, MAX_UPDATE_SEC) * CPU_TICKS_PER_SECOND;
      let runUntilTicks = this.ticks + deltaTicks - this.leftoverTicks;
      this.runUntil(runUntilTicks);
      const deltaTimeMs = performance.now() - startTimeMs;
      const deltaTimeSec = deltaTimeMs / 1000;

      if (this.fastForward) {
        // Estimate how much faster we can run in fast-forward, keeping the
        // same rAF update rate.
        const speedUp = (deltaTicks / CPU_TICKS_PER_SECOND) / deltaTimeSec;
        const extraFrames = Math.floor(speedUp - deltaTimeSec);
        const extraTicks = extraFrames * deltaTicks;
        runUntilTicks = this.ticks + extraTicks - this.leftoverTicks;
        this.runUntil(runUntilTicks);
      }

      this.leftoverTicks = (this.ticks - runUntilTicks) | 0;
      this.lastRafSec = startSec;
    }
    const lerp = (from, to, alpha) => (alpha * from) + (1 - alpha) * to;
    this.fps = lerp(this.fps, Math.min(1 / deltaSec, 10000), 0.3);
    this.video.renderTexture();
  }

  updateOnscreenGamepad() {
    $('#controller').style.display = this.touchEnabled ? 'block' : 'none';
  }

  bindTouch() {
    this.touchFuncs = {
      'controller_b': this.setJoypB.bind(this),
      'controller_a': this.setJoypA.bind(this),
      'controller_start': this.setJoypStart.bind(this),
      'controller_select': this.setJoypSelect.bind(this),
    };

    this.boundButtonTouchStart = this.buttonTouchStart.bind(this);
    this.boundButtonTouchEnd = this.buttonTouchEnd.bind(this);
    selectEl.addEventListener('touchstart', this.boundButtonTouchStart);
    selectEl.addEventListener('touchend', this.boundButtonTouchEnd);
    startEl.addEventListener('touchstart', this.boundButtonTouchStart);
    startEl.addEventListener('touchend', this.boundButtonTouchEnd);
    bEl.addEventListener('touchstart', this.boundButtonTouchStart);
    bEl.addEventListener('touchend', this.boundButtonTouchEnd);
    aEl.addEventListener('touchstart', this.boundButtonTouchStart);
    aEl.addEventListener('touchend', this.boundButtonTouchEnd);

    this.boundDpadTouchStartMove = this.dpadTouchStartMove.bind(this);
    this.boundDpadTouchEnd = this.dpadTouchEnd.bind(this);
    dpadEl.addEventListener('touchstart', this.boundDpadTouchStartMove);
    dpadEl.addEventListener('touchmove', this.boundDpadTouchStartMove);
    dpadEl.addEventListener('touchend', this.boundDpadTouchEnd);

    this.boundTouchRestore = this.touchRestore.bind(this);
    window.addEventListener('touchstart', this.boundTouchRestore);
  }

  unbindTouch() {
    selectEl.removeEventListener('touchstart', this.boundButtonTouchStart);
    selectEl.removeEventListener('touchend', this.boundButtonTouchEnd);
    startEl.removeEventListener('touchstart', this.boundButtonTouchStart);
    startEl.removeEventListener('touchend', this.boundButtonTouchEnd);
    bEl.removeEventListener('touchstart', this.boundButtonTouchStart);
    bEl.removeEventListener('touchend', this.boundButtonTouchEnd);
    aEl.removeEventListener('touchstart', this.boundButtonTouchStart);
    aEl.removeEventListener('touchend', this.boundButtonTouchEnd);

    dpadEl.removeEventListener('touchstart', this.boundDpadTouchStartMove);
    dpadEl.removeEventListener('touchmove', this.boundDpadTouchStartMove);
    dpadEl.removeEventListener('touchend', this.boundDpadTouchEnd);

    window.removeEventListener('touchstart', this.boundTouchRestore);
  }

  buttonTouchStart(event) {
    if (event.currentTarget.id in this.touchFuncs) {
      this.touchFuncs[event.currentTarget.id](true);
      event.currentTarget.classList.add('btnPressed');
      event.preventDefault();
    }
  }

  buttonTouchEnd(event) {
    if (event.currentTarget.id in this.touchFuncs) {
      this.touchFuncs[event.currentTarget.id](false);
      event.currentTarget.classList.remove('btnPressed');
      event.preventDefault();
    }
  }

  dpadTouchStartMove(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (2 * (event.targetTouches[0].clientX - rect.left)) / rect.width - 1;
    const y = (2 * (event.targetTouches[0].clientY - rect.top)) / rect.height - 1;

    if (Math.abs(x) > OSGP_DEADZONE) {
      if (y > x && y < -x) {
        this.setJoypLeft(true);
        this.setJoypRight(false);
      } else if (y < x && y > -x) {
        this.setJoypLeft(false);
        this.setJoypRight(true);
      }
    } else {
      this.setJoypLeft(false);
      this.setJoypRight(false);
    }

    if (Math.abs(y) > OSGP_DEADZONE) {
      if (x > y && x < -y) {
        this.setJoypUp(true);
        this.setJoypDown(false);
      } else if (x < y && x > -y) {
        this.setJoypUp(false);
        this.setJoypDown(true);
      }
    } else {
      this.setJoypUp(false);
      this.setJoypDown(false);
    }
    event.preventDefault();
  }

  dpadTouchEnd(event) {
    this.setJoypLeft(false);
    this.setJoypRight(false);
    this.setJoypUp(false);
    this.setJoypDown(false);
    event.preventDefault();
  }

  touchRestore() {
    this.touchEnabled = true;
    this.updateOnscreenGamepad();
  }

  bindKeys() {
    this.keyFuncs = {
      'ArrowDown': this.setJoypDown.bind(this),
      'ArrowLeft': this.setJoypLeft.bind(this),
      'ArrowRight': this.setJoypRight.bind(this),
      'ArrowUp': this.setJoypUp.bind(this),
      'KeyZ': this.setJoypB.bind(this),
      'KeyX': this.setJoypA.bind(this),
      'Enter': this.setJoypStart.bind(this),
      'Tab': this.setJoypSelect.bind(this),
      'Backspace': this.keyRewind.bind(this),
      'Space': this.keyPause.bind(this),
      'BracketLeft': this.keyPrevPalette.bind(this),
      'BracketRight': this.keyNextPalette.bind(this),
      'ShiftLeft': this.setFastForward.bind(this),
      'F6': this.saveState.bind(this),
      'F9': this.loadState.bind(this),
    };
    this.boundKeyDown = this.keyDown.bind(this);
    this.boundKeyUp = this.keyUp.bind(this);

    window.addEventListener('keydown', this.boundKeyDown);
    window.addEventListener('keyup', this.boundKeyUp);
  }

  unbindKeys() {
    window.removeEventListener('keydown', this.boundKeyDown);
    window.removeEventListener('keyup', this.boundKeyUp);
  }

  keyDown(event) {
    if (event.code in this.keyFuncs) {
      if (this.touchEnabled) {
        this.touchEnabled = false;
        this.updateOnscreenGamepad();
      }
      this.keyFuncs[event.code](true);
      event.preventDefault();
    }
  }

  keyUp(event) {
    if (event.code in this.keyFuncs) {
      this.keyFuncs[event.code](false);
      event.preventDefault();
    }
  }

  keyRewind(isKeyDown) {
    if (!ENABLE_REWIND) { return; }
    if (this.isRewinding !== isKeyDown) {
      if (isKeyDown) {
        vm.paused = true;
        this.autoRewind = true;
      } else {
        this.autoRewind = false;
        vm.paused = false;
      }
    }
  }

  keyPause(isKeyDown) {
    if (!ENABLE_PAUSE) { return; }
    if (isKeyDown) vm.togglePause();
  }

  keyPrevPalette(isKeyDown) {
    if (!ENABLE_SWITCH_PALETTES) { return; }
    if (isKeyDown) {
      vm.palIdx = (vm.palIdx + PALETTES.length - 1) % PALETTES.length;
      emulator.setBuiltinPalette(vm.palIdx);
    }
  }

  keyNextPalette(isKeyDown) {
    if (!ENABLE_SWITCH_PALETTES) { return; }
    if (isKeyDown) {
      vm.palIdx = (vm.palIdx + 1) % PALETTES.length;
      emulator.setBuiltinPalette(vm.palIdx);
    }
  }

  setFastForward(isKeyDown) {
    if (!ENABLE_FAST_FORWARD) { return; }
    this.fastForward = isKeyDown;
  }

  setJoypDown(set) { this.module._set_joyp_down(this.e, set); }
  setJoypUp(set) { this.module._set_joyp_up(this.e, set); }
  setJoypLeft(set) { this.module._set_joyp_left(this.e, set); }
  setJoypRight(set) { this.module._set_joyp_right(this.e, set); }
  setJoypSelect(set) { this.module._set_joyp_select(this.e, set); }
  setJoypStart(set) { this.module._set_joyp_start(this.e, set); }
  setJoypB(set) { this.module._set_joyp_B(this.e, set); }
  setJoypA(set) { this.module._set_joyp_A(this.e, set); }
}

class Audio {
  constructor(module, e) {
    this.started = false;
    this.module = module;
    this.buffer = makeWasmBuffer(
        this.module, this.module._get_audio_buffer_ptr(e),
        this.module._get_audio_buffer_capacity(e));
    this.startSec = 0;
    this.resume();

    this.boundStartPlayback = this.startPlayback.bind(this);
    window.addEventListener('keydown', this.boundStartPlayback, true);
    window.addEventListener('click', this.boundStartPlayback, true);
    window.addEventListener('touchend', this.boundStartPlayback, true);
  }

  startPlayback() {
    window.removeEventListener('touchend', this.boundStartPlayback, true);
    window.removeEventListener('keydown', this.boundStartPlayback, true);
    window.removeEventListener('click', this.boundStartPlayback, true);
    this.started = true;
    this.resume();
  }

  get sampleRate() { return Audio.ctx.sampleRate; }

  pushBuffer() {
    if (!this.started) { return; }
    const nowSec = Audio.ctx.currentTime;
    const nowPlusLatency = nowSec + AUDIO_LATENCY_SEC;
    const volume = vm.volume;
    this.startSec = (this.startSec || nowPlusLatency);
    if (this.startSec >= nowSec) {
      const buffer = Audio.ctx.createBuffer(2, AUDIO_FRAMES, this.sampleRate);
      const channel0 = buffer.getChannelData(0);
      const channel1 = buffer.getChannelData(1);
      for (let i = 0; i < AUDIO_FRAMES; i++) {
        channel0[i] = this.buffer[2 * i] * volume / 255;
        channel1[i] = this.buffer[2 * i + 1] * volume / 255;
      }
      const bufferSource = Audio.ctx.createBufferSource();
      bufferSource.buffer = buffer;
      bufferSource.connect(Audio.ctx.destination);
      bufferSource.start(this.startSec);
      const bufferSec = AUDIO_FRAMES / this.sampleRate;
      this.startSec += bufferSec;
    } else {
      console.log(
          'Resetting audio (' + this.startSec.toFixed(2) + ' < ' +
          nowSec.toFixed(2) + ')');
      this.startSec = nowPlusLatency;
    }
  }

  pause() {
    if (!this.started) { return; }
    Audio.ctx.suspend();
  }

  resume() {
    if (!this.started) { return; }
    Audio.ctx.resume();
  }
}

Audio.ctx = new (window.AudioContext || window.webkitAudioContext)();

class Video {
  constructor(module, e, el) {
    this.module = module;
    // iPhone Safari doesn't upscale using image-rendering: pixelated on webgl
    // canvases. See https://bugs.webkit.org/show_bug.cgi?id=193895.
    // For now, default to Canvas2D.
    if (window.navigator.userAgent.match(/iPhone|iPad/)) {
      this.renderer = new Canvas2DRenderer(el);
    } else {
      try {
        this.renderer = new WebGLRenderer(el);
      } catch (error) {
        console.log(`Error creating WebGLRenderer: ${error}`);
        this.renderer = new Canvas2DRenderer(el);
      }
    }
    this.buffer = makeWasmBuffer(
        this.module, this.module._get_frame_buffer_ptr(e),
        this.module._get_frame_buffer_size(e));
  }

  uploadTexture() {
    this.renderer.uploadTexture(this.buffer);
  }

  renderTexture() {
    this.renderer.renderTexture();
  }
}

class Canvas2DRenderer {
  constructor(el) {
    this.ctx = el.getContext('2d');
    this.imageData = this.ctx.createImageData(el.width, el.height);
  }

  renderTexture() {
    this.ctx.putImageData(this.imageData, 0, 0);
  }

  uploadTexture(buffer) {
    this.imageData.data.set(buffer);
  }
}

class WebGLRenderer {
  constructor(el) {
    const gl = this.gl = el.getContext('webgl', {preserveDrawingBuffer: true});
    if (gl === null) {
      throw new Error('unable to create webgl context');
    }

    const w = SCREEN_WIDTH / 256;
    const h = SCREEN_HEIGHT / 256;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1,  0, h,
      +1, -1,  w, h,
      -1, +1,  0, 0,
      +1, +1,  w, 0,
    ]), gl.STATIC_DRAW);

    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(
        gl.TEXTURE_2D, 0, gl.RGBA, 256, 256, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);

    function compileShader(type, source) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        throw new Error(`compileShader failed: ${gl.getShaderInfoLog(shader)}`);
      }
      return shader;
    }

    const vertexShader = compileShader(gl.VERTEX_SHADER,
       `attribute vec2 aPos;
        attribute vec2 aTexCoord;
        varying highp vec2 vTexCoord;
        void main(void) {
          gl_Position = vec4(aPos, 0.0, 1.0);
          vTexCoord = aTexCoord;
        }`);
    const fragmentShader = compileShader(gl.FRAGMENT_SHADER,
       `varying highp vec2 vTexCoord;
        uniform sampler2D uSampler;
        void main(void) {
          gl_FragColor = texture2D(uSampler, vTexCoord);
        }`);

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    gl.useProgram(program);

    const aPos = gl.getAttribLocation(program, 'aPos');
    const aTexCoord = gl.getAttribLocation(program, 'aTexCoord');
    const uSampler = gl.getUniformLocation(program, 'uSampler');

    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aTexCoord);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, gl.FALSE, 16, 0);
    gl.vertexAttribPointer(aTexCoord, 2, gl.FLOAT, gl.FALSE, 16, 8);
    gl.uniform1i(uSampler, 0);
  }

  renderTexture() {
    this.gl.clearColor(0.5, 0.5, 0.5, 1.0);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  uploadTexture(buffer) {
    this.gl.texSubImage2D(
        this.gl.TEXTURE_2D, 0, 0, 0, SCREEN_WIDTH, SCREEN_HEIGHT, this.gl.RGBA,
        this.gl.UNSIGNED_BYTE, buffer);
  }
}

class Rewind {
  constructor(module, e) {
    this.module = module;
    this.e = e;
    this.joypadBufferPtr = this.module._joypad_new();
    this.statePtr = 0;
    this.bufferPtr = this.module._rewind_new_simple(
        e, REWIND_FRAMES_PER_BASE_STATE, REWIND_BUFFER_CAPACITY);
    this.module._emulator_set_default_joypad_callback(e, this.joypadBufferPtr);
  }

  destroy() {
    this.module._rewind_delete(this.bufferPtr);
    this.module._joypad_delete(this.joypadBufferPtr);
  }

  get oldestTicks() {
    return this.module._rewind_get_oldest_ticks_f64(this.bufferPtr);
  }

  get newestTicks() {
    return this.module._rewind_get_newest_ticks_f64(this.bufferPtr);
  }

  pushBuffer() {
    if (!this.isRewinding) {
      this.module._rewind_append(this.bufferPtr, this.e);
    }
  }

  get isRewinding() {
    return this.statePtr !== 0;
  }

  beginRewind() {
    if (this.isRewinding) return;
    this.statePtr =
        this.module._rewind_begin(this.e, this.bufferPtr, this.joypadBufferPtr);
  }

  rewindToTicks(ticks) {
    if (!this.isRewinding) return;
    return this.module._rewind_to_ticks_wrapper(this.statePtr, ticks) ===
        RESULT_OK;
  }

  endRewind() {
    if (!this.isRewinding) return;
    this.module._emulator_set_default_joypad_callback(
        this.e, this.joypadBufferPtr);
    this.module._rewind_end(this.statePtr);
    this.statePtr = 0;
  }
}

resetButtonEl.addEventListener('click', async () => {
  try {
    await restartCurrentRom();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  }
});

bundledRomButtonEl?.addEventListener('click', async () => {
  try {
    await loadBundledRom();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  }
});

fullscreenButtonEl?.addEventListener('click', () => {
  toggleGameScreenFullscreen();
});

gridOverlayButtonEl?.addEventListener('click', () => {
  setGridOverlayEnabled(!gridOverlayEnabled);
});

pauseButtonEl.addEventListener('click', () => {
  try {
    togglePause();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  }
});

saveStateButtonEl.addEventListener('click', () => {
  try {
    saveCurrentState();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  }
});

loadStateButtonEl.addEventListener('click', () => {
  try {
    loadCurrentState();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  }
});

clearSaveButtonEl.addEventListener('click', () => {
  try {
    clearCurrentSave();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  }
});

romFileEl.addEventListener('change', async () => {
  const file = romFileEl.files && romFileEl.files[0];
  romFileEl.value = '';
  try {
    await loadRomFile(file);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  }
});

window.HerdBrowserExtension = {
  manifest: GAME_BOY_EXTENSION_MANIFEST,
  call(method, args = {}) {
    switch (method) {
      case 'state':
        return currentState();
      case 'load_bundled_rom':
        return {
          state: loadBundledRomSync(String(args?.rom ?? DEFAULT_BUNDLED_ROM ?? '')),
        };
      case 'reset':
        return {
          state: restartCurrentRomSync(),
        };
      case 'toggle_pause':
        return {
          state: togglePause(),
        };
      case 'save_state':
        return {
          state: saveCurrentState(),
        };
      case 'load_state':
        return {
          state: loadCurrentState(),
        };
      case 'clear_save':
        return {
          state: clearCurrentSave(),
        };
      case 'screenshot':
        return screenshotSource();
      case 'set_grid_overlay':
        return {
          state: setGridOverlayEnabled(Boolean(args?.enabled)),
        };
      case 'set_button': {
        const button = String(args?.button ?? '').trim().toLowerCase();
        const pressed = args?.pressed !== undefined ? Boolean(args.pressed) : true;
        clearPendingButtonCombo();
        applyButtonState(button, pressed);
        return {
          button,
          pressed,
          state: currentState(),
        };
      }
      case 'button_combo':
        return startButtonCombo(args ?? {});
      case 'release_all_buttons':
        releaseAllButtons();
        return {
          state: currentState(),
        };
      default:
        throw new Error(`unknown extension method: ${method}`);
    }
  },
};

window.addEventListener('keydown', handleWindowKeyDown);

setStatus('Choose a Game Boy ROM to begin.');
setRomName('No ROM loaded.');
setSaveStatus('Load a local .gb or .gbc file, or use the bundled Pokemon Yellow ROM.');
updateFullscreenButton();
syncRuntimeButtons();
renderGridOverlay();
