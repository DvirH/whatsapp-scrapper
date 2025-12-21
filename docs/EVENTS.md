# Event Testing Guide

This guide explains how to test each user-facing event in the WhatsApp data collector and verify you're getting all the information needed.

## Prerequisites

- Node.js and pnpm installed
- WhatsApp account ready for testing
- A test group created (you can create a small group with 2-3 people)
- `.env` file configured with `FIRST_RUN=true`

## Running the Application

```bash
# Install dependencies
pnpm install

# Set FIRST_RUN=true in .env for initial data collection
echo "FIRST_RUN=true" > .env

# Start the application
pnpm start
```

1. Scan the QR code with WhatsApp
2. Wait for "WhatsApp Client is ready!" message
3. Data will be saved to `data/{AVATAR_NAME}/{timestamp}/{group_name}/`

## Output Files

After running, you'll find these files in each group folder:

| File | Description |
|------|-------------|
| `group_info.json` | Group metadata and settings |
| `group_members.json` | List of all group members |
| `group_chat.json` | All messages with reactions, replies |
| `membership_events.json` | Join/leave/add/remove events |
| `media/` | Downloaded media files |

---

## Testing Each Event

### 1. Text Messages

**How to trigger:**
Send a regular text message in the group.

**Test steps:**
1. Open the test group in WhatsApp
2. Type a message and send it
3. Run the application

**Expected output in `group_chat.json`:**
```json
{
    "id": "972501234567-1234567890@g.us_ABCD1234",
    "timestamp": 1702900000,
    "type": "chat",
    "text": "Hello, this is a test message!",
    "sender": {
        "id": "972501234567",
        "username": "John",
        "first_name": "John Doe",
        "last_name": null,
        "phone": "972501234567"
    },
    "has_media": false,
    "media_path": null,
    "reactions": [],
    "isReply": false,
    "replyInfo": null,
    "isEphemeral": false,
    "isViewOnce": false
}
```

**Verification:**
- `type` should be `"chat"`
- `text` contains the message content
- `sender` has user information

---

### 2. Reactions

**How to trigger:**
Long press on any message and add an emoji reaction.

**Test steps:**
1. Find a message in the group
2. Long press on it
3. Select an emoji reaction (e.g., thumbs up, heart)
4. Run the application

**Expected output in `group_chat.json`:**
```json
{
    "id": "...",
    "text": "Original message text",
    "reactions": [
        {
            "emoji": "👍",
            "sender": {
                "id": "972509876543",
                "username": "Jane",
                "first_name": "Jane Smith",
                "last_name": null,
                "phone": "972509876543"
            }
        },
        {
            "emoji": "❤️",
            "sender": {
                "id": "972501234567",
                "username": "John",
                "first_name": "John Doe",
                "last_name": null,
                "phone": "972501234567"
            }
        }
    ]
}
```

**Verification:**
- `reactions` array is populated
- Each reaction has `emoji` and `sender` info
- Multiple reactions from different users appear

---

### 3. Replies (Quoted Messages)

**How to trigger:**
Swipe right on a message to reply to it, or long press and select "Reply".

**Test steps:**
1. Find a message in the group
2. Swipe right or long press and tap "Reply"
3. Type your reply and send
4. Run the application

**Expected output in `group_chat.json`:**
```json
{
    "id": "...",
    "text": "This is my reply to your message",
    "isReply": true,
    "replyInfo": {
        "quotedMessageId": "false_972501234567-1234567890@g.us_ORIGINAL123",
        "quotedText": "The original message that was replied to",
        "quotedSenderId": "972509876543@c.us"
    }
}
```

**Verification:**
- `isReply` is `true`
- `replyInfo` contains:
  - `quotedMessageId` - ID of the original message
  - `quotedText` - Text of the original message (truncated to 200 chars)
  - `quotedSenderId` - Who sent the original message

---

### 4. Media Messages

**How to trigger:**
Send different types of media in the group.

**Test steps:**

| Media Type | How to Send |
|------------|-------------|
| Image | Tap attachment > Gallery > Select photo |
| Video | Tap attachment > Gallery > Select video |
| Audio | Hold the microphone button to record |
| Document | Tap attachment > Document > Select file |
| Sticker | Tap sticker icon > Select sticker |
| GIF | Tap attachment > Gallery > Select GIF |

**Expected output in `group_chat.json`:**
```json
{
    "id": "...",
    "timestamp": 1702900000,
    "type": "image",
    "text": "Caption text (if any)",
    "has_media": true,
    "media_path": "/path/to/data/Avatar/timestamp/group/media/MSGID_image.jpg"
}
```

**Media types and file extensions:**

| Message Type | Possible Extensions |
|--------------|---------------------|
| `image` | .jpg, .png, .webp, .gif |
| `video` | .mp4, .3gp |
| `audio` | .ogg, .mp3, .opus |
| `ptt` (voice note) | .ogg, .opus |
| `document` | .pdf, .doc, .ppt, etc. |
| `sticker` | .webp |

**Verification:**
- `has_media` is `true`
- `media_path` points to downloaded file
- File exists in `media/` folder
- `type` matches the media type

---

### 5. Membership Events

**How to trigger:**
Add or remove members from the group.

**Test steps:**

| Event Type | How to Trigger |
|------------|----------------|
| `add` | Group admin adds someone to the group |
| `remove` | Group admin removes someone from the group |
| `leave` | A member leaves the group voluntarily |
| `invite` | Someone joins via invite link |
| `create` | Create a new group |

**Expected output in `membership_events.json`:**
```json
[
    {
        "id": "EVENT123",
        "timestamp": 1702900000,
        "eventType": "add",
        "affectedUsers": ["972501234567", "972509876543"],
        "performedBy": "972551112222",
        "body": ""
    },
    {
        "id": "EVENT456",
        "timestamp": 1702900100,
        "eventType": "leave",
        "affectedUsers": ["972501234567"],
        "performedBy": null,
        "body": ""
    }
]
```

**Event types:**

| eventType | Description |
|-----------|-------------|
| `add` | Admin added member(s) to group |
| `remove` | Admin removed member(s) from group |
| `leave` | Member left the group voluntarily |
| `invite` | Member joined via invite link |
| `create` | Group was created |

**Verification:**
- `membership_events.json` file is created
- `eventType` matches the action performed
- `affectedUsers` lists the phone numbers involved
- `performedBy` shows who performed the action (null for leave)

---

### 6. Ephemeral Messages (Disappearing Messages)

**How to trigger:**
Enable disappearing messages in group settings.

**Test steps:**
1. Open group settings (tap group name)
2. Tap "Disappearing messages"
3. Select a duration (24 hours, 7 days, or 90 days)
4. Send a message in the group
5. Run the application

**Expected output in `group_chat.json`:**
```json
{
    "id": "...",
    "text": "This message will disappear",
    "isEphemeral": true,
    "isViewOnce": false
}
```

**Verification:**
- `isEphemeral` is `true`
- The message has a timer icon in WhatsApp

---

### 7. View Once Messages

**How to trigger:**
Send a photo or video as "View once".

**Test steps:**
1. Tap the attachment button
2. Select a photo or video
3. Tap the "1" icon at the bottom (View once)
4. Send the message
5. Run the application

**Expected output in `group_chat.json`:**
```json
{
    "id": "...",
    "type": "image",
    "has_media": true,
    "isEphemeral": false,
    "isViewOnce": true
}
```

**Verification:**
- `isViewOnce` is `true`
- `type` is `image` or `video`
- Media may or may not be downloadable (depends on timing)

---

### 8. GIF Messages

**How to trigger:**
Send a GIF in the group.

**Test steps:**
1. Tap the attachment button or GIF button
2. Search for and select a GIF
3. Send the GIF
4. Run the application

**Expected output in `group_chat.json`:**
```json
{
    "id": "...",
    "type": "video",
    "has_media": true,
    "isGif": true,
    "metadata": {
        "type": "video",
        "duration": 3,
        "groupMentions": []
    }
}
```

**Verification:**
- `type` is `video` (GIFs are sent as videos)
- `isGif` is `true`
- `metadata.duration` shows GIF length in seconds

---

### 9. Forwarded Messages

**How to trigger:**
Forward a message from another chat.

**Test steps:**
1. Long press on a message in any chat
2. Tap "Forward"
3. Select the test group
4. Send the forwarded message
5. Run the application

**Expected output in `group_chat.json`:**
```json
{
    "id": "...",
    "text": "Original message text",
    "isForwarded": true
}
```

**Verification:**
- `isForwarded` is `true`
- Message shows "Forwarded" label in WhatsApp

---

### 10. Messages with Links

**How to trigger:**
Send a message containing a URL.

**Test steps:**
1. Type a message with a URL (e.g., "Check this out: https://example.com")
2. Send the message
3. Run the application

**Expected output in `group_chat.json`:**
```json
{
    "id": "...",
    "text": "Check this out: https://example.com",
    "links": [
        {
            "link": "https://example.com",
            "isSuspicious": false
        }
    ]
}
```

**Verification:**
- `links` array contains the URL
- `isSuspicious` indicates if WhatsApp flagged the link

---

### 11. Location Messages

**How to trigger:**
Share a location in the group.

**Test steps:**
1. Tap the attachment button
2. Select "Location"
3. Choose "Send your current location" or pick a location
4. Send the location
5. Run the application

**Expected output in `group_chat.json`:**
```json
{
    "id": "...",
    "type": "location",
    "location": {
        "latitude": 32.0853,
        "longitude": 34.7818,
        "description": "Tel Aviv, Israel"
    }
}
```

**Verification:**
- `type` is `location`
- `location` object has `latitude` and `longitude`
- `description` may contain address info

---

### 12. Mentions

**How to trigger:**
Mention someone in a message using @.

**Test steps:**
1. Type @ in the message field
2. Select a group member from the list
3. Complete your message and send
4. Run the application

**Expected output in `group_chat.json`:**
```json
{
    "id": "...",
    "text": "@John have you seen this?",
    "mentionedIds": ["972501234567"]
}
```

**Verification:**
- `mentionedIds` array contains the phone numbers of mentioned users
- Text contains the @ mention

---

### 13. Contact Messages

**How to trigger:**
Share a contact in the group.

**Test steps:**
1. Tap the attachment button
2. Select "Contact"
3. Choose one or more contacts to share
4. Send the contact(s)
5. Run the application

**Expected output in `group_chat.json`:**
```json
{
    "id": "...",
    "type": "vcard",
    "vCardContacts": [
        {
            "name": "John Doe",
            "number": "972501234567",
            "vcard": "BEGIN:VCARD\nVERSION:3.0\n..."
        }
    ]
}
```

**Verification:**
- `type` is `vcard` or `multi_vcard`
- `vCardContacts` array contains shared contacts
- Each contact has `name`, `number`, and raw `vcard` data

---

### 14. Poll Messages

**How to trigger:**
Create a poll in the group.

**Test steps:**
1. Tap the attachment button
2. Select "Poll"
3. Enter a question and options
4. Send the poll
5. Have group members vote
6. Run the application

**Expected output in `group_chat.json`:**
```json
{
    "id": "...",
    "type": "poll_creation",
    "text": "What's your favorite color?"
}
```

**Expected output in `group_votes.json`:**
```json
[
    {
        "pollId": "POLL123",
        "pollTimestamp": 1702900000,
        "voterId": "972501234567",
        "voterPhone": "972501234567",
        "voterName": "John",
        "selectedOptions": ["Blue", "Green"],
        "timestamp": 1702900100
    }
]
```

**Verification:**
- `type` is `poll_creation` for the poll message
- `group_votes.json` file is created with vote data
- Each vote shows who voted and what they selected

---

## Testing Checklist

Use this checklist to verify all events work correctly:

| Event | Triggered | Data Captured | Notes |
|-------|-----------|---------------|-------|
| Text Message | [ ] | [ ] | Check `type: "chat"` |
| Reaction | [ ] | [ ] | Check `reactions` array |
| Reply | [ ] | [ ] | Check `isReply` and `replyInfo` |
| Image | [ ] | [ ] | Check `media/` folder |
| Video | [ ] | [ ] | Check `media/` folder |
| Voice Note | [ ] | [ ] | `type: "ptt"` |
| Document | [ ] | [ ] | Check `media/` folder |
| Sticker | [ ] | [ ] | `type: "sticker"` |
| GIF | [ ] | [ ] | Check `isGif: true` |
| Forwarded | [ ] | [ ] | Check `isForwarded: true` |
| Links | [ ] | [ ] | Check `links` array |
| Location | [ ] | [ ] | Check `location` object |
| Mentions | [ ] | [ ] | Check `mentionedIds` array |
| Contact | [ ] | [ ] | Check `vCardContacts` array |
| Poll | [ ] | [ ] | Check `group_votes.json` |
| Member Added | [ ] | [ ] | Check `membership_events.json` |
| Member Removed | [ ] | [ ] | Check `membership_events.json` |
| Member Left | [ ] | [ ] | Check `membership_events.json` |
| Ephemeral Message | [ ] | [ ] | Check `isEphemeral` |
| View Once | [ ] | [ ] | Check `isViewOnce` |
| Failed Media | [ ] | [ ] | Check `isFailedToDownload: true` |

---

## Troubleshooting

### No messages captured
- Ensure `FIRST_RUN=true` is set in `.env`
- Check that the group name matches the filter in `src/index.ts` (line 479)
- Verify you have at least one group chat

### Media not downloading
- Some media may be too old to download
- View once media may not be accessible
- Check console for "Could not download media" errors

### Reactions not showing
- Reactions only appear on messages that have reactions
- The `hasReaction` property must be true on the message

### Membership events not captured
- Only notification/system messages are parsed
- Events must be recent (within message fetch limit)
- Check for `type: "notification"` in raw messages

### LID not resolving to phone numbers
- LIDs are internal WhatsApp identifiers
- The cache builds over time from contacts
- Check `lid_mapping_cache.json` for mappings

---

## Data Structures Reference

### ChatMessage
```typescript
interface ChatMessage {
    id: string;              // Unique message ID
    timestamp: number;       // Unix timestamp
    type: string;           // chat, image, video, ptt, sticker, etc.
    text: string;           // Message text or caption
    sender: Sender;         // Who sent the message
    has_media: boolean;     // Whether message has media
    media_path: string | null;  // Path to downloaded media
    isFailedToDownload: boolean;  // True if media download failed
    isGif: boolean;         // True if video is actually a GIF
    isForwarded: boolean;   // True if message was forwarded
    links: Array<{          // URLs found in message
        link: string;
        isSuspicious: boolean;
    }>;
    location: {             // GPS coordinates (if location message)
        latitude: number;
        longitude: number;
        description?: string;
    } | null;
    mentionedIds: string[]; // User IDs mentioned with @
    vCardContacts: ContactInfo[];  // Contact cards shared in message
    reactions: Array<{      // List of reactions
        emoji: string;
        sender: Sender;
    }>;
    isReply: boolean;       // Is this a reply to another message
    replyInfo: ReplyInfo | null;  // Info about quoted message
    isEphemeral: boolean;   // Is disappearing message
    isViewOnce: boolean;    // Is view once message
    originalAuthorId: string;     // Original author ID
    resolvedAuthorId: string | null;  // Resolved phone number
    metadata: WhatsAppMetadata;   // WhatsApp-specific metadata
}
```

### WhatsAppMetadata
```typescript
interface WhatsAppMetadata {
    type: string;           // MessageTypes (chat, image, video, ptt, etc.)
    duration: number | null;  // Duration for video/audio in seconds
    groupMentions: Array<{  // Groups mentioned in message
        groupSubject: string;
        groupJid: { server: string; user: string; _serialized: string };
    }>;
}
```

### ContactInfo
```typescript
interface ContactInfo {
    name: string;           // Contact display name
    number: string;         // Phone number
    vcard: string;          // Raw vCard data
}
```

### PollVote
```typescript
interface PollVote {
    pollId: string;         // Poll message ID
    pollTimestamp: number;  // When poll was created
    voterId: string;        // Voter's user ID
    voterPhone: string | null;  // Voter's phone number
    voterName: string | null;   // Voter's display name
    selectedOptions: string[];  // Options they selected
    timestamp: number;      // When they voted
}
```

### MembershipEvent
```typescript
interface MembershipEvent {
    id: string;             // Event ID
    timestamp: number;      // Unix timestamp
    eventType: 'add' | 'remove' | 'leave' | 'invite' | 'create';
    affectedUsers: string[];  // Phone numbers affected
    performedBy: string | null;  // Who performed the action
    body: string;           // Event description
}
```

### Sender
```typescript
interface Sender {
    id: number | string;    // User ID or phone number
    username: string | null;  // WhatsApp display name
    first_name: string | null;  // Contact name
    last_name: string | null;   // (usually null)
    phone: string | null;   // Phone number
}
```
