const { createGameApp } = window.HerdGameRuntime;
const {
  CHECKERS_SEATS,
  applyCheckersMove,
  presentCheckers,
  startCheckers,
  createInitialCheckersState,
} = window.CheckersLogic;

const roomInput = document.querySelector('#room-id');
const nameInput = document.querySelector('#player-name');
const seatSelect = document.querySelector('#seat');
const seedInput = document.querySelector('#seed');
const joinButton = document.querySelector('#join');
const startButton = document.querySelector('#start');
const statusEl = document.querySelector('#status');
const winnerEl = document.querySelector('#winner');
const playersEl = document.querySelector('#players');
const boardEl = document.querySelector('#board');

let pendingFrom = null;

function labelForCell(piece) {
  return piece ?? '';
}

function updatePlayers(view) {
  playersEl.innerHTML = '';
  for (const seat of CHECKERS_SEATS) {
    const player = view.players.find((entry) => entry.seat === seat);
    const item = document.createElement('div');
    item.className = 'player-card';
    item.dataset.seat = seat;
    item.textContent = player ? `${seat}: ${player.name}` : `${seat}: open`;
    playersEl.appendChild(item);
  }
}

function renderBoard(view, app) {
  boardEl.innerHTML = '';
  const board = view.board ?? createInitialCheckersState().board;
  for (let row = 0; row < board.length; row += 1) {
    for (let col = 0; col < board[row].length; col += 1) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `cell ${(row + col) % 2 === 0 ? 'light' : 'dark'}`;
      button.dataset.cell = `${row}-${col}`;
      button.textContent = labelForCell(board[row][col]);
      if (pendingFrom && pendingFrom[0] === row && pendingFrom[1] === col) {
        button.dataset.selected = 'true';
      }
      button.addEventListener('click', () => {
        const piece = board[row][col];
        if (piece && view.self?.seat === (piece.toLowerCase() === 'r' ? 'red' : 'black')) {
          pendingFrom = [row, col];
          app.render();
          return;
        }
        if (pendingFrom) {
          app.perform({
            type: 'move',
            from: pendingFrom,
            to: [row, col],
          });
          pendingFrom = null;
        }
      });
      boardEl.appendChild(button);
    }
  }
}

const app = createGameApp({
  gameId: 'checkers',
  seats: CHECKERS_SEATS,
  tickMs: 0,
  createInitialState: () => createInitialCheckersState(),
  describeLobby(snapshot) {
    return `Lobby: ${snapshot.players.length}/2 players joined`;
  },
  startGame(snapshot) {
    return startCheckers(snapshot.players);
  },
  applyAction(snapshot, action, helpers) {
    if (action?.type !== 'move') {
      return null;
    }
    const player = snapshot.players.find((entry) => entry.clientId === helpers.actorClientId);
    if (!player) {
      return null;
    }
    return applyCheckersMove(snapshot.gameState, player.seat, action);
  },
  present: presentCheckers,
  render(view, runtime) {
    statusEl.textContent = view.status;
    winnerEl.textContent = view.winner ? `Winner: ${view.winner}` : '';
    startButton.disabled = !(view.players.length === 2 && view.phase === 'lobby');
    updatePlayers(view);
    renderBoard(view, runtime);
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
