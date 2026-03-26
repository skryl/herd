import { describe, expect, it } from 'vitest';

import {
  gameFileUrl,
  textContent,
  withBrowserContext,
} from '../../../tests/browser-game-helpers';

import './logic.js';

const {
  BIG_BLIND,
  HOLD_EM_SEATS,
  STARTING_STACK,
  compareEvaluations,
  createHoldemController,
  createInitialHoldemState,
  evaluateBestHand,
} = (globalThis as any).TexasHoldemLogic;

function ctx(senderTileId: string, senderAgentId = `${senderTileId}-agent`) {
  return {
    sender_tile_id: senderTileId,
    sender_agent_id: senderAgentId,
    sender_agent_role: 'worker',
  };
}

function seatTile(seat: string) {
  return `tile-${seat}`;
}

function claimFullTable(controller: ReturnType<typeof createHoldemController>) {
  for (const seat of HOLD_EM_SEATS) {
    controller.call('claim_seat', { seat, name: seat.toUpperCase() }, ctx(seatTile(seat)));
  }
}

async function browserExtensionCall<T>(
  page: import('playwright').Page,
  method: string,
  args: Record<string, unknown> = {},
  context: Record<string, unknown> = {},
): Promise<T> {
  return page.evaluate(
    ({ methodName, methodArgs, methodContext }) => {
      return (globalThis as any).HerdBrowserExtension.call(methodName, methodArgs, methodContext);
    },
    {
      methodName: method,
      methodArgs: args,
      methodContext: context,
    },
  );
}

describe("texas hold'em", () => {
  it('starts a deterministic match with a shared public turn order', () => {
    const controller = createHoldemController();
    claimFullTable(controller);

    const started = controller.call('start_match', { seed: 'shared-table-seed' }, ctx(seatTile('north')));
    const state = started.state;

    expect(state.phase).toBe('in_hand');
    expect(state.street).toBe('preflop');
    expect(state.button_seat).toBe('north');
    expect(state.small_blind_seat).toBe('east');
    expect(state.big_blind_seat).toBe('south');
    expect(state.turn_seat).toBe('west');
    expect(state.pot).toBe(3);
    expect(state.current_bet).toBe(BIG_BLIND);
    expect(state.seats.every((seat: any) => seat.visible_cards === null)).toBe(true);
  });

  it('binds private reveals to the caller seat and reserves full reveals for the commentator', () => {
    const controller = createHoldemController();
    claimFullTable(controller);
    controller.call('register_commentator', { name: 'Booth' }, ctx('tile-commentator'));
    controller.call('start_match', { seed: 'reveal-seed' }, ctx(seatTile('north')));

    const northReveal = controller.call('reveal_private', {}, ctx(seatTile('north')));
    const eastReveal = controller.call('reveal_private', {}, ctx(seatTile('east')));
    const boothReveal = controller.call('reveal_all', {}, ctx('tile-commentator'));

    expect(northReveal.seat).toBe('north');
    expect(northReveal.cards).toHaveLength(2);
    expect(eastReveal.seat).toBe('east');
    expect(eastReveal.cards).toHaveLength(2);
    expect(northReveal.cards).not.toEqual(eastReveal.cards);
    expect(Object.keys(boothReveal.hands)).toEqual(HOLD_EM_SEATS);
    expect(() => controller.call('reveal_private', {}, ctx('tile-outsider'))).toThrow(/does not own a seat/i);
    expect(() => controller.call('reveal_all', {}, ctx(seatTile('south')))).toThrow(/not the commentator/i);
  });

  it('rejects seat stealing and commentator/player overlap', () => {
    const controller = createHoldemController();

    controller.call('claim_seat', { seat: 'north', name: 'North' }, ctx(seatTile('north')));
    controller.call('register_commentator', { name: 'Booth' }, ctx('tile-commentator'));

    expect(() => controller.call('claim_seat', { seat: 'north' }, ctx('tile-rival'))).toThrow(/already claimed/i);
    expect(() => controller.call('register_commentator', {}, ctx(seatTile('north')))).toThrow(/players cannot register/i);
    expect(() => controller.call('claim_seat', { seat: 'east' }, ctx('tile-commentator'))).toThrow(/commentator cannot claim/i);
  });

  it('advances from preflop to flop after the outstanding action closes', () => {
    const controller = createHoldemController();
    claimFullTable(controller);
    controller.call('start_match', { seed: 'flop-seed' }, ctx(seatTile('north')));

    controller.call('act', { type: 'call' }, ctx(seatTile('west')));
    controller.call('act', { type: 'call' }, ctx(seatTile('north')));
    controller.call('act', { type: 'call' }, ctx(seatTile('east')));
    const settled = controller.call('act', { type: 'check' }, ctx(seatTile('south')));

    expect(settled.state.street).toBe('flop');
    expect(settled.state.board).toHaveLength(3);
    expect(settled.state.turn_seat).toBe('east');
    expect(
      settled.state.seats
        .filter((seat: any) => seat.in_hand)
        .every((seat: any) => seat.visible_cards === null && seat.hole_count === 2),
    ).toBe(true);
  });

  it('keeps action moving clockwise after a player folds out of turn order', () => {
    const controller = createHoldemController();
    claimFullTable(controller);
    controller.call('start_match', { seed: 'fold-order-seed' }, ctx(seatTile('north')));

    controller.call('act', { type: 'fold' }, ctx(seatTile('west')));
    controller.call('act', { type: 'raise' }, ctx(seatTile('north')));
    const afterEastFold = controller.call('act', { type: 'fold' }, ctx(seatTile('east')));

    expect(afterEastFold.state.turn_seat).toBe('south');
    expect(afterEastFold.state.status).toBe('South to act on preflop');
  });

  it('scores the best seven-card hand correctly', () => {
    const fullHouse = evaluateBestHand(['AS', 'AH', 'AD', 'KC', 'KS', '2D', '3H']);
    const flush = evaluateBestHand(['AS', 'QS', '9S', '7S', '3S', 'KD', '2C']);

    expect(fullHouse.category).toBe('Full house');
    expect(flush.category).toBe('Flush');
    expect(compareEvaluations(fullHouse, flush)).toBeGreaterThan(0);
  });

  it('awards an odd chip clockwise from the button on a split pot', () => {
    const prepared = createInitialHoldemState('split-pot-seed');
    prepared.phase = 'in_hand';
    prepared.street = 'river';
    prepared.status = 'South to act on river';
    prepared.handNumber = 1;
    prepared.turnSeat = 'south';
    prepared.buttonSeat = 'west';
    prepared.smallBlindSeat = 'north';
    prepared.bigBlindSeat = 'south';
    prepared.currentBet = 0;
    prepared.raiseCount = 0;
    prepared.pot = 7;
    prepared.board = ['AS', 'AH', 'KD', 'KC', '2C'];
    prepared.handSeats = ['north', 'south'];

    prepared.seats.north.ownerTileId = seatTile('north');
    prepared.seats.north.name = 'North';
    prepared.seats.north.chips = 10;
    prepared.seats.north.holeCards = ['QH', '3D'];
    prepared.seats.north.hasActed = true;

    prepared.seats.south.ownerTileId = seatTile('south');
    prepared.seats.south.name = 'South';
    prepared.seats.south.chips = 10;
    prepared.seats.south.holeCards = ['QS', '4D'];
    prepared.seats.south.hasActed = false;

    const controller = createHoldemController(prepared);
    const result = controller.call('act', { type: 'check' }, ctx(seatTile('south')));
    const northSeat = result.state.seats.find((seat: any) => seat.seat === 'north');
    const southSeat = result.state.seats.find((seat: any) => seat.seat === 'south');

    expect(result.state.phase).toBe('hand_complete');
    expect(result.state.showdown?.winners).toEqual(['north', 'south']);
    expect(northSeat.chips).toBe(14);
    expect(southSeat.chips).toBe(13);
  });

  it('resets chips while preserving claimed seats and the commentator', () => {
    const controller = createHoldemController();
    claimFullTable(controller);
    controller.call('register_commentator', { name: 'Booth' }, ctx('tile-commentator'));
    controller.call('start_match', { seed: 'reset-seed' }, ctx(seatTile('north')));
    controller.call('reset_match', { seed: 'reset-seed-2' }, ctx(seatTile('east')));

    const state = controller.getPublicState();

    expect(state.phase).toBe('lobby');
    expect(state.commentator?.name).toBe('Booth');
    expect(state.seats.filter((seat: any) => seat.claimed)).toHaveLength(4);
    expect(state.seats.every((seat: any) => !seat.claimed || seat.chips === STARTING_STACK)).toBe(true);
  });

  it('rotates the button clockwise across busted seats between hands', () => {
    const prepared = createInitialHoldemState('button-rotation-seed');
    prepared.phase = 'hand_complete';
    prepared.buttonSeat = 'east';

    prepared.seats.north.ownerTileId = seatTile('north');
    prepared.seats.north.name = 'North';
    prepared.seats.north.chips = 20;

    prepared.seats.east.ownerTileId = seatTile('east');
    prepared.seats.east.name = 'East';
    prepared.seats.east.chips = 1;
    prepared.seats.east.busted = true;

    prepared.seats.south.ownerTileId = seatTile('south');
    prepared.seats.south.name = 'South';
    prepared.seats.south.chips = 20;

    prepared.seats.west.ownerTileId = seatTile('west');
    prepared.seats.west.name = 'West';
    prepared.seats.west.chips = 20;

    const controller = createHoldemController(prepared);
    const nextHand = controller.call('start_next_hand', {}, ctx(seatTile('north')));

    expect(nextHand.state.button_seat).toBe('south');
    expect(nextHand.state.small_blind_seat).toBe('west');
    expect(nextHand.state.big_blind_seat).toBe('north');
    expect(nextHand.state.turn_seat).toBe('south');
  });
});

describe("texas hold'em browser page", () => {
  it('renders a fixed-seat poker table with card faces and no API method panel', async () => {
    await withBrowserContext(async (context) => {
      const page = await context.newPage();
      await page.goto(gameFileUrl('extensions/browser/texas-holdem/index.html'));

      await page.locator('#status').waitFor({ state: 'visible' });
      await page.locator('.table-stage').waitFor({ state: 'visible' });
      expect(await textContent(page, '#status')).toBe('Claim all four seats to start the match');
      expect(await page.locator('#api-methods').count()).toBe(0);
      expect(await page.locator('.seat-shell').count()).toBe(4);
      expect(await page.locator('.chair-anchor').count()).toBe(4);
      expect(
        await page.locator('.seat-shell').evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute('data-seat')),
        ),
      ).toEqual(['north', 'east', 'south', 'west']);

      await browserExtensionCall(page, 'register_commentator', { name: 'Booth' }, ctx('tile-commentator'));
      for (const seat of HOLD_EM_SEATS) {
        await browserExtensionCall(page, 'claim_seat', { seat, name: seat.toUpperCase() }, ctx(seatTile(seat)));
      }

      await browserExtensionCall(page, 'start_match', { seed: 'browser-layout-seed' }, ctx(seatTile('north')));
      expect(await page.locator('[data-seat="north"] .card.card-back').count()).toBe(2);
      expect(await page.locator('[data-seat="east"] .card.card-back').count()).toBe(2);
      expect(await textContent(page, '#commentator')).toBe('Booth');

      await browserExtensionCall(page, 'act', { type: 'call' }, ctx(seatTile('west')));
      await browserExtensionCall(page, 'act', { type: 'call' }, ctx(seatTile('north')));
      await browserExtensionCall(page, 'act', { type: 'call' }, ctx(seatTile('east')));
      await browserExtensionCall(page, 'act', { type: 'check' }, ctx(seatTile('south')));

      await page.waitForFunction(() => document.querySelectorAll('#board .card .card-face').length === 3);
      expect(await page.locator('#board .card').count()).toBe(3);
      expect(await page.locator('#board .board-slot').count()).toBe(2);
      expect(await page.locator('#board .card .card-rank').first().textContent()).not.toBeNull();
      expect(await page.locator('#board .card .card-suit').first().textContent()).not.toBe('');
    });
  }, 45_000);
});
