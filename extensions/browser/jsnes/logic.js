(() => {
const PLAYER_IDS = Object.freeze([1, 2]);
const BUTTON_NAMES = Object.freeze(['up', 'down', 'left', 'right', 'a', 'b', 'start', 'select']);
const INITIAL_STATUS = 'Choose an NES ROM to begin.';
const DEFAULT_BUTTON_COMBO_DELAY_MS = 120;
const DEFAULT_BUTTON_COMBO_HOLD_MS = 80;
const BUNDLED_ROM_NAMES = Object.freeze(
  globalThis.JsnesBundledRoms && typeof globalThis.JsnesBundledRoms === 'object'
    ? Object.keys(globalThis.JsnesBundledRoms).sort()
    : [],
);
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
const JSNES_EXTENSION_MANIFEST = {
  extension_id: 'jsnes',
  label: 'JSNES',
  methods: [
    {
      name: 'state',
      description: 'Return emulator readiness, ROM metadata, player claims, and held buttons.',
      args: [],
    },
    {
      name: 'claim_player',
      description: 'Claim player 1 or player 2 for the caller tile.',
      args: [
        {
          name: 'player',
          type: 'integer',
          required: true,
          description: 'NES player number.',
          enum_values: ['1', '2'],
        },
        {
          name: 'name',
          type: 'string',
          required: false,
          description: 'Display name for the claimed player.',
        },
      ],
    },
    {
      name: 'release_player',
      description: 'Release the caller tile player claim and clear held buttons for that player.',
      args: [],
    },
    {
      name: 'load_rom_base64',
      description: 'Load a ROM from base64-encoded iNES data.',
      args: [
        {
          name: 'filename',
          type: 'string',
          required: false,
          description: 'Optional ROM filename for display.',
        },
        {
          name: 'data_base64',
          type: 'string',
          required: true,
          description: 'Base64-encoded ROM bytes.',
        },
      ],
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
      description: 'Reset the active ROM and resume playback.',
      args: [],
    },
    {
      name: 'toggle_pause',
      description: 'Pause or resume the active ROM.',
      args: [],
    },
    {
      name: 'screenshot',
      description: 'Capture the current emulator screen.',
      args: SCREENSHOT_METHOD_ARGS,
    },
    {
      name: 'set_button',
      description: 'Press or release one NES controller button for the caller-owned player.',
      args: [
        {
          name: 'button',
          type: 'string',
          required: true,
          description: 'Button name.',
          enum_values: [...BUTTON_NAMES],
        },
        {
          name: 'pressed',
          type: 'boolean',
          required: false,
          description: 'Whether the button should be pressed. Defaults to true.',
        },
      ],
    },
    {
      name: 'button_combo',
      description: 'Play an ordered button combo for the caller-owned player using timer-backed presses.',
      args: BUTTON_COMBO_METHOD_ARGS,
    },
    {
      name: 'release_all_buttons',
      description: 'Release every held button for the caller-owned player.',
      args: [],
    },
  ],
};

function cloneValue(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function createButtonState() {
  return Object.fromEntries(BUTTON_NAMES.map((button) => [button, false]));
}

function bundledRomRegistry() {
  return globalThis.JsnesBundledRoms && typeof globalThis.JsnesBundledRoms === 'object'
    ? globalThis.JsnesBundledRoms
    : {};
}

function bundledRomNames() {
  return Object.keys(bundledRomRegistry()).sort();
}

function bundledRomSummaries() {
  const registry = bundledRomRegistry();
  return bundledRomNames().map((filename) => ({
    filename,
    label: registry[filename]?.label || filename,
    size: registry[filename]?.size || 0,
  }));
}

function createPlayerState(player) {
  return {
    player,
    claimed: false,
    name: null,
    owner_tile_id: null,
    owner_agent_id: null,
    buttons: createButtonState(),
  };
}

function createInitialJsnesState() {
  return {
    core_ready: false,
    loaded: false,
    paused: false,
    status: INITIAL_STATUS,
    status_tone: 'info',
    rom: null,
    available_buttons: [...BUTTON_NAMES],
    players: PLAYER_IDS.map((player) => createPlayerState(player)),
  };
}

function decodeBase64ToBytes(base64) {
  const normalized = String(base64 ?? '').trim();
  if (!normalized) {
    throw new Error('data_base64 is required');
  }
  if (typeof atob === 'function') {
    const text = atob(normalized);
    const bytes = new Uint8Array(text.length);
    for (let index = 0; index < text.length; index += 1) {
      bytes[index] = text.charCodeAt(index);
    }
    return bytes;
  }
  if (typeof Buffer !== 'undefined') {
    return Uint8Array.from(Buffer.from(normalized, 'base64'));
  }
  throw new Error('base64 decoding is unavailable');
}

function normalizePlayerId(value) {
  const player = Number(value);
  if (!PLAYER_IDS.includes(player)) {
    throw new Error('player must be 1 or 2');
  }
  return player;
}

function normalizeButtonName(value) {
  const button = String(value ?? '').trim().toLowerCase();
  if (!BUTTON_NAMES.includes(button)) {
    throw new Error(`unsupported button: ${value}`);
  }
  return button;
}

function findPlayerState(state, player) {
  const playerId = normalizePlayerId(player);
  return state.players.find((entry) => entry.player === playerId) ?? null;
}

function claimedPlayerByTile(state, senderTileId) {
  return state.players.find((entry) => entry.owner_tile_id === senderTileId) ?? null;
}

function requireSenderTile(context) {
  const senderTileId = String(context?.sender_tile_id ?? '').trim();
  if (!senderTileId) {
    throw new Error('extension call requires sender_tile_id');
  }
  return senderTileId;
}

function resetButtonState(player) {
  for (const button of BUTTON_NAMES) {
    player.buttons[button] = false;
  }
}

function hasHeldButtons(player) {
  return BUTTON_NAMES.some((button) => player.buttons[button]);
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
      const button = normalizeButtonName(rawButton);
      if (!normalized.includes(button)) {
        normalized.push(button);
      }
    }
    return normalized;
  });
}

function createJsnesController(options = {}) {
  const state = createInitialJsnesState();
  let emulator = null;
  const pendingButtonCombos = new Map(
    PLAYER_IDS.map((playerId) => [playerId, { generation: 0, timers: new Set() }]),
  );

  function publicState() {
    const snapshot = cloneValue(state);
    snapshot.available_roms = bundledRomSummaries();
    return snapshot;
  }

  function emitChange() {
    options.onChange?.(publicState());
  }

  function setStatus(message, tone = 'info') {
    state.status = String(message);
    state.status_tone = tone;
  }

  function requireEmulator() {
    if (!emulator || !state.core_ready) {
      throw new Error('jsnes is not ready');
    }
    return emulator;
  }

  function requireLoadedRom() {
    if (!state.loaded || !state.rom) {
      throw new Error('no ROM is loaded');
    }
  }

  function stateResult(extra = {}) {
    return {
      ...extra,
      state: publicState(),
    };
  }

  function comboStateForPlayer(player) {
    return pendingButtonCombos.get(player.player);
  }

  function clearPendingButtonCombo(player) {
    const comboState = comboStateForPlayer(player);
    comboState.generation += 1;
    for (const timerId of comboState.timers) {
      globalThis.clearTimeout(timerId);
    }
    comboState.timers.clear();
  }

  function scheduleButtonComboCallback(player, generation, delayMs, callback) {
    const comboState = comboStateForPlayer(player);
    const timerId = globalThis.setTimeout(() => {
      comboState.timers.delete(timerId);
      if (comboState.generation !== generation) {
        return;
      }
      callback();
    }, delayMs);
    comboState.timers.add(timerId);
  }

  function releaseButtonsForPlayer(player, options = {}) {
    if (options.cancelCombo !== false) {
      clearPendingButtonCombo(player);
    }
    if (state.core_ready && emulator && hasHeldButtons(player)) {
      emulator.releaseAllButtons(player.player);
    }
    resetButtonState(player);
  }

  function setButtonsForPlayer(player, buttons, pressed) {
    const activeEmulator = requireEmulator();
    for (const button of buttons) {
      activeEmulator.setButton(player.player, button, pressed);
      player.buttons[button] = pressed;
    }
    emitChange();
  }

  function clearAllButtons() {
    for (const player of state.players) {
      releaseButtonsForPlayer(player);
    }
  }

  function loadRomBytes(bytes, metadata = {}) {
    const activeEmulator = requireEmulator();
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) {
      throw new Error('ROM bytes are required');
    }
    activeEmulator.loadRom(bytes);
    clearAllButtons();
    state.loaded = true;
    state.paused = false;
    state.rom = {
      filename: String(metadata.filename ?? 'cartridge.nes'),
      source: String(metadata.source ?? 'api'),
      size: bytes.length,
    };
    setStatus(`Loaded ${state.rom.filename}.`, 'success');
    emitChange();
    return stateResult();
  }

  function claimPlayer(args = {}, context = {}) {
    const senderTileId = requireSenderTile(context);
    const requestedPlayer = findPlayerState(state, args.player);
    if (!requestedPlayer) {
      throw new Error(`unknown player: ${args.player}`);
    }
    const ownedPlayer = claimedPlayerByTile(state, senderTileId);
    if (ownedPlayer && ownedPlayer.player !== requestedPlayer.player) {
      throw new Error(`caller already owns player ${ownedPlayer.player}`);
    }
    if (requestedPlayer.owner_tile_id && requestedPlayer.owner_tile_id !== senderTileId) {
      throw new Error(`player ${requestedPlayer.player} is already claimed`);
    }

    requestedPlayer.claimed = true;
    requestedPlayer.owner_tile_id = senderTileId;
    requestedPlayer.owner_agent_id = context?.sender_agent_id ?? null;
    requestedPlayer.name = String(args.name ?? '').trim() || `Player ${requestedPlayer.player}`;
    setStatus(`${requestedPlayer.name} claimed player ${requestedPlayer.player}.`, 'info');
    emitChange();
    return stateResult({ player: cloneValue(requestedPlayer) });
  }

  function releasePlayer(_args = {}, context = {}) {
    const senderTileId = requireSenderTile(context);
    const player = claimedPlayerByTile(state, senderTileId);
    if (!player) {
      return stateResult({ released: false });
    }

    releaseButtonsForPlayer(player);
    player.claimed = false;
    player.name = null;
    player.owner_tile_id = null;
    player.owner_agent_id = null;
    setStatus(`Released player ${player.player}.`, 'info');
    emitChange();
    return stateResult({ released: true, player: cloneValue(player) });
  }

  function loadRomBase64(args = {}) {
    const bytes = decodeBase64ToBytes(args.data_base64);
    return loadRomBytes(bytes, {
      filename: String(args.filename ?? 'api-rom.nes').trim() || 'api-rom.nes',
      source: 'api',
    });
  }

  function loadBundledRom(args = {}) {
    const registry = bundledRomRegistry();
    const names = bundledRomNames();
    if (names.length === 0) {
      throw new Error('no bundled ROMs are available');
    }
    const rom = String(args.rom ?? names[0]).trim() || names[0];
    const entry = registry[rom];
    if (!entry?.dataBase64) {
      throw new Error(`unknown bundled ROM: ${rom}`);
    }
    return loadRomBytes(decodeBase64ToBytes(entry.dataBase64), {
      filename: rom,
      source: 'bundled',
    });
  }

  function resetRom() {
    requireLoadedRom();
    requireEmulator().reset();
    clearAllButtons();
    state.paused = false;
    setStatus(`Reset ${state.rom.filename}.`, 'success');
    emitChange();
    return stateResult();
  }

  function togglePause() {
    requireLoadedRom();
    const nextPaused = !state.paused;
    requireEmulator().setPaused(nextPaused);
    state.paused = nextPaused;
    setStatus(`${nextPaused ? 'Paused' : 'Resumed'} ${state.rom.filename}.`, 'info');
    emitChange();
    return stateResult();
  }

  function screenshot() {
    requireLoadedRom();
    const source = requireEmulator().screenshot();
    if (!source || typeof source !== 'object') {
      throw new Error('emulator screenshot did not return a source object');
    }
    return source;
  }

  function setButton(args = {}, context = {}) {
    requireLoadedRom();
    const senderTileId = requireSenderTile(context);
    const player = claimedPlayerByTile(state, senderTileId);
    if (!player) {
      throw new Error('caller does not own a player');
    }
    const button = normalizeButtonName(args.button);
    const pressed = args.pressed !== false;
    clearPendingButtonCombo(player);
    setButtonsForPlayer(player, [button], pressed);
    return stateResult({ player: cloneValue(player), button, pressed });
  }

  function buttonCombo(args = {}, context = {}) {
    requireLoadedRom();
    const senderTileId = requireSenderTile(context);
    const player = claimedPlayerByTile(state, senderTileId);
    if (!player) {
      throw new Error('caller does not own a player');
    }
    const sequence = normalizeButtonComboSequence(args.sequence);
    const delayMs = normalizeComboDuration(args.delay_ms, DEFAULT_BUTTON_COMBO_DELAY_MS, 'delay_ms');
    const holdMs = normalizeComboDuration(args.hold_ms, DEFAULT_BUTTON_COMBO_HOLD_MS, 'hold_ms');

    clearPendingButtonCombo(player);
    releaseButtonsForPlayer(player, { cancelCombo: false });

    const generation = comboStateForPlayer(player).generation;
    const runStep = (stepIndex) => {
      const buttons = sequence[stepIndex];
      releaseButtonsForPlayer(player, { cancelCombo: false });
      setButtonsForPlayer(player, buttons, true);
      const releaseAfterMs = stepIndex === sequence.length - 1
        ? holdMs
        : Math.min(holdMs, delayMs);
      scheduleButtonComboCallback(player, generation, releaseAfterMs, () => {
        setButtonsForPlayer(player, buttons, false);
      });
    };

    runStep(0);
    for (let index = 1; index < sequence.length; index += 1) {
      scheduleButtonComboCallback(player, generation, index * delayMs, () => {
        runStep(index);
      });
    }

    return stateResult({
      player: cloneValue(player),
      sequence_length: sequence.length,
      delay_ms: delayMs,
      hold_ms: holdMs,
    });
  }

  function releaseAllButtons(_args = {}, context = {}) {
    requireLoadedRom();
    const senderTileId = requireSenderTile(context);
    const player = claimedPlayerByTile(state, senderTileId);
    if (!player) {
      throw new Error('caller does not own a player');
    }
    releaseButtonsForPlayer(player);
    emitChange();
    return stateResult({ player: cloneValue(player) });
  }

  function call(method, args = {}, context = {}) {
    switch (method) {
      case 'state':
        return publicState();
      case 'claim_player':
        return claimPlayer(args, context);
      case 'release_player':
        return releasePlayer(args, context);
      case 'load_rom_base64':
        return loadRomBase64(args, context);
      case 'load_bundled_rom':
        return loadBundledRom(args, context);
      case 'reset':
        return resetRom(args, context);
      case 'toggle_pause':
        return togglePause(args, context);
      case 'screenshot':
        return screenshot(args, context);
      case 'set_button':
        return setButton(args, context);
      case 'button_combo':
        return buttonCombo(args, context);
      case 'release_all_buttons':
        return releaseAllButtons(args, context);
      default:
        throw new Error(`unknown extension method: ${method}`);
    }
  }

  function attachEmulator(nextEmulator) {
    emulator = nextEmulator;
    state.core_ready = Boolean(nextEmulator);
    if (state.core_ready) {
      setStatus(state.loaded && state.rom ? `Loaded ${state.rom.filename}.` : INITIAL_STATUS, state.loaded ? 'success' : 'info');
    }
    emitChange();
  }

  function reportError(error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message, 'error');
    emitChange();
  }

  return {
    manifest: JSNES_EXTENSION_MANIFEST,
    attachEmulator,
    call,
    getPublicState: publicState,
    loadRomBytes,
    reportError,
  };
}

globalThis.JsnesExtensionLogic = {
  BUTTON_NAMES,
  JSNES_EXTENSION_MANIFEST,
  PLAYER_IDS,
  createInitialJsnesState,
  createJsnesController,
};
})();
