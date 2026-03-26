(() => {
const HOLD_EM_SEATS = ['north', 'east', 'south', 'west'];
const STARTING_STACK = 40;
const SMALL_BLIND = 1;
const BIG_BLIND = 2;
const EARLY_STREET_RAISE = 2;
const LATE_STREET_RAISE = 4;
const MAX_RAISES_PER_STREET = 3;

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

const STREET_LABELS = {
  idle: 'Idle',
  preflop: 'Preflop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
};

const HOLD_EM_EXTENSION_MANIFEST = {
  extension_id: 'texas-holdem',
  label: "Texas Hold'em",
  methods: [
    {
      name: 'state',
      description: 'Return the public shared-table state.',
      args: [],
    },
    {
      name: 'claim_seat',
      description: 'Claim one of the four poker seats for the caller tile.',
      args: [
        {
          name: 'seat',
          type: 'string',
          required: true,
          description: 'Seat to claim.',
          enum_values: HOLD_EM_SEATS,
        },
        {
          name: 'name',
          type: 'string',
          required: false,
          description: 'Display name for the claimed seat.',
        },
      ],
    },
    {
      name: 'release_seat',
      description: 'Release the caller tile seat while the match is in the lobby.',
      args: [],
    },
    {
      name: 'register_commentator',
      description: 'Register the caller tile as the non-playing commentator.',
      args: [
        {
          name: 'name',
          type: 'string',
          required: false,
          description: 'Display name for the commentator.',
        },
      ],
    },
    {
      name: 'unregister_commentator',
      description: 'Release the current commentator role if owned by the caller tile.',
      args: [],
    },
    {
      name: 'start_match',
      description: 'Start a new match after all four seats are claimed.',
      args: [
        {
          name: 'seed',
          type: 'string',
          required: false,
          description: 'Optional deterministic shuffle seed.',
        },
      ],
    },
    {
      name: 'start_next_hand',
      description: 'Advance from a completed hand to the next hand in the match.',
      args: [],
    },
    {
      name: 'act',
      description: 'Take the next betting action for the caller seat.',
      args: [
        {
          name: 'type',
          type: 'string',
          required: true,
          description: 'Betting action to apply.',
          enum_values: ['fold', 'check', 'call', 'raise'],
        },
      ],
    },
    {
      name: 'reveal_private',
      description: 'Return the caller seat hole cards.',
      args: [],
    },
    {
      name: 'reveal_all',
      description: 'Return all hole cards for the registered commentator.',
      args: [],
    },
    {
      name: 'reset_match',
      description: 'Reset chips and hand state while preserving seat ownership.',
      args: [
        {
          name: 'seed',
          type: 'string',
          required: false,
          description: 'Optional deterministic shuffle seed for the next match.',
        },
      ],
    },
  ],
};

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

function capitalize(value) {
  if (!value) {
    return '';
  }
  return value[0].toUpperCase() + value.slice(1);
}

function createSeat(seat) {
  return {
    seat,
    ownerTileId: null,
    name: null,
    chips: STARTING_STACK,
    busted: false,
    folded: false,
    holeCards: [],
    streetContribution: 0,
    hasActed: false,
    lastAction: null,
  };
}

function createInitialHoldemState(seed = 'texas-holdem') {
  return {
    seed,
    rngState: hashSeed(seed),
    phase: 'lobby',
    status: 'Claim all four seats to start the match',
    street: 'idle',
    handNumber: 0,
    turnSeat: null,
    buttonSeat: null,
    smallBlindSeat: null,
    bigBlindSeat: null,
    currentBet: 0,
    raiseCount: 0,
    pot: 0,
    board: [],
    deck: [],
    handSeats: [],
    showdown: null,
    commentary: [],
    commentator: null,
    seats: Object.fromEntries(HOLD_EM_SEATS.map((seat) => [seat, createSeat(seat)])),
  };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function pushLog(state, text) {
  state.commentary.push(text);
  state.commentary = state.commentary.slice(-16);
}

function buildDeck() {
  const suits = ['S', 'H', 'D', 'C'];
  return suits.flatMap((suit) => Object.keys(RANK_VALUES).map((rank) => `${rank}${suit}`));
}

function randomInt(state, maxExclusive) {
  state.rngState = nextRandomState(state.rngState);
  return Math.floor((state.rngState / 0xffffffff) * maxExclusive);
}

function shuffleDeck(state, deck) {
  const cards = [...deck];
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(state, index + 1);
    [cards[index], cards[swapIndex]] = [cards[swapIndex], cards[index]];
  }
  return cards;
}

function dealCard(state) {
  const card = state.deck.shift();
  if (!card) {
    throw new Error('deck exhausted');
  }
  return card;
}

function burnCard(state) {
  dealCard(state);
}

function claimedSeats(state) {
  return HOLD_EM_SEATS.filter((seat) => Boolean(state.seats[seat].ownerTileId));
}

function normalizeSeatName(seat, provided) {
  const value = String(provided ?? '').trim();
  return value || capitalize(seat);
}

function seatIndex(seat) {
  return HOLD_EM_SEATS.indexOf(seat);
}

function orderedFromSeat(seats, startSeat) {
  if (!seats.length) {
    return [];
  }
  const startIndex = seats.indexOf(startSeat);
  if (startIndex < 0) {
    return [...seats];
  }
  return [...seats.slice(startIndex), ...seats.slice(0, startIndex)];
}

function nextSeatInList(seats, currentSeat) {
  if (!seats.length) {
    return null;
  }
  if (!currentSeat) {
    return seats[0];
  }
  const currentIndex = seats.indexOf(currentSeat);
  if (currentIndex < 0) {
    return seats[0];
  }
  return seats[(currentIndex + 1) % seats.length];
}

function orderedAfterSeatClockwise(seats, startAfterSeat) {
  if (!seats.length) {
    return [];
  }
  const startIndex = seatIndex(startAfterSeat);
  if (startIndex < 0) {
    return [...seats];
  }
  const seatSet = new Set(seats);
  const ordered = [];
  for (let offset = 1; offset <= HOLD_EM_SEATS.length; offset += 1) {
    const seat = HOLD_EM_SEATS[(startIndex + offset) % HOLD_EM_SEATS.length];
    if (seatSet.has(seat)) {
      ordered.push(seat);
    }
  }
  return ordered;
}

function orderedAfterSeat(seats, startAfterSeat) {
  return orderedAfterSeatClockwise(seats, startAfterSeat);
}

function activeHandSeats(state) {
  return state.handSeats.filter((seat) => !state.seats[seat].folded);
}

function activeMatchSeats(state) {
  return claimedSeats(state).filter((seat) => state.seats[seat].chips >= BIG_BLIND);
}

function seatOwnedByTile(state, senderTileId) {
  return HOLD_EM_SEATS.find((seat) => state.seats[seat].ownerTileId === senderTileId) ?? null;
}

function requireSenderTile(context) {
  const senderTileId = String(context?.sender_tile_id ?? '').trim();
  if (!senderTileId) {
    throw new Error('missing sender_tile_id');
  }
  return senderTileId;
}

function requireParticipant(state, senderTileId) {
  const seat = seatOwnedByTile(state, senderTileId);
  if (!seat) {
    throw new Error('caller does not own a seat');
  }
  return seat;
}

function isCommentator(state, senderTileId) {
  return state.commentator?.tileId === senderTileId;
}

function requireParticipantOrCommentator(state, senderTileId) {
  if (seatOwnedByTile(state, senderTileId) || isCommentator(state, senderTileId)) {
    return;
  }
  throw new Error('caller must be a player or the commentator');
}

function streetRaiseSize(street) {
  return street === 'turn' || street === 'river' ? LATE_STREET_RAISE : EARLY_STREET_RAISE;
}

function resetHandFields(seatState) {
  seatState.folded = false;
  seatState.holeCards = [];
  seatState.streetContribution = 0;
  seatState.hasActed = false;
  seatState.lastAction = null;
}

function prepareSeatsForMatch(state) {
  for (const seat of HOLD_EM_SEATS) {
    const seatState = state.seats[seat];
    resetHandFields(seatState);
    if (seatState.ownerTileId) {
      seatState.chips = STARTING_STACK;
      seatState.busted = false;
    } else {
      seatState.chips = STARTING_STACK;
      seatState.busted = false;
    }
  }
}

function normalizeBustedSeats(state) {
  for (const seat of HOLD_EM_SEATS) {
    const seatState = state.seats[seat];
    if (!seatState.ownerTileId) {
      seatState.busted = false;
      continue;
    }
    seatState.busted = seatState.chips < BIG_BLIND;
  }
}

function assignForcedBets(state, smallBlindSeat, bigBlindSeat) {
  const smallBlindPlayer = state.seats[smallBlindSeat];
  const bigBlindPlayer = state.seats[bigBlindSeat];
  smallBlindPlayer.chips -= SMALL_BLIND;
  bigBlindPlayer.chips -= BIG_BLIND;
  smallBlindPlayer.streetContribution = SMALL_BLIND;
  bigBlindPlayer.streetContribution = BIG_BLIND;
  smallBlindPlayer.lastAction = `posted ${SMALL_BLIND}`;
  bigBlindPlayer.lastAction = `posted ${BIG_BLIND}`;
  state.pot = SMALL_BLIND + BIG_BLIND;
  state.currentBet = BIG_BLIND;
  pushLog(state, `${smallBlindSeat} posted the small blind (${SMALL_BLIND})`);
  pushLog(state, `${bigBlindSeat} posted the big blind (${BIG_BLIND})`);
}

function dealHoleCards(state, handSeats, firstSeat) {
  const dealOrder = orderedFromSeat(handSeats, firstSeat);
  for (let round = 0; round < 2; round += 1) {
    for (const seat of dealOrder) {
      state.seats[seat].holeCards.push(dealCard(state));
    }
  }
}

function startHand(state) {
  normalizeBustedSeats(state);
  const handSeats = activeMatchSeats(state);
  if (handSeats.length < 2) {
    const winner = claimedSeats(state).sort((left, right) => state.seats[right].chips - state.seats[left].chips)[0] ?? null;
    state.phase = 'match_complete';
    state.street = 'idle';
    state.turnSeat = null;
    state.handSeats = [];
    state.currentBet = 0;
    state.raiseCount = 0;
    state.board = [];
    state.deck = [];
    state.pot = 0;
    state.showdown = null;
    state.status = winner ? `${winner} wins the match` : 'Match complete';
    if (winner) {
      pushLog(state, `${winner} won the match`);
    }
    return;
  }

  for (const seat of HOLD_EM_SEATS) {
    resetHandFields(state.seats[seat]);
  }

  state.handNumber += 1;
  state.phase = 'in_hand';
  state.street = 'preflop';
  state.board = [];
  state.deck = shuffleDeck(state, buildDeck());
  state.pot = 0;
  state.currentBet = 0;
  state.raiseCount = 0;
  state.showdown = null;
  state.handSeats = [...handSeats];
  state.commentary = state.commentary.slice(-8);

  const previousButton = state.buttonSeat;
  state.buttonSeat = previousButton
    ? (orderedAfterSeat(handSeats, previousButton)[0] ?? handSeats[0])
    : handSeats[0];

  if (handSeats.length === 2) {
    state.smallBlindSeat = state.buttonSeat;
    state.bigBlindSeat = nextSeatInList(handSeats, state.buttonSeat);
    assignForcedBets(state, state.smallBlindSeat, state.bigBlindSeat);
    dealHoleCards(state, handSeats, state.smallBlindSeat);
    state.turnSeat = state.buttonSeat;
  } else {
    state.smallBlindSeat = nextSeatInList(handSeats, state.buttonSeat);
    state.bigBlindSeat = nextSeatInList(handSeats, state.smallBlindSeat);
    assignForcedBets(state, state.smallBlindSeat, state.bigBlindSeat);
    dealHoleCards(state, handSeats, state.smallBlindSeat);
    state.turnSeat = nextSeatInList(handSeats, state.bigBlindSeat);
  }

  state.status = `${capitalize(state.turnSeat)} to act on ${STREET_LABELS[state.street].toLowerCase()}`;
  pushLog(state, `Hand ${state.handNumber} started with button on ${state.buttonSeat}`);
}

function resetBettingRound(state, street) {
  state.street = street;
  state.currentBet = 0;
  state.raiseCount = 0;
  for (const seat of state.handSeats) {
    const seatState = state.seats[seat];
    seatState.streetContribution = 0;
    seatState.hasActed = seatState.folded;
    if (!seatState.folded) {
      seatState.lastAction = null;
    }
  }
}

function dealCommunityCards(state, count) {
  burnCard(state);
  for (let index = 0; index < count; index += 1) {
    state.board.push(dealCard(state));
  }
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

function evaluateFiveCardHand(hand) {
  const values = hand.map((card) => RANK_VALUES[card[0]]).sort((left, right) => right - left);
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
    return { rank: [8, straight], category: 'Straight flush' };
  }
  if (groups[0][1] === 4) {
    return { rank: [7, groups[0][0], groups[1][0]], category: 'Four of a kind' };
  }
  if (groups[0][1] === 3 && groups[1][1] === 2) {
    return { rank: [6, groups[0][0], groups[1][0]], category: 'Full house' };
  }
  if (flush) {
    return { rank: [5, ...values], category: 'Flush' };
  }
  if (straight) {
    return { rank: [4, straight], category: 'Straight' };
  }
  if (groups[0][1] === 3) {
    const kickers = groups.slice(1).map((group) => group[0]).sort((left, right) => right - left);
    return { rank: [3, groups[0][0], ...kickers], category: 'Three of a kind' };
  }
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const pairs = groups.slice(0, 2).map((group) => group[0]).sort((left, right) => right - left);
    return { rank: [2, ...pairs, groups[2][0]], category: 'Two pair' };
  }
  if (groups[0][1] === 2) {
    const kickers = groups.slice(1).map((group) => group[0]).sort((left, right) => right - left);
    return { rank: [1, groups[0][0], ...kickers], category: 'One pair' };
  }
  return { rank: [0, ...values], category: 'High card' };
}

function compareEvaluations(left, right) {
  for (let index = 0; index < Math.max(left.rank.length, right.rank.length); index += 1) {
    const diff = (left.rank[index] ?? 0) - (right.rank[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function combinations(cards, chooseCount) {
  const result = [];
  const current = [];
  function walk(startIndex) {
    if (current.length === chooseCount) {
      result.push([...current]);
      return;
    }
    for (let index = startIndex; index < cards.length; index += 1) {
      current.push(cards[index]);
      walk(index + 1);
      current.pop();
    }
  }
  walk(0);
  return result;
}

function evaluateBestHand(cards) {
  const hands = combinations(cards, 5).map((hand) => ({
    cards: [...hand],
    ...evaluateFiveCardHand(hand),
  }));
  hands.sort((left, right) => compareEvaluations(right, left));
  return hands[0];
}

function finishHandByFold(state, winnerSeat) {
  state.seats[winnerSeat].chips += state.pot;
  state.showdown = {
    winners: [winnerSeat],
    revealed: {},
    bestHands: {},
    reason: 'fold',
  };
  state.status = `${winnerSeat} wins the pot by fold`;
  pushLog(state, `${winnerSeat} won ${state.pot} chips by fold`);
  state.pot = 0;
  finalizeHandState(state);
}

function finishHandByShowdown(state) {
  const contenders = activeHandSeats(state);
  const scored = contenders.map((seat) => ({
    seat,
    cards: [...state.seats[seat].holeCards],
    bestHand: evaluateBestHand([...state.seats[seat].holeCards, ...state.board]),
  }));
  scored.sort((left, right) =>
    compareEvaluations(right.bestHand, left.bestHand) || (seatIndex(left.seat) - seatIndex(right.seat)));
  const best = scored[0].bestHand;
  const winners = scored
    .filter((entry) => compareEvaluations(entry.bestHand, best) === 0)
    .map((entry) => entry.seat);
  const share = Math.floor(state.pot / winners.length);
  let remainder = state.pot - (share * winners.length);
  for (const winner of winners) {
    state.seats[winner].chips += share;
  }
  if (remainder > 0) {
    const oddChipSeat = orderedAfterSeat(
      HOLD_EM_SEATS.filter((seat) => winners.includes(seat)),
      state.buttonSeat,
    )[0] ?? winners[0];
    state.seats[oddChipSeat].chips += remainder;
    remainder = 0;
  }
  state.showdown = {
    winners,
    revealed: Object.fromEntries(scored.map((entry) => [entry.seat, entry.cards])),
    bestHands: Object.fromEntries(scored.map((entry) => [entry.seat, entry.bestHand])),
    reason: 'showdown',
  };
  state.status = winners.length === 1
    ? `${winners[0]} wins at showdown`
    : `Split pot: ${winners.join(', ')}`;
  pushLog(state, state.status);
  state.pot = 0;
  finalizeHandState(state);
}

function finalizeHandState(state) {
  normalizeBustedSeats(state);
  state.street = 'idle';
  state.turnSeat = null;
  state.currentBet = 0;
  state.raiseCount = 0;
  if (activeMatchSeats(state).length < 2) {
    const winner = claimedSeats(state)
      .filter((seat) => state.seats[seat].ownerTileId)
      .sort((left, right) => state.seats[right].chips - state.seats[left].chips)[0] ?? null;
    state.phase = 'match_complete';
    state.status = winner ? `${winner} wins the match` : 'Match complete';
    if (winner) {
      pushLog(state, `${winner} won the match`);
    }
    return;
  }
  state.phase = 'hand_complete';
}

function advanceStreet(state) {
  if (state.street === 'preflop') {
    resetBettingRound(state, 'flop');
    dealCommunityCards(state, 3);
    state.turnSeat = orderedAfterSeat(activeHandSeats(state), state.buttonSeat)[0] ?? null;
    state.status = `${capitalize(state.turnSeat)} to act on flop`;
    pushLog(state, 'Flop dealt');
    return;
  }
  if (state.street === 'flop') {
    resetBettingRound(state, 'turn');
    dealCommunityCards(state, 1);
    state.turnSeat = orderedAfterSeat(activeHandSeats(state), state.buttonSeat)[0] ?? null;
    state.status = `${capitalize(state.turnSeat)} to act on turn`;
    pushLog(state, 'Turn dealt');
    return;
  }
  if (state.street === 'turn') {
    resetBettingRound(state, 'river');
    dealCommunityCards(state, 1);
    state.turnSeat = orderedAfterSeat(activeHandSeats(state), state.buttonSeat)[0] ?? null;
    state.status = `${capitalize(state.turnSeat)} to act on river`;
    pushLog(state, 'River dealt');
    return;
  }
  finishHandByShowdown(state);
}

function settleAfterAction(state) {
  const contenders = activeHandSeats(state);
  if (contenders.length === 1) {
    finishHandByFold(state, contenders[0]);
    return;
  }

  const streetSettled = contenders.every((seat) => {
    const seatState = state.seats[seat];
    return seatState.hasActed && seatState.streetContribution === state.currentBet;
  });
  if (streetSettled) {
    advanceStreet(state);
    return;
  }

  state.turnSeat = orderedAfterSeat(contenders, state.turnSeat)[0] ?? contenders[0] ?? null;
  state.status = `${capitalize(state.turnSeat)} to act on ${STREET_LABELS[state.street].toLowerCase()}`;
}

function publicSeatState(state, seat) {
  const seatState = state.seats[seat];
  const claimed = Boolean(seatState.ownerTileId);
  const revealedCards = state.showdown?.revealed?.[seat] ?? null;
  return {
    seat,
    name: claimed ? seatState.name : null,
    claimed,
    chips: claimed ? seatState.chips : null,
    busted: claimed ? seatState.busted : false,
    folded: claimed ? seatState.folded : false,
    current_bet: claimed ? seatState.streetContribution : 0,
    last_action: seatState.lastAction,
    in_hand: state.handSeats.includes(seat),
    is_button: state.buttonSeat === seat,
    is_small_blind: state.smallBlindSeat === seat,
    is_big_blind: state.bigBlindSeat === seat,
    is_turn: state.turnSeat === seat,
    hole_count: revealedCards ? revealedCards.length : (state.handSeats.includes(seat) ? 2 : 0),
    visible_cards: revealedCards,
  };
}

function publicGameState(state) {
  return {
    phase: state.phase,
    status: state.status,
    street: state.street,
    hand_number: state.handNumber,
    turn_seat: state.turnSeat,
    button_seat: state.buttonSeat,
    small_blind_seat: state.smallBlindSeat,
    big_blind_seat: state.bigBlindSeat,
    current_bet: state.currentBet,
    raise_count: state.raiseCount,
    pot: state.pot,
    board: [...state.board],
    seats: HOLD_EM_SEATS.map((seat) => publicSeatState(state, seat)),
    commentator: state.commentator ? { name: state.commentator.name } : null,
    showdown: state.showdown ? {
      winners: [...state.showdown.winners],
      best_hands: Object.fromEntries(
        Object.entries(state.showdown.bestHands).map(([seat, hand]) => [seat, {
          category: hand.category,
          cards: [...hand.cards],
        }]),
      ),
      reason: state.showdown.reason,
    } : null,
    commentary: [...state.commentary],
    can_start_match: claimedSeats(state).length === HOLD_EM_SEATS.length && state.phase === 'lobby',
    can_start_next_hand: state.phase === 'hand_complete',
  };
}

function stateResult(state, extra = {}) {
  return {
    state: publicGameState(state),
    ...extra,
  };
}

function createHoldemController(initialState = createInitialHoldemState()) {
  const state = cloneState(initialState);

  function claimSeat(args, context) {
    const senderTileId = requireSenderTile(context);
    if (state.phase !== 'lobby') {
      throw new Error('seats can only be claimed in the lobby');
    }
    if (isCommentator(state, senderTileId)) {
      throw new Error('commentator cannot claim a player seat');
    }
    const seat = String(args?.seat ?? '').trim();
    if (!HOLD_EM_SEATS.includes(seat)) {
      throw new Error(`invalid seat: ${seat}`);
    }
    const ownedSeat = seatOwnedByTile(state, senderTileId);
    if (ownedSeat && ownedSeat !== seat) {
      throw new Error(`caller already owns seat ${ownedSeat}`);
    }
    const seatState = state.seats[seat];
    if (seatState.ownerTileId && seatState.ownerTileId !== senderTileId) {
      throw new Error(`seat ${seat} is already claimed`);
    }
    seatState.ownerTileId = senderTileId;
    seatState.name = normalizeSeatName(seat, args?.name);
    seatState.chips = STARTING_STACK;
    seatState.busted = false;
    state.status = `Seat ${seat} claimed by ${seatState.name}`;
    pushLog(state, `${seatState.name} claimed ${seat}`);
    return stateResult(state, { seat });
  }

  function releaseSeat(_args, context) {
    const senderTileId = requireSenderTile(context);
    if (state.phase !== 'lobby') {
      throw new Error('seats can only be released in the lobby');
    }
    const seat = requireParticipant(state, senderTileId);
    state.seats[seat] = createSeat(seat);
    state.status = `Seat ${seat} released`;
    pushLog(state, `${seat} returned to the lobby`);
    return stateResult(state, { seat });
  }

  function registerCommentator(args, context) {
    const senderTileId = requireSenderTile(context);
    if (seatOwnedByTile(state, senderTileId)) {
      throw new Error('players cannot register as the commentator');
    }
    if (state.commentator && state.commentator.tileId !== senderTileId) {
      throw new Error('commentator role is already claimed');
    }
    state.commentator = {
      tileId: senderTileId,
      name: String(args?.name ?? '').trim() || 'Commentator',
    };
    state.status = `${state.commentator.name} joined as commentator`;
    pushLog(state, `${state.commentator.name} registered as commentator`);
    return stateResult(state);
  }

  function unregisterCommentator(_args, context) {
    const senderTileId = requireSenderTile(context);
    if (!isCommentator(state, senderTileId)) {
      throw new Error('caller is not the commentator');
    }
    pushLog(state, `${state.commentator?.name ?? 'Commentator'} left the table`);
    state.commentator = null;
    state.status = 'Commentator released';
    return stateResult(state);
  }

  function resetMatch(args, context) {
    const senderTileId = requireSenderTile(context);
    requireParticipantOrCommentator(state, senderTileId);
    const seed = String(args?.seed ?? '').trim() || state.seed;
    state.seed = seed;
    state.rngState = hashSeed(seed);
    state.phase = 'lobby';
    state.street = 'idle';
    state.handNumber = 0;
    state.turnSeat = null;
    state.buttonSeat = null;
    state.smallBlindSeat = null;
    state.bigBlindSeat = null;
    state.currentBet = 0;
    state.raiseCount = 0;
    state.pot = 0;
    state.board = [];
    state.deck = [];
    state.handSeats = [];
    state.showdown = null;
    state.commentary = [];
    prepareSeatsForMatch(state);
    state.status = 'Claimed seats are ready for a new match';
    pushLog(state, 'Match reset');
    return stateResult(state);
  }

  function startMatch(args, context) {
    const senderTileId = requireSenderTile(context);
    requireParticipantOrCommentator(state, senderTileId);
    if (state.phase !== 'lobby') {
      throw new Error('match has already started');
    }
    if (claimedSeats(state).length !== HOLD_EM_SEATS.length) {
      throw new Error('all four seats must be claimed before starting');
    }
    const seed = String(args?.seed ?? '').trim() || state.seed;
    state.seed = seed;
    state.rngState = hashSeed(seed);
    prepareSeatsForMatch(state);
    startHand(state);
    return stateResult(state);
  }

  function startNextHand(_args, context) {
    const senderTileId = requireSenderTile(context);
    requireParticipantOrCommentator(state, senderTileId);
    if (state.phase !== 'hand_complete') {
      throw new Error('current hand is not complete');
    }
    startHand(state);
    return stateResult(state);
  }

  function act(args, context) {
    const senderTileId = requireSenderTile(context);
    if (state.phase !== 'in_hand') {
      throw new Error('no active hand');
    }
    const seat = requireParticipant(state, senderTileId);
    if (state.turnSeat !== seat) {
      throw new Error(`it is not ${seat}'s turn`);
    }
    const seatState = state.seats[seat];
    const action = String(args?.type ?? '').trim();
    if (!['fold', 'check', 'call', 'raise'].includes(action)) {
      throw new Error(`invalid action: ${action}`);
    }
    if (seatState.folded || seatState.busted) {
      throw new Error(`${seat} cannot act`);
    }

    if (action === 'fold') {
      seatState.folded = true;
      seatState.hasActed = true;
      seatState.lastAction = 'folded';
      pushLog(state, `${seat} folded`);
      settleAfterAction(state);
      return stateResult(state, { action });
    }

    if (action === 'check') {
      if (seatState.streetContribution !== state.currentBet) {
        throw new Error('check is not available when facing a bet');
      }
      seatState.hasActed = true;
      seatState.lastAction = 'checked';
      pushLog(state, `${seat} checked`);
      settleAfterAction(state);
      return stateResult(state, { action });
    }

    if (action === 'call') {
      const amount = state.currentBet - seatState.streetContribution;
      if (amount <= 0) {
        throw new Error('call is not available when no bet is outstanding');
      }
      if (seatState.chips < amount) {
        throw new Error('caller cannot cover the bet');
      }
      seatState.chips -= amount;
      seatState.streetContribution += amount;
      seatState.hasActed = true;
      seatState.lastAction = `called ${amount}`;
      state.pot += amount;
      pushLog(state, `${seat} called ${amount}`);
      settleAfterAction(state);
      return stateResult(state, { action, amount });
    }

    if (state.raiseCount >= MAX_RAISES_PER_STREET) {
      throw new Error('raise cap reached for this street');
    }
    const raiseSize = streetRaiseSize(state.street);
    const amount = (state.currentBet + raiseSize) - seatState.streetContribution;
    if (seatState.chips < amount) {
      throw new Error('caller cannot cover the raise');
    }
    seatState.chips -= amount;
    seatState.streetContribution += amount;
    seatState.hasActed = true;
    seatState.lastAction = `raised to ${seatState.streetContribution}`;
    state.pot += amount;
    state.currentBet += raiseSize;
    state.raiseCount += 1;
    for (const otherSeat of activeHandSeats(state)) {
      if (otherSeat !== seat) {
        state.seats[otherSeat].hasActed = false;
      }
    }
    pushLog(state, `${seat} raised to ${state.currentBet}`);
    settleAfterAction(state);
    return stateResult(state, { action, amount });
  }

  function revealPrivate(_args, context) {
    const senderTileId = requireSenderTile(context);
    const seat = requireParticipant(state, senderTileId);
    return stateResult(state, {
      seat,
      cards: [...state.seats[seat].holeCards],
    });
  }

  function revealAll(_args, context) {
    const senderTileId = requireSenderTile(context);
    if (!isCommentator(state, senderTileId)) {
      throw new Error('caller is not the commentator');
    }
    return stateResult(state, {
      hands: Object.fromEntries(
        HOLD_EM_SEATS
          .filter((seat) => Boolean(state.seats[seat].ownerTileId))
          .map((seat) => [seat, [...state.seats[seat].holeCards]]),
      ),
    });
  }

  function stateMethod() {
    return publicGameState(state);
  }

  function call(method, args = {}, context = {}) {
    switch (method) {
      case 'state':
        return stateMethod();
      case 'claim_seat':
        return claimSeat(args, context);
      case 'release_seat':
        return releaseSeat(args, context);
      case 'register_commentator':
        return registerCommentator(args, context);
      case 'unregister_commentator':
        return unregisterCommentator(args, context);
      case 'start_match':
        return startMatch(args, context);
      case 'start_next_hand':
        return startNextHand(args, context);
      case 'act':
        return act(args, context);
      case 'reveal_private':
        return revealPrivate(args, context);
      case 'reveal_all':
        return revealAll(args, context);
      case 'reset_match':
        return resetMatch(args, context);
      default:
        throw new Error(`unknown extension method: ${method}`);
    }
  }

  return {
    manifest: HOLD_EM_EXTENSION_MANIFEST,
    call,
    getState: () => cloneState(state),
    getPublicState: () => publicGameState(state),
  };
}

globalThis.TexasHoldemLogic = {
  BIG_BLIND,
  EARLY_STREET_RAISE,
  HOLD_EM_EXTENSION_MANIFEST,
  HOLD_EM_SEATS,
  LATE_STREET_RAISE,
  MAX_RAISES_PER_STREET,
  SMALL_BLIND,
  STARTING_STACK,
  compareEvaluations,
  createHoldemController,
  createInitialHoldemState,
  evaluateBestHand,
  publicGameState,
};
})();
