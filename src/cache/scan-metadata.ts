import * as fs from 'fs';
import * as path from 'path';
import { ScanMetadata } from '../types';
import { ensureDir, getISOTimestamp } from '../utils';
import logger from '../logger';

/**
 * Get the path to the scan metadata file for an avatar.
 */
export function getScanMetadataPath(avatarPath: string): string {
    return path.join(avatarPath, 'scan_metadata.json');
}

/**
 * Load scan metadata from file, or create a new one if it doesn't exist.
 */
export function loadScanMetadata(avatarPath: string): ScanMetadata {
    const metadataPath = getScanMetadataPath(avatarPath);
    if (fs.existsSync(metadataPath)) {
        try {
            const data = fs.readFileSync(metadataPath, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            logger.warn('Could not load scan metadata, creating new one');
        }
    }
    return {
        version: '1.0',
        lastUpdated: getISOTimestamp(),
        groups: {}
    };
}

/**
 * Save scan metadata to file.
 */
export function saveScanMetadata(avatarPath: string, metadata: ScanMetadata): void {
    const metadataPath = getScanMetadataPath(avatarPath);
    metadata.lastUpdated = getISOTimestamp();
    ensureDir(avatarPath);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 4));
}

/**
 * Check if this is the first scan for a group.
 */
export function isFirstRunForGroup(metadata: ScanMetadata, groupId: string): boolean {
    return !metadata.groups[groupId];
}

/**
 * Get the timestamp of the last message processed for a group.
 */
export function getLastMessageTimestamp(metadata: ScanMetadata, groupId: string): number | null {
    const groupInfo = metadata.groups[groupId];
    return groupInfo?.lastMessageTimestamp ?? null;
}
