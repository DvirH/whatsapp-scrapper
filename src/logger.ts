import pino from 'pino';
import * as path from 'path';
import * as fs from 'fs';

// Configuration from environment
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_RETENTION_DAYS = parseInt(process.env.LOG_RETENTION_DAYS || '14', 10);
const LOG_MAX_SIZE = process.env.LOG_MAX_SIZE || '10m';

// Use DATA_DIR pattern from main application
const DATA_DIR = path.join(process.cwd(), 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');

// Ensure log directory exists synchronously at module load
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Transport configuration
const transports = pino.transport({
    targets: [
        // File transport - JSON Lines format with rotation
        {
            target: 'pino-roll',
            options: {
                file: path.join(LOG_DIR, 'whatsapp'),
                frequency: 'daily',
                mkdir: true,
                size: LOG_MAX_SIZE,
                extension: '.jsonl',
                limit: { count: LOG_RETENTION_DAYS }
            },
            level: 'debug'
        },
        // Console transport - human-readable format
        {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:HH:MM:ss',
                ignore: 'pid,hostname',
                customColors: 'info:cyan,warn:yellow,error:red,debug:gray'
            },
            level: LOG_LEVEL
        }
    ]
});

// Create the logger instance
const logger = pino({
    level: 'debug', // Set to lowest level; transports filter individually
    timestamp: pino.stdTimeFunctions.isoTime,
    base: {
        app: 'whatsapp-collector'
    }
}, transports);

export default logger;
