import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT } from '../config';
import { findExistingMoltbotProcess } from '../gateway';
import { uploadMediaToR2, parseMediaPaths } from '../gateway/media';

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


// OpenAI-compatible API proxy - /v1/*
const API_PORT = 18789;

// /v1/chat/completions - 特殊處理，支援圖片上傳到 R2 + session key 管理
// 串流模式直接 pass-through，非串流才處理 media

publicRoutes.all('/v1/chat/completions', async (c) => {
  const sandbox = c.get('sandbox');
  const { ensureMoltbotGateway } = await import('../gateway');

  try {
    await ensureMoltbotGateway(sandbox, c.env);
  } catch (error) {
    console.error('[API] Failed to start gateway:', error);
    return c.json({ error: 'Gateway not available' }, 503);
  }

  const url = new URL(c.req.url);
  const method = c.req.method;
  const isGetOrHead = method === 'GET' || method === 'HEAD';

  // === Session Key 處理 ===
  let sessionKey = c.req.header('x-clawdbot-session-key') || '';
  let isStream = false;
  let requestBody: Blob | null = null;
  let agentId = 'main'; // 預設 agent

  if (!isGetOrHead) {
    const bodyText = await c.req.text();
    try {
      const parsed = JSON.parse(bodyText);
      isStream = parsed.stream === true;

      // 從 model 提取 agent id (e.g., "clawdbot:kgib" → "kgib")
      if (parsed.model?.startsWith('clawdbot:')) {
        agentId = parsed.model.split(':')[1] || 'main';
      }

      requestBody = new Blob([bodyText], { type: 'application/json' });
    } catch {
      // 解析失敗，當作非串流，保持原 body
      requestBody = new Blob([bodyText], { type: 'application/json' });
    }
  }

  // 如果沒有 session key，生成一個
  if (!sessionKey) {
    sessionKey = `agent:${agentId}:api:${crypto.randomUUID()}`;
  }

  // 建立新的 headers，加入 session key
  const headers = new Headers(c.req.raw.headers);
  headers.set('x-clawdbot-session-key', sessionKey);

  const rewrittenReq = new Request(url.toString(), {
    method,
    headers,
    body: requestBody,
  });

  const httpResponse = await sandbox.containerFetch(rewrittenReq, API_PORT);

  // 串流模式：pass-through，但在 header 加 session key
  if (isStream) {
    const responseHeaders = new Headers(httpResponse.headers);
    responseHeaders.set('x-clawdbot-session-key', sessionKey);

    return new Response(httpResponse.body, {
      status: httpResponse.status,
      statusText: httpResponse.statusText,
      headers: responseHeaders,
    });
  }

  // 非串流模式：處理 MEDIA paths
  const responseText = await httpResponse.text();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let data: any;
  try {
    data = JSON.parse(responseText);
  } catch {
    // 不是 JSON，直接返回
    return new Response(responseText, {
      status: httpResponse.status,
      headers: httpResponse.headers,
    });
  }

  // 檢查並處理 MEDIA: paths
  const content = data.choices?.[0]?.message?.content;
  if (content && typeof content === 'string') {
    const mediaPaths = parseMediaPaths(content);

    if (mediaPaths.length > 0) {
      const mediaItems: Array<{ type: string; url: string }> = [];
      let newContent = content;

      for (const filePath of mediaPaths) {
        const result = await uploadMediaToR2(sandbox, c.env, filePath);
        if (result) {
          const ext = filePath.split('.').pop()?.toLowerCase() || '';
          const type = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)
            ? 'image'
            : ['mp3', 'wav', 'mp4'].includes(ext)
              ? 'audio'
              : 'file';

          mediaItems.push({ type, url: result.url });
          newContent = newContent.replace(
            new RegExp(`MEDIA:\\s*${filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n?`),
            ''
          );
        }
      }

      data.choices[0].message.content = newContent.trim();
      if (mediaItems.length > 0) {
        data.choices[0].message.media = mediaItems;
      }
    }
  }

  // ✅ 在回應中加入 session_key
  data.session_key = sessionKey;

  // 設定 response header
  c.header('x-clawdbot-session-key', sessionKey);

  return c.json(data, httpResponse.status as 200);
});

// /v1/* 其他 endpoints - 直接 proxy
publicRoutes.all('/v1/*', async (c) => {
  const sandbox = c.get('sandbox');
  const { ensureMoltbotGateway } = await import('../gateway');
  
  try {
    await ensureMoltbotGateway(sandbox, c.env);
  } catch (error) {
    console.error('[API] Failed to start gateway:', error);
    return c.json({ error: 'Gateway not available' }, 503);
  }

  const url = new URL(c.req.url);
  const method = c.req.method;
  const isGetOrHead = method === 'GET' || method === 'HEAD';
  
  const rewrittenReq = new Request(url.toString(), {
    method,
    headers: c.req.raw.headers,
    body: isGetOrHead ? null : await c.req.raw.clone().blob(),
  });
  
  const httpResponse = await sandbox.containerFetch(rewrittenReq, API_PORT);
  
  return new Response(httpResponse.body, {
    status: httpResponse.status,
    statusText: httpResponse.statusText,
    headers: httpResponse.headers,
  });
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
