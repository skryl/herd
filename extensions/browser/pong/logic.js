(() => {
const PONG_SEATS = ['left', 'right'];
const WIDTH = 11;
const HEIGHT = 9;
const PADDLE_SIZE = 3;
const TARGET_SCORE = 5;

function createPongState() {
  return {
    width: WIDTH,
    height: HEIGHT,
    paddleSize: PADDLE_SIZE,
    paddles: {
      left: { center: Math.floor(HEIGHT / 2), intent: 'stop' },
      right: { center: Math.floor(HEIGHT / 2), intent: 'stop' },
    },
    ball: {
      x: Math.floor(WIDTH / 2),
      y: Math.floor(HEIGHT / 2),
      vx: 1,
      vy: 1,
    },
    serveDirection: 1,
    serveDelay: 2,
    scores: {
      left: 0,
      right: 0,
    },
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function paddleRange(center) {
  return [center - 1, center, center + 1];
}

function statusText(state) {
  return `Left ${state.scores.left} - Right ${state.scores.right}`;
}

function resetBall(state, direction) {
  state.ball = {
    x: Math.floor(state.width / 2),
    y: Math.floor(state.height / 2),
    vx: direction,
    vy: direction > 0 ? 1 : -1,
  };
  state.serveDirection = direction;
  state.serveDelay = 2;
}

function scorePoint(state, scorer) {
  state.scores[scorer] += 1;
  if (state.scores[scorer] >= TARGET_SCORE) {
    return {
      winner: scorer,
      phase: 'finished',
      status: `${scorer} wins ${state.scores.left}-${state.scores.right}`,
      gameState: state,
    };
  }
  resetBall(state, scorer === 'left' ? 1 : -1);
  return {
    winner: null,
    phase: 'in_progress',
    status: statusText(state),
    gameState: state,
  };
}

function movePaddles(state) {
  for (const seat of PONG_SEATS) {
    const paddle = state.paddles[seat];
    if (paddle.intent === 'up') {
      paddle.center = clamp(paddle.center - 1, 1, state.height - 2);
    } else if (paddle.intent === 'down') {
      paddle.center = clamp(paddle.center + 1, 1, state.height - 2);
    }
  }
}

function ballStep(state) {
  if (state.serveDelay > 0) {
    state.serveDelay -= 1;
    return {
      winner: null,
      phase: 'in_progress',
      status: statusText(state),
      gameState: state,
    };
  }

  let nextX = state.ball.x + state.ball.vx;
  let nextY = state.ball.y + state.ball.vy;

  if (nextY < 0 || nextY >= state.height) {
    state.ball.vy *= -1;
    nextY = state.ball.y + state.ball.vy;
  }

  if (nextX <= 0) {
    const range = paddleRange(state.paddles.left.center);
    if (range.includes(nextY)) {
      state.ball.vx = 1;
      state.ball.vy = clamp(nextY - state.paddles.left.center, -1, 1);
      nextX = 1;
    } else {
      return scorePoint(state, 'right');
    }
  } else if (nextX >= state.width - 1) {
    const range = paddleRange(state.paddles.right.center);
    if (range.includes(nextY)) {
      state.ball.vx = -1;
      state.ball.vy = clamp(nextY - state.paddles.right.center, -1, 1);
      nextX = state.width - 2;
    } else {
      return scorePoint(state, 'left');
    }
  }

  state.ball.x = nextX;
  state.ball.y = nextY;
  return {
    winner: null,
    phase: 'in_progress',
    status: statusText(state),
    gameState: state,
  };
}

function applyPongIntent(snapshot, seat, action) {
  if (action?.type !== 'intent' || !['up', 'down', 'stop'].includes(action.value)) {
    return null;
  }
  const nextState = JSON.parse(JSON.stringify(snapshot.gameState));
  nextState.paddles[seat].intent = action.value;
  return {
    winner: null,
    phase: 'in_progress',
    status: `${statusText(nextState)} | ${seat} intent ${action.value}`,
    gameState: nextState,
  };
}

function tickPong(snapshot) {
  const nextState = JSON.parse(JSON.stringify(snapshot.gameState));
  movePaddles(nextState);
  return ballStep(nextState);
}

function startPong(snapshot) {
  return {
    phase: 'in_progress',
    winner: null,
    status: statusText(createPongState()),
    gameState: createPongState(),
    players: snapshot.players.map((player) => ({ ...player })),
  };
}

function presentPong(snapshot, clientId) {
  const self = snapshot.players.find((player) => player.clientId === clientId) ?? null;
  const legalActions = self && snapshot.phase === 'in_progress'
    ? ['up', 'down', 'stop'].map((value) => ({ type: 'intent', value }))
    : [];
  return {
    ...snapshot,
    ball: snapshot.gameState.ball,
    paddles: snapshot.gameState.paddles,
    scores: snapshot.gameState.scores,
    legalActions,
  };
}

window.PongLogic = {
  PONG_SEATS,
  TARGET_SCORE,
  applyPongIntent,
  createPongState,
  presentPong,
  startPong,
  tickPong,
};
})();
