// src/gateway/media.ts
import { AwsClient } from 'aws4fetch';
import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';

function getR2Client(env: MoltbotEnv): { client: AwsClient; endpoint: string } | null {
  const accessKeyId = env.R2_ACCESS_KEY_ID;
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY;
  const accountId = env.CF_ACCOUNT_ID;

  if (!accessKeyId || !secretAccessKey || !accountId) {
    console.error('[Media] Missing R2 credentials or CF_ACCOUNT_ID');
    return null;
  }

  return {
    client: new AwsClient({
      accessKeyId,
      secretAccessKey,
      service: 's3',
    }),
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  };
}

/**
 * 從 sandbox 讀取檔案並上傳到 R2
 */
export async function uploadMediaToR2(
  sandbox: Sandbox,
  env: MoltbotEnv,
  filePath: string
): Promise<{ url: string; key: string } | null> {
  const bucket = 'moltbot-data';

  const r2 = getR2Client(env);
  if (!r2) return null;

  try {
    // 從 sandbox 讀取檔案
    const catProc = await sandbox.startProcess(`base64 -w0 "${filePath}"`);
    let attempts = 0;
    while (catProc.status === 'running' && attempts < 30) {
      await new Promise((r) => setTimeout(r, 200));
      attempts++;
    }

    const logs = await catProc.getLogs();
    if (!logs.stdout || catProc.exitCode !== 0) {
      console.error('[Media] Failed to read file:', filePath, logs.stderr);
      return null;
    }

    // Decode base64
    const base64Data = logs.stdout.trim();
    const binaryString = atob(base64Data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    // Content type
    const ext = filePath.split('.').pop()?.toLowerCase() || 'bin';
    const contentTypes: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      mp3: 'audio/mpeg',
      mp4: 'video/mp4',
      wav: 'audio/wav',
      pdf: 'application/pdf',
    };
    const contentType = contentTypes[ext] || 'application/octet-stream';

    // 唯一 key
    const timestamp = Date.now();
    const randomId = Math.random().toString(36).substring(2, 10);
    const key = `media/${timestamp}-${randomId}.${ext}`;

    // 上傳到 R2
    const uploadUrl = `${r2.endpoint}/${bucket}/${key}`;
    const uploadResp = await r2.client.fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: bytes,
    });

    if (!uploadResp.ok) {
      console.error('[Media] Upload failed:', uploadResp.status, await uploadResp.text());
      return null;
    }

    // Presigned URL (1 小時有效)
    const presignedUrl = await generatePresignedUrl(r2.client, r2.endpoint, bucket, key, 3600);

    console.log('[Media] Uploaded to R2:', key);
    return { url: presignedUrl, key };
  } catch (err) {
    console.error('[Media] Upload failed:', err);
    return null;
  }
}

async function generatePresignedUrl(
  client: AwsClient,
  endpoint: string,
  bucket: string,
  key: string,
  expiresIn: number
): Promise<string> {
  const url = new URL(`${endpoint}/${bucket}/${key}`);
  url.searchParams.set('X-Amz-Expires', expiresIn.toString());

  const signed = await client.sign(url.toString(), {
    method: 'GET',
    aws: { signQuery: true },
  });

  return signed.url;
}

/**
 * 解析媒體路徑 - 支援多種格式
 * 1. MEDIA: /path/to/file
 * 2. 檔案位置：`/path/to/file`
 * 3. Output: /path/to/file
 * 4. 任何絕對路徑 + 媒體擴展名
 */
export function parseMediaPaths(content: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  
  // Pattern 1: MEDIA: /path/to/file
  const mediaRegex = /MEDIA:\s*(\S+)/g;
  let match;
  while ((match = mediaRegex.exec(content)) !== null) {
    if (!seen.has(match[1])) {
      paths.push(match[1]);
      seen.add(match[1]);
    }
  }
  
  // Pattern 2: 檔案位置：`/path/to/file` or 檔案位置：/path/to/file
  const zhRegex = /檔案位置[：:]\s*`?([\/~][^\s`]+)`?/g;
  while ((match = zhRegex.exec(content)) !== null) {
    if (!seen.has(match[1])) {
      paths.push(match[1]);
      seen.add(match[1]);
    }
  }
  
  // Pattern 3: Output: /path/to/file
  const outputRegex = /Output:\s*([\/~]\S+)/gi;
  while ((match = outputRegex.exec(content)) !== null) {
    if (!seen.has(match[1])) {
      paths.push(match[1]);
      seen.add(match[1]);
    }
  }
  
  // Pattern 4: Any absolute path with media extension
  const mediaExtensions = /\.(png|jpg|jpeg|gif|webp|mp3|mp4|wav|pdf)$/i;
  const pathRegex = /(\/[\w\-\.\/]+\.(png|jpg|jpeg|gif|webp|mp3|mp4|wav|pdf))/gi;
  while ((match = pathRegex.exec(content)) !== null) {
    if (!seen.has(match[1])) {
      paths.push(match[1]);
      seen.add(match[1]);
    }
  }
  
  return paths;
}
