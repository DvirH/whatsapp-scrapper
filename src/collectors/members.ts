import * as path from 'path';
import { Client, GroupChat, Contact, MessageMedia } from 'whatsapp-web.js';
import pLimit from 'p-limit';
import { GroupMember, UserImageCache, MembershipEvent, PastMember } from '../types';
import { MEMBER_FETCH_CONCURRENCY } from '../config';
import { extractIdNumber, getISOTimestamp, getMediaExtension, saveMedia, formatDuration } from '../utils';
import { userImageExists, generateUserImageFilename } from '../cache/user-image';
import logger from '../logger';

/**
 * Collect group members with profile pictures.
 */
export async function collectGroupMembers(
    client: Client,
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

/**
 * Aggregates past members from membership events.
 * Identifies users who left or were removed and are not current members.
 */
export function aggregatePastMembers(
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
