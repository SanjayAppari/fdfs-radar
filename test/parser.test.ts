import { describe, expect, it } from 'vitest';
import { parseByVenue } from '../src/sources/ticketing.js';
import { fullResponse, loadShowDetails, META } from './helpers.js';

describe('parseByVenue', () => {
  it('parses every session in the fixture', () => {
    const snap = parseByVenue(fullResponse(), '20261217', META);
    expect(snap.status).toBe('open');
    expect(snap.openDates).toEqual(['20261216', '20261217']);
    expect(snap.shows).toHaveLength(11);
    expect(new Set(snap.shows.map((s) => s.sessionId)).size).toBe(11);
    expect(new Set(snap.shows.map((s) => s.movie))).toEqual(new Set(['Avengers: Doomsday', 'Dune: Part Three']));
  });

  it('maps fields from parent event, child event and showtime', () => {
    const snap = parseByVenue(fullResponse(), '20261217', META);
    const s = snap.shows.find((x) => x.sessionId === '259079')!;
    expect(s).toEqual({
      source: 'ticketing',
      venue: 'PRHN',
      date: '20261217',
      sessionId: '259079',
      movie: 'Avengers: Doomsday',
      eventName: 'Avengers: Doomsday (MS-Infinity Vsn 3D) - English',
      eventCode: 'ET00526306',
      dimension: 'MS-Infinity Vsn 3d',
      screen: 'SCREEN 3',
      attributes: 'Infinity Vision 3D',
      time: '08:00 AM',
      showDateTime: '202612170800',
      availStatus: '0',
      categories: [{ name: 'EXECUTIVE + 3D Glass', price: '325.00', availStatus: '0', code: '0000000002' }],
    });
    const dune = snap.shows.find((x) => x.sessionId === '259271')!;
    expect(dune).toMatchObject({ dimension: '2D', screen: 'SCREEN 6', attributes: 'PCX Screen', availStatus: '1' });
  });

  it('accepts the bare ShowDetails object (fixture shape)', () => {
    const snap = parseByVenue(loadShowDetails(), '20261217', META);
    expect(snap.status).toBe('open');
    expect(snap.openDates).toBeNull();
    expect(snap.shows).toHaveLength(11);
  });

  it('treats a Date mismatch as not open (site falls back to nearest date)', () => {
    const snap = parseByVenue(fullResponse(), '20261218', META);
    expect(snap.status).toBe('not_open');
    expect(snap.shows).toEqual([]);
  });

  it('treats a disabled date in ShowDatesArray as not open', () => {
    const details = { ...loadShowDetails(), Date: '20261218' };
    const snap = parseByVenue(fullResponse({ details }), '20261218', META);
    expect(snap.status).toBe('not_open');
  });

  it('reports venue_down', () => {
    const details = loadShowDetails();
    details.Venues.isVenueDown = true;
    expect(parseByVenue(fullResponse({ details }), '20261217', META).status).toBe('venue_down');
  });

  it('survives empty / malformed payloads', () => {
    expect(parseByVenue(null, '20261217', META).status).toBe('not_open');
    expect(parseByVenue({}, '20261217', META).status).toBe('not_open');
    expect(parseByVenue({ ShowDetails: [] }, '20261217', META).status).toBe('not_open');
    const snap = parseByVenue({ ShowDetails: [{ Date: '20261217', Event: [{ EventTitle: 'X' }] }] }, '20261217', META);
    expect(snap).toMatchObject({ status: 'open', shows: [] });
  });
});
