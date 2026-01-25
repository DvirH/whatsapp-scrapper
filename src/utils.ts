import * as fs from 'fs';
import { MessageMedia } from 'whatsapp-web.js';

// ============================================================================
// File & Path Utilities
// ============================================================================

/**
 * Sanitize a string for use as a file/folder name.
 * Removes invalid characters and limits length.
 */
export function sanitizeFileName(name: string): string {
    return name
        .replace(/[<>:"/\\|?*\x00-\x1f\u200B-\u200D\uFEFF]/g, '') // Remove invalid chars and zero-width chars
        .replace(/[^\w\u0590-\u05FF\u0600-\u06FF\u4E00-\u9FFF.-]/g, '-') // Replace other special chars with dash (keep Hebrew, Arabic, Chinese, alphanumeric)
        .replace(/-+/g, '-') // Collapse multiple dashes
        .replace(/^-|-$/g, '') // Trim leading/trailing dashes
        .substring(0, 100) || 'unnamed';
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export function ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * Extract the ID number from a WhatsApp ID string.
 * Example: "1234567890@c.us" -> "1234567890"
 */
export function extractIdNumber(id: string): string {
    return id.split('@')[0];
}

// ============================================================================
// Timestamp Utilities
// ============================================================================

/**
 * Get current timestamp in ISO format with colons replaced by dashes.
 */
export function getCurrentTimestamp(): string {
    const now = new Date();
    return now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
}

/**
 * Get current timestamp in standard ISO format.
 */
export function getISOTimestamp(): string {
    return new Date().toISOString();
}

/**
 * Returns UTC datetime string for use in file/folder paths.
 * Format: YYYY-MM-DD_HH-mm (no colons for Windows compatibility)
 */
export function getUTCDatetimeForPath(): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    const hour = String(now.getUTCHours()).padStart(2, '0');
    const minute = String(now.getUTCMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}_${hour}-${minute}`;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 */
export function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

// ============================================================================
// Media Utilities
// ============================================================================

/**
 * Save media data to a file.
 */
export async function saveMedia(media: MessageMedia, filePath: string): Promise<void> {
    const buffer = Buffer.from(media.data, 'base64');
    fs.writeFileSync(filePath, buffer);
}

/**
 * Get file extension from MIME type.
 */
export function getMediaExtension(mimetype: string): string {
    const mimeToExt: Record<string, string> = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/gif': 'gif',
        'image/webp': 'webp',
        'video/mp4': 'mp4',
        'video/3gpp': '3gp',
        'audio/ogg': 'ogg',
        'audio/mpeg': 'mp3',
        'audio/opus': 'opus',
        'application/pdf': 'pdf',
        'application/vnd.ms-powerpoint': 'ppt',
        'application/msword': 'doc',
    };
    return mimeToExt[mimetype] || mimetype.split('/')[1] || 'bin';
}

// ============================================================================
// Async Utilities
// ============================================================================

/**
 * Wrap a promise with a timeout.
 * Rejects with the provided error message if the timeout is exceeded.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
    const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(errorMessage)), ms);
    });
    return Promise.race([promise, timeout]);
}

// ============================================================================
// Error Utilities
// ============================================================================

/**
 * Serialize an error for logging (extracts message and stack).
 */
export function serializeError(error: unknown): { message: string; stack?: string } {
    if (error instanceof Error) {
        return { message: error.message, stack: error.stack };
    }
    return { message: String(error) };
}
