import http from 'http';
import crypto from 'crypto';
import { createScopedLogger } from '#shared/logging/logger.js';
import { regenerateSessionMessage } from '#modules/session/controller/session.controller.js';

const logger = createScopedLogger('AdminServer');

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function isAuthorized(req: http.IncomingMessage, token: string): boolean {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return false;
  }

  const provided = authHeader.slice('Bearer '.length);

  // Hash both values to normalize length and prevent timing side-channels
  const expected = crypto.createHmac('sha256', token).digest();
  const received = crypto.createHmac('sha256', provided).digest();
  return crypto.timingSafeEqual(expected, received);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function handleRegenSession(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const body = await readBody(req);
  let parsed: { sessionId?: string };

  try {
    parsed = JSON.parse(body) as { sessionId?: string };
  } catch {
    jsonResponse(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const { sessionId } = parsed;
  if (!sessionId || typeof sessionId !== 'string') {
    jsonResponse(res, 400, { error: 'Missing or invalid sessionId' });
    return;
  }

  logger.info('Regenerating session message via admin API', { sessionId });

  try {
    await regenerateSessionMessage(sessionId);
    logger.info('Session message regenerated successfully', { sessionId });
    jsonResponse(res, 200, { ok: true, sessionId });
  } catch (error) {
    logger.error('Failed to regenerate session message', { sessionId, error });
    jsonResponse(res, 500, { error: 'Failed to regenerate session message' });
  }
}

export function createAdminServer(): http.Server {
  return http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('OK');
      return;
    }

    if (req.url === '/admin/regen-session' && req.method === 'POST') {
      const token = process.env.ADMIN_API_TOKEN;
      if (!token) {
        logger.warn('Admin request rejected: ADMIN_API_TOKEN not configured');
        jsonResponse(res, 403, { error: 'Admin API not configured' });
        return;
      }

      if (!isAuthorized(req, token)) {
        logger.warn('Admin request rejected: invalid or missing token');
        jsonResponse(res, 401, { error: 'Unauthorized' });
        return;
      }

      void handleRegenSession(req, res);
      return;
    }

    res.writeHead(404);
    res.end();
  });
}
