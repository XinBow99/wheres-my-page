import {describe, expect, it} from 'vitest';

import {
  AppError,
  ERROR_CODES,
  err,
  isWireError,
  ok,
  toWireError,
} from './errors';

describe('AppError', () => {
  it('only retries NO_RECEIVER by default', () => {
    const retryable = ERROR_CODES.filter(
      code => new AppError(code, 'x').retryable,
    );
    expect(retryable).toEqual(['NO_RECEIVER']);
  });

  it('lets the thrower override retryable and keep the cause', () => {
    const cause = new Error('quota');
    const e = new AppError('STORAGE_FAILED', 'write failed', {
      retryable: true,
      cause,
    });
    expect(e).toBeInstanceOf(Error);
    expect(e).toMatchObject({
      name: 'AppError',
      code: 'STORAGE_FAILED',
      message: 'write failed',
      retryable: true,
      cause,
    });
  });
});

describe('toWireError', () => {
  it('keeps the code of an AppError', () => {
    expect(toWireError(new AppError('TIMEOUT', 'no reply in 5000 ms'))).toEqual(
      {code: 'TIMEOUT', message: 'no reply in 5000 ms', retryable: false},
    );
  });

  it('turns any other Error into INTERNAL with its message', () => {
    expect(toWireError(new TypeError('x is undefined'))).toEqual({
      code: 'INTERNAL',
      message: 'x is undefined',
      retryable: false,
    });
  });

  it.each([
    ['a string', 'boom', 'boom'],
    ['a number', 42, '42'],
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
  ])('stringifies %s', (_, thrown, message) => {
    expect(toWireError(thrown)).toEqual({
      code: 'INTERNAL',
      message,
      retryable: false,
    });
  });

  it('survives JSON serialization', () => {
    const wire = toWireError(new AppError('NO_RECEIVER', 'offscreen closed'));
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
  });
});

describe('isWireError', () => {
  it('accepts what toWireError produces', () => {
    expect(isWireError(toWireError(new AppError('DENIED', 'no')))).toBe(true);
  });

  it.each([
    ['null', null],
    ['a string', 'TIMEOUT'],
    ['an unknown code', {code: 'NOPE', message: 'x', retryable: false}],
    ['a missing message', {code: 'TIMEOUT', retryable: false}],
    ['a string retryable', {code: 'TIMEOUT', message: 'x', retryable: 'no'}],
  ])('rejects %s', (_, x) => {
    expect(isWireError(x)).toBe(false);
  });
});

describe('Result helpers', () => {
  it('build both variants', () => {
    expect(ok(3)).toEqual({ok: true, data: 3});
    const error = toWireError(new AppError('NOT_FOUND', 'no such page'));
    expect(err(error)).toEqual({ok: false, error});
  });
});
