const { createGameApp } = window.HerdGameRuntime;
const {
  POKER_SEATS,
  applyPokerAction,
  createPokerState,
  presentPoker,
  startPoker,
} = window.DrawPokerLogic;

const roomInput = document.querySelector('#room-id');
const nameInput = document.querySelector('#player-name');
const seatSelect = document.querySelector('#seat');
const seedInput = document.querySelector('#seed');
const joinButton = document.querySelector('#join');
const startButton = document.querySelector('#start');
const statusEl = document.querySelector('#status');
const winnerEl = document.querySelector('#winner');
const playersEl = document.querySelector('#players');
const discardInput = document.querySelector('#discard');
const actionButtons = document.querySelector('#actions');

function parseDiscardList(text) {
  return text
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0 && value < 5);
}

function renderPlayers(view) {
  playersEl.innerHTML = '';
  const table = view.table ?? createPokerState().seats;
  for (const seat of POKER_SEATS) {
    const player = view.players.find((entry) => entry.seat === seat);
    const seatState = table[seat];
    const card = document.createElement('div');
    card.className = 'player-card';
    card.textContent = player
      ? `${seat}: ${player.name} | chips ${seatState.chips} | ${seatState.folded ? 'folded' : seatState.hand.join(' ')}`
      : `${seat}: open`;
    playersEl.appendChild(card);
  }
}

function makeActionButton(id, label, actionFactory) {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = id;
  button.textContent = label;
  button.addEventListener('click', actionFactory);
  actionButtons.appendChild(button);
}

const app = createGameApp({
  gameId: 'draw-poker',
  seats: POKER_SEATS,
  tickMs: 0,
  createInitialState: () => createPokerState(),
  describeLobby(snapshot) {
    return `Lobby: ${snapshot.players.length}/4 players joined`;
  },
  startGame(snapshot, helpers) {
    return startPoker(snapshot, helpers);
  },
  applyAction(snapshot, action, helpers) {
    const player = snapshot.players.find((entry) => entry.clientId === helpers.actorClientId);
    if (!player) {
      return null;
    }
    return applyPokerAction(snapshot, player.seat, action);
  },
  present: presentPoker,
  render(view) {
    statusEl.textContent = view.status;
    winnerEl.textContent = view.winner ? `Winner: ${view.winner}` : '';
    startButton.disabled = !(view.players.length === 4 && view.phase === 'lobby');
    renderPlayers(view);
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

makeActionButton('action-check', 'Check', () => app.perform({ type: 'check' }));
makeActionButton('action-call', 'Call', () => app.perform({ type: 'call' }));
makeActionButton('action-raise', 'Raise', () => app.perform({ type: 'raise' }));
makeActionButton('action-fold', 'Fold', () => app.perform({ type: 'fold' }));
makeActionButton('action-draw', 'Draw', () => app.perform({ type: 'draw', discard: parseDiscardList(discardInput.value) }));
