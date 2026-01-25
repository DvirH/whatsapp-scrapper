import * as path from 'path';
import { Client, GroupChat, Message } from 'whatsapp-web.js';
import pLimit from 'p-limit';
import { ChatMessage, Sender, ReplyInfo, WhatsAppMetadata, ContactInfo, ErrorLogEntry, LidMappingCache, ScanMetadata } from '../types';
import { MEDIA_DOWNLOAD_TIMEOUT, MEDIA_DOWNLOAD_CONCURRENCY, HISTORY_SYNC_WAIT_MS, INITIAL_SCAN_DAYS } from '../config';
import { extractIdNumber, getISOTimestamp, getMediaExtension, saveMedia, withTimeout, formatDuration } from '../utils';
import { isLid, resolveLid } from '../cache/lid-mapping';
import { isFirstRunForGroup, getLastMessageTimestamp } from '../cache/scan-metadata';
import logger from '../logger';

/**
 * Collect messages from a group chat.
 */
export async function collectMessages(
    client: Client,
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
                await new Promise(resolve => setTimeout(resolve, HISTORY_SYNC_WAIT_MS));
            } else {
                logger.debug(`  - No additional history to sync (attempt ${attempt})`);
                break;
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
    const totalMessages = messages.length;

    // Collect media download tasks for concurrent processing
    interface MediaDownloadTask {
        chatMessageIndex: number;
        msg: Message;
        isViewOnce: boolean;
        isGif: boolean;
    }
    const mediaDownloadTasks: MediaDownloadTask[] = [];

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
                senderInfo.phone = resolvedAuthorId;
            }
        }

        // Extract raw data early for error context
        const rawData = (msg as any).rawData || (msg as any)._data || {};
        const isViewOnce = rawData?.isViewOnce || msg.type === 'ciphertext';
        const isGif = msg.type === 'video' && (rawData.isGif || rawData.gifPlayback || false);
        const isEdited = rawData.latestEditMsgKey != null || (msg as any).latestEditMsgKey != null;

        // Media will be downloaded concurrently after all messages are processed
        let mediaFilePath: string | null = null;
        let isFailedToDownload = false;

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
                replyInfo = {
                    quotedMessageId: 'unknown',
                    quotedText: null,
                    quotedSenderId: null
                };
            }
        }

        // Handle ephemeral flag
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

        // Get vCard contacts if present
        const vCardContacts: ContactInfo[] = [];
        if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
            try {
                const vcardData = (msg as any).vCards || (msg as any).vcard;
                if (vcardData) {
                    const vcards = Array.isArray(vcardData) ? vcardData : [vcardData];
                    for (const vcard of vcards) {
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

        // Queue media download task if message has media
        if (msg.hasMedia) {
            mediaDownloadTasks.push({
                chatMessageIndex: chatMessages.length - 1,
                msg,
                isViewOnce,
                isGif
            });
        }
    }

    // Download all media concurrently
    if (mediaDownloadTasks.length > 0) {
        logger.info(`  - Downloading ${mediaDownloadTasks.length} media files (concurrency: ${MEDIA_DOWNLOAD_CONCURRENCY})...`);
        const mediaDownloadStart = Date.now();
        const mediaLimit = pLimit(MEDIA_DOWNLOAD_CONCURRENCY);

        const mediaResults = await Promise.all(
            mediaDownloadTasks.map((task, taskIndex) =>
                mediaLimit(async () => {
                    const { chatMessageIndex, msg, isViewOnce, isGif } = task;
                    let downloadedPath: string | null = null;
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
                            downloadedPath = path.join(mediaPath, fileName);
                            await saveMedia(media, downloadedPath);
                            logger.debug(`    - Downloaded media ${taskIndex + 1}/${mediaDownloadTasks.length}: ${fileName}`);
                        } else {
                            downloadError = 'Media download returned null';
                        }
                    } catch (error) {
                        downloadError = String(error);
                    }

                    return { chatMessageIndex, downloadedPath, downloadError, isViewOnce, isGif, msg };
                })
            )
        );

        // Update chatMessages with download results and collect errors
        let mediaCount = 0;
        for (const result of mediaResults) {
            const { chatMessageIndex, downloadedPath, downloadError, isViewOnce, isGif, msg } = result;

            if (downloadedPath) {
                chatMessages[chatMessageIndex].media_path = downloadedPath;
                mediaCount++;
            } else if (downloadError) {
                chatMessages[chatMessageIndex].isFailedToDownload = true;
                const isOld = (Date.now() / 1000 - msg.timestamp) > 14 * 24 * 60 * 60;
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

        const mediaDownloadDuration = Date.now() - mediaDownloadStart;
        logger.info(`  - Downloaded ${mediaCount}/${mediaDownloadTasks.length} media files in ${formatDuration(mediaDownloadDuration)}`);
    }

    return { chatMessages, rawMessages: messages, errors, newestTimestamp };
}
