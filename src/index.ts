import { Client, LocalAuth, GroupChat, Message, Contact, MessageMedia } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';

// Environment configuration
const FIRST_RUN = process.env.FIRST_RUN === 'true';

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

// ============================================================================
// Configuration
// ============================================================================

const AVATAR_NAME = 'Dvir'; // Change this per user/session
const MAX_GROUPS = Infinity; // Only process first 2 groups
const DATA_DIR = path.join(process.cwd(), 'data');

// ============================================================================
// Utility Functions
// ============================================================================

function sanitizeFileName(name: string): string {
    return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').substring(0, 100);
}

function getCurrentTimestamp(): string {
    const now = new Date();
    return now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
}

function getISOTimestamp(): string {
    return new Date().toISOString();
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
            console.log('  - Could not load LID cache, creating new one');
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

    console.log('Building LID mapping cache from contacts...');

    try {
        const contacts = await client.getContacts();

        // Collect user IDs for batch lookup
        const userIds: string[] = [];
        for (const contact of contacts) {
            if (contact.id._serialized && contact.id._serialized.endsWith('@c.us')) {
                userIds.push(contact.id._serialized);
            }
        }

        console.log(`  - Found ${userIds.length} contacts to lookup`);

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
            console.log(`  - LID cache: ${Object.keys(cache.mappings).length} total mappings (${newMappings} new)`);
        }

    } catch (error) {
        console.log(`  - Error building LID cache: ${error}`);
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
            console.log(`    - Could not get poll votes for ${msg.id.id}: ${error}`);
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

const client = new Client({
    authStrategy: new LocalAuth({
        clientId: AVATAR_NAME,
        dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// ============================================================================
// Event Handlers
// ============================================================================

client.on('qr', (qr: string) => {
    console.log('\n========================================');
    console.log('Scan this QR code with WhatsApp:');
    console.log('========================================\n');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('Authenticated successfully!');
});

client.on('auth_failure', (msg: string) => {
    console.error('Authentication failed:', msg);
    process.exit(1);
});

client.on('disconnected', (reason: string) => {
    console.log('Client disconnected:', reason);
});

client.on('ready', async () => {
    console.log('\n========================================');
    console.log('WhatsApp Client is ready!');
    console.log('========================================\n');

    try {
        await processGroups();
        console.log('\nData collection complete!');
        console.log('You can now close this program or leave it running for live updates.');
    } catch (error) {
        console.error('Error processing groups:', error);
    }
});

// ============================================================================
// Data Collection Functions
// ============================================================================

async function processGroups(): Promise<void> {
    const scanTimestamp = getCurrentTimestamp();
    const avatarPath = path.join(DATA_DIR, AVATAR_NAME);
    const basePath = path.join(avatarPath, scanTimestamp);

    // Build LID mapping cache from contacts
    const lidCache = await buildLidMappingFromContacts(client, avatarPath);

    console.log(`Fetching chats...`);
    const chats = await client.getChats();

    // Filter to group chats only
    const groupChats = chats.filter(chat => chat.isGroup) as GroupChat[];
    console.log(`Found ${groupChats.length} group chats`);

    // Process only first MAX_GROUPS groups
    const groupsToProcess = groupChats.slice(0, MAX_GROUPS);
    console.log(`Processing ${groupsToProcess.length} groups...\n`);

    for (let i = 0; i < groupsToProcess.length; i++) {
        const group = groupsToProcess[i];
        console.log(`\n[${i + 1}/${groupsToProcess.length}] Processing group: ${group.name}`);

        if (group.name !== "רותם - יניב - הראל - דביר") { continue }
        const groupDirName = sanitizeFileName(group.name);
        const groupPath = path.join(basePath, groupDirName);
        const mediaPath = path.join(groupPath, 'media');
        const usersMediaPath = path.join(mediaPath, 'users');

        ensureDir(groupPath);
        ensureDir(mediaPath);
        ensureDir(usersMediaPath);

        try {
            // Collect all data for this group
            const [groupInfo, groupMembers, messages] = await Promise.all([
                collectGroupInfo(group, groupPath, mediaPath),
                collectGroupMembers(group, usersMediaPath),
                collectMessages(group, mediaPath, lidCache)
            ]);

            // Extract membership events (join/leave/removed) from system messages
            const membershipEvents = extractMembershipEvents(messages.rawMessages, lidCache);

            // Save all JSON files
            fs.writeFileSync(
                path.join(groupPath, 'group_info.json'),
                JSON.stringify(groupInfo, null, 4)
            );
            console.log(`  - Saved group_info.json`);

            fs.writeFileSync(
                path.join(groupPath, 'group_members.json'),
                JSON.stringify(groupMembers, null, 4)
            );
            console.log(`  - Saved group_members.json (${groupMembers.length} members)`);

            fs.writeFileSync(
                path.join(groupPath, 'group_chat.json'),
                JSON.stringify(messages.chatMessages, null, 4)
            );
            console.log(`  - Saved group_chat.json (${messages.chatMessages.length} messages)`);

            // Save membership events if any were found
            if (membershipEvents.length > 0) {
                fs.writeFileSync(
                    path.join(groupPath, 'membership_events.json'),
                    JSON.stringify(membershipEvents, null, 4)
                );
                console.log(`  - Saved membership_events.json (${membershipEvents.length} events)`);
            }

            // Collect and save poll votes
            const pollResult = await collectPollVotes(messages.rawMessages, lidCache);
            if (pollResult.votes.length > 0) {
                fs.writeFileSync(
                    path.join(groupPath, 'group_votes.json'),
                    JSON.stringify(pollResult.votes, null, 4)
                );
                console.log(`  - Saved group_votes.json (${pollResult.votes.length} votes)`);
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
                path.join(groupPath, 'raw_messages.json'),
                JSON.stringify(rawMessagesData, null, 4)
            );
            console.log(`  - Saved raw_messages.json (${rawMessagesData.length} messages)`);

            // Combine and save all errors
            const allErrors: ErrorLogEntry[] = [
                ...messages.errors,
                ...pollResult.errors
            ];
            if (allErrors.length > 0) {
                fs.writeFileSync(
                    path.join(groupPath, 'error_log.json'),
                    JSON.stringify(allErrors, null, 4)
                );
                console.log(`  - Saved error_log.json (${allErrors.length} errors)`);
            }

        } catch (error) {
            console.error(`  Error processing group ${group.name}:`, error);
        }
    }

    // Save updated LID cache
    saveLidMappingCache(avatarPath, lidCache);
    console.log(`\nLID cache updated with ${Object.keys(lidCache.mappings).length} mappings`);
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
            console.log(`  - Downloaded group profile picture`);
        }
    } catch (error) {
        console.log(`  - Could not fetch group profile picture`);
    }

    // Try to get invite code
    try {
        inviteCode = await group.getInviteCode();
    } catch (error) {
        console.log(`  - Could not fetch invite code`);
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
        console.log(`  - Could not fetch security settings`);
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

async function collectGroupMembers(group: GroupChat, usersMediaPath: string): Promise<GroupMember[]> {
    const timestamp = getISOTimestamp();
    const members: GroupMember[] = [];
    const participants = group.participants || [];

    console.log(`  - Processing ${participants.length} members...`);

    for (const participant of participants) {
        let contact: Contact | null = null;
        let profilePicPath: string | null = null;
        let about: string | null = null;

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

        // Try to download profile picture
        try {
            const profilePicUrl = await client.getProfilePicUrl(participant.id._serialized);
            if (profilePicUrl) {
                const media = await MessageMedia.fromUrl(profilePicUrl);
                const ext = getMediaExtension(media.mimetype);
                const fileName = `${extractIdNumber(participant.id._serialized)}.${ext}`;
                profilePicPath = path.join(usersMediaPath, fileName);
                await saveMedia(media, profilePicPath);
            }
        } catch (error) {
            // Profile picture not available
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

        members.push(member);
    }

    return members;
}

async function collectMessages(
    group: GroupChat,
    mediaPath: string,
    lidCache: LidMappingCache
): Promise<{ chatMessages: ChatMessage[]; rawMessages: Message[]; errors: ErrorLogEntry[] }> {
    console.log(`  - Fetching messages...`);
    const errors: ErrorLogEntry[] = [];

    // Load messages with retries to ensure we get historical messages
    const TARGET_MESSAGES = 500;
    const MAX_RETRIES = 10;
    let retries = 0;
    let allMessages = await group.fetchMessages({ limit: TARGET_MESSAGES });
    console.log(`  - Initial fetch: ${allMessages.length} messages`);

    // Keep loading until we hit target or no more messages come in
    while (allMessages.length < TARGET_MESSAGES && retries < MAX_RETRIES) {
        const prevCount = allMessages.length;
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1 second between loads
        allMessages = await group.fetchMessages({ limit: TARGET_MESSAGES });
        console.log(`  - Retry ${retries + 1}: ${allMessages.length} messages`);

        // If no new messages loaded, stop retrying
        if (allMessages.length === prevCount) {
            console.log(`  - No new messages loaded, stopping`);
            break;
        }
        retries++;
    }

    // Filter messages based on FIRST_RUN setting
    let messages: Message[];
    if (FIRST_RUN) {
        // First run: get all messages without time filter
        messages = allMessages;
        console.log(`  - FIRST_RUN mode: returning all ${allMessages.length} messages`);
    } else {
        // Normal run: filter to last 10 minutes only (rolling window)
        const tenMinutesAgo = Math.floor(Date.now() / 1000) - (10 * 60);
        messages = allMessages.filter(msg => msg.timestamp >= tenMinutesAgo);
        console.log(`  - Found ${allMessages.length} total, filtered to ${messages.length} from last 10 minutes`);
    }

    const chatMessages: ChatMessage[] = [];
    let mediaCount = 0;

    for (const msg of messages) {
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
                const media = await msg.downloadMedia();
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
                console.log(`    - Media download failed for ${msg.id.id}: ${downloadError}`);
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
        console.log(`  - Downloaded ${mediaCount} media files`);
    }

    return { chatMessages, rawMessages: messages, errors };
}

// ============================================================================
// Start the Client
// ============================================================================

console.log('Starting WhatsApp client...');
console.log(`Avatar: ${AVATAR_NAME}`);
console.log(`Data will be saved to: ${DATA_DIR}`);
console.log('');

client.initialize();
