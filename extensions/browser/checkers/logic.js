(() => {
const CHECKERS_SEATS = ['red', 'black'];
const BOARD_SIZE = 8;

function createEmptyBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array.from({ length: BOARD_SIZE }, () => null));
}

function createInitialCheckersState() {
  const board = createEmptyBoard();
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      if ((row + col) % 2 === 0) {
        continue;
      }
      if (row <= 2) {
        board[row][col] = 'b';
      } else if (row >= 5) {
        board[row][col] = 'r';
      }
    }
  }
  return {
    board,
    turn: 'red',
    chain: null,
    lastMove: null,
  };
}

function inBounds(row, col) {
  return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function pieceSeat(piece) {
  if (!piece) {
    return null;
  }
  return piece.toLowerCase() === 'r' ? 'red' : 'black';
}

function directionsForPiece(piece) {
  if (!piece) {
    return [];
  }
  if (piece === 'R' || piece === 'B') {
    return [
      [-1, -1],
      [-1, 1],
      [1, -1],
      [1, 1],
    ];
  }
  return piece === 'r'
    ? [
        [-1, -1],
        [-1, 1],
      ]
    : [
        [1, -1],
        [1, 1],
      ];
}

function crownForSeat(seat) {
  return seat === 'red' ? 0 : BOARD_SIZE - 1;
}

function cloneBoard(board) {
  return board.map((row) => [...row]);
}

function capturesForPiece(board, row, col) {
  const piece = board[row]?.[col] ?? null;
  const owner = pieceSeat(piece);
  if (!piece || !owner) {
    return [];
  }
  const captures = [];
  for (const [dy, dx] of directionsForPiece(piece)) {
    const midRow = row + dy;
    const midCol = col + dx;
    const nextRow = row + (dy * 2);
    const nextCol = col + (dx * 2);
    if (!inBounds(nextRow, nextCol) || !inBounds(midRow, midCol)) {
      continue;
    }
    const jumped = board[midRow][midCol];
    if (jumped && pieceSeat(jumped) && pieceSeat(jumped) !== owner && !board[nextRow][nextCol]) {
      captures.push({
        from: [row, col],
        to: [nextRow, nextCol],
        capture: [midRow, midCol],
      });
    }
  }
  return captures;
}

function simpleMovesForPiece(board, row, col) {
  const piece = board[row]?.[col] ?? null;
  if (!piece) {
    return [];
  }
  const moves = [];
  for (const [dy, dx] of directionsForPiece(piece)) {
    const nextRow = row + dy;
    const nextCol = col + dx;
    if (inBounds(nextRow, nextCol) && !board[nextRow][nextCol]) {
      moves.push({
        from: [row, col],
        to: [nextRow, nextCol],
        capture: null,
      });
    }
  }
  return moves;
}

function legalMovesForSeat(gameState, seat) {
  const captures = [];
  const simpleMoves = [];

  const scan = (row, col) => {
    const piece = gameState.board[row][col];
    if (!piece || pieceSeat(piece) !== seat) {
      return;
    }
    captures.push(...capturesForPiece(gameState.board, row, col));
    simpleMoves.push(...simpleMovesForPiece(gameState.board, row, col));
  };

  if (gameState.chain) {
    const { row, col } = gameState.chain;
    return capturesForPiece(gameState.board, row, col);
  }

  for (let row = 0; row < BOARD_SIZE; row += 1) {
    for (let col = 0; col < BOARD_SIZE; col += 1) {
      scan(row, col);
    }
  }

  return captures.length > 0 ? captures : simpleMoves;
}

function sameMove(left, right) {
  return left.from[0] === right.from[0]
    && left.from[1] === right.from[1]
    && left.to[0] === right.to[0]
    && left.to[1] === right.to[1];
}

function opponentOf(seat) {
  return seat === 'red' ? 'black' : 'red';
}

function hasPieces(gameState, seat) {
  return gameState.board.some((row) => row.some((piece) => pieceSeat(piece) === seat));
}

function statusForTurn(turn) {
  return turn === 'red' ? 'Red to move' : 'Black to move';
}

function applyCheckersMove(gameState, seat, requestedMove) {
  if (gameState.turn !== seat) {
    return null;
  }

  const legalMoves = legalMovesForSeat(gameState, seat);
  const move = legalMoves.find((candidate) => sameMove(candidate, requestedMove));
  if (!move) {
    return null;
  }

  const board = cloneBoard(gameState.board);
  let piece = board[move.from[0]][move.from[1]];
  board[move.from[0]][move.from[1]] = null;
  if (move.capture) {
    board[move.capture[0]][move.capture[1]] = null;
  }

  if (move.to[0] === crownForSeat(seat)) {
    piece = seat === 'red' ? 'R' : 'B';
  }
  board[move.to[0]][move.to[1]] = piece;

  const nextState = {
    board,
    turn: gameState.turn,
    chain: null,
    lastMove: move,
  };

  if (move.capture) {
    const followUps = capturesForPiece(board, move.to[0], move.to[1]);
    if (followUps.length > 0) {
      nextState.chain = { row: move.to[0], col: move.to[1] };
      return {
        gameState: nextState,
        status: `${seat === 'red' ? 'Red' : 'Black'} must continue capturing`,
        winner: null,
        phase: 'in_progress',
      };
    }
  }

  const nextTurn = opponentOf(seat);
  nextState.turn = nextTurn;
  const opponentHasPieces = hasPieces(nextState, nextTurn);
  const opponentMoves = legalMovesForSeat(nextState, nextTurn);

  if (!opponentHasPieces || opponentMoves.length === 0) {
    return {
      gameState: nextState,
      status: `${seat === 'red' ? 'Red' : 'Black'} wins`,
      winner: seat,
      phase: 'finished',
    };
  }

  return {
    gameState: nextState,
    status: statusForTurn(nextTurn),
    winner: null,
    phase: 'in_progress',
  };
}

function startCheckers(players) {
  return {
    phase: 'in_progress',
    status: statusForTurn('red'),
    winner: null,
    gameState: createInitialCheckersState(),
    players: players.map((player) => ({ ...player, score: 0 })),
  };
}

function presentCheckers(snapshot, clientId) {
  const self = snapshot.players.find((player) => player.clientId === clientId) ?? null;
  const legalMoves = self && snapshot.phase === 'in_progress'
    ? legalMovesForSeat(snapshot.gameState, self.seat)
    : [];
  return {
    ...snapshot,
    board: snapshot.gameState.board,
    turn: snapshot.gameState.turn,
    chain: snapshot.gameState.chain,
    legalActions: legalMoves.map((move) => ({
      type: 'move',
      from: move.from,
      to: move.to,
      capture: move.capture,
    })),
  };
}

window.CheckersLogic = {
  CHECKERS_SEATS,
  applyCheckersMove,
  createInitialCheckersState,
  legalMovesForSeat,
  presentCheckers,
  startCheckers,
};
})();
