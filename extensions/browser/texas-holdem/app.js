(() => {
const {
  HOLD_EM_EXTENSION_MANIFEST,
  HOLD_EM_SEATS,
  createHoldemController,
} = globalThis.TexasHoldemLogic

const SUIT_INFO = {
  S: { color: 'black', name: 'spades', symbol: '♠' },
  H: { color: 'red', name: 'hearts', symbol: '♥' },
  D: { color: 'red', name: 'diamonds', symbol: '♦' },
  C: { color: 'black', name: 'clubs', symbol: '♣' },
}

const BOARD_SLOT_LABELS = ['Flop 1', 'Flop 2', 'Flop 3', 'Turn', 'River']

const statusEl = document.querySelector('#status')
const handNumberEl = document.querySelector('#hand-number')
const phaseEl = document.querySelector('#phase')
const streetEl = document.querySelector('#street')
const turnEl = document.querySelector('#turn')
const potEl = document.querySelector('#pot')
const potCenterEl = document.querySelector('#pot-center')
const currentBetEl = document.querySelector('#current-bet')
const blindsEl = document.querySelector('#blinds')
const blindsPanelEl = document.querySelector('#blinds-panel')
const commentatorEl = document.querySelector('#commentator')
const commentatorPanelEl = document.querySelector('#commentator-panel')
const buttonSeatEl = document.querySelector('#button-seat')
const boardEl = document.querySelector('#board')
const seatsEl = document.querySelector('#seats')
const commentaryEl = document.querySelector('#commentary')
const tableNoteEl = document.querySelector('#table-note')

const controller = createHoldemController()

function titleCase(value) {
  if (!value) {
    return 'Waiting'
  }
  return String(value)
    .split('_')
    .filter(Boolean)
    .map((segment) => segment.slice(0, 1).toUpperCase() + segment.slice(1))
    .join(' ')
}

function seatLabel(seat) {
  return seat ? seat.slice(0, 1).toUpperCase() + seat.slice(1) : 'Waiting'
}

function cardRankLabel(rank) {
  return rank === 'T' ? '10' : rank
}

function parseCard(code) {
  if (typeof code !== 'string' || code.length < 2) {
    return null
  }
  const suit = SUIT_INFO[code.slice(-1).toUpperCase()]
  if (!suit) {
    return null
  }
  return {
    code: code.toUpperCase(),
    rank: cardRankLabel(code.slice(0, -1).toUpperCase()),
    suitColor: suit.color,
    suitName: suit.name,
    suitSymbol: suit.symbol,
  }
}

function badgeNode(label, tone = 'neutral') {
  const badge = document.createElement('span')
  badge.className = `seat-badge seat-badge-${tone}`
  badge.textContent = label
  return badge
}

function seatPlaceholderNode() {
  const slot = document.createElement('div')
  slot.className = 'seat-card-slot'
  return slot
}

function hiddenCardNode() {
  const card = document.createElement('article')
  card.className = 'card card-back'
  const face = document.createElement('div')
  face.className = 'card-back-face'
  const emblem = document.createElement('div')
  emblem.className = 'card-back-emblem'
  emblem.textContent = 'H'
  face.appendChild(emblem)
  card.appendChild(face)
  return card
}

function boardSlotNode(label) {
  const slot = document.createElement('div')
  slot.className = 'board-slot'
  const inner = document.createElement('div')
  inner.className = 'board-slot-inner'
  inner.textContent = label
  slot.appendChild(inner)
  return slot
}

function cardNode(code) {
  const parsed = parseCard(code)
  const card = document.createElement('article')
  card.className = `card card-${parsed?.suitColor ?? 'black'}`
  if (!parsed) {
    card.textContent = String(code ?? '')
    return card
  }

  card.dataset.card = parsed.code
  card.dataset.rank = parsed.rank
  card.dataset.suit = parsed.suitName

  const face = document.createElement('div')
  face.className = 'card-face'

  const topCorner = document.createElement('div')
  topCorner.className = 'card-corner card-corner-top'
  const topRank = document.createElement('span')
  topRank.className = 'card-rank'
  topRank.textContent = parsed.rank
  const topSuit = document.createElement('span')
  topSuit.className = 'card-suit'
  topSuit.textContent = parsed.suitSymbol
  topCorner.append(topRank, topSuit)

  const center = document.createElement('div')
  center.className = 'card-center'
  center.textContent = parsed.suitSymbol

  const bottomCorner = document.createElement('div')
  bottomCorner.className = 'card-corner card-corner-bottom'
  const bottomRank = document.createElement('span')
  bottomRank.className = 'card-rank'
  bottomRank.textContent = parsed.rank
  const bottomSuit = document.createElement('span')
  bottomSuit.className = 'card-suit'
  bottomSuit.textContent = parsed.suitSymbol
  bottomCorner.append(bottomRank, bottomSuit)

  face.append(topCorner, center, bottomCorner)
  card.appendChild(face)
  return card
}

function seatBadges(seat) {
  if (!seat?.claimed) {
    return []
  }
  const badges = []
  if (seat.is_button) {
    badges.push(['Dealer', 'gold'])
  }
  if (seat.is_small_blind) {
    badges.push(['SB', 'neutral'])
  }
  if (seat.is_big_blind) {
    badges.push(['BB', 'neutral'])
  }
  if (seat.is_turn) {
    badges.push(['Turn', 'attention'])
  }
  if (seat.folded) {
    badges.push(['Folded', 'muted'])
  }
  if (seat.busted) {
    badges.push(['Out', 'danger'])
  }
  return badges
}

function seatSummary(seat, phase) {
  if (!seat?.claimed) {
    return 'Ready for a new player'
  }
  if (seat.busted) {
    return 'Stack exhausted'
  }
  if (seat.folded) {
    return 'Folded this hand'
  }
  if (phase === 'lobby') {
    return 'Ready for the opening deal'
  }
  if (seat.is_turn) {
    return 'On the clock'
  }
  if (seat.in_hand) {
    return 'Cards live'
  }
  return 'Waiting for the next hand'
}

function tableNote(view) {
  if (view.showdown?.reason) {
    return view.showdown.reason
  }
  if (view.phase === 'lobby') {
    return 'Claim all four chairs to begin the table broadcast.'
  }
  if (view.turn_seat) {
    return `${seatLabel(view.turn_seat)} is next to act.`
  }
  return 'Table is waiting for the next move.'
}

function renderBoard(board) {
  boardEl.innerHTML = ''
  for (let index = 0; index < BOARD_SLOT_LABELS.length; index += 1) {
    const card = board[index]
    boardEl.appendChild(card ? cardNode(card) : boardSlotNode(BOARD_SLOT_LABELS[index]))
  }
}

function renderCommentary(view) {
  commentaryEl.innerHTML = ''
  const lines = view.commentary.length ? view.commentary : ['Waiting for the first hand.']
  for (const line of lines) {
    const item = document.createElement('li')
    item.textContent = line
    if (!view.commentary.length) {
      item.className = 'commentary-empty'
    }
    commentaryEl.appendChild(item)
  }
}

function renderSeatCards(seat) {
  const cards = document.createElement('div')
  cards.className = 'hole-cards'

  const visibleCards = seat?.visible_cards ?? null
  if (visibleCards?.length) {
    for (const card of visibleCards) {
      cards.appendChild(cardNode(card))
    }
    return cards
  }

  if (seat?.hole_count) {
    for (let index = 0; index < seat.hole_count; index += 1) {
      cards.appendChild(hiddenCardNode())
    }
    return cards
  }

  cards.append(seatPlaceholderNode(), seatPlaceholderNode())
  return cards
}

function renderSeats(view) {
  seatsEl.innerHTML = ''
  for (const seatName of HOLD_EM_SEATS) {
    const seat = view.seats.find((entry) => entry.seat === seatName)
    const bestHand = view.showdown?.best_hands?.[seatName]

    const shell = document.createElement('article')
    shell.className = 'seat-shell'
    shell.dataset.seat = seatName
    if (seat?.is_turn) {
      shell.dataset.turn = 'true'
    }
    if (!seat?.claimed) {
      shell.dataset.open = 'true'
    }

    const chairAnchor = document.createElement('div')
    chairAnchor.className = 'chair-anchor'
    chairAnchor.setAttribute('aria-hidden', 'true')

    const section = document.createElement('section')
    section.className = 'seat-card'

    const positionRow = document.createElement('div')
    positionRow.className = 'seat-position-row'
    const position = document.createElement('span')
    position.className = 'seat-position'
    position.textContent = seatLabel(seatName)
    const badges = document.createElement('div')
    badges.className = 'seat-badges'
    for (const [label, tone] of seatBadges(seat)) {
      badges.appendChild(badgeNode(label, tone))
    }
    positionRow.append(position, badges)

    const header = document.createElement('div')
    header.className = 'seat-header'
    const title = document.createElement('strong')
    title.className = 'seat-name'
    title.textContent = seat?.name ?? 'Open chair'
    const stack = document.createElement('span')
    stack.className = 'seat-stack'
    stack.textContent = seat?.claimed ? `${seat.chips} chips` : 'available'
    header.append(title, stack)

    const summary = document.createElement('p')
    summary.className = 'seat-summary'
    summary.textContent = seatSummary(seat, view.phase)

    const footer = document.createElement('div')
    footer.className = 'seat-footer'
    const bet = document.createElement('span')
    bet.className = 'seat-bet'
    bet.textContent = seat?.claimed ? `Bet ${seat.current_bet}` : 'Waiting for player'
    const action = document.createElement('span')
    action.className = 'seat-action'
    action.textContent = seat?.last_action ?? (seat?.claimed ? 'Waiting' : '')
    footer.append(bet, action)

    const showdown = document.createElement('div')
    showdown.className = 'seat-showdown'
    showdown.textContent = bestHand ? `${bestHand.category}: ${bestHand.cards.join(' ')}` : ''

    section.append(positionRow, header, summary, renderSeatCards(seat), footer, showdown)
    shell.append(chairAnchor, section)
    seatsEl.appendChild(shell)
  }
}

function render() {
  const view = controller.getPublicState()
  const blinds = view.small_blind_seat && view.big_blind_seat
    ? `${seatLabel(view.small_blind_seat)} / ${seatLabel(view.big_blind_seat)}`
    : 'Waiting'
  const commentator = view.commentator?.name ?? 'none'

  statusEl.textContent = view.status
  handNumberEl.textContent = String(view.hand_number)
  phaseEl.textContent = titleCase(view.phase)
  streetEl.textContent = titleCase(view.street)
  turnEl.textContent = seatLabel(view.turn_seat)
  potEl.textContent = String(view.pot)
  potCenterEl.textContent = String(view.pot)
  currentBetEl.textContent = String(view.current_bet)
  blindsEl.textContent = blinds
  blindsPanelEl.textContent = blinds
  commentatorEl.textContent = commentator
  commentatorPanelEl.textContent = commentator
  buttonSeatEl.textContent = seatLabel(view.button_seat)
  tableNoteEl.textContent = tableNote(view)

  renderBoard(view.board)
  renderSeats(view)
  renderCommentary(view)
}

globalThis.HerdBrowserExtension = {
  manifest: HOLD_EM_EXTENSION_MANIFEST,
  call(method, args, context) {
    const result = controller.call(method, args, context)
    render()
    return result
  },
}

render()
})()
