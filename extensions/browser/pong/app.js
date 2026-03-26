const { createGameApp } = window.HerdGameRuntime;
const {
  PONG_SEATS,
  applyPongIntent,
  createPongState,
  presentPong,
  startPong,
  tickPong,
} = window.PongLogic;

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
const upButton = document.querySelector('#intent-up');
const downButton = document.querySelector('#intent-down');
const stopButton = document.querySelector('#intent-stop');

function renderArena(view) {
  const state = view.gameState ?? createPongState();
  const rows = [];
  for (let row = 0; row < state.height; row += 1) {
    let line = '';
    for (let col = 0; col < state.width; col += 1) {
      if (col === 0 && [state.paddles.left.center - 1, state.paddles.left.center, state.paddles.left.center + 1].includes(row)) {
        line += '|';
      } else if (
        col === state.width - 1
        && [state.paddles.right.center - 1, state.paddles.right.center, state.paddles.right.center + 1].includes(row)
      ) {
        line += '|';
      } else if (col === state.ball.x && row === state.ball.y) {
        line += 'o';
      } else {
        line += '.';
      }
    }
    rows.push(line);
  }
  arenaEl.textContent = rows.join('\n');
}

function updatePlayers(view) {
  playersEl.innerHTML = '';
  for (const seat of PONG_SEATS) {
    const player = view.players.find((entry) => entry.seat === seat);
    const item = document.createElement('div');
    item.className = 'player-card';
    item.textContent = player ? `${seat}: ${player.name}` : `${seat}: open`;
    playersEl.appendChild(item);
  }
}

const app = createGameApp({
  gameId: 'pong',
  seats: PONG_SEATS,
  tickMs: 350,
  createInitialState: () => createPongState(),
  describeLobby(snapshot) {
    return `Lobby: ${snapshot.players.length}/2 players joined`;
  },
  startGame(snapshot) {
    return startPong(snapshot);
  },
  applyAction(snapshot, action, helpers) {
    const player = snapshot.players.find((entry) => entry.clientId === helpers.actorClientId);
    if (!player) {
      return null;
    }
    return applyPongIntent(snapshot, player.seat, action);
  },
  onTick(snapshot) {
    return tickPong(snapshot);
  },
  present: presentPong,
  render(view) {
    statusEl.textContent = view.status;
    winnerEl.textContent = view.winner ? `Winner: ${view.winner}` : '';
    startButton.disabled = !(view.players.length === 2 && view.phase === 'lobby');
    updatePlayers(view);
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

upButton.addEventListener('click', () => app.perform({ type: 'intent', value: 'up' }));
downButton.addEventListener('click', () => app.perform({ type: 'intent', value: 'down' }));
stopButton.addEventListener('click', () => app.perform({ type: 'intent', value: 'stop' }));
