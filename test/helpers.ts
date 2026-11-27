import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = fileURLToPath(new URL('../fixtures/sample-20261217.json', import.meta.url));

/** Bare ShowDetails[0] object, as stored in the fixture. Fresh copy each call. */
export const loadShowDetails = (): any => JSON.parse(readFileSync(path, 'utf8'));

/** Full byvenue response shape wrapping the fixture. */
export const fullResponse = (overrides: { dates?: { DateCode: string; isDisabled: boolean }[]; details?: any } = {}) => ({
  ShowDatesArray: overrides.dates ?? [
    { DateCode: '20261216', isDisabled: false },
    { DateCode: '20261217', isDisabled: false },
    { DateCode: '20261218', isDisabled: true },
  ],
  ShowDetails: [overrides.details ?? loadShowDetails()],
});

export const META = { source: 'ticketing', venue: 'PRHN' };
