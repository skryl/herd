export interface CheckersMove {
  seat: 'red' | 'black';
  from: [number, number];
  to: [number, number];
}

export interface CheckersDomCellExpectation {
  row: number;
  col: number;
  value: string;
}

export interface CheckersDomCheckpoint {
  moveNumber: number;
  status: string;
  cells: CheckersDomCellExpectation[];
}

export const CHECKERS_FULL_GAME_SEQUENCE: CheckersMove[] = [
  { seat: 'red', from: [5, 0], to: [4, 1] },
  { seat: 'black', from: [2, 1], to: [3, 0] },
  { seat: 'red', from: [5, 6], to: [4, 5] },
  { seat: 'black', from: [2, 5], to: [3, 6] },
  { seat: 'red', from: [5, 2], to: [4, 3] },
  { seat: 'black', from: [3, 0], to: [5, 2] },
  { seat: 'red', from: [6, 3], to: [4, 1] },
  { seat: 'black', from: [2, 3], to: [3, 4] },
  { seat: 'red', from: [4, 3], to: [2, 5] },
  { seat: 'black', from: [1, 6], to: [3, 4] },
  { seat: 'black', from: [3, 4], to: [5, 6] },
  { seat: 'red', from: [6, 7], to: [4, 5] },
  { seat: 'black', from: [0, 7], to: [1, 6] },
  { seat: 'red', from: [7, 4], to: [6, 3] },
  { seat: 'black', from: [1, 4], to: [2, 3] },
  { seat: 'red', from: [4, 1], to: [3, 0] },
  { seat: 'black', from: [0, 5], to: [1, 4] },
  { seat: 'red', from: [3, 0], to: [2, 1] },
  { seat: 'black', from: [1, 2], to: [3, 0] },
  { seat: 'red', from: [6, 3], to: [5, 2] },
  { seat: 'black', from: [2, 3], to: [3, 4] },
  { seat: 'red', from: [4, 5], to: [2, 3] },
  { seat: 'red', from: [2, 3], to: [0, 5] },
  { seat: 'black', from: [0, 3], to: [1, 4] },
  { seat: 'red', from: [0, 5], to: [2, 3] },
  { seat: 'black', from: [1, 0], to: [2, 1] },
  { seat: 'red', from: [2, 3], to: [1, 4] },
  { seat: 'black', from: [2, 1], to: [3, 2] },
  { seat: 'red', from: [6, 5], to: [5, 6] },
  { seat: 'black', from: [1, 6], to: [2, 5] },
  { seat: 'red', from: [1, 4], to: [0, 3] },
  { seat: 'black', from: [0, 1], to: [1, 2] },
  { seat: 'red', from: [0, 3], to: [2, 1] },
  { seat: 'red', from: [2, 1], to: [4, 3] },
  { seat: 'black', from: [3, 6], to: [4, 5] },
  { seat: 'red', from: [5, 4], to: [3, 6] },
  { seat: 'red', from: [3, 6], to: [1, 4] },
  { seat: 'black', from: [2, 7], to: [3, 6] },
  { seat: 'red', from: [5, 6], to: [4, 5] },
  { seat: 'black', from: [3, 6], to: [5, 4] },
  { seat: 'red', from: [4, 3], to: [6, 5] },
  { seat: 'black', from: [3, 0], to: [4, 1] },
  { seat: 'red', from: [5, 2], to: [3, 0] },
];

export const CHECKERS_DOM_CHECKPOINTS: CheckersDomCheckpoint[] = [
  {
    moveNumber: 6,
    status: 'Red to move',
    cells: [
      { row: 5, col: 2, value: 'b' },
      { row: 4, col: 1, value: '' },
      { row: 4, col: 3, value: 'r' },
    ],
  },
  {
    moveNumber: 12,
    status: 'Black to move',
    cells: [
      { row: 4, col: 1, value: 'r' },
      { row: 5, col: 2, value: '' },
    ],
  },
  {
    moveNumber: 18,
    status: 'Black to move',
    cells: [
      { row: 2, col: 1, value: 'r' },
      { row: 2, col: 3, value: 'b' },
    ],
  },
  {
    moveNumber: 22,
    status: 'Red must continue capturing',
    cells: [
      { row: 2, col: 3, value: 'r' },
      { row: 3, col: 0, value: 'b' },
      { row: 5, col: 2, value: 'r' },
    ],
  },
  {
    moveNumber: 23,
    status: 'Black to move',
    cells: [
      { row: 0, col: 5, value: 'R' },
      { row: 2, col: 3, value: '' },
      { row: 1, col: 4, value: '' },
    ],
  },
  {
    moveNumber: 31,
    status: 'Black to move',
    cells: [
      { row: 0, col: 3, value: 'R' },
      { row: 3, col: 0, value: 'b' },
    ],
  },
  {
    moveNumber: 33,
    status: 'Red must continue capturing',
    cells: [
      { row: 2, col: 1, value: 'R' },
      { row: 0, col: 3, value: '' },
    ],
  },
  {
    moveNumber: 34,
    status: 'Black to move',
    cells: [
      { row: 4, col: 3, value: 'R' },
      { row: 2, col: 1, value: '' },
    ],
  },
  {
    moveNumber: 36,
    status: 'Red must continue capturing',
    cells: [
      { row: 4, col: 3, value: 'R' },
      { row: 3, col: 0, value: 'b' },
    ],
  },
  {
    moveNumber: 43,
    status: 'Red wins',
    cells: [
      { row: 3, col: 0, value: 'r' },
      { row: 6, col: 5, value: 'R' },
      { row: 1, col: 4, value: 'r' },
    ],
  },
];
