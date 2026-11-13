import {describe, expect, it} from 'vitest';

import {sharedGolden as golden} from '../../test/golden';
import {DEFAULTS, type Settings, parseSettings} from './settings';

describe('DEFAULTS', () => {
  it('match the PoC defaults', () => {
    expect(DEFAULTS).toEqual(golden.defaults);
  });

  it('are frozen, including the domain list', () => {
    expect(Object.isFrozen(DEFAULTS)).toBe(true);
    expect(Object.isFrozen(DEFAULTS.badgeHiddenDomains)).toBe(true);
  });
});

describe('parseSettings', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'settings'],
    ['an array', [1, 2]],
    ['an empty object', {}],
  ])('returns the defaults for %s', (_, raw) => {
    expect(parseSettings(raw)).toEqual(DEFAULTS);
  });

  it('keeps a complete valid value', () => {
    const valid: Settings = {
      enabled: false,
      minDwellSec: 45,
      denylist: 'example.com',
      model: 'eg2_440m',
      showBadge: false,
      badgeHiddenDomains: ['a.com', 'b.org'],
      tagMinScore: 0.35,
      autoImages: true,
      searchMinSim: 0.4,
      imageMinSim: 0.2,
      blockMode: 'hints',
    };
    expect(parseSettings(valid)).toEqual(valid);
  });

  type Case = [string, Record<string, unknown>, Partial<Settings>];
  const cases: Case[] = [
    ['a wrongly typed boolean', {enabled: 'false'}, {enabled: true}],
    ['a numeric string', {minDwellSec: '45'}, {minDwellSec: 20}],
    ['NaN', {minDwellSec: NaN}, {minDwellSec: 20}],
    ['Infinity', {tagMinScore: Infinity}, {tagMinScore: 0.2}],
    ['a dwell time below the minimum', {minDwellSec: 0}, {minDwellSec: 3}],
    ['a dwell time above the maximum', {minDwellSec: 1e6}, {minDwellSec: 600}],
    ['a tag threshold below the range', {tagMinScore: -1}, {tagMinScore: 0.05}],
    ['a tag threshold above the range', {tagMinScore: 2}, {tagMinScore: 0.6}],
    ['a negative similarity', {searchMinSim: -0.5}, {searchMinSim: 0}],
    ['a similarity above the range', {imageMinSim: 1}, {imageMinSim: 0.9}],
    ['an unknown model', {model: 'gpt'}, {model: 'eg2_270m'}],
    [
      'an inherited property as model',
      {model: 'toString'},
      {model: 'eg2_270m'},
    ],
    ['an unknown block mode', {blockMode: 'auto'}, {blockMode: 'manual'}],
    ['a non-string denylist', {denylist: 42}, {denylist: DEFAULTS.denylist}],
    ['an empty denylist', {denylist: ''}, {denylist: ''}],
    [
      'a non-array domain list',
      {badgeHiddenDomains: 'a.com'},
      {badgeHiddenDomains: []},
    ],
    [
      'junk in the domain list',
      {badgeHiddenDomains: [' a.com ', 3, '', null, 'b.org']},
      {badgeHiddenDomains: ['a.com', 'b.org']},
    ],
  ];

  it.each(cases)('repairs %s', (_, raw, expected) => {
    expect(parseSettings(raw)).toEqual({...DEFAULTS, ...expected});
  });

  it('drops unknown fields', () => {
    expect(parseSettings({extra: 1, enabled: false})).toEqual({
      ...DEFAULTS,
      enabled: false,
    });
  });

  it('returns a new domain list each time', () => {
    const a = parseSettings({});
    a.badgeHiddenDomains = ['x'];
    expect(parseSettings({}).badgeHiddenDomains).toEqual([]);
  });
});
