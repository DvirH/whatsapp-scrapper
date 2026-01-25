# WhatsApp Data Fetcher

A tool to fetch and archive WhatsApp group data using whatsapp-web.js.

## Prerequisites

- Node.js 18+
- pnpm

## Installation

```bash
pnpm install
```

## Development

Run in development mode:

```bash
pnpm start --avatar=YOUR_AVATAR_NAME
```

Or using environment variable:

```bash
AVATAR_NAME=YOUR_AVATAR_NAME pnpm start
```

## Build

Compile TypeScript to JavaScript:

```bash
pnpm build
```

## Production

Run compiled version:

```bash
pnpm start:prod --avatar=YOUR_AVATAR_NAME
```

## Scheduler

Run with scheduler:

```bash
# Development
pnpm scheduler

# Production
pnpm scheduler:prod
```

### Scheduler Configuration

Edit `avatars.config.json` to configure:

```json
{
    "intervalHours": 6,
    "maxRetries": 3,
    "avatars": [
        { "name": "MyAvatar", "enabled": true }
    ]
}
```

| Setting | Description |
|---------|-------------|
| `intervalHours` | Hours between scans (e.g., `24` for daily) |
| `maxRetries` | Retry attempts on failure |
| `avatars` | List of accounts to scan |

## Configuration

Create a `.env` file:

```env
AVATAR_NAME=default
MEDIA_DOWNLOAD_TIMEOUT=10000
MEMBER_FETCH_CONCURRENCY=5
MEDIA_DOWNLOAD_CONCURRENCY=5
HISTORY_SYNC_WAIT_MS=3000
AUTH_TIMEOUT_MS=300000
```

## Output

Data is saved to `data/{AVATAR_NAME}/` with the following structure:

```
data/
└── {avatar}/
    ├── {group_name}_{id}/
    │   ├── media/
    │   │   └── users/
    │   └── {timestamp}/
    │       ├── group_info.json
    │       ├── group_members.json
    │       ├── group_chat.json
    │       └── media/
    ├── scan_metadata.json
    ├── user_image_cache.json
    └── lid_mapping_cache.json
```
