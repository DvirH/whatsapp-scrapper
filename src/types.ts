import { GroupChat } from 'whatsapp-web.js';

// ============================================================================
// Core Types
// ============================================================================

export interface Sender {
    id: number | string;
    username: string | null;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
}

export interface ChatMessage {
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

export interface GroupInfo {
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

export interface GroupMember {
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

export interface GroupSecuritySettings {
    membershipApprovalRequired: boolean;
    messagesAdminsOnly: boolean;
    infoEditAdminsOnly: boolean;
    addMembersAdminsOnly: boolean;
}

export interface ReplyInfo {
    quotedMessageId: string;
    quotedText: string | null;
    quotedSenderId: string | null;
}

export interface WhatsAppMetadata {
    type: string;
    duration: number | null;
    groupMentions: Array<{
        groupSubject: string;
        groupJid: { server: string; user: string; _serialized: string };
    }>;
}

export interface ContactInfo {
    name: string;
    number: string;
    vcard: string;
}

// ============================================================================
// Poll & Error Types
// ============================================================================

export interface PollVote {
    pollId: string;
    pollTimestamp: number;
    voterId: string;
    voterPhone: string | null;
    voterName: string | null;
    selectedOptions: string[];
    timestamp: number;
}

export interface ErrorLogEntry {
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

// ============================================================================
// Membership Types
// ============================================================================

export interface MembershipEvent {
    id: string;
    timestamp: number;
    eventType: 'add' | 'remove' | 'leave' | 'invite' | 'create' | 'unknown';
    affectedUsers: string[];
    performedBy: string | null;
    body: string;
}

export interface PastMember {
    id: string;
    phoneNumber: string | null;
    name: string | null;
    leftAt: string;
    leftReason: 'leave' | 'remove' | 'unknown';
    removedBy: string | null;
}

// ============================================================================
// Cache Types
// ============================================================================

export interface LidMapping {
    lid: string;
    phoneNumber: string;
    resolvedAt: string;
    source: 'contact_lookup' | 'message_context' | 'manual';
}

export interface LidMappingCache {
    version: string;
    lastUpdated: string;
    mappings: Record<string, LidMapping>;
}

export interface ScanMetadata {
    version: string;
    lastUpdated: string;
    groups: Record<string, GroupScanInfo>;
}

export interface GroupScanInfo {
    groupId: string;
    groupName: string;
    lastScanTimestamp: string;
    lastMessageTimestamp: number;
    scanCount: number;
}

export interface UserImageCache {
    version: string;
    lastUpdated: string;
    images: Record<string, UserImageEntry>;
}

export interface UserImageEntry {
    userId: string;
    imagePath: string;
    downloadedAt: string;
}

// ============================================================================
// Processing Types
// ============================================================================

export interface FailedGroup {
    group: GroupChat;
    groupId: string;
    groupName: string;
    scanPath: string;
    error: string;
    attempt: number;
}

export interface ProcessOneGroupResult {
    success: boolean;
    updatedCache: UserImageCache;
    error?: string;
}

export interface ProcessGroupsResult {
    success: boolean;
    groupsProcessed: number;
}

// ============================================================================
// Initialization Types
// ============================================================================

export interface InitializationAttempt {
    timestamp: string;
    attempt: number;
    success: boolean;
    reason?: string;
    errorDetails?: string;
    scanTiming?: ScanTiming;
}

export interface InitializationsLog {
    lastUpdated: string;
    attempts: InitializationAttempt[];
    currentScan?: ScanTiming;
}

export interface ScanTiming {
    scanStartTime: string;
    scanFinishTime?: string;
    scanStatus: 'in_progress' | 'completed' | 'failed';
    scanDurationMs?: number;
    groupsProcessed?: number;
    errorMessage?: string;
}
