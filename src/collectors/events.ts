import { Client, Message } from 'whatsapp-web.js';
import { MembershipEvent, PollVote, ErrorLogEntry, LidMappingCache } from '../types';
import { extractIdNumber, getISOTimestamp } from '../utils';
import { isLid } from '../cache/lid-mapping';
import logger from '../logger';

/**
 * Extracts membership events (join/leave/removed) from WhatsApp system messages.
 * WhatsApp sends notification messages for group membership changes.
 */
export function extractMembershipEvents(messages: Message[], lidCache: LidMappingCache): MembershipEvent[] {
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
export async function collectPollVotes(
    client: Client,
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

                        // Resolve LID if needed
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
