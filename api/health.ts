import { IncomingMessage, ServerResponse } from 'node:http';

/** Openbare healthcheck — geen authenticatie vereist. */
export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok' }));
}
