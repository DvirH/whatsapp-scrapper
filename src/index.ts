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
    reactions: Array<{ emoji: string; sender: Sender }>;
    isReply: boolean;
    replyInfo: ReplyInfo | null;
    isEphemeral: boolean;
    isViewOnce: boolean;
    originalAuthorId: string;
    resolvedAuthorId: string | null;
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

const AVATAR_NAME = 'default_avatar'; // Change this per user/session
const MAX_GROUPS = 4; // Only process first 2 groups
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
 * Builds LID mapping cache by scanning all contacts.
 */
async function buildLidMappingFromContacts(
    client: Client,
    avatarPath: string
): Promise<LidMappingCache> {
    const cache = loadLidMappingCache(avatarPath);

    console.log('Building LID mapping cache from contacts...');

    try {
        const contacts = await client.getContacts();
        let newMappings = 0;

        for (const contact of contacts) {
            if (contact.number && contact.id._serialized) {
                const idNumber = extractIdNumber(contact.id._serialized);

                // If we have a phone number, cache it
                if (contact.number && !cache.mappings[idNumber]) {
                    cache.mappings[idNumber] = {
                        lid: idNumber,
                        phoneNumber: contact.number,
                        resolvedAt: getISOTimestamp(),
                        source: 'contact_lookup'
                    };
                    newMappings++;
                }
            }
        }

        saveLidMappingCache(avatarPath, cache);
        console.log(`  - LID cache: ${Object.keys(cache.mappings).length} total mappings (${newMappings} new)`);

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
function extractMembershipEvents(messages: Message[]): MembershipEvent[] {
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
                affectedUsers.push(extractIdNumber(recipient));
            }
        }

        // Get who performed the action (author)
        let performedBy: string | null = null;
        if (msg.author) {
            performedBy = extractIdNumber(msg.author);
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

        if (group.name !== "דביר + הראל 1") { continue }
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
            const membershipEvents = extractMembershipEvents(messages.rawMessages);

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
            // const profilePicUrl = await client.getProfilePicUrl(participant.id._serialized);
            // if (profilePicUrl) {
            //     const media = await MessageMedia.fromUrl(profilePicUrl);
            //     const ext = getMediaExtension(media.mimetype);
            //     const fileName = `${extractIdNumber(participant.id._serialized)}.${ext}`;
            //     profilePicPath = path.join(usersMediaPath, fileName);
            //     await saveMedia(media, profilePicPath);
            // }
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
): Promise<{ chatMessages: ChatMessage[]; rawMessages: Message[] }> {
    console.log(`  - Fetching messages...`);

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

        // Handle media
        let mediaFilePath: string | null = null;
        if (msg.hasMedia) {
            try {
                const media = await msg.downloadMedia();
                if (media) {
                    const ext = getMediaExtension(media.mimetype);
                    const msgIdSafe = msg.id.id.replace(/[^a-zA-Z0-9]/g, '_');
                    const fileName = `${msgIdSafe}_${msg.type}.${ext}`;
                    mediaFilePath = path.join(mediaPath, fileName);
                    await saveMedia(media, mediaFilePath);
                    mediaCount++;
                }
            } catch (error) {
                console.log(`    - Could not download media for message ${msg.id.id}`);
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

        // Handle ephemeral and view-once flags
        const isEphemeral = (msg as any).isEphemeral || false;
        const rawData = (msg as any).rawData || (msg as any)._data;
        const isViewOnce = rawData?.isViewOnce || false;

        const chatMessage: ChatMessage = {
            id: `${extractIdNumber(group.id._serialized)}_${msg.id.id}`,
            timestamp: msg.timestamp,
            type: msg.type || 'message',
            text: msg.body || '',
            sender: senderInfo,
            has_media: msg.hasMedia,
            media_path: mediaFilePath,
            reactions: reactions,
            isReply: isReply,
            replyInfo: replyInfo,
            isEphemeral: isEphemeral,
            isViewOnce: isViewOnce,
            originalAuthorId: originalAuthorId,
            resolvedAuthorId: resolvedAuthorId
        };

        chatMessages.push(chatMessage);
    }

    if (mediaCount > 0) {
        console.log(`  - Downloaded ${mediaCount} media files`);
    }

    return { chatMessages, rawMessages: messages };
}

// ============================================================================
// Start the Client
// ============================================================================

console.log('Starting WhatsApp client...');
console.log(`Avatar: ${AVATAR_NAME}`);
console.log(`Data will be saved to: ${DATA_DIR}`);
console.log('');

client.initialize();
