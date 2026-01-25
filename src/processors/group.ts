import * as fs from 'fs';
import * as path from 'path';
import { Client, GroupChat } from 'whatsapp-web.js';
import {
    ProcessOneGroupResult,
    ProcessGroupsResult,
    FailedGroup,
    UserImageCache,
    ScanMetadata,
    LidMappingCache
} from '../types';
import { MAX_GROUPS, DATA_DIR } from '../config';
import { sanitizeFileName, ensureDir, extractIdNumber, getISOTimestamp, getUTCDatetimeForPath, formatDuration } from '../utils';
import { loadScanMetadata, saveScanMetadata } from '../cache/scan-metadata';
import { loadUserImageCache, saveUserImageCache } from '../cache/user-image';
import { loadLidMappingCache, saveLidMappingCache, buildLidMappingFromContacts } from '../cache/lid-mapping';
import { collectGroupInfo } from '../collectors/group-info';
import { collectGroupMembers, aggregatePastMembers } from '../collectors/members';
import { collectMessages } from '../collectors/messages';
import { extractMembershipEvents, collectPollVotes } from '../collectors/events';
import logger from '../logger';

/**
 * Process a single group and collect all data.
 */
async function processOneGroup(
    client: Client,
    group: GroupChat,
    groupId: string,
    scanPath: string,
    scanMediaPath: string,
    usersMediaPath: string,
    avatarPath: string,
    scanMetadata: ScanMetadata,
    userImageCache: UserImageCache,
    lidCache: LidMappingCache
): Promise<ProcessOneGroupResult> {
    // Collect all data for this group with timing
    logger.info('  - Fetching group info...');
    const groupInfoStart = Date.now();
    const groupInfo = await collectGroupInfo(client, group, scanPath, scanMediaPath);
    logger.info(`  - Fetching group info... done. Took ${formatDuration(Date.now() - groupInfoStart)}`);

    logger.info('  - Fetching members list...');
    const membersStart = Date.now();
    const membersResult = await collectGroupMembers(client, group, usersMediaPath, userImageCache);
    const groupMembers = membersResult.members;
    userImageCache = membersResult.updatedCache;
    logger.info(`  - Fetching members list... done. Took ${formatDuration(Date.now() - membersStart)}`);

    logger.info('  - Fetching messages...');
    const messagesStart = Date.now();
    const messages = await collectMessages(client, group, scanMediaPath, lidCache, scanMetadata, groupId);
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
    const pollResult = await collectPollVotes(client, messages.rawMessages, lidCache);
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
    const allErrors = [
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

    return { success: true, updatedCache: userImageCache };
}

/**
 * Process all groups and collect data.
 */
export async function processGroups(client: Client, avatarName: string): Promise<ProcessGroupsResult> {
    const scanTimestamp = getUTCDatetimeForPath();
    const avatarPath = path.join(DATA_DIR, avatarName);
    let groupsProcessedCount = 0;

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

    // Track failed groups for retry
    const failedGroups: FailedGroup[] = [];

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
            const errorMessage = dirError instanceof Error ? dirError.message : String(dirError);
            logger.error({ error: errorMessage, path: groupBasePath }, `  Failed to create directories for group ${group.name}`);
            failedGroups.push({
                group,
                groupId,
                groupName: group.name,
                scanPath,
                error: `Directory creation failed: ${errorMessage}`,
                attempt: 1
            });
            continue;
        }

        try {
            const result = await processOneGroup(
                client,
                group,
                groupId,
                scanPath,
                scanMediaPath,
                usersMediaPath,
                avatarPath,
                scanMetadata,
                userImageCache,
                lidCache
            );

            userImageCache = result.updatedCache;
            groupsProcessedCount++;

            // Save caches after each group to prevent data loss on crash/termination
            saveUserImageCache(avatarPath, userImageCache);
            saveScanMetadata(avatarPath, scanMetadata);

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logger.error({ error: errorMessage }, `  Error processing group ${group.name}`);
            failedGroups.push({
                group,
                groupId,
                groupName: group.name,
                scanPath,
                error: errorMessage,
                attempt: 1
            });
        }
    }

    // Retry failed groups
    if (failedGroups.length > 0) {
        logger.info(`\n${'='.repeat(60)}`);
        logger.info(`Retrying ${failedGroups.length} failed group(s)...`);
        logger.info(`${'='.repeat(60)}`);

        for (const failed of failedGroups) {
            logger.info(`\n[RETRY] Processing group: ${failed.groupName}`);

            // Ensure directories exist for retry
            const groupDirName = `${sanitizeFileName(failed.groupName)}_${failed.groupId}`;
            const groupBasePath = path.join(avatarPath, groupDirName);
            const groupMediaPath = path.join(groupBasePath, 'media');
            const usersMediaPath = path.join(groupMediaPath, 'users');
            const scanMediaPath = path.join(failed.scanPath, 'media');

            try {
                ensureDir(groupBasePath);
                ensureDir(groupMediaPath);
                ensureDir(usersMediaPath);
                ensureDir(failed.scanPath);
                ensureDir(scanMediaPath);

                const result = await processOneGroup(
                    client,
                    failed.group,
                    failed.groupId,
                    failed.scanPath,
                    scanMediaPath,
                    usersMediaPath,
                    avatarPath,
                    scanMetadata,
                    userImageCache,
                    lidCache
                );

                userImageCache = result.updatedCache;
                groupsProcessedCount++;
                logger.info(`  [RETRY] Success: ${failed.groupName}`);

                // Save caches after successful retry
                saveUserImageCache(avatarPath, userImageCache);
                saveScanMetadata(avatarPath, scanMetadata);

            } catch (retryError) {
                const errorMessage = retryError instanceof Error ? retryError.message : String(retryError);
                logger.error({ error: errorMessage }, `  [RETRY] Failed again: ${failed.groupName}`);

                // Save scan_error.json in the group's scan directory
                try {
                    ensureDir(failed.scanPath);
                    fs.writeFileSync(
                        path.join(failed.scanPath, 'scan_error.json'),
                        JSON.stringify({
                            groupId: failed.groupId,
                            groupName: failed.groupName,
                            firstError: failed.error,
                            retryError: errorMessage,
                            attempts: 2,
                            timestamp: getISOTimestamp()
                        }, null, 4)
                    );
                    logger.warn(`  Saved scan_error.json for ${failed.groupName}`);
                } catch (saveError) {
                    logger.error({ error: saveError }, `  Could not save scan_error.json for ${failed.groupName}`);
                }
            }
        }
    }

    // Save updated caches
    saveLidMappingCache(avatarPath, lidCache);
    logger.info(`\nLID cache updated with ${Object.keys(lidCache.mappings).length} mappings`);

    saveScanMetadata(avatarPath, scanMetadata);
    logger.info(`Scan metadata updated for ${Object.keys(scanMetadata.groups).length} groups`);

    saveUserImageCache(avatarPath, userImageCache);
    logger.info(`User image cache updated with ${Object.keys(userImageCache.images).length} images`);

    return { success: true, groupsProcessed: groupsProcessedCount };
}
