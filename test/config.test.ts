import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

describe('parseConfig', () => {
  it('reads a venues list with shared and per-venue settings', () => {
    const cfg = parseConfig({
      region: 'HYD',
      dates: ['2026-12-18', '20261217'],
      movies: ['Avengers'],
      venues: [
        { name: 'Prasads Multiplex', code: 'prhn', slug: 'prasads-multiplex-hyderabad', screens: { 'screen 6': { rows: 'A-N' } } },
        { name: 'AMB Cinemas', code: 'AMBH', slug: 'amb-cinemas-gachibowli', dates: ['20261219'], movies: ['Dune'] },
      ],
    });
    expect(cfg.venues.map((v) => v.code)).toEqual(['PRHN', 'AMBH']);
    expect(cfg.venues[0]!.dates).toEqual(['20261217', '20261218']);
    expect(cfg.venues[0]!.movies).toEqual(['Avengers']);
    expect(cfg.venues[0]!.screens).toEqual({ 'SCREEN 6': { rows: 'A-N' } });
    expect(cfg.venues[1]!.dates).toEqual(['20261219']);
    expect(cfg.venues[1]!.movies).toEqual(['Dune']);
    expect(cfg.dates).toEqual(['20261217', '20261218', '20261219']);
  });

  it('still loads the old single-venue format', () => {
    const cfg = parseConfig({
      venueName: 'Prasads Multiplex',
      venue: 'PRHN',
      venueSlug: 'prasads-multiplex-hyderabad',
      region: 'HYD',
      dates: ['20261217'],
      movies: [],
      seats: { screens: { 'SCREEN 4': { rows: 'N-A' } } },
    });
    expect(cfg.venues).toEqual([
      { name: 'Prasads Multiplex', code: 'PRHN', slug: 'prasads-multiplex-hyderabad', dates: ['20261217'], movies: [], screens: { 'SCREEN 4': { rows: 'N-A' } } },
    ]);
  });

  it('rejects duplicate venue codes and venues without dates', () => {
    const base = { region: 'HYD', dates: ['20261217'] };
    expect(() => parseConfig({ ...base, venues: [{ code: 'A1', slug: 'a' }, { code: 'a1', slug: 'b' }] })).toThrow(/duplicate/);
    expect(() => parseConfig({ region: 'HYD', venues: [{ code: 'A1', slug: 'a' }] })).toThrow(/no dates/);
  });
});
