(() => {
const ROOM_POLL_MS = 120;
const HEARTBEAT_MS = 500;
// Browser tiles often run in background tabs, where timers can be clamped for
// several seconds. Keep host-stale detection generous so turn-based rooms do
// not falsely abandon while the host browser tile is still alive.
const STALE_HOST_MS = 30_000;
const ACTION_RETENTION_MS = 60_000;

function cloneValue(value) {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value));
}

function now() {
  return Date.now();
}

function randomId(prefix = 'id') {
  const body = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${body}`;
}

function hashSeed(seed) {
  let hash = 2166136261;
  const text = String(seed);
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

function nextRandomState(state) {
  let next = state >>> 0;
  next ^= next << 13;
  next ^= next >>> 17;
  next ^= next << 5;
  return (next >>> 0) || 1;
}

function createRandomTools(snapshot) {
  return {
    float() {
      snapshot.rng_state = nextRandomState(snapshot.rng_state);
      return snapshot.rng_state / 0xffffffff;
    },
    int(maxExclusive) {
      if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) {
        throw new Error(`invalid random bound: ${maxExclusive}`);
      }
      return Math.floor(this.float() * maxExclusive);
    },
    pick(items) {
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('cannot pick from an empty collection');
      }
      return items[this.int(items.length)];
    },
    shuffle(items) {
      const result = [...items];
      for (let index = result.length - 1; index > 0; index -= 1) {
        const swapIndex = this.int(index + 1);
        [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
      }
      return result;
    },
  };
}

function safeParse(raw, fallback = null) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function roomKey(gameId, roomId, suffix) {
  return `herd-game:${gameId}:${roomId}:${suffix}`;
}

function storagePrefix(gameId) {
  return `herd-game:${gameId}:`;
}

function createBaseSnapshot(gameId, roomId, seed, hostClientId, players, initialState) {
  const startedAt = now();
  return {
    game: gameId,
    roomId,
    seed,
    rng_state: hashSeed(seed),
    hostClientId,
    phase: 'lobby',
    tick: 0,
    status: 'Lobby open',
    winner: null,
    players,
    gameState: initialState,
    updatedAt: startedAt,
    hostHeartbeatAt: startedAt,
  };
}

function upsertPlayer(players, incoming) {
  const nextPlayers = players.map((player) => ({ ...player }));
  const index = nextPlayers.findIndex((player) => player.seat === incoming.seat);
  if (index >= 0) {
    nextPlayers[index] = {
      ...nextPlayers[index],
      ...incoming,
      connected: true,
    };
  } else {
    nextPlayers.push({
      ...incoming,
      connected: true,
    });
  }
  return nextPlayers;
}

function storageKeysForRoom(gameId, roomId) {
  return {
    snapshot: roomKey(gameId, roomId, 'snapshot'),
    abandoned: roomKey(gameId, roomId, 'abandoned'),
    actionPrefix: roomKey(gameId, roomId, 'action:'),
  };
}

function createGameApp(config) {
  const clientId = randomId('client');
  let currentRoomId = null;
  let snapshot = null;
  let channel = null;
  let pollTimer = null;
  let tickTimer = null;
  let heartbeatTimer = null;
  const processedActionIds = new Set();

  function activeKeys() {
    if (!currentRoomId) {
      throw new Error('no active room');
    }
    return storageKeysForRoom(config.gameId, currentRoomId);
  }

  function isHost() {
    return Boolean(snapshot && snapshot.hostClientId === clientId && snapshot.phase !== 'abandoned');
  }

  function seatForClient(currentSnapshot) {
    return currentSnapshot?.players?.find((player) => player.clientId === clientId) ?? null;
  }

  function buildView() {
    if (!snapshot) {
      return {
        game: config.gameId,
        roomId: currentRoomId,
        phase: 'idle',
        status: 'No room joined',
        winner: null,
        players: [],
        legalActions: [],
      };
    }
    const presented = typeof config.present === 'function'
      ? config.present(cloneValue(snapshot), clientId)
      : cloneValue(snapshot);
    return {
      ...presented,
      clientId,
      roomId: snapshot.roomId,
      isHost: isHost(),
      self: seatForClient(snapshot),
    };
  }

  function render() {
    config.render(buildView(), api);
  }

  function writeSnapshot(nextSnapshot, announce = true) {
    snapshot = cloneValue(nextSnapshot);
    const keys = activeKeys();
    localStorage.setItem(keys.snapshot, JSON.stringify(snapshot));
    if (announce && channel) {
      channel.postMessage({ type: 'snapshot', snapshot });
    }
    render();
  }

  function commit(mutator, announce = true) {
    if (!snapshot) {
      throw new Error('cannot commit without an active snapshot');
    }
    const nextSnapshot = cloneValue(snapshot);
    mutator(nextSnapshot);
    nextSnapshot.updatedAt = now();
    if (nextSnapshot.hostClientId === clientId) {
      nextSnapshot.hostHeartbeatAt = nextSnapshot.updatedAt;
    }
    writeSnapshot(nextSnapshot, announce);
  }

  function randomTools(nextSnapshot) {
    return createRandomTools(nextSnapshot);
  }

  function processEnvelope(envelope) {
    if (!snapshot || !isHost()) {
      return false;
    }
    if (envelope.roomId !== snapshot.roomId) {
      return false;
    }
    if (processedActionIds.has(envelope.id)) {
      return false;
    }

    let changed = false;
    commit((nextSnapshot) => {
      const helpers = {
        now: () => now(),
        random: randomTools(nextSnapshot),
        hostClientId: clientId,
      };
      switch (envelope.type) {
        case 'join':
          nextSnapshot.players = upsertPlayer(nextSnapshot.players, {
            seat: envelope.seat,
            name: envelope.name,
            clientId: envelope.clientId,
          });
          nextSnapshot.status = typeof config.describeLobby === 'function'
            ? config.describeLobby(nextSnapshot)
            : `Lobby: ${nextSnapshot.players.length} joined`;
          changed = true;
          break;
        case 'start':
          if (nextSnapshot.phase === 'lobby') {
            const requiredPlayers = config.seats.length;
            if (nextSnapshot.players.length === requiredPlayers) {
              const started = config.startGame(nextSnapshot, helpers);
              Object.assign(nextSnapshot, started);
              changed = true;
            }
          }
          break;
        case 'action':
          if (nextSnapshot.phase === 'in_progress') {
            const updated = config.applyAction(nextSnapshot, envelope.action, {
              ...helpers,
              actorClientId: envelope.clientId,
            });
            if (updated) {
              Object.assign(nextSnapshot, updated);
              changed = true;
            }
          }
          break;
        default:
          break;
      }
    });

    processedActionIds.add(envelope.id);
    if (changed) {
      localStorage.removeItem(`${activeKeys().actionPrefix}${envelope.id}`);
    }
    return changed;
  }

  function scanActionQueue() {
    if (!currentRoomId || !snapshot || !isHost()) {
      return;
    }
    const keys = activeKeys();
    const pending = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key || !key.startsWith(keys.actionPrefix)) {
        continue;
      }
      const payload = safeParse(localStorage.getItem(key));
      if (!payload || payload.roomId !== currentRoomId) {
        continue;
      }
      if (payload.createdAt < now() - ACTION_RETENTION_MS) {
        localStorage.removeItem(key);
        continue;
      }
      pending.push(payload);
    }
    pending
      .sort((left, right) => left.createdAt - right.createdAt)
      .forEach((payload) => {
        processEnvelope(payload);
      });
  }

  function syncFromStorage() {
    if (!currentRoomId) {
      return;
    }
    const stored = safeParse(localStorage.getItem(activeKeys().snapshot));
    if (!stored) {
      return;
    }
    if (!snapshot || stored.updatedAt > snapshot.updatedAt) {
      snapshot = stored;
      render();
    }
  }

  function clearQueuedActions() {
    if (!currentRoomId) {
      return;
    }
    const keys = activeKeys();
    const pending = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && key.startsWith(keys.actionPrefix)) {
        pending.push(key);
      }
    }
    for (const key of pending) {
      localStorage.removeItem(key);
    }
    processedActionIds.clear();
  }

  function ensureRoom(roomId, seed, seat, name) {
    if (currentRoomId !== roomId) {
      teardownRoom();
      currentRoomId = roomId;
      channel = new BroadcastChannel(`herd-game:${config.gameId}:${roomId}`);
      channel.addEventListener('message', (event) => {
        const payload = event.data ?? {};
        if (payload.type === 'snapshot' && payload.snapshot?.roomId === currentRoomId) {
          if (!snapshot || payload.snapshot.updatedAt >= snapshot.updatedAt) {
            snapshot = payload.snapshot;
            render();
          }
          return;
        }
        if (payload.type === 'action' && isHost()) {
          scanActionQueue();
        }
      });
      pollTimer = window.setInterval(() => {
        syncFromStorage();
        scanActionQueue();
        if (!isHost() && snapshot && snapshot.phase !== 'abandoned' && now() - snapshot.hostHeartbeatAt > STALE_HOST_MS) {
          snapshot = {
            ...snapshot,
            phase: 'abandoned',
            status: 'Host disconnected',
            updatedAt: now(),
          };
          render();
        }
      }, ROOM_POLL_MS);
      heartbeatTimer = window.setInterval(() => {
        if (snapshot && isHost() && snapshot.phase !== 'abandoned') {
          commit((nextSnapshot) => {
            nextSnapshot.hostHeartbeatAt = now();
          }, false);
        }
      }, HEARTBEAT_MS);
      if (config.tickMs > 0) {
        tickTimer = window.setInterval(() => {
          if (!snapshot || !isHost() || snapshot.phase !== 'in_progress') {
            return;
          }
          commit((nextSnapshot) => {
            const updated = config.onTick(nextSnapshot, {
              now: () => now(),
              random: randomTools(nextSnapshot),
              actorClientId: null,
            });
            if (updated) {
              Object.assign(nextSnapshot, updated);
              nextSnapshot.tick += 1;
            }
          });
        }, config.tickMs);
      }
    }

    const keys = activeKeys();
    const storedSnapshot = safeParse(localStorage.getItem(keys.snapshot));
    if (storedSnapshot) {
      snapshot = storedSnapshot;
    } else {
      snapshot = createBaseSnapshot(
        config.gameId,
        roomId,
        seed ?? roomId,
        clientId,
        [],
        config.createInitialState(seed ?? roomId),
      );
      writeSnapshot(snapshot);
    }

    const joinEnvelope = {
      id: randomId('join'),
      type: 'join',
      roomId,
      clientId,
      seat,
      name,
      createdAt: now(),
    };

    if (isHost()) {
      processEnvelope(joinEnvelope);
    } else {
      localStorage.setItem(`${keys.actionPrefix}${joinEnvelope.id}`, JSON.stringify(joinEnvelope));
      channel?.postMessage({ type: 'action', roomId });
      scanActionQueue();
      syncFromStorage();
    }
  }

  function submitEnvelope(envelope) {
    if (!currentRoomId) {
      throw new Error('join a room before acting');
    }
    if (!snapshot) {
      throw new Error('missing room snapshot');
    }
    const keys = activeKeys();
    if (isHost()) {
      processEnvelope(envelope);
      return;
    }
    localStorage.setItem(`${keys.actionPrefix}${envelope.id}`, JSON.stringify(envelope));
    channel?.postMessage({ type: 'action', roomId: currentRoomId });
  }

  function teardownRoom() {
    if (tickTimer) {
      window.clearInterval(tickTimer);
      tickTimer = null;
    }
    if (heartbeatTimer) {
      window.clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (pollTimer) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
    if (channel) {
      channel.close();
      channel = null;
    }
    snapshot = null;
  }

  const api = {
    clientId,
    seats: [...config.seats],
    joinRoom(roomId, seat, name, seed) {
      ensureRoom(roomId.trim(), seed ?? roomId.trim(), seat, name.trim() || seat);
      return buildView();
    },
    startGame() {
      submitEnvelope({
        id: randomId('start'),
        type: 'start',
        roomId: currentRoomId,
        clientId,
        createdAt: now(),
      });
      return buildView();
    },
    perform(action) {
      submitEnvelope({
        id: randomId('action'),
        type: 'action',
        roomId: currentRoomId,
        clientId,
        action,
        createdAt: now(),
      });
      return buildView();
    },
    render,
  };

  window.addEventListener('beforeunload', () => {
    if (snapshot && isHost() && snapshot.phase !== 'abandoned') {
      const nextSnapshot = {
        ...snapshot,
        phase: 'abandoned',
        status: 'Host disconnected',
        updatedAt: now(),
        hostHeartbeatAt: now(),
      };
      localStorage.setItem(activeKeys().snapshot, JSON.stringify(nextSnapshot));
      channel?.postMessage({ type: 'snapshot', snapshot: nextSnapshot });
    }
    teardownRoom();
  });

  render();
  return api;
}

window.HerdGameRuntime = { createGameApp };
})();
