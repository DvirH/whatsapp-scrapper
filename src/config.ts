import * as path from 'path';
import 'dotenv/config';

// ============================================================================
// Environment Configuration
// ============================================================================

export const MEDIA_DOWNLOAD_TIMEOUT = parseInt(process.env.MEDIA_DOWNLOAD_TIMEOUT || '10000', 10);
export const MEMBER_FETCH_CONCURRENCY = parseInt(process.env.MEMBER_FETCH_CONCURRENCY || '5', 10);
export const MEDIA_DOWNLOAD_CONCURRENCY = parseInt(process.env.MEDIA_DOWNLOAD_CONCURRENCY || '5', 10);
export const HISTORY_SYNC_WAIT_MS = parseInt(process.env.HISTORY_SYNC_WAIT_MS || '3000', 10);

// Auth and scan configuration
export const AUTH_TIMEOUT_MS = parseInt(process.env.AUTH_TIMEOUT_MS || '300000', 10); // Default 5 minutes
export const AUTH_MAX_RETRIES = 3; // Maximum number of authentication attempts
export const INITIAL_SCAN_DAYS = 30; // Days to look back on first scan

// ============================================================================
// Application Configuration
// ============================================================================

export const MAX_GROUPS = Infinity; // Process all groups (set to number to limit)
export const DATA_DIR = path.join(process.cwd(), 'data');

// ============================================================================
// CLI Argument Parsing
// ============================================================================

/**
 * Parse avatar name from CLI arguments or environment variable.
 * Supports: --avatar=NAME, -a NAME, or AVATAR_NAME env var
 */
export function getAvatarName(): string {
    const args = process.argv.slice(2);

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        // Handle --avatar=VALUE format
        if (arg.startsWith('--avatar=')) {
            return arg.split('=')[1];
        }
        // Handle -a VALUE or --avatar VALUE format
        if (arg === '-a' || arg === '--avatar') {
            if (args[i + 1] && !args[i + 1].startsWith('-')) {
                return args[i + 1];
            }
        }
    }

    // Check environment variable
    if (process.env.AVATAR_NAME) {
        return process.env.AVATAR_NAME;
    }

    throw new Error(
        'Avatar name is required. Use --avatar=NAME, -a NAME, or set AVATAR_NAME environment variable.'
    );
}
