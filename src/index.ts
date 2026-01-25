import { getAvatarName, DATA_DIR } from './config';
import { initializeWithRetry } from './client';
import { serializeError } from './utils';
import logger from './logger';

/**
 * Main entry point for the WhatsApp data fetcher.
 */
async function main(): Promise<void> {
    // Parse avatar name from CLI arguments or environment variable
    const avatarName = getAvatarName();

    logger.info('Starting WhatsApp client...');
    logger.info(`Avatar: ${avatarName}`);
    logger.info(`Data will be saved to: ${DATA_DIR}`);
    logger.info('');

    const success = await initializeWithRetry(avatarName);

    if (!success) {
        logger.fatal('Failed to authenticate after all retries');
        process.exit(1);
    }
}

main().catch((error) => {
    logger.fatal({ err: serializeError(error) }, 'Unhandled error in main');
    process.exit(1);
});
