import * as fs from 'fs';
import * as path from 'path';
import { UserImageCache } from '../types';
import { ensureDir, getISOTimestamp, getUTCDatetimeForPath } from '../utils';
import logger from '../logger';

/**
 * Get the path to the user image cache file for an avatar.
 */
export function getUserImageCachePath(avatarPath: string): string {
    return path.join(avatarPath, 'user_image_cache.json');
}

/**
 * Load user image cache from file, or create a new one if it doesn't exist.
 */
export function loadUserImageCache(avatarPath: string): UserImageCache {
    const cachePath = getUserImageCachePath(avatarPath);
    if (fs.existsSync(cachePath)) {
        try {
            const data = fs.readFileSync(cachePath, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            logger.warn('Could not load user image cache, creating new one');
        }
    }
    return {
        version: '1.0',
        lastUpdated: getISOTimestamp(),
        images: {}
    };
}

/**
 * Save user image cache to file.
 */
export function saveUserImageCache(avatarPath: string, cache: UserImageCache): void {
    const cachePath = getUserImageCachePath(avatarPath);
    cache.lastUpdated = getISOTimestamp();
    ensureDir(avatarPath);
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 4));
}

/**
 * Checks if a user's profile picture is already cached and the file exists.
 * Returns the cached path if found, null otherwise.
 */
export function userImageExists(cache: UserImageCache, userId: string): string | null {
    const entry = cache.images[userId];
    if (entry && fs.existsSync(entry.imagePath)) {
        return entry.imagePath;
    }
    return null;
}

/**
 * Generates a filename for a user's profile picture with timestamp.
 * Format: {userId}_{datetime_UTC}.{ext}
 */
export function generateUserImageFilename(userId: string, ext: string): string {
    const datetime = getUTCDatetimeForPath();
    return `${userId}_${datetime}.${ext}`;
}
