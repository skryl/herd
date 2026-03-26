(() => {
const SNAKE_SEATS = ['north', 'east', 'south', 'west'];
const GRID_SIZE = 15;
const DIRECTIONS = {
  up: { x: 0, y: -1, opposite: 'down' },
  down: { x: 0, y: 1, opposite: 'up' },
  left: { x: -1, y: 0, opposite: 'right' },
  right: { x: 1, y: 0, opposite: 'left' },
};
const MAX_TICKS = 60;

function createSnakeState() {
  return {
    size: GRID_SIZE,
    maxTicks: MAX_TICKS,
    food: { x: 7, y: 7 },
    snakes: {
      north: {
        direction: 'down',
        nextDirection: 'down',
        alive: true,
        score: 0,
        body: [{ x: 7, y: 1 }, { x: 7, y: 0 }],
      },
      east: {
        direction: 'left',
        nextDirection: 'left',
        alive: true,
        score: 0,
        body: [{ x: 13, y: 7 }, { x: 14, y: 7 }],
      },
      south: {
        direction: 'up',
        nextDirection: 'up',
        alive: true,
        score: 0,
        body: [{ x: 7, y: 13 }, { x: 7, y: 14 }],
      },
      west: {
        direction: 'right',
        nextDirection: 'right',
        alive: true,
        score: 0,
        body: [{ x: 1, y: 7 }, { x: 0, y: 7 }],
      },
    },
  };
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function statusText(state) {
  return SNAKE_SEATS
    .map((seat) => `${seat}:${state.snakes[seat].body.length}`)
    .join(' ');
}

function inBounds(size, point) {
  return point.x >= 0 && point.y >= 0 && point.x < size && point.y < size;
}

function samePoint(left, right) {
  return left.x === right.x && left.y === right.y;
}

function directionForMove(current, next) {
  return DIRECTIONS[next] && DIRECTIONS[current]?.opposite !== next ? next : current;
}

function occupiedPoints(state) {
  return Object.values(state.snakes)
    .flatMap((snake) => snake.body.map((point) => `${point.x},${point.y}`));
}

function chooseFood(state, random) {
  const occupied = new Set(occupiedPoints(state));
  const open = [];
  for (let y = 0; y < state.size; y += 1) {
    for (let x = 0; x < state.size; x += 1) {
      const key = `${x},${y}`;
      if (!occupied.has(key)) {
        open.push({ x, y });
      }
    }
  }
  return open.length > 0 ? random.pick(open) : state.food;
}

function decideWinner(state) {
  const ranked = [...SNAKE_SEATS]
    .sort((left, right) => {
      const leftSnake = state.snakes[left];
      const rightSnake = state.snakes[right];
      if (leftSnake.alive !== rightSnake.alive) {
        return leftSnake.alive ? -1 : 1;
      }
      if (leftSnake.body.length !== rightSnake.body.length) {
        return rightSnake.body.length - leftSnake.body.length;
      }
      if (leftSnake.score !== rightSnake.score) {
        return rightSnake.score - leftSnake.score;
      }
      return SNAKE_SEATS.indexOf(left) - SNAKE_SEATS.indexOf(right);
    });
  return ranked[0];
}

function tickSnake(snapshot, helpers) {
  const state = cloneState(snapshot.gameState);
  const aliveSeats = SNAKE_SEATS.filter((seat) => state.snakes[seat].alive);
  if (aliveSeats.length <= 1) {
    const winner = aliveSeats[0] ?? decideWinner(state);
    return {
      phase: 'finished',
      winner,
      status: `${winner} wins`,
      gameState: state,
    };
  }

  const nextHeads = {};
  const occupied = new Set(occupiedPoints(state));

  for (const seat of SNAKE_SEATS) {
    const snake = state.snakes[seat];
    if (!snake.alive) {
      continue;
    }
    snake.direction = directionForMove(snake.direction, snake.nextDirection);
    const delta = DIRECTIONS[snake.direction];
    nextHeads[seat] = {
      x: snake.body[0].x + delta.x,
      y: snake.body[0].y + delta.y,
    };
  }

  for (const seat of SNAKE_SEATS) {
    const snake = state.snakes[seat];
    const nextHead = nextHeads[seat];
    if (!snake.alive || !nextHead) {
      continue;
    }
    if (!inBounds(state.size, nextHead)) {
      snake.alive = false;
      continue;
    }
    const clashes = SNAKE_SEATS.some((otherSeat) => {
      if (otherSeat === seat) {
        return false;
      }
      const otherHead = nextHeads[otherSeat];
      return otherHead && samePoint(nextHead, otherHead);
    });
    if (clashes || occupied.has(`${nextHead.x},${nextHead.y}`)) {
      snake.alive = false;
    }
  }

  for (const seat of SNAKE_SEATS) {
    const snake = state.snakes[seat];
    const nextHead = nextHeads[seat];
    if (!snake.alive || !nextHead) {
      continue;
    }
    snake.body.unshift(nextHead);
    if (samePoint(nextHead, state.food)) {
      snake.score += 1;
      state.food = chooseFood(state, helpers.random);
    } else {
      snake.body.pop();
    }
  }

  const remaining = SNAKE_SEATS.filter((seat) => state.snakes[seat].alive);
  if (remaining.length <= 1) {
    const winner = remaining[0] ?? decideWinner(state);
    return {
      phase: 'finished',
      winner,
      status: `${winner} wins`,
      gameState: state,
    };
  }

  if ((snapshot.tick + 1) >= state.maxTicks) {
    const winner = decideWinner(state);
    return {
      phase: 'finished',
      winner,
      status: `${winner} wins on timeout`,
      gameState: state,
    };
  }

  return {
    phase: 'in_progress',
    winner: null,
    status: statusText(state),
    gameState: state,
  };
}

function applySnakeDirection(snapshot, seat, action) {
  if (action?.type !== 'direction' || !DIRECTIONS[action.value]) {
    return null;
  }
  const state = cloneState(snapshot.gameState);
  const snake = state.snakes[seat];
  if (!snake?.alive) {
    return null;
  }
  snake.nextDirection = directionForMove(snake.direction, action.value);
  return {
    phase: 'in_progress',
    winner: null,
    status: `${statusText(state)} | ${seat} -> ${snake.nextDirection}`,
    gameState: state,
  };
}

function startSnake(snapshot) {
  return {
    phase: 'in_progress',
    winner: null,
    status: statusText(createSnakeState()),
    gameState: createSnakeState(),
    players: snapshot.players.map((player) => ({ ...player })),
  };
}

function presentSnake(snapshot, clientId) {
  const self = snapshot.players.find((player) => player.clientId === clientId) ?? null;
  const legalActions = self && snapshot.phase === 'in_progress'
    ? Object.keys(DIRECTIONS).map((value) => ({ type: 'direction', value }))
    : [];
  return {
    ...snapshot,
    snakes: snapshot.gameState.snakes,
    food: snapshot.gameState.food,
    legalActions,
  };
}

window.SnakeArenaLogic = {
  DIRECTIONS,
  SNAKE_SEATS,
  applySnakeDirection,
  createSnakeState,
  presentSnake,
  startSnake,
  tickSnake,
};
})();
