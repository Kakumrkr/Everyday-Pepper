import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gunzipSync } from 'node:zlib';

/** One request received by a `recordingServer`. */
export interface RecordedRequest {
  method: string;
  path: string;
  body: string;
}

/**
 * An HTTP server on a random local port that answers 200 `{}` and records every request
 * (gzip bodies decoded). Stands in for collectors such as Sentry or an OTLP endpoint.
 */
export async function recordingServer(): Promise<{
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body = req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw;
      // `method` and `url` are always set on requests an http.Server receives.
      requests.push({
        method: String(req.method),
        path: String(req.url),
        body: body.toString('utf8'),
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** A TCP port that was free a moment ago, for a process the test starts. */
export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}
