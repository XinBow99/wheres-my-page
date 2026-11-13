import {describe, expect, it} from 'vitest';

import {type DwellCase, dwellGolden as golden} from '../../../test/golden';
import {
  DWELL_STATES,
  type DwellContext,
  type DwellEvent,
  type DwellState,
  initialDwell,
  transition,
} from './state_machine';

type Tag = {id: string};

const label = (c: DwellCase) =>
  `${c.ctx.state}${c.ctx.reason ? `(${c.ctx.reason})` : ''}` +
  `${c.ctx.known ? '+known' : ''} × ${JSON.stringify(c.ev)}`;

describe('dwell state machine', () => {
  it('has the PoC states', () => {
    expect(DWELL_STATES).toEqual(golden.states);
  });

  it('starts from the PoC initial context', () => {
    expect(initialDwell()).toEqual(golden.initial);
  });

  it('covers every state × event pair in the golden table', () => {
    const states = new Set(golden.cases.map(c => c.ctx.state));
    expect([...states].sort()).toEqual([...DWELL_STATES].sort());
    expect(golden.cases.length).toBeGreaterThanOrEqual(
      DWELL_STATES.length * 20,
    );
  });

  it.each(golden.cases.map(c => [label(c), c] as const))(
    '%s matches the PoC',
    (_, c) => {
      expect(transition(c.ctx, c.ev)).toEqual(c.next);
    },
  );

  it('does not modify the input context', () => {
    const ctx = {...initialDwell<Tag>(), state: 'WAITING' as const};
    const copy = structuredClone(ctx);
    transition(ctx, {type: 'TICK', ms: 99_999, needMs: 1});
    expect(ctx).toEqual(copy);
  });

  it('indexes after enough visible time across ticks', () => {
    let ctx: DwellContext<Tag> = initialDwell();
    const events: Array<DwellEvent<Tag>> = [
      {type: 'CHECK_RESULT', visible: true},
      {type: 'TICK', ms: 8000, needMs: 20_000},
      {type: 'HIDDEN'},
      {type: 'TICK', ms: 60_000, needMs: 20_000},
      {type: 'VISIBLE'},
      {type: 'TICK', ms: 12_000, needMs: 20_000},
    ];
    for (const ev of events) ctx = transition(ctx, ev);
    expect(ctx).toMatchObject({state: 'INDEXING', dwellMs: 20_000});
    ctx = transition(ctx, {
      type: 'RESULT',
      result: {ok: true, chunks: 7, tags: [{id: 'ai'}]},
    });
    expect(ctx).toMatchObject({
      state: 'INDEXED',
      detail: 'new',
      chunks: 7,
      known: true,
      tags: [{id: 'ai'}],
    });
  });

  it('treats a missing reply as an unknown error', () => {
    const ctx = {...initialDwell<Tag>(), state: 'INDEXING' as const};
    expect(transition(ctx, {type: 'RESULT'})).toMatchObject({
      state: 'ERROR',
      error: '未知錯誤',
    });
    expect(transition(ctx, {type: 'RESULT', result: null}).state).toBe('ERROR');
  });

  it('rejects a state outside the union', () => {
    const ctx = {...initialDwell<Tag>(), state: 'BOGUS' as DwellState};
    expect(() => transition(ctx, {type: 'HIDDEN'})).toThrow(/BOGUS/);
  });
});
