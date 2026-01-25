import * as fs from 'fs';
import * as path from 'path';
import { Client } from 'whatsapp-web.js';
import { LidMappingCache } from '../types';
import { ensureDir, getISOTimestamp } from '../utils';
import logger from '../logger';

/**
 * Detects if an ID is a LID (internal WhatsApp identifier) rather than a phone number.
 * LIDs have formats like:
 * - "198908542234665" (numeric, typically 15+ digits)
 * - "216848670933050:26" (numeric with colon suffix)
 * - "1246127775785@lid" (with @lid suffix)
 */
export function isLid(id: string): boolean {
    if (!id) return false;

    // Check for @lid suffix
    if (id.includes('@lid')) return true;

    // Check for colon format (LID:device)
    if (id.includes(':') && !id.includes('@')) return true;

    // Extract numeric part
    const numericPart = id.split('@')[0].replace(/:/g, '');

    // LIDs are typically very long numbers (15+ digits) without country code patterns
    if (numericPart.length > 14 && /^\d+$/.test(numericPart)) {
        return true;
    }

    return false;
}

/**
 * Loads existing LID mapping cache from file.
 */
export function loadLidMappingCache(avatarPath: string): LidMappingCache {
    const cachePath = path.join(avatarPath, 'lid_mapping_cache.json');

    if (fs.existsSync(cachePath)) {
        try {
            const data = fs.readFileSync(cachePath, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            logger.warn('  - Could not load LID cache, creating new one');
        }
    }

    return {
        version: '1.0',
        lastUpdated: getISOTimestamp(),
        mappings: {}
    };
}

/**
 * Saves LID mapping cache to file.
 */
export function saveLidMappingCache(avatarPath: string, cache: LidMappingCache): void {
    const cachePath = path.join(avatarPath, 'lid_mapping_cache.json');
    cache.lastUpdated = getISOTimestamp();
    ensureDir(avatarPath);
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 4));
}

/**
 * Attempts to resolve a LID to a phone number.
 */
export async function resolveLid(
    client: Client,
    lid: string,
    cache: LidMappingCache
): Promise<string | null> {
    // Normalize LID format
    const normalizedLid = lid.replace('@lid', '').split(':')[0];

    // Check cache first
    if (cache.mappings[normalizedLid]) {
        return cache.mappings[normalizedLid].phoneNumber;
    }

    try {
        // Try to get contact by the LID
        const contact = await client.getContactById(`${normalizedLid}@c.us`);
        if (contact && contact.number) {
            cache.mappings[normalizedLid] = {
                lid: normalizedLid,
                phoneNumber: contact.number,
                resolvedAt: getISOTimestamp(),
                source: 'contact_lookup'
            };
            return contact.number;
        }
    } catch (error) {
        // Contact lookup failed
    }

    return null;
}

/**
 * Builds LID mapping cache by scanning all contacts using getContactLidAndPhone.
 * The cache maps LID -> phone number for resolving internal WhatsApp identifiers.
 */
export async function buildLidMappingFromContacts(
    client: Client,
    avatarPath: string
): Promise<LidMappingCache> {
    const cache = loadLidMappingCache(avatarPath);

    logger.info('Building LID mapping cache from contacts...');

    try {
        const contacts = await client.getContacts();

        // Collect user IDs for batch lookup
        const userIds: string[] = [];
        for (const contact of contacts) {
            if (contact.id._serialized && contact.id._serialized.endsWith('@c.us')) {
                userIds.push(contact.id._serialized);
            }
        }

        logger.info(`  - Found ${userIds.length} contacts to lookup`);

        if (userIds.length > 0) {
            // Use getContactLidAndPhone to get LID -> phone number mappings
            const lidPhoneMappings = await (client as any).getContactLidAndPhone(userIds);
            let newMappings = 0;

            for (const mapping of lidPhoneMappings) {
                // mapping has { lid: string, pn: string }
                if (mapping.lid && mapping.pn && !cache.mappings[mapping.lid]) {
                    cache.mappings[mapping.lid] = {
                        lid: mapping.lid,
                        phoneNumber: mapping.pn,
                        resolvedAt: getISOTimestamp(),
                        source: 'contact_lookup'
                    };
                    newMappings++;
                }
            }

            saveLidMappingCache(avatarPath, cache);
            logger.info(`  - LID cache: ${Object.keys(cache.mappings).length} total mappings (${newMappings} new)`);
        }

    } catch (error) {
        logger.error(`  - Error building LID cache: ${error}`);
    }

    return cache;
}
