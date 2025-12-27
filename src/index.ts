import { Client, LocalAuth, GroupChat, Message, Contact, MessageMedia } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';
import pLimit from 'p-limit';
import logger from './logger';

// Environment configuration
const MEDIA_DOWNLOAD_TIMEOUT = parseInt(process.env.MEDIA_DOWNLOAD_TIMEOUT || '10000', 10);
const MEMBER_FETCH_CONCURRENCY = parseInt(process.env.MEMBER_FETCH_CONCURRENCY || '5', 10);
const HISTORY_SYNC_WAIT_MS = parseInt(process.env.HISTORY_SYNC_WAIT_MS || '3000', 10);

// Auth and scan configuration
const AUTH_TIMEOUT_MS = parseInt(process.env.AUTH_TIMEOUT_MS || '300000', 10); // Default 5 minutes
const AUTH_MAX_RETRIES = 3; // Maximum number of authentication attempts
const INITIAL_SCAN_DAYS = 30; // Days to look back on first scan

// ============================================================================
// Type Definitions
// ============================================================================

interface Sender {
    id: number | string;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
}

interface ChatMessage {
    id: string;
    timestamp: number;
    type: string;
    text: string;
    sender: Sender;
    has_media: boolean;
    media_path: string | null;
    isFailedToDownload: boolean;
    isGif: boolean;
    isForwarded: boolean;
    links: Array<{ link: string; isSuspicious: boolean }>;
    location: { latitude: number; longitude: number; description?: string } | null;
    mentionedIds: string[];
    vCardContacts: ContactInfo[];
    reactions: Array<{ emoji: string; sender: Sender }>;
    isReply: boolean;
    replyInfo: ReplyInfo | null;
    isEphemeral: boolean;
    isViewOnce: boolean;
    originalAuthorId: string;
    resolvedAuthorId: string | null;
    metadata: WhatsAppMetadata;
    isEdited: boolean;
}

interface GroupInfo {
    id: string;
    name: string;
    description: string;
    profile_picture_path: string | null;
    memberCount: number;
    adminCount: number;
    admin: Sender | null;
    createdAt: string;
    creator: string;
    timestamp: string;
    groupType: string;
    groupUrl: string | null;
    platform: string;
    securitySettings: GroupSecuritySettings;
}

interface GroupMember {
    id: string;
    phoneNumber: string;
    user: string | null;
    name: string;
    role: string;
    isAdmin: boolean;
    isSuperAdmin: boolean;
    profile_picture_path: string | null;
    timestamp: string;
    about: string | null;
}

interface GroupSecuritySettings {
    membershipApprovalRequired: boolean;
    messagesAdminsOnly: boolean;
    infoEditAdminsOnly: boolean;
    addMembersAdminsOnly: boolean;
}

interface ReplyInfo {
    quotedMessageId: string;
    quotedText: string | null;
    quotedSenderId: string | null;
}

interface WhatsAppMetadata {
    type: string;
    duration: number | null;
    groupMentions: Array<{
        groupSubject: string;
        groupJid: { server: string; user: string; _serialized: string };
    }>;
}

interface ContactInfo {
    name: string;
    number: string;
    vcard: string;
}

interface PollVote {
    pollId: string;
    pollTimestamp: number;
    voterId: string;
    voterPhone: string | null;
    voterName: string | null;
    selectedOptions: string[];
    timestamp: number;
}

interface ErrorLogEntry {
    timestamp: string;
    messageId: string;
    errorType: 'media_download' | 'poll_votes' | 'vcard_extraction' | 'reaction' | 'other';
    error: string;
    explanation: string;
    context: {
        messageType?: string;
        messageTimestamp?: number;
        isOldMessage?: boolean;
        isGif?: boolean;
        isViewOnce?: boolean;
    };
}

interface MembershipEvent {
    id: string;
    timestamp: number;
    eventType: 'add' | 'remove' | 'leave' | 'invite' | 'create' | 'unknown';
    affectedUsers: string[];
    performedBy: string | null;
    body: string;
}

interface LidMapping {
    lid: string;
    phoneNumber: string;
    resolvedAt: string;
    source: 'contact_lookup' | 'message_context' | 'manual';
}

interface LidMappingCache {
    version: string;
    lastUpdated: string;
    mappings: Record<string, LidMapping>;
}

interface ScanMetadata {
    version: string;
    lastUpdated: string;
    groups: Record<string, GroupScanInfo>;
}

interface GroupScanInfo {
    groupId: string;
    groupName: string;
    lastScanTimestamp: string;
    lastMessageTimestamp: number;
    scanCount: number;
}

interface UserImageCache {
    version: string;
    lastUpdated: string;
    images: Record<string, UserImageEntry>;
}

interface UserImageEntry {
    userId: string;
    imagePath: string;
    downloadedAt: string;
}

interface PastMember {
    id: string;
    phoneNumber: string | null;
    name: string | null;
    leftAt: string;
    leftReason: 'leave' | 'remove' | 'unknown';
    removedBy: string | null;
}

interface InitializationAttempt {
    timestamp: string;
    attempt: number;
    success: boolean;
    reason?: string;
    errorDetails?: string;
}

interface InitializationsLog {
    lastUpdated: string;
    attempts: InitializationAttempt[];
}

// ============================================================================
// Configuration
// ============================================================================

const AVATAR_NAME = 'S62'; // Change this per user/session
const MAX_GROUPS = Infinity; // Only process first 2 groups
const DATA_DIR = path.join(process.cwd(), 'data');

// ============================================================================
// Utility Functions
// ============================================================================

function sanitizeFileName(name: string): string {
    return name
        .replace(/[<>:"/\\|?*\x00-\x1f\u200B-\u200D\uFEFF]/g, '') // Remove invalid chars and zero-width chars
        .replace(/[^\w\u0590-\u05FF\u0600-\u06FF\u4E00-\u9FFF.-]/g, '-') // Replace other special chars with dash (keep Hebrew, Arabic, Chinese, alphanumeric)
        .replace(/-+/g, '-') // Collapse multiple dashes
        .replace(/^-|-$/g, '') // Trim leading/trailing dashes
        .substring(0, 100) || 'unnamed';
}

function getCurrentTimestamp(): string {
    const now = new Date();
    return now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
}

function getISOTimestamp(): string {
    return new Date().toISOString();
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

function ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function extractIdNumber(id: string): string {
    // WhatsApp IDs are like "1234567890@c.us" or "1234567890-1234567890@g.us"
    return id.split('@')[0];
}

async function saveMedia(media: MessageMedia, filePath: string): Promise<void> {
    const buffer = Buffer.from(media.data, 'base64');
    fs.writeFileSync(filePath, buffer);
}

function getMediaExtension(mimetype: string): string {
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

function withTimeout<T>(promise: Promise<T>, ms: number, errorMessage: string): Promise<T> {
    const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error(errorMessage)), ms);
    });
    return Promise.race([promise, timeout]);
}

/**
 * Returns UTC datetime string for use in file/folder paths.
 * Format: YYYY-MM-DD_HH-mm (no colons for Windows compatibility)
 */
function getUTCDatetimeForPath(): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    const hour = String(now.getUTCHours()).padStart(2, '0');
    const minute = String(now.getUTCMinutes()).padStart(2, '0');
    return `${year}-${month}-${day}_${hour}-${minute}`;
}

// ============================================================================
// Scan Metadata Functions
// ============================================================================

function getScanMetadataPath(avatarPath: string): string {
    return path.join(avatarPath, 'scan_metadata.json');
}

function loadScanMetadata(avatarPath: string): ScanMetadata {
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

function saveScanMetadata(avatarPath: string, metadata: ScanMetadata): void {
    const metadataPath = getScanMetadataPath(avatarPath);
    metadata.lastUpdated = getISOTimestamp();
    ensureDir(avatarPath);
    fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 4));
}

function isFirstRunForGroup(metadata: ScanMetadata, groupId: string): boolean {
    return !metadata.groups[groupId];
}

function getLastMessageTimestamp(metadata: ScanMetadata, groupId: string): number | null {
    const groupInfo = metadata.groups[groupId];
    return groupInfo?.lastMessageTimestamp ?? null;
}

// ============================================================================
// User Image Cache Functions
// ============================================================================

function getUserImageCachePath(avatarPath: string): string {
    return path.join(avatarPath, 'user_image_cache.json');
}

function loadUserImageCache(avatarPath: string): UserImageCache {
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

function saveUserImageCache(avatarPath: string, cache: UserImageCache): void {
    const cachePath = getUserImageCachePath(avatarPath);
    cache.lastUpdated = getISOTimestamp();
    ensureDir(avatarPath);
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 4));
}

/**
 * Checks if a user's profile picture is already cached and the file exists.
 * Returns the cached path if found, null otherwise.
 */
function userImageExists(cache: UserImageCache, userId: string): string | null {
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
function generateUserImageFilename(userId: string, ext: string): string {
    const datetime = getUTCDatetimeForPath();
    return `${userId}_${datetime}.${ext}`;
}

// ============================================================================
// Past Members Functions
// ============================================================================

/**
 * Aggregates past members from membership events.
 * Identifies users who left or were removed and are not current members.
 */
function aggregatePastMembers(
    membershipEvents: MembershipEvent[],
    currentMembers: GroupMember[]
): PastMember[] {
    const currentMemberIds = new Set(currentMembers.map(m => m.id));
    const pastMembersMap = new Map<string, PastMember>();

    // Process events in chronological order
    const sortedEvents = [...membershipEvents].sort((a, b) => a.timestamp - b.timestamp);

    for (const event of sortedEvents) {
        if (event.eventType === 'leave' || event.eventType === 'remove') {
            for (const userId of event.affectedUsers) {
                // Only track if not a current member
                if (!currentMemberIds.has(userId)) {
                    pastMembersMap.set(userId, {
                        id: userId,
                        phoneNumber: userId,
                        name: null,
                        leftAt: new Date(event.timestamp * 1000).toISOString(),
                        leftReason: event.eventType,
                        removedBy: event.performedBy
                    });
                }
            }
        }
    }

    return Array.from(pastMembersMap.values());
}

// ============================================================================
// LID Resolution Functions
// ============================================================================

/**
 * Detects if an ID is a LID (internal WhatsApp identifier) rather than a phone number.
 * LIDs have formats like:
 * - "198908542234665" (numeric, typically 15+ digits)
 * - "216848670933050:26" (numeric with colon suffix)
 * - "1246127775785@lid" (with @lid suffix)
 */
function isLid(id: string): boolean {
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
function loadLidMappingCache(avatarPath: string): LidMappingCache {
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
function saveLidMappingCache(avatarPath: string, cache: LidMappingCache): void {
    const cachePath = path.join(avatarPath, 'lid_mapping_cache.json');
    cache.lastUpdated = getISOTimestamp();
    ensureDir(avatarPath);
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 4));
}

/**
 * Attempts to resolve a LID to a phone number.
 */
async function resolveLid(
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
async function buildLidMappingFromContacts(
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

// ============================================================================
// Membership Events Functions
// ============================================================================

/**
 * Extracts membership events (join/leave/removed) from WhatsApp system messages.
 * WhatsApp sends notification messages for group membership changes.
 */
function extractMembershipEvents(messages: Message[], lidCache: LidMappingCache): MembershipEvent[] {
    const events: MembershipEvent[] = [];

    for (const msg of messages) {
        // Check for notification/system messages
        const msgType = msg.type as string;
        if (msgType !== 'notification' && msgType !== 'gp2' && msgType !== 'e2e_notification') {
            continue;
        }

        // Get the subtype which indicates the event type
        const rawData = (msg as any).rawData || (msg as any)._data || {};
        const subtype = rawData.subtype || (msg as any).subtype || '';

        // Map subtypes to event types
        let eventType: MembershipEvent['eventType'] = 'unknown';
        if (subtype === 'add' || subtype === 'invite') {
            eventType = subtype;
        } else if (subtype === 'remove') {
            eventType = 'remove';
        } else if (subtype === 'leave') {
            eventType = 'leave';
        } else if (subtype === 'create') {
            eventType = 'create';
        }

        // Skip unknown events
        if (eventType === 'unknown' && !msg.body) {
            continue;
        }

        // Extract affected users from recipients or body
        const affectedUsers: string[] = [];
        if (rawData.recipients && Array.isArray(rawData.recipients)) {
            for (const recipient of rawData.recipients) {
                // Handle both string IDs and object IDs
                const recipientId = typeof recipient === 'string'
                    ? recipient
                    : recipient?._serialized || recipient?.id?._serialized;
                if (recipientId) {
                    const idNumber = extractIdNumber(recipientId);
                    // Resolve LID to phone number if possible
                    if (isLid(idNumber) && lidCache.mappings[idNumber]) {
                        affectedUsers.push(lidCache.mappings[idNumber].phoneNumber);
                    } else {
                        affectedUsers.push(idNumber);
                    }
                }
            }
        }

        // Get who performed the action (author)
        let performedBy: string | null = null;
        if (msg.author) {
            const authorId = extractIdNumber(msg.author);
            // Resolve LID to phone number if possible
            if (isLid(authorId) && lidCache.mappings[authorId]) {
                performedBy = lidCache.mappings[authorId].phoneNumber;
            } else {
                performedBy = authorId;
            }
        }

        events.push({
            id: msg.id.id,
            timestamp: msg.timestamp,
            eventType: eventType,
            affectedUsers: affectedUsers,
            performedBy: performedBy,
            body: msg.body || ''
        });
    }

    return events;
}

/**
 * Collects poll votes from poll messages.
 */
async function collectPollVotes(
    messages: Message[],
    lidCache: LidMappingCache
): Promise<{ votes: PollVote[]; errors: ErrorLogEntry[] }> {
    const pollVotes: PollVote[] = [];
    const errors: ErrorLogEntry[] = [];

    for (const msg of messages) {
        if (msg.type !== 'poll_creation') continue;

        try {
            const votes = await (msg as any).getPollVotes();
            if (votes && Array.isArray(votes)) {
                for (const vote of votes) {
                    let voterPhone: string | null = null;
                    let voterName: string | null = null;
                    let voterId: string = 'unknown';

                    // Handle different voter formats (could be string, object, or undefined)
                    // Note: wwebjs docs say voter is a string, but keep fallbacks for safety
                    const voterRaw = vote.voter;
                    if (voterRaw) {
                        if (typeof voterRaw === 'string') {
                            voterId = extractIdNumber(voterRaw);
                        } else if ((voterRaw as any)._serialized) {
                            voterId = extractIdNumber((voterRaw as any)._serialized);
                        } else if ((voterRaw as any).id?._serialized) {
                            voterId = extractIdNumber((voterRaw as any).id._serialized);
                        }

                        // Try to get voter contact info
                        try {
                            const senderId = typeof voterRaw === 'string'
                                ? voterRaw
                                : ((voterRaw as any)._serialized || (voterRaw as any).id?._serialized);
                            if (senderId) {
                                const contact = await client.getContactById(senderId);
                                voterPhone = contact.number || null;
                                voterName = contact.pushname || contact.name || null;
                            }
                        } catch (e) {
                            // Contact lookup failed
                        }

                        // Resolve LID if needed (ensure key ends with @lid)
                        if (isLid(voterId)) {
                            const lidKey = voterId.endsWith('@lid') ? voterId : `${voterId}@lid`;
                            if (lidCache.mappings[lidKey]) {
                                voterPhone = lidCache.mappings[lidKey].phoneNumber;
                            }
                        }
                    }

                    pollVotes.push({
                        pollId: msg.id.id,
                        pollTimestamp: msg.timestamp,
                        voterId: voterId,
                        voterPhone: voterPhone,
                        voterName: voterName,
                        selectedOptions: vote.selectedOptions || [],
                        timestamp: vote.timestamp || 0
                    });
                }
            }
        } catch (error) {
            logger.warn(`    - Could not get poll votes for ${msg.id.id}: ${error}`);
            errors.push({
                timestamp: getISOTimestamp(),
                messageId: msg.id.id,
                errorType: 'poll_votes',
                error: String(error),
                explanation: 'Failed to retrieve poll votes - poll may have no votes or API limitation',
                context: {
                    messageType: msg.type,
                    messageTimestamp: msg.timestamp
                }
            });
        }
    }

    return { votes: pollVotes, errors };
}

// ============================================================================
// WhatsApp Client Setup
// ============================================================================

let client: Client;
let isShuttingDown = false;
let isClientReady = false;
let authAttempts = 0;

function serializeError(error: unknown): { message: string; stack?: string } {
    if (error instanceof Error) {
        return { message: error.message, stack: error.stack };
    }
    return { message: String(error) };
}

async function gracefulShutdown(exitCode: number = 0, reason: string = 'unknown'): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`Shutting down: ${reason}`);

    if (isClientReady) {
        try {
            await client.destroy();
            logger.info('Client destroyed successfully');
        } catch (error) {
            logger.error({ err: serializeError(error) }, 'Error destroying client');
        }
    }

    process.exit(exitCode);
}

// Handle Ctrl+C
process.on('SIGINT', () => {
    gracefulShutdown(0, 'SIGINT');
});

// Handle kill signal
process.on('SIGTERM', () => {
    gracefulShutdown(0, 'SIGTERM');
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.fatal({ err: serializeError(error) }, 'Uncaught exception');
    gracefulShutdown(1, 'uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: serializeError(reason) }, 'Unhandled rejection');
    gracefulShutdown(1, 'unhandledRejection');
});

// ============================================================================
// Authentication with Retry
// ============================================================================

/**
 * Logs an initialization attempt (success or failure) to initializations.json.
 */
function logInitializationAttempt(avatarPath: string, success: boolean, reason?: string): void {
    const logPath = path.join(avatarPath, 'initializations.json');
    ensureDir(avatarPath);

    // Load existing log or create new one
    let log: InitializationsLog;
    if (fs.existsSync(logPath)) {
        try {
            log = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
        } catch {
            log = { lastUpdated: getISOTimestamp(), attempts: [] };
        }
    } else {
        log = { lastUpdated: getISOTimestamp(), attempts: [] };
    }

    // Add new attempt
    const attempt: InitializationAttempt = {
        timestamp: getISOTimestamp(),
        attempt: authAttempts,
        success: success
    };
    if (reason) {
        attempt.reason = reason;
        attempt.errorDetails = reason;
    }

    log.attempts.push(attempt);
    log.lastUpdated = getISOTimestamp();

    fs.writeFileSync(logPath, JSON.stringify(log, null, 4));

    if (success) {
        logger.info(`Initialization succeeded on attempt ${authAttempts}. Logged to ${logPath}`);
    } else {
        logger.warn(`Initialization attempt ${authAttempts} failed: ${reason}. Logged to ${logPath}`);
    }
}

/**
 * Sets up event handlers on the client.
 */
function setupEventHandlers(clientInstance: Client): void {
    clientInstance.on('qr', (qr: string) => {
        logger.info('\n========================================');
        logger.info('Scan this QR code with WhatsApp:');
        logger.info('========================================\n');
        qrcode.generate(qr, { small: true });
    });

    clientInstance.on('authenticated', () => {
        logger.info('Authenticated successfully!');
    });

    clientInstance.on('disconnected', (reason: string) => {
        logger.warn(`Client disconnected: ${reason}`);
    });

    clientInstance.on('ready', async () => {
        isClientReady = true;
        logger.info('\n========================================');
        logger.info('WhatsApp Client is ready!');
        logger.info('========================================\n');

        try {
            await processGroups();
            logger.info('\nData collection complete!');
            await gracefulShutdown(0, 'complete');
        } catch (error) {
            logger.error({ err: serializeError(error) }, 'Error processing groups');
            await gracefulShutdown(1, 'processing_error');
        }
    });
}

/**
 * Initializes the WhatsApp client with retry logic.
 * Waits max 60 seconds for authentication, retries up to 3 times.
 */
async function initializeWithRetry(): Promise<boolean> {
    const avatarPath = path.join(DATA_DIR, AVATAR_NAME);
    ensureDir(avatarPath);

    for (let attempt = 1; attempt <= AUTH_MAX_RETRIES; attempt++) {
        authAttempts = attempt;
        logger.info(`\nAuthentication attempt ${attempt}/${AUTH_MAX_RETRIES}`);

        // Reset state for new attempt
        isClientReady = false;
        isShuttingDown = false;

        // Create new client instance
        client = new Client({
            authStrategy: new LocalAuth({
                clientId: AVATAR_NAME,
                dataPath: './.wwebjs_auth'
            }),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });

        // Setup event handlers
        setupEventHandlers(client);

        try {
            // Create promise that resolves when client is ready or rejects on auth failure
            const authPromise = new Promise<void>((resolve, reject) => {
                client.on('ready', () => resolve());
                client.on('auth_failure', (msg: string) => reject(new Error(`Auth failed: ${msg}`)));
            });

            // Start initialization
            client.initialize();
            logger.info(`Waiting up to ${AUTH_TIMEOUT_MS / 60000} minutes for authentication...`);

            // Wait for ready with timeout
            await withTimeout(
                authPromise,
                AUTH_TIMEOUT_MS,
                `Authentication timeout after ${AUTH_TIMEOUT_MS / 1000} seconds`
            );

            // If we reach here, authentication succeeded
            logger.info('Client initialized successfully!');
            logInitializationAttempt(avatarPath, true);
            return true;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logInitializationAttempt(avatarPath, false, errorMessage);

            // Cleanup before retry
            try {
                await client.destroy();
            } catch (e) {
                // Ignore cleanup errors
            }

            if (attempt === AUTH_MAX_RETRIES) {
                // All retries exhausted
                logger.error(`Authentication failed after ${authAttempts} attempts`);
                return false;
            }

            // Wait 2 seconds before retry
            logger.info('Waiting 2 seconds before retry...');
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    return false;
}

// ============================================================================
// Data Collection Functions
// ============================================================================

async function processGroups(): Promise<void> {
    const scanTimestamp = getUTCDatetimeForPath();
    const avatarPath = path.join(DATA_DIR, AVATAR_NAME);

    // Load scan metadata and user image cache
    const scanMetadata = loadScanMetadata(avatarPath);
    let userImageCache = loadUserImageCache(avatarPath);

    // Build LID mapping cache from contacts
    const lidCache = await buildLidMappingFromContacts(client, avatarPath);

    logger.info('Fetching chats...');
    const chatsStartTime = Date.now();
    const chats = await client.getChats();
    logger.info(`Fetching chats... done. Took ${formatDuration(Date.now() - chatsStartTime)}`);

    // Filter to group chats only
    const groupChats = chats.filter(chat => chat.isGroup) as GroupChat[];
    logger.info(`Found ${groupChats.length} group chats`);

    // Process only first MAX_GROUPS groups
    const groupsToProcess = groupChats.slice(0, MAX_GROUPS);
    logger.info(`Processing ${groupsToProcess.length} groups...\n`);

    for (let i = 0; i < groupsToProcess.length; i++) {
        const group = groupsToProcess[i];
        logger.info(`\n[${i + 1}/${groupsToProcess.length}] Processing group: ${group.name}`);

        const groupId = extractIdNumber(group.id._serialized);
        const groupDirName = `${sanitizeFileName(group.name)}_${groupId}`;

        // New directory structure: avatar/group/{media,scan_timestamp/}
        const groupBasePath = path.join(avatarPath, groupDirName);
        const groupMediaPath = path.join(groupBasePath, 'media');
        const usersMediaPath = path.join(groupMediaPath, 'users');
        const scanPath = path.join(groupBasePath, scanTimestamp);
        const scanMediaPath = path.join(scanPath, 'media');

        try {
            ensureDir(groupBasePath);
            ensureDir(groupMediaPath);
            ensureDir(usersMediaPath);
            ensureDir(scanPath);
            ensureDir(scanMediaPath);
        } catch (dirError) {
            logger.error({ error: dirError, path: groupBasePath }, `  Failed to create directories for group ${group.name}`);
            continue;
        }

        try {
            // Collect all data for this group with timing
            logger.info('  - Fetching group info...');
            const groupInfoStart = Date.now();
            const groupInfo = await collectGroupInfo(group, scanPath, scanMediaPath);
            logger.info(`  - Fetching group info... done. Took ${formatDuration(Date.now() - groupInfoStart)}`);

            logger.info('  - Fetching members list...');
            const membersStart = Date.now();
            const membersResult = await collectGroupMembers(group, usersMediaPath, userImageCache);
            const groupMembers = membersResult.members;
            userImageCache = membersResult.updatedCache;
            logger.info(`  - Fetching members list... done. Took ${formatDuration(Date.now() - membersStart)}`);

            logger.info('  - Fetching messages...');
            const messagesStart = Date.now();
            const messages = await collectMessages(group, scanMediaPath, lidCache, scanMetadata, groupId);
            logger.info(`  - Fetching messages... done. Took ${formatDuration(Date.now() - messagesStart)}`);

            // Extract membership events (join/leave/removed) from system messages
            const membershipEvents = extractMembershipEvents(messages.rawMessages, lidCache);

            // Aggregate past members from membership events
            const pastMembers = aggregatePastMembers(membershipEvents, groupMembers);

            // Save all JSON files to scan folder
            fs.writeFileSync(
                path.join(scanPath, 'group_info.json'),
                JSON.stringify(groupInfo, null, 4)
            );
            logger.info('  - Saved group_info.json');

            fs.writeFileSync(
                path.join(scanPath, 'group_members.json'),
                JSON.stringify(groupMembers, null, 4)
            );
            logger.info(`  - Saved group_members.json (${groupMembers.length} members)`);

            fs.writeFileSync(
                path.join(scanPath, 'group_chat.json'),
                JSON.stringify(messages.chatMessages, null, 4)
            );
            logger.info(`  - Saved group_chat.json (${messages.chatMessages.length} messages)`);

            // Save membership events if any were found
            if (membershipEvents.length > 0) {
                fs.writeFileSync(
                    path.join(scanPath, 'membership_events.json'),
                    JSON.stringify(membershipEvents, null, 4)
                );
                logger.info(`  - Saved membership_events.json (${membershipEvents.length} events)`);
            }

            // Save past members if any were found
            if (pastMembers.length > 0) {
                fs.writeFileSync(
                    path.join(scanPath, 'past_members.json'),
                    JSON.stringify(pastMembers, null, 4)
                );
                logger.info(`  - Saved past_members.json (${pastMembers.length} former members inferred)`);
            }

            // Collect and save poll votes
            const pollResult = await collectPollVotes(messages.rawMessages, lidCache);
            if (pollResult.votes.length > 0) {
                fs.writeFileSync(
                    path.join(scanPath, 'group_votes.json'),
                    JSON.stringify(pollResult.votes, null, 4)
                );
                logger.info(`  - Saved group_votes.json (${pollResult.votes.length} votes)`);
            }

            // Save raw messages
            const rawMessagesData = await Promise.all(messages.rawMessages.map(async (msg) => {
                const raw = (msg as any).rawData || (msg as any)._data || {};
                const baseData = {
                    id: msg.id,
                    timestamp: msg.timestamp,
                    type: msg.type,
                    body: msg.body,
                    from: msg.from,
                    to: msg.to,
                    author: msg.author,
                    hasMedia: msg.hasMedia,
                    hasQuotedMsg: msg.hasQuotedMsg,
                    ...raw
                };

                // Add raw poll votes for poll_creation messages
                if (msg.type === 'poll_creation') {
                    try {
                        const rawPollVotes = await (msg as any).getPollVotes();
                        return { ...baseData, rawPollVotes };
                    } catch (e) {
                        return baseData;
                    }
                }

                return baseData;
            }));
            fs.writeFileSync(
                path.join(scanPath, 'raw_messages.json'),
                JSON.stringify(rawMessagesData, null, 4)
            );
            logger.info(`  - Saved raw_messages.json (${rawMessagesData.length} messages)`);

            // Combine and save all errors
            const allErrors: ErrorLogEntry[] = [
                ...messages.errors,
                ...pollResult.errors
            ];
            if (allErrors.length > 0) {
                fs.writeFileSync(
                    path.join(scanPath, 'error_log.json'),
                    JSON.stringify(allErrors, null, 4)
                );
                logger.info(`  - Saved error_log.json (${allErrors.length} errors)`);
            }

            // Update scan metadata for this group
            scanMetadata.groups[groupId] = {
                groupId: groupId,
                groupName: group.name,
                lastScanTimestamp: getISOTimestamp(),
                lastMessageTimestamp: messages.newestTimestamp,
                scanCount: (scanMetadata.groups[groupId]?.scanCount || 0) + 1
            };

        } catch (error) {
            logger.error({ error }, `  Error processing group ${group.name}`);
        }
    }

    // Save updated caches
    saveLidMappingCache(avatarPath, lidCache);
    logger.info(`\nLID cache updated with ${Object.keys(lidCache.mappings).length} mappings`);

    saveScanMetadata(avatarPath, scanMetadata);
    logger.info(`Scan metadata updated for ${Object.keys(scanMetadata.groups).length} groups`);

    saveUserImageCache(avatarPath, userImageCache);
    logger.info(`User image cache updated with ${Object.keys(userImageCache.images).length} images`);
}

async function collectGroupInfo(group: GroupChat, groupPath: string, mediaPath: string): Promise<GroupInfo> {
    const timestamp = getISOTimestamp();
    let profilePicPath: string | null = null;
    let inviteCode: string | null = null;

    // Try to get group profile picture
    try {
        const profilePicUrl = await client.getProfilePicUrl(group.id._serialized);
        if (profilePicUrl) {
            // Download profile picture using client
            const media = await MessageMedia.fromUrl(profilePicUrl);
            const ext = getMediaExtension(media.mimetype);
            const fileName = `group_profile_photo.${ext}`;
            profilePicPath = path.join(mediaPath, fileName);
            await saveMedia(media, profilePicPath);
            logger.debug('  - Downloaded group profile picture');
        }
    } catch (error) {
        logger.debug('  - Could not fetch group profile picture');
    }

    // Try to get invite code
    try {
        inviteCode = await group.getInviteCode();
    } catch (error) {
        logger.debug('  - Could not fetch invite code');
    }

    // Find first admin
    const participants = group.participants || [];
    const admins = participants.filter(p => p.isAdmin || p.isSuperAdmin);
    let adminInfo: Sender | null = null;

    if (admins.length > 0) {
        try {
            const adminContact = await client.getContactById(admins[0].id._serialized);
            adminInfo = {
                id: extractIdNumber(admins[0].id._serialized),
                username: adminContact.pushname || null,
                first_name: adminContact.name || adminContact.pushname || null,
                last_name: null,
                phone: adminContact.number || null
            };
        } catch (error) {
            adminInfo = {
                id: extractIdNumber(admins[0].id._serialized),
                username: null,
                first_name: null,
                last_name: null,
                phone: null
            };
        }
    }

    // Collect security settings
    let securitySettings: GroupSecuritySettings = {
        membershipApprovalRequired: false,
        messagesAdminsOnly: false,
        infoEditAdminsOnly: true,
        addMembersAdminsOnly: false
    };

    try {
        // Check if group is read-only (only admins can send)
        securitySettings.messagesAdminsOnly = (group as any).isReadOnly || false;

        // Access raw data for additional settings
        const rawData = (group as any).rawData || (group as any)._data || (group as any).groupMetadata;
        if (rawData) {
            securitySettings.membershipApprovalRequired = rawData.membershipApprovalMode || false;
            securitySettings.infoEditAdminsOnly = rawData.restrict || false;
            securitySettings.addMembersAdminsOnly = rawData.memberAddMode || false;
        }
    } catch (error) {
        logger.debug('  - Could not fetch security settings');
    }

    const groupInfo: GroupInfo = {
        id: extractIdNumber(group.id._serialized),
        name: group.name,
        description: group.description || '',
        profile_picture_path: profilePicPath,
        memberCount: participants.length,
        adminCount: admins.length,
        admin: adminInfo,
        createdAt: group.createdAt ? new Date(Number(group.createdAt) * 1000).toISOString() : 'N/A',
        creator: group.owner ? extractIdNumber(group.owner._serialized) : 'N/A',
        timestamp: timestamp,
        groupType: 'group',
        groupUrl: inviteCode ? `https://chat.whatsapp.com/${inviteCode}` : null,
        platform: 'WhatsApp',
        securitySettings: securitySettings
    };

    return groupInfo;
}

async function collectGroupMembers(
    group: GroupChat,
    usersMediaPath: string,
    userImageCache: UserImageCache
): Promise<{ members: GroupMember[]; updatedCache: UserImageCache }> {
    const timestamp = getISOTimestamp();
    const participants = group.participants || [];

    logger.info(`  - Processing ${participants.length} members (concurrency: ${MEMBER_FETCH_CONCURRENCY})...`);

    const profilePicStartTime = Date.now();
    const limit = pLimit(MEMBER_FETCH_CONCURRENCY);

    // Process members in parallel with controlled concurrency
    const memberResults = await Promise.all(
        participants.map((participant, i) =>
            limit(async () => {
                const participantId = extractIdNumber(participant.id._serialized);
                logger.debug(`    - Processing member ${i + 1}/${participants.length}: ${participantId}`);

                let contact: Contact | null = null;
                let profilePicPath: string | null = null;
                let about: string | null = null;
                let picSource: 'downloaded' | 'cached' | 'none' = 'none';

                try {
                    contact = await client.getContactById(participant.id._serialized);

                    // Try to get about/status text
                    try {
                        about = await contact.getAbout();
                    } catch (error) {
                        // About not available due to privacy settings
                    }
                } catch (error) {
                    // Contact info not available
                }

                // Check cache first for profile picture
                const cachedPath = userImageExists(userImageCache, participantId);
                if (cachedPath) {
                    profilePicPath = cachedPath;
                    picSource = 'cached';
                    logger.debug(`    - Using cached profile picture for ${participantId}`);
                } else {
                    // Not cached, try to download profile picture
                    try {
                        const profilePicUrl = await client.getProfilePicUrl(participant.id._serialized);
                        if (profilePicUrl) {
                            const media = await MessageMedia.fromUrl(profilePicUrl);
                            const ext = getMediaExtension(media.mimetype);
                            // New filename format: {id}_{datetime_UTC}.{ext}
                            const fileName = generateUserImageFilename(participantId, ext);
                            profilePicPath = path.join(usersMediaPath, fileName);
                            await saveMedia(media, profilePicPath);
                            picSource = 'downloaded';

                            // Update cache with new download
                            userImageCache.images[participantId] = {
                                userId: participantId,
                                imagePath: profilePicPath,
                                downloadedAt: getISOTimestamp()
                            };
                        }
                    } catch (error) {
                        // Profile picture not available
                    }
                }

                const member: GroupMember = {
                    id: extractIdNumber(participant.id._serialized),
                    phoneNumber: contact?.number || '',
                    user: contact?.pushname || null,
                    name: contact?.name || contact?.pushname || extractIdNumber(participant.id._serialized),
                    role: participant.isSuperAdmin ? 'superadmin' : (participant.isAdmin ? 'admin' : 'member'),
                    isAdmin: participant.isAdmin || participant.isSuperAdmin,
                    isSuperAdmin: participant.isSuperAdmin || false,
                    profile_picture_path: profilePicPath,
                    timestamp: timestamp,
                    about: about
                };

                return { member, picSource };
            })
        )
    );

    // Aggregate results
    const members = memberResults.map(r => r.member);
    const profilePicCount = memberResults.filter(r => r.picSource === 'downloaded').length;
    const cachedPicCount = memberResults.filter(r => r.picSource === 'cached').length;

    if (profilePicCount > 0 || cachedPicCount > 0) {
        logger.info(`  - Profile pictures: ${profilePicCount} downloaded, ${cachedPicCount} from cache. Took ${formatDuration(Date.now() - profilePicStartTime)}`);
    }

    return { members, updatedCache: userImageCache };
}

async function collectMessages(
    group: GroupChat,
    mediaPath: string,
    lidCache: LidMappingCache,
    scanMetadata: ScanMetadata,
    groupId: string
): Promise<{ chatMessages: ChatMessage[]; rawMessages: Message[]; errors: ErrorLogEntry[]; newestTimestamp: number }> {
    const errors: ErrorLogEntry[] = [];

    // Determine if this is the first run for this group
    const isFirstRun = isFirstRunForGroup(scanMetadata, groupId);
    const lastMessageTs = getLastMessageTimestamp(scanMetadata, groupId);

    // Calculate cutoff timestamp based on first run or delta
    let cutoffTimestamp: number;
    if (isFirstRun) {
        // First run: get 30 days of history
        cutoffTimestamp = Math.floor(Date.now() / 1000) - (INITIAL_SCAN_DAYS * 24 * 60 * 60);
        logger.info(`  - First scan for group: fetching ${INITIAL_SCAN_DAYS} days of messages`);
    } else {
        // Delta: get messages newer than last scan (but cap at 30 days for safety)
        const thirtyDaysAgo = Math.floor(Date.now() / 1000) - (INITIAL_SCAN_DAYS * 24 * 60 * 60);
        cutoffTimestamp = lastMessageTs ? Math.max(lastMessageTs, thirtyDaysAgo) : thirtyDaysAgo;
        logger.info(`  - Delta scan: fetching messages since ${new Date(cutoffTimestamp * 1000).toISOString()}`);
    }

    // Sync message history from phone first (loads older messages)
    // Try multiple times as WhatsApp loads history incrementally
    const MAX_SYNC_ATTEMPTS = 3;

    // Debug: Check the endOfHistoryTransferType value
    try {
        const chatData = (group as any).rawData || (group as any)._data || {};
        logger.debug(`  - Chat endOfHistoryTransferType: ${chatData.endOfHistoryTransferType}`);
    } catch (e) {
        // ignore
    }

    for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {
        try {
            const syncResult = await group.syncHistory();
            if (syncResult) {
                logger.info(`  - Syncing message history from phone (attempt ${attempt}/${MAX_SYNC_ATTEMPTS}, waiting ${HISTORY_SYNC_WAIT_MS}ms)...`);
                // Wait for sync to complete (messages are loaded asynchronously)
                await new Promise(resolve => setTimeout(resolve, HISTORY_SYNC_WAIT_MS));
            } else {
                logger.debug(`  - No additional history to sync (attempt ${attempt})`);
                break; // No more history available
            }
        } catch (error) {
            logger.debug(`  - Could not sync history (attempt ${attempt}): ${error}`);
            break;
        }
    }

    // Fetch all messages
    let allMessages = await group.fetchMessages({ limit: 1000000000000 });
    logger.info(`  - Fetched ${allMessages.length} total messages`);

    // Filter messages based on cutoff timestamp
    const messages = allMessages.filter(msg => msg.timestamp > cutoffTimestamp);
    logger.info(`  - Filtered to ${messages.length} messages since cutoff`);

    // Track newest message timestamp for next delta scan
    let newestTimestamp = cutoffTimestamp;
    for (const msg of messages) {
        if (msg.timestamp > newestTimestamp) {
            newestTimestamp = msg.timestamp;
        }
    }

    const chatMessages: ChatMessage[] = [];
    let mediaCount = 0;
    const totalMessages = messages.length;

    for (let msgIndex = 0; msgIndex < messages.length; msgIndex++) {
        const msg = messages[msgIndex];
        logger.debug(`  - Processing message ${msgIndex + 1}/${totalMessages} (type: ${msg.type}, id: ${msg.id.id.substring(0, 8)}...)`);

        // Skip status/story messages
        if ((msg as any).isStatus) {
            continue;
        }

        let senderInfo: Sender = {
            id: 0,
            username: null,
            first_name: null,
            last_name: null,
            phone: null
        };

        // Track original and resolved author IDs for LID resolution
        let originalAuthorId = '';
        let resolvedAuthorId: string | null = null;

        // Get sender information
        try {
            const contact = await msg.getContact();
            senderInfo = {
                id: extractIdNumber(contact.id._serialized),
                username: contact.pushname || null,
                first_name: contact.name || contact.pushname || null,
                last_name: null,
                phone: contact.number || null
            };
            originalAuthorId = extractIdNumber(contact.id._serialized);
        } catch (error) {
            if (msg.author) {
                originalAuthorId = extractIdNumber(msg.author);
                senderInfo.id = originalAuthorId;
            }
        }

        // Handle LID resolution
        if (originalAuthorId && isLid(originalAuthorId)) {
            resolvedAuthorId = await resolveLid(client, originalAuthorId, lidCache);
            if (resolvedAuthorId) {
                // Update sender info with resolved phone
                senderInfo.phone = resolvedAuthorId;
            }
        }

        // Extract raw data early for error context
        const rawData = (msg as any).rawData || (msg as any)._data || {};
        const isViewOnce = rawData?.isViewOnce || msg.type === 'ciphertext';
        const isGif = msg.type === 'video' && (rawData.isGif || rawData.gifPlayback || false);
        const isEdited = rawData.latestEditMsgKey != null || (msg as any).latestEditMsgKey != null;

        // Handle media
        let mediaFilePath: string | null = null;
        let isFailedToDownload = false;
        if (msg.hasMedia) {
            let downloadError: string | null = null;
            try {
                const media = await withTimeout(
                    msg.downloadMedia(),
                    MEDIA_DOWNLOAD_TIMEOUT,
                    `Download timed out after ${MEDIA_DOWNLOAD_TIMEOUT}ms`
                );
                if (media) {
                    const ext = getMediaExtension(media.mimetype);
                    const msgIdSafe = msg.id.id.replace(/[^a-zA-Z0-9]/g, '_');
                    const fileName = `${msgIdSafe}_${msg.type}.${ext}`;
                    mediaFilePath = path.join(mediaPath, fileName);
                    await saveMedia(media, mediaFilePath);
                    mediaCount++;
                } else {
                    downloadError = 'Media download returned null';
                }
            } catch (error) {
                downloadError = String(error);
            }

            if (downloadError) {
                isFailedToDownload = true;
                const isOld = (Date.now() / 1000 - msg.timestamp) > 14 * 24 * 60 * 60; // >14 days
                logger.warn(`    - Media download failed for ${msg.id.id}: ${downloadError}`);
                errors.push({
                    timestamp: getISOTimestamp(),
                    messageId: msg.id.id,
                    errorType: 'media_download',
                    error: downloadError,
                    explanation: isViewOnce
                        ? 'View once media - only accessible once, may already be viewed'
                        : isOld
                            ? 'Message is older than 14 days - media likely expired on WhatsApp servers'
                            : isGif
                                ? 'GIF from external source (Giphy/Tenor) - may not be downloadable'
                                : 'Media temporarily unavailable - network or timing issue',
                    context: {
                        messageType: msg.type,
                        messageTimestamp: msg.timestamp,
                        isOldMessage: isOld,
                        isGif: isGif,
                        isViewOnce: isViewOnce
                    }
                });
            }
        }

        // Get reactions
        const reactions: Array<{ emoji: string; sender: Sender }> = [];
        if (msg.hasReaction) {
            try {
                const reactionList = await msg.getReactions();
                if (reactionList) {
                    for (const reaction of reactionList) {
                        for (const sender of reaction.senders) {
                            let reactionSender: Sender = {
                                id: extractIdNumber(sender.senderId),
                                username: null,
                                first_name: null,
                                last_name: null,
                                phone: null
                            };

                            try {
                                const reactionContact = await client.getContactById(sender.senderId);
                                reactionSender = {
                                    id: extractIdNumber(sender.senderId),
                                    username: reactionContact.pushname || null,
                                    first_name: reactionContact.name || reactionContact.pushname || null,
                                    last_name: null,
                                    phone: reactionContact.number || null
                                };
                            } catch (error) {
                                // Use basic info
                            }

                            reactions.push({
                                emoji: reaction.aggregateEmoji,
                                sender: reactionSender
                            });
                        }
                    }
                }
            } catch (error) {
                // Reactions not available
            }
        }

        // Handle reply/quoted message tracking
        let isReply = false;
        let replyInfo: ReplyInfo | null = null;

        if (msg.hasQuotedMsg) {
            isReply = true;
            try {
                const quotedMsg = await msg.getQuotedMessage();
                replyInfo = {
                    quotedMessageId: quotedMsg.id._serialized,
                    quotedText: quotedMsg.body ? quotedMsg.body.substring(0, 200) : null,
                    quotedSenderId: quotedMsg.author || quotedMsg.from || null
                };
            } catch (error) {
                // Quoted message may no longer be available
                replyInfo = {
                    quotedMessageId: 'unknown',
                    quotedText: null,
                    quotedSenderId: null
                };
            }
        }

        // Handle ephemeral flag (rawData, isViewOnce, isGif already extracted above)
        const isEphemeral = (msg as any).isEphemeral || msg.type === 'ciphertext';

        // Get forwarded status
        const isForwarded = (msg as any).isForwarded || false;

        // Get links from message
        const links: Array<{ link: string; isSuspicious: boolean }> = [];
        if ((msg as any).links && Array.isArray((msg as any).links)) {
            for (const linkInfo of (msg as any).links) {
                links.push({
                    link: linkInfo.link || linkInfo.url || '',
                    isSuspicious: linkInfo.isSuspicious || false
                });
            }
        }

        // Get location if present
        let location: { latitude: number; longitude: number; description?: string } | null = null;
        if ((msg as any).location) {
            const loc = (msg as any).location;
            location = {
                latitude: loc.latitude,
                longitude: loc.longitude,
                description: loc.description || loc.address || undefined
            };
        }

        // Get mentioned user IDs
        const mentionedIds: string[] = [];
        if ((msg as any).mentionedIds && Array.isArray((msg as any).mentionedIds)) {
            for (const id of (msg as any).mentionedIds) {
                mentionedIds.push(typeof id === 'string' ? extractIdNumber(id) : extractIdNumber(id._serialized || ''));
            }
        }

        // Get vCard contacts if present (types are vcard or multi_vcard)
        const vCardContacts: ContactInfo[] = [];
        if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
            try {
                // Use the vcard/vCards property directly instead of getVCards()
                const vcardData = (msg as any).vCards || (msg as any).vcard;
                if (vcardData) {
                    // vcardData can be a string (single) or array (multi)
                    const vcards = Array.isArray(vcardData) ? vcardData : [vcardData];
                    for (const vcard of vcards) {
                        // Parse vCard string to extract name and number
                        const nameMatch = vcard.match(/FN:(.+)/);
                        const telMatch = vcard.match(/TEL[^:]*:(.+)/);
                        vCardContacts.push({
                            name: nameMatch ? nameMatch[1].trim() : '',
                            number: telMatch ? telMatch[1].replace(/\D/g, '') : '',
                            vcard: vcard
                        });
                    }
                }
            } catch (error) {
                errors.push({
                    timestamp: getISOTimestamp(),
                    messageId: msg.id.id,
                    errorType: 'vcard_extraction',
                    error: String(error),
                    explanation: 'Failed to extract contact information from vCard',
                    context: {
                        messageType: msg.type,
                        messageTimestamp: msg.timestamp
                    }
                });
            }
        }

        // Build WhatsApp metadata
        const metadata: WhatsAppMetadata = {
            type: msg.type || 'unknown',
            duration: rawData.duration || null,
            groupMentions: rawData.groupMentions || []
        };

        const chatMessage: ChatMessage = {
            id: `${extractIdNumber(group.id._serialized)}_${msg.id.id}`,
            timestamp: msg.timestamp,
            type: msg.type || 'message',
            text: msg.body || '',
            sender: senderInfo,
            has_media: msg.hasMedia,
            media_path: mediaFilePath,
            isFailedToDownload: isFailedToDownload,
            isGif: isGif,
            isForwarded: isForwarded,
            links: links,
            location: location,
            mentionedIds: mentionedIds,
            vCardContacts: vCardContacts,
            reactions: reactions,
            isReply: isReply,
            replyInfo: replyInfo,
            isEphemeral: isEphemeral,
            isViewOnce: isViewOnce,
            originalAuthorId: originalAuthorId,
            resolvedAuthorId: resolvedAuthorId,
            metadata: metadata,
            isEdited: isEdited
        };

        chatMessages.push(chatMessage);
    }

    if (mediaCount > 0) {
        logger.info(`  - Downloaded ${mediaCount} media files`);
    }

    return { chatMessages, rawMessages: messages, errors, newestTimestamp };
}

// ============================================================================
// Start the Client
// ============================================================================

async function main(): Promise<void> {
    logger.info('Starting WhatsApp client...');
    logger.info(`Avatar: ${AVATAR_NAME}`);
    logger.info(`Data will be saved to: ${DATA_DIR}`);
    logger.info('');

    const success = await initializeWithRetry();

    if (!success) {
        logger.fatal('Failed to authenticate after all retries');
        process.exit(1);
    }
}

main().catch((error) => {
    logger.fatal({ err: serializeError(error) }, 'Unhandled error in main');
    process.exit(1);
});
