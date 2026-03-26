(() => {
const POKER_SEATS = ['north', 'east', 'south', 'west'];
const STARTING_STACK = 20;
const ANTE = 1;
const MAX_RAISES = 2;
const RANK_VALUES = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  T: 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

function buildDeck() {
  const ranks = Object.keys(RANK_VALUES);
  const suits = ['S', 'H', 'D', 'C'];
  return suits.flatMap((suit) => ranks.map((rank) => `${rank}${suit}`));
}

function createSeatState() {
  return {
    chips: STARTING_STACK,
    hand: [],
    folded: false,
    currentBet: 0,
    hasActed: false,
  };
}

function createPokerState() {
  return {
    round: 'lobby',
    turnSeat: null,
    pot: 0,
    deck: [],
    currentBet: 0,
    raiseCount: 0,
    seats: {
      north: createSeatState(),
      east: createSeatState(),
      south: createSeatState(),
      west: createSeatState(),
    },
    showdown: null,
  };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function activeSeats(state) {
  return POKER_SEATS.filter((seat) => !state.seats[seat].folded);
}

function resetBettingFlags(state) {
  for (const seat of POKER_SEATS) {
    state.seats[seat].currentBet = 0;
    state.seats[seat].hasActed = false;
  }
  state.currentBet = 0;
  state.raiseCount = 0;
}

function nextActiveSeat(state, currentSeat = null) {
  const active = activeSeats(state);
  if (active.length === 0) {
    return null;
  }
  if (!currentSeat) {
    return active[0];
  }
  const startIndex = POKER_SEATS.indexOf(currentSeat);
  for (let offset = 1; offset <= POKER_SEATS.length; offset += 1) {
    const seat = POKER_SEATS[(startIndex + offset + POKER_SEATS.length) % POKER_SEATS.length];
    if (active.includes(seat)) {
      return seat;
    }
  }
  return active[0];
}

function dealOne(state) {
  const card = state.deck.shift();
  if (!card) {
    throw new Error('deck exhausted');
  }
  return card;
}

function rankList(hand) {
  return hand.map((card) => RANK_VALUES[card[0]]).sort((left, right) => right - left);
}

function straightHigh(values) {
  const unique = [...new Set(values)].sort((left, right) => right - left);
  if (unique.length !== 5) {
    return null;
  }
  if (unique[0] - unique[4] === 4) {
    return unique[0];
  }
  const aceLow = [14, 5, 4, 3, 2];
  return aceLow.every((value, index) => unique[index] === value) ? 5 : null;
}

function evaluateHand(hand) {
  const values = rankList(hand);
  const suits = hand.map((card) => card[1]);
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  const groups = [...counts.entries()].sort((left, right) => {
    if (left[1] !== right[1]) {
      return right[1] - left[1];
    }
    return right[0] - left[0];
  });
  const flush = suits.every((suit) => suit === suits[0]);
  const straight = straightHigh(values);

  if (flush && straight) {
    return [8, straight];
  }
  if (groups[0][1] === 4) {
    return [7, groups[0][0], groups[1][0]];
  }
  if (groups[0][1] === 3 && groups[1][1] === 2) {
    return [6, groups[0][0], groups[1][0]];
  }
  if (flush) {
    return [5, ...values];
  }
  if (straight) {
    return [4, straight];
  }
  if (groups[0][1] === 3) {
    const kickers = groups.slice(1).map((group) => group[0]).sort((left, right) => right - left);
    return [3, groups[0][0], ...kickers];
  }
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const pairs = groups.slice(0, 2).map((group) => group[0]).sort((left, right) => right - left);
    return [2, ...pairs, groups[2][0]];
  }
  if (groups[0][1] === 2) {
    const kickers = groups.slice(1).map((group) => group[0]).sort((left, right) => right - left);
    return [1, groups[0][0], ...kickers];
  }
  return [0, ...values];
}

function compareEvaluations(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function statusText(state) {
  const turn = state.turnSeat ? ` | turn ${state.turnSeat}` : '';
  return `${state.round} | pot ${state.pot}${turn}`;
}

function finishWithWinner(state, winner, message) {
  state.seats[winner].chips += state.pot;
  state.showdown = {
    winner,
    evaluations: Object.fromEntries(
      activeSeats(state).map((seat) => [seat, evaluateHand(state.seats[seat].hand)]),
    ),
  };
  return {
    phase: 'finished',
    winner,
    status: message,
    gameState: state,
  };
}

function maybeAdvance(state) {
  const active = activeSeats(state);
  if (active.length === 1) {
    return finishWithWinner(state, active[0], `${active[0]} wins by fold`);
  }

  if (state.round === 'draw') {
    const finishedDraw = active.every((seat) => state.seats[seat].hasActed);
    if (!finishedDraw) {
      state.turnSeat = nextActiveSeat(state, state.turnSeat);
      return {
        phase: 'in_progress',
        winner: null,
        status: statusText(state),
        gameState: state,
      };
    }
    state.round = 'post_draw';
    resetBettingFlags(state);
    state.turnSeat = nextActiveSeat(state);
    return {
      phase: 'in_progress',
      winner: null,
      status: statusText(state),
      gameState: state,
    };
  }

  const settled = active.every((seat) => state.seats[seat].hasActed && state.seats[seat].currentBet === state.currentBet);
  if (!settled) {
    state.turnSeat = nextActiveSeat(state, state.turnSeat);
    return {
      phase: 'in_progress',
      winner: null,
      status: statusText(state),
      gameState: state,
    };
  }

  if (state.round === 'pre_draw') {
    state.round = 'draw';
    for (const seat of POKER_SEATS) {
      state.seats[seat].hasActed = state.seats[seat].folded;
    }
    state.turnSeat = nextActiveSeat(state);
    return {
      phase: 'in_progress',
      winner: null,
      status: statusText(state),
      gameState: state,
    };
  }

  const winner = active
    .map((seat) => ({ seat, evaluation: evaluateHand(state.seats[seat].hand) }))
    .sort((left, right) => compareEvaluations(right.evaluation, left.evaluation) || (POKER_SEATS.indexOf(left.seat) - POKER_SEATS.indexOf(right.seat)))[0]
    .seat;
  return finishWithWinner(state, winner, `${winner} wins at showdown`);
}

function applyPokerAction(snapshot, seat, action) {
  const state = cloneState(snapshot.gameState);
  if (state.turnSeat !== seat) {
    return null;
  }
  const player = state.seats[seat];
  if (player.folded) {
    return null;
  }

  if (state.round === 'draw') {
    if (action?.type !== 'draw') {
      return null;
    }
    const discard = [...new Set((action.discard ?? []).map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0 && value < 5))].sort((left, right) => right - left);
    for (const index of discard) {
      player.hand.splice(index, 1);
    }
    while (player.hand.length < 5) {
      player.hand.push(dealOne(state));
    }
    player.hasActed = true;
    return maybeAdvance(state);
  }

  switch (action?.type) {
    case 'fold':
      player.folded = true;
      player.hasActed = true;
      break;
    case 'check':
      if (player.currentBet !== state.currentBet) {
        return null;
      }
      player.hasActed = true;
      break;
    case 'call': {
      const diff = state.currentBet - player.currentBet;
      if (diff <= 0 || player.chips < diff) {
        return null;
      }
      player.chips -= diff;
      player.currentBet = state.currentBet;
      player.hasActed = true;
      state.pot += diff;
      break;
    }
    case 'raise': {
      if (state.raiseCount >= MAX_RAISES) {
        return null;
      }
      const diff = (state.currentBet + 1) - player.currentBet;
      if (player.chips < diff) {
        return null;
      }
      player.chips -= diff;
      state.pot += diff;
      state.currentBet += 1;
      state.raiseCount += 1;
      player.currentBet = state.currentBet;
      for (const otherSeat of activeSeats(state)) {
        state.seats[otherSeat].hasActed = otherSeat === seat;
      }
      break;
    }
    default:
      return null;
  }

  return maybeAdvance(state);
}

function startPoker(snapshot, helpers) {
  const state = createPokerState();
  state.round = 'pre_draw';
  state.deck = helpers.random.shuffle(buildDeck());
  for (const seat of POKER_SEATS) {
    const seatState = state.seats[seat];
    seatState.chips -= ANTE;
    state.pot += ANTE;
  }
  for (let cardIndex = 0; cardIndex < 5; cardIndex += 1) {
    for (const seat of POKER_SEATS) {
      state.seats[seat].hand.push(dealOne(state));
    }
  }
  state.turnSeat = 'north';
  return {
    phase: 'in_progress',
    winner: null,
    status: statusText(state),
    gameState: state,
    players: snapshot.players.map((player) => ({ ...player })),
  };
}

function legalActions(snapshot, clientId) {
  const self = snapshot.players.find((player) => player.clientId === clientId) ?? null;
  if (!self || snapshot.phase !== 'in_progress') {
    return [];
  }
  const state = snapshot.gameState;
  const seatState = state.seats[self.seat];
  if (state.turnSeat !== self.seat || seatState.folded) {
    return [];
  }
  if (state.round === 'draw') {
    return [{ type: 'draw' }];
  }
  const actions = ['fold'];
  if (seatState.currentBet === state.currentBet) {
    actions.push('check');
  } else {
    actions.push('call');
  }
  if (state.raiseCount < MAX_RAISES && seatState.chips > (state.currentBet + 1 - seatState.currentBet)) {
    actions.push('raise');
  }
  return actions.map((type) => ({ type }));
}

function presentPoker(snapshot, clientId) {
  return {
    ...snapshot,
    table: snapshot.gameState.seats,
    round: snapshot.gameState.round,
    pot: snapshot.gameState.pot,
    turnSeat: snapshot.gameState.turnSeat,
    legalActions: legalActions(snapshot, clientId),
    showdown: snapshot.gameState.showdown,
  };
}

window.DrawPokerLogic = {
  MAX_RAISES,
  POKER_SEATS,
  STARTING_STACK,
  ANTE,
  applyPokerAction,
  compareEvaluations,
  createPokerState,
  evaluateHand,
  presentPoker,
  startPoker,
};
})();
