import { bench, describe } from 'vitest';

import { RingBuffer, redactBody, redactHeaders, redactSecrets, redactUrl } from '../src/index.js';

/**
 * Redaction runs on every console, network, and request result before it leaves the adapter, so
 * its cost is charged to the read tools' latency budget. These benchmarks keep that cost visible.
 */

const headers = {
  authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.7QW9m0Yc0hEXAMPLEsignature',
  cookie: 'session=abcdef123456; theme=dark',
  'content-type': 'application/json',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'x-request-id': '0f8fad5b-d9cb-469f-a165-70867728950e',
};

const jsonBody = JSON.stringify({
  email: 'max@example.test',
  password: 'plaintext-secret',
  profile: { displayName: 'Max', apiKey: 'sk-live-0123456789' },
  items: Array.from({ length: 20 }, (_, index) => ({ id: index, label: `Item ${index}` })),
});

const formBody = 'email=max%40example.test&password=plaintext-secret&remember=1';

const requestListing = Array.from({ length: 100 }, (_, index) => ({
  id: `request-${index}`,
  method: index % 3 === 0 ? 'POST' : 'GET',
  status: index % 7 === 0 ? 503 : 200,
  url: `https://example.test/api/items/${index}?access_token=secret-${index}`,
  requestHeaders: headers,
  requestBody: index % 3 === 0 ? jsonBody : undefined,
}));

describe('redaction primitives', () => {
  bench('headers', () => {
    redactHeaders(headers);
  });

  bench('url with sensitive query parameters', () => {
    redactUrl('https://example.test/callback?code=abc123&access_token=secret&state=xyz');
  });

  bench('json body', () => {
    redactBody(jsonBody);
  });

  bench('form-encoded body', () => {
    redactBody(formBody);
  });
});

describe('redaction of a full result set', () => {
  bench('100-request network listing', () => {
    redactSecrets(requestListing);
  });
});

describe('bounded buffers', () => {
  const buffer = new RingBuffer<{ index: number; text: string }>(500);
  let index = 0;

  bench('push past capacity', () => {
    index += 1;
    buffer.push({ index, text: `console message ${index}` });
  });

  bench('drain with a filter', () => {
    buffer.toArray().filter((entry) => entry.index % 2 === 0);
  });
});
