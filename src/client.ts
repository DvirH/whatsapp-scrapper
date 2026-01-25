import * as fs from 'fs';
import * as path from 'path';
import { Client, LocalAuth } from 'whatsapp-web.js';
import * as qrcode from 'qrcode-terminal';
import { InitializationsLog, InitializationAttempt, ScanTiming } from './types';
import { AUTH_TIMEOUT_MS, AUTH_MAX_RETRIES, DATA_DIR } from './config';
import { ensureDir, getISOTimestamp, withTimeout, serializeError } from './utils';
import { processGroups } from './processors/group';
import logger from './logger';

// ============================================================================
// Global State
// ============================================================================

let client: Client;
let isShuttingDown = false;
let isClientReady = false;
let authAttempts = 0;
let currentAvatarName: string;

/**
 * Get the current WhatsApp client instance.
 */
export function getClient(): Client {
    return client;
}

/**
 * Get the current avatar name.
 */
export function getAvatarNameFromClient(): string {
    return currentAvatarName;
}

// ============================================================================
// Shutdown Handling
// ============================================================================

/**
 * Gracefully shutdown the client and exit.
 */
export async function gracefulShutdown(exitCode: number = 0, reason: string = 'unknown'): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`Shutting down: ${reason}`);

    if (isClientReady) {
        try {
            await client.destroy();
            logger.info('Client destroyed successfully');
        } catch (error) {
            logger.error({ err: serializeError(error) }, 'Error destroying client');
        }
    }

    process.exit(exitCode);
}

// Handle Ctrl+C
process.on('SIGINT', () => {
    gracefulShutdown(0, 'SIGINT');
});

// Handle kill signal
process.on('SIGTERM', () => {
    gracefulShutdown(0, 'SIGTERM');
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.fatal({ err: serializeError(error) }, 'Uncaught exception');
    gracefulShutdown(1, 'uncaughtException');
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: serializeError(reason) }, 'Unhandled rejection');
    gracefulShutdown(1, 'unhandledRejection');
});

// ============================================================================
// Initialization Logging
// ============================================================================

/**
 * Logs an initialization attempt (success or failure) to initializations.json.
 */
function logInitializationAttempt(avatarPath: string, success: boolean, reason?: string): void {
    const logPath = path.join(avatarPath, 'initializations.json');
    ensureDir(avatarPath);

    // Load existing log or create new one
    let log: InitializationsLog;
    if (fs.existsSync(logPath)) {
        try {
            log = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
        } catch {
            log = { lastUpdated: getISOTimestamp(), attempts: [] };
        }
    } else {
        log = { lastUpdated: getISOTimestamp(), attempts: [] };
    }

    // Add new attempt
    const attempt: InitializationAttempt = {
        timestamp: getISOTimestamp(),
        attempt: authAttempts,
        success: success
    };
    if (reason) {
        attempt.reason = reason;
        attempt.errorDetails = reason;
    }

    log.attempts.push(attempt);
    log.lastUpdated = getISOTimestamp();

    fs.writeFileSync(logPath, JSON.stringify(log, null, 4));

    if (success) {
        logger.info(`Initialization succeeded on attempt ${authAttempts}. Logged to ${logPath}`);
    } else {
        logger.warn(`Initialization attempt ${authAttempts} failed: ${reason}. Logged to ${logPath}`);
    }
}

/**
 * Updates the scan status in initializations.json.
 */
export function updateScanStatus(
    avatarPath: string,
    status: 'in_progress' | 'completed' | 'failed',
    options?: { groupsProcessed?: number; errorMessage?: string }
): void {
    const logPath = path.join(avatarPath, 'initializations.json');
    ensureDir(avatarPath);

    // Load existing log or create new one
    let log: InitializationsLog;
    if (fs.existsSync(logPath)) {
        try {
            log = JSON.parse(fs.readFileSync(logPath, 'utf-8'));
        } catch {
            log = { lastUpdated: getISOTimestamp(), attempts: [] };
        }
    } else {
        log = { lastUpdated: getISOTimestamp(), attempts: [] };
    }

    const now = getISOTimestamp();

    if (status === 'in_progress') {
        log.currentScan = {
            scanStartTime: now,
            scanStatus: 'in_progress'
        };
    } else {
        const startTime = log.currentScan?.scanStartTime;
        const scanDurationMs = startTime
            ? new Date(now).getTime() - new Date(startTime).getTime()
            : undefined;

        log.currentScan = {
            scanStartTime: startTime || now,
            scanFinishTime: now,
            scanStatus: status,
            scanDurationMs,
            groupsProcessed: options?.groupsProcessed,
            errorMessage: options?.errorMessage
        };

        // Also update the most recent successful attempt with scan timing
        if (log.attempts.length > 0) {
            const lastAttempt = log.attempts[log.attempts.length - 1];
            if (lastAttempt.success) {
                lastAttempt.scanTiming = { ...log.currentScan };
            }
        }
    }

    log.lastUpdated = now;
    fs.writeFileSync(logPath, JSON.stringify(log, null, 4));
    logger.info(`Scan status updated to '${status}' for avatar ${currentAvatarName}`);
}

// ============================================================================
// Event Handlers
// ============================================================================

/**
 * Sets up event handlers on the client.
 */
function setupEventHandlers(clientInstance: Client): void {
    clientInstance.on('qr', (qr: string) => {
        logger.info('\n========================================');
        logger.info('Scan this QR code with WhatsApp:');
        logger.info('========================================\n');
        qrcode.generate(qr, { small: true });
    });

    clientInstance.on('authenticated', () => {
        logger.info('Authenticated successfully!');
    });

    clientInstance.on('disconnected', (reason: string) => {
        logger.warn(`Client disconnected: ${reason}`);
    });

    clientInstance.on('ready', async () => {
        isClientReady = true;
        logger.info('\n========================================');
        logger.info('WhatsApp Client is ready!');
        logger.info('========================================\n');

        const avatarPath = path.join(DATA_DIR, currentAvatarName);
        updateScanStatus(avatarPath, 'in_progress');

        try {
            const result = await processGroups(client, currentAvatarName);
            updateScanStatus(avatarPath, 'completed', { groupsProcessed: result.groupsProcessed });
            logger.info('\nData collection complete!');
            await gracefulShutdown(0, 'complete');
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            updateScanStatus(avatarPath, 'failed', { errorMessage });
            logger.error({ err: serializeError(error) }, 'Error processing groups');
            await gracefulShutdown(1, 'processing_error');
        }
    });
}

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initializes the WhatsApp client with retry logic.
 */
export async function initializeWithRetry(avatarName: string): Promise<boolean> {
    currentAvatarName = avatarName;
    const avatarPath = path.join(DATA_DIR, avatarName);
    ensureDir(avatarPath);

    for (let attempt = 1; attempt <= AUTH_MAX_RETRIES; attempt++) {
        authAttempts = attempt;
        logger.info(`\nAuthentication attempt ${attempt}/${AUTH_MAX_RETRIES}`);

        // Reset state for new attempt
        isClientReady = false;
        isShuttingDown = false;

        // Create new client instance
        client = new Client({
            authStrategy: new LocalAuth({
                clientId: avatarName,
                dataPath: './.wwebjs_auth'
            }),
            puppeteer: {
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            }
        });

        // Setup event handlers
        setupEventHandlers(client);

        try {
            // Create promise that resolves when client is ready or rejects on auth failure
            const authPromise = new Promise<void>((resolve, reject) => {
                client.on('ready', () => resolve());
                client.on('auth_failure', (msg: string) => reject(new Error(`Auth failed: ${msg}`)));
            });

            // Start initialization
            client.initialize();
            logger.info(`Waiting up to ${AUTH_TIMEOUT_MS / 60000} minutes for authentication...`);

            // Wait for ready with timeout
            await withTimeout(
                authPromise,
                AUTH_TIMEOUT_MS,
                `Authentication timeout after ${AUTH_TIMEOUT_MS / 1000} seconds`
            );

            // If we reach here, authentication succeeded
            logger.info('Client initialized successfully!');
            logInitializationAttempt(avatarPath, true);
            return true;

        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            logInitializationAttempt(avatarPath, false, errorMessage);

            // Cleanup before retry
            try {
                await client.destroy();
            } catch (e) {
                // Ignore cleanup errors
            }

            if (attempt === AUTH_MAX_RETRIES) {
                logger.error(`Authentication failed after ${authAttempts} attempts`);
                return false;
            }

            // Wait 2 seconds before retry
            logger.info('Waiting 2 seconds before retry...');
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    return false;
}
