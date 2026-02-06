import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT } from '../config';
import { findExistingMoltbotProcess } from '../gateway';

/**
 * Public routes - NO Cloudflare Access authentication required
 * 
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltbot-sandbox',
    gateway_port: MOLTBOT_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Public health check for gateway status (no auth required)
publicRoutes.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox');
  
  try {
    const process = await findExistingMoltbotProcess(sandbox);
    if (!process) {
      return c.json({ ok: false, status: 'not_running' });
    }
    
    // Process exists, check if it's actually responding
    // Try to reach the gateway with a short timeout
    try {
      await process.waitForPort(18789, { mode: 'tcp', timeout: 5000 });
      return c.json({ ok: true, status: 'running', processId: process.id });
    } catch {
      return c.json({ ok: false, status: 'not_responding', processId: process.id });
    }
  } catch (err) {
    return c.json({ ok: false, status: 'error', error: err instanceof Error ? err.message : 'Unknown error' });
  }
});


// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});


// POST /webhooks/* - Webhook endpoints (LINE, Telegram, etc.)
publicRoutes.all('/webhooks/*', async (c) => {
  // === Capture EVERYTHING first ===
  const method = c.req.method;
  const hasBody = !['GET', 'HEAD'].includes(method);
  const bodyText = hasBody ? await c.req.text() : null;
  const headerEntries: [string, string][] = [...c.req.raw.headers.entries()];
  const originalPath = new URL(c.req.url).pathname;
  
  // Rewrite: /webhooks/line → /line/webhook
  // Generic: /webhooks/{channel} → /{channel}/webhook
  const match = originalPath.match(/^\/webhooks\/(\w+)$/);
  const newPath = match ? `/${match[1]}/webhook` : originalPath;
  
  const sandbox = c.get('sandbox');
  const env = c.env;

  // Process in background
  c.executionCtx.waitUntil((async () => {
    try {
      const { ensureMoltbotGateway } = await import('../gateway');
      await ensureMoltbotGateway(sandbox, env);
      
      const internalUrl = `http://localhost:${MOLTBOT_PORT}${newPath}`;
      
      const rewrittenReq = new Request(internalUrl, {
        method,
        headers: headerEntries,
        body: bodyText,
      });
      
      const response = await sandbox.containerFetch(rewrittenReq, MOLTBOT_PORT);
      console.log(`[WEBHOOK] Forwarded to ${newPath}, Response: ${response.status}`);
    } catch (error) {
      console.error('[WEBHOOK] Background processing failed:', error);
    }
  })());

  return c.json({ status: 'ok' });
});


// POST /line/* - LINE webhook endpoint
// No CF Access auth required - LINE has its own signature verification
// POST /line/* - LINE webhook endpoint
publicRoutes.all('/line/*', async (c) => {
  const sandbox = c.get('sandbox');
  const { ensureMoltbotGateway } = await import('../gateway');

  try {
    await ensureMoltbotGateway(sandbox, c.env);
  } catch (error) {
    console.error('[LINE] Failed to start gateway:', error);
    return c.json({ error: 'Gateway not available' }, 503);
  }

  const url = new URL(c.req.url);
  url.pathname = '/webhook/line';

  // --- 修正開始 ---
  const method = c.req.method;
  const isGetOrHead = method === 'GET' || method === 'HEAD';

  const requestInit = {
    method: method,
    headers: c.req.raw.headers,
    // 只有非 GET/HEAD 請求才傳遞 body
    body: isGetOrHead ? null : await c.req.raw.clone().blob(),
    redirect: 'follow'
  };

  const rewrittenReq = new Request(url.toString(), requestInit);
  // --- 修正結束 ---

  const httpResponse = await sandbox.containerFetch(rewrittenReq, MOLTBOT_PORT);
  return new Response(httpResponse.body, {
    status: httpResponse.status,
    statusText: httpResponse.statusText,
    headers: httpResponse.headers,
  });
});

export { publicRoutes };
