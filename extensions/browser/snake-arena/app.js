const { createGameApp } = window.HerdGameRuntime;
const {
  DIRECTIONS,
  SNAKE_SEATS,
  applySnakeDirection,
  createSnakeState,
  presentSnake,
  startSnake,
  tickSnake,
} = window.SnakeArenaLogic;

const roomInput = document.querySelector('#room-id');
const nameInput = document.querySelector('#player-name');
const seatSelect = document.querySelector('#seat');
const seedInput = document.querySelector('#seed');
const joinButton = document.querySelector('#join');
const startButton = document.querySelector('#start');
const statusEl = document.querySelector('#status');
const winnerEl = document.querySelector('#winner');
const playersEl = document.querySelector('#players');
const arenaEl = document.querySelector('#arena');
const controlsEl = document.querySelector('#controls');

function renderArena(view) {
  const state = view.gameState ?? createSnakeState();
  const rows = [];
  for (let y = 0; y < state.size; y += 1) {
    let row = '';
    for (let x = 0; x < state.size; x += 1) {
      if (state.food.x === x && state.food.y === y) {
        row += '*';
        continue;
      }
      let token = '.';
      for (const seat of SNAKE_SEATS) {
        const snake = state.snakes[seat];
        const segmentIndex = snake.body.findIndex((segment) => segment.x === x && segment.y === y);
        if (segmentIndex >= 0) {
          token = segmentIndex === 0 ? seat[0].toUpperCase() : seat[0];
          break;
        }
      }
      row += token;
    }
    rows.push(row);
  }
  arenaEl.textContent = rows.join('\n');
}

function renderPlayers(view) {
  playersEl.innerHTML = '';
  for (const seat of SNAKE_SEATS) {
    const player = view.players.find((entry) => entry.seat === seat);
    const snake = view.snakes?.[seat];
    const item = document.createElement('div');
    item.className = 'player-card';
    const alive = snake?.alive ? 'alive' : 'dead';
    item.textContent = player
      ? `${seat}: ${player.name} (${alive}, len ${snake?.body?.length ?? 0})`
      : `${seat}: open`;
    playersEl.appendChild(item);
  }
}

const app = createGameApp({
  gameId: 'snake-arena',
  seats: SNAKE_SEATS,
  tickMs: 450,
  createInitialState: () => createSnakeState(),
  describeLobby(snapshot) {
    return `Lobby: ${snapshot.players.length}/4 players joined`;
  },
  startGame(snapshot) {
    return startSnake(snapshot);
  },
  applyAction(snapshot, action, helpers) {
    const player = snapshot.players.find((entry) => entry.clientId === helpers.actorClientId);
    if (!player) {
      return null;
    }
    return applySnakeDirection(snapshot, player.seat, action);
  },
  onTick(snapshot, helpers) {
    return tickSnake(snapshot, helpers);
  },
  present: presentSnake,
  render(view) {
    statusEl.textContent = view.status;
    winnerEl.textContent = view.winner ? `Winner: ${view.winner}` : '';
    startButton.disabled = !(view.players.length === 4 && view.phase === 'lobby');
    renderPlayers(view);
    renderArena(view);
  },
});

joinButton.addEventListener('click', () => {
  app.joinRoom(
    roomInput.value.trim(),
    seatSelect.value,
    nameInput.value.trim() || seatSelect.value,
    seedInput.value.trim() || roomInput.value.trim(),
  );
});

startButton.addEventListener('click', () => {
  app.startGame();
});

for (const direction of Object.keys(DIRECTIONS)) {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = `direction-${direction}`;
  button.textContent = direction;
  button.addEventListener('click', () => app.perform({ type: 'direction', value: direction }));
  controlsEl.appendChild(button);
}
