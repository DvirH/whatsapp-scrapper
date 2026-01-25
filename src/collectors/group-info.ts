import * as path from 'path';
import { Client, GroupChat, MessageMedia } from 'whatsapp-web.js';
import { GroupInfo, Sender, GroupSecuritySettings } from '../types';
import { extractIdNumber, getISOTimestamp, getMediaExtension, saveMedia } from '../utils';
import logger from '../logger';

/**
 * Collect group information including metadata, profile picture, and security settings.
 */
export async function collectGroupInfo(
    client: Client,
    group: GroupChat,
    groupPath: string,
    mediaPath: string
): Promise<GroupInfo> {
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
