import type { Sandbox } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { R2_MOUNT_PATH } from '../config';
import { mountR2Storage } from './r2';
import { waitForProcess } from './utils';

export interface SyncResult {
  success: boolean;
  lastSync?: string;
  error?: string;
  details?: string;
}

/**
 * Check if R2 backup is newer than local data.
 * Returns true if we should restore from R2.
 */
async function shouldRestoreFromR2(sandbox: Sandbox): Promise<boolean> {
  const R2_SYNC_FILE = `${R2_MOUNT_PATH}/.last-sync`;
  const LOCAL_SYNC_FILE = '/root/.clawdbot/.last-sync';

  try {
    // Check if R2 sync timestamp exists
    const r2Check = await sandbox.startProcess(`cat ${R2_SYNC_FILE} 2>/dev/null || echo ""`);
    await waitForProcess(r2Check, 5000);
    const r2Logs = await r2Check.getLogs();
    const r2Time = r2Logs.stdout?.trim();

    if (!r2Time) {
      console.log('[syncFromR2] No R2 sync timestamp found, skipping restore');
      return false;
    }

    // Check if local sync timestamp exists
    const localCheck = await sandbox.startProcess(`cat ${LOCAL_SYNC_FILE} 2>/dev/null || echo ""`);
    await waitForProcess(localCheck, 5000);
    const localLogs = await localCheck.getLogs();
    const localTime = localLogs.stdout?.trim();

    if (!localTime) {
      console.log('[syncFromR2] No local sync timestamp, will restore from R2');
      return true;
    }

    console.log('[syncFromR2] R2 last sync:', r2Time);
    console.log('[syncFromR2] Local last sync:', localTime);

    // Compare timestamps (ISO format can be compared as strings)
    if (r2Time > localTime) {
      console.log('[syncFromR2] R2 backup is newer, will restore');
      return true;
    } else {
      console.log('[syncFromR2] Local data is newer or same, skipping restore');
      return false;
    }
  } catch (err) {
    console.error('[syncFromR2] Error checking timestamps:', err);
    return false;
  }
}

/**
 * Restore moltbot config from R2 backup to container.
 * 
 * This function:
 * 1. Mounts R2 if not already mounted
 * 2. Checks if R2 backup is newer than local data
 * 3. Runs rsync to restore config from R2 (incremental, preserves newer local files)
 * 
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns SyncResult with success status and optional error details
 */
export async function syncFromR2(sandbox: Sandbox, env: MoltbotEnv): Promise<SyncResult> {
  // Check if R2 is configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    return { success: false, error: 'R2 storage is not configured' };
  }

  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { success: false, error: 'Failed to mount R2 storage' };
  }

  // Wait a moment for mount to be fully ready
  await new Promise(r => setTimeout(r, 1000));

  // Check if R2 backup exists and has clawdbot.json
  try {
    const checkProc = await sandbox.startProcess(`test -f ${R2_MOUNT_PATH}/clawdbot/clawdbot.json && echo "ok"`);
    await waitForProcess(checkProc, 5000);
    const checkLogs = await checkProc.getLogs();
    if (!checkLogs.stdout?.includes('ok')) {
      console.log('[syncFromR2] No backup found in R2, skipping restore');
      return { success: true, details: 'No backup found in R2' };
    }
  } catch (err) {
    console.log('[syncFromR2] Error checking R2 backup:', err);
    return { success: false, error: 'Failed to check R2 backup', details: String(err) };
  }

  // Check if we should restore
  const shouldRestore = await shouldRestoreFromR2(sandbox);
  if (!shouldRestore) {
    return { success: true, details: 'Local data is up to date' };
  }

  // Create directories if they don't exist
  await sandbox.startProcess('mkdir -p /root/.clawdbot /root/clawd/skills');

  // Run rsync to restore config from R2 (incremental mode with --update)
  // --update: skip files that are newer on the receiver (preserves local changes)
  // --checksum: use checksum instead of mod-time to determine if files differ
  const restoreCmd = `
    rsync -r --update --checksum --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' --exclude='*.sqlite' --exclude='*.sqlite-journal' ${R2_MOUNT_PATH}/clawdbot/ /root/.clawdbot/ 2>&1 && \
    rsync -r --update --checksum ${R2_MOUNT_PATH}/skills/ /root/clawd/skills/ 2>&1 && \
    cp -f ${R2_MOUNT_PATH}/.last-sync /root/.clawdbot/.last-sync 2>/dev/null || true && \
    echo "RESTORE_COMPLETE"
  `;

  try {
    console.log('[syncFromR2] Starting restore from R2...');
    const proc = await sandbox.startProcess(restoreCmd);
    await waitForProcess(proc, 60000); // 60 second timeout

    const logs = await proc.getLogs();
    console.log('[syncFromR2] Restore output:', logs.stdout?.slice(-500));
    
    if (logs.stdout?.includes('RESTORE_COMPLETE')) {
      // Read the sync timestamp
      const timestampProc = await sandbox.startProcess('cat /root/.clawdbot/.last-sync 2>/dev/null');
      await waitForProcess(timestampProc, 5000);
      const timestampLogs = await timestampProc.getLogs();
      const lastSync = timestampLogs.stdout?.trim();

      console.log('[syncFromR2] Restore completed successfully, lastSync:', lastSync);
      return { success: true, lastSync, details: 'Restored from R2 backup' };
    } else {
      return {
        success: false,
        error: 'Restore may have failed',
        details: logs.stderr || logs.stdout || 'Unknown error',
      };
    }
  } catch (err) {
    return {
      success: false,
      error: 'Restore error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

/**
 * Sync moltbot config from container to R2 for persistence.
 * 
 * This function:
 * 1. Mounts R2 if not already mounted
 * 2. Verifies source has critical files (prevents overwriting good backup with empty data)
 * 3. Runs rsync to copy config to R2
 * 4. Writes a timestamp file for tracking
 * 
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns SyncResult with success status and optional error details
 */
export async function syncToR2(sandbox: Sandbox, env: MoltbotEnv): Promise<SyncResult> {
  // Check if R2 is configured
  if (!env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY || !env.CF_ACCOUNT_ID) {
    return { success: false, error: 'R2 storage is not configured' };
  }

  // Mount R2 if not already mounted
  const mounted = await mountR2Storage(sandbox, env);
  if (!mounted) {
    return { success: false, error: 'Failed to mount R2 storage' };
  }

  // Sanity check: verify source has critical files before syncing
  // This prevents accidentally overwriting a good backup with empty/corrupted data
  try {
    const checkProc = await sandbox.startProcess('test -f /root/.clawdbot/clawdbot.json && echo "ok"');
    await waitForProcess(checkProc, 5000);
    const checkLogs = await checkProc.getLogs();
    if (!checkLogs.stdout?.includes('ok')) {
      return { 
        success: false, 
        error: 'Sync aborted: source missing clawdbot.json',
        details: 'The local config directory is missing critical files. This could indicate corruption or an incomplete setup.',
      };
    }
  } catch (err) {
    return { 
      success: false, 
      error: 'Failed to verify source files',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }

  // Run rsync to backup config to R2
  // Note: Use --no-times because s3fs doesn't support setting timestamps
  const syncCmd = `rsync -r --no-times --delete --exclude='*.lock' --exclude='*.log' --exclude='*.tmp' /root/.clawdbot/ ${R2_MOUNT_PATH}/clawdbot/ && rsync -r --no-times --delete /root/clawd/skills/ ${R2_MOUNT_PATH}/skills/ && date -Iseconds > ${R2_MOUNT_PATH}/.last-sync`;
  
  try {
    const proc = await sandbox.startProcess(syncCmd);
    await waitForProcess(proc, 30000); // 30 second timeout for sync

    // Check for success by reading the timestamp file
    // (process status may not update reliably in sandbox API)
    // Note: backup structure is ${R2_MOUNT_PATH}/clawdbot/ and ${R2_MOUNT_PATH}/skills/
    const timestampProc = await sandbox.startProcess(`cat ${R2_MOUNT_PATH}/.last-sync`);
    await waitForProcess(timestampProc, 5000);
    const timestampLogs = await timestampProc.getLogs();
    const lastSync = timestampLogs.stdout?.trim();
    
    if (lastSync && lastSync.match(/^\d{4}-\d{2}-\d{2}/)) {
      return { success: true, lastSync };
    } else {
      const logs = await proc.getLogs();
      return {
        success: false,
        error: 'Sync failed',
        details: logs.stderr || logs.stdout || 'No timestamp file created',
      };
    }
  } catch (err) {
    return { 
      success: false, 
      error: 'Sync error',
      details: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}
