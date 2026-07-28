import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FixtureServer {
  /** Loopback URL of the fixture document, carrying a per-run identifier. */
  readonly url: string;
  close(): Promise<void>;
}

const page = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Agent bridge fixture</title></head>
  <body>
    <main>
      <h1>Account settings</h1>
      <form id="account-form">
        <label>Email <input name="email" type="email" aria-label="Email"></label>
        <label>Password <input name="password" type="password" aria-label="Password"></label>
        <button type="submit" data-testid="save">Save</button>
      </form>
      <p role="status" id="result">Waiting</p>
    </main>
    <script>
      document.querySelector('#account-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        document.querySelector('#result').textContent = 'Saved';
        console.error('fixture-console-failure');
        await fetch('/api/save?access_token=query-secret', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer header-secret' },
          body: JSON.stringify({ password: event.currentTarget.password.value }),
        });
      });
    </script>
  </body>
</html>`;

/**
 * Starts a loopback-only fixture document used by the live end-to-end suite.
 *
 * `POST /api/save` always fails with HTTP 503 and returns secret-shaped headers so tests can
 * assert both failed-request inspection and redaction on the same exchange.
 */
export const startFixtureServer = async (): Promise<FixtureServer> => {
  const server: Server = createServer((request, response) => {
    if (request.url?.startsWith('/api/save')) {
      request.resume();
      response.writeHead(503, {
        'content-type': 'application/json',
        'set-cookie': 'session=cookie-secret; HttpOnly',
      });
      response.end('{"error":"intentional fixture failure"}');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(page);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    throw new Error('The fixture server did not expose a TCP address.');
  }

  return {
    url: `http://127.0.0.1:${address.port}/?run=${randomUUID().slice(0, 12)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
};
