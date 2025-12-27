import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import pino from 'pino';
import treeKill from 'tree-kill';

// ============================================================================
// Configuration Interfaces
// ============================================================================

interface AvatarConfig {
    name: string;
    enabled: boolean;
}

interface SchedulerConfig {
    intervalHours: number;
    maxRetries: number;
    retryDelayMs: number;
    processTimeoutMs: number;
    inactivityTimeoutMs: number;
    avatars: AvatarConfig[];
}

interface AvatarRunResult {
    avatarName: string;
    success: boolean;
    startTime: string;
    endTime: string;
    durationMs: number;
    exitCode: number;
    errorMessage?: string;
    attempt: number;
}

interface RunHistoryEntry {
    runId: string;
    startTime: string;
    endTime: string;
    durationMs: number;
    avatarsProcessed: AvatarRunResult[];
    status: 'completed' | 'failed' | 'partial';
}

interface SchedulerState {
    lastRunStartTime: string | null;
    lastRunEndTime: string | null;
    nextScheduledRun: string | null;
    isRunning: boolean;
    currentAvatar: string | null;
    runHistory: RunHistoryEntry[];
}

// ============================================================================
// Logger Setup
// ============================================================================

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const DATA_DIR = path.join(process.cwd(), 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const transports = pino.transport({
    targets: [
        {
            target: 'pino-roll',
            options: {
                file: path.join(LOG_DIR, 'scheduler'),
                frequency: 'daily',
                mkdir: true,
                size: '10m',
                extension: '.jsonl',
                limit: { count: 14 }
            },
            level: 'debug'
        },
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

const logger = pino({
    level: 'debug',
    timestamp: pino.stdTimeFunctions.isoTime,
    base: { app: 'whatsapp-scheduler' }
}, transports);

// ============================================================================
// Utility Functions
// ============================================================================

function getISOTimestamp(): string {
    return new Date().toISOString();
}

function generateRunId(): string {
    return `run_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}m ${seconds}s`;
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// AvatarScheduler Class
// ============================================================================

class AvatarScheduler {
    private config: SchedulerConfig;
    private state: SchedulerState;
    private intervalHandle: NodeJS.Timeout | null = null;
    private isShuttingDown = false;
    private currentProcess: ChildProcess | null = null;
    private configPath: string;
    private statePath: string;

    constructor(configPath: string) {
        this.configPath = configPath;
        this.statePath = path.join(DATA_DIR, 'scheduler_state.json');
        this.config = this.loadConfig();
        this.state = this.loadState();
    }

    /**
     * Load configuration from JSON file
     */
    private loadConfig(): SchedulerConfig {
        if (!fs.existsSync(this.configPath)) {
            throw new Error(`Configuration file not found: ${this.configPath}`);
        }

        try {
            const content = fs.readFileSync(this.configPath, 'utf-8');
            const config = JSON.parse(content) as SchedulerConfig;

            // Validate required fields
            if (!config.avatars || !Array.isArray(config.avatars)) {
                throw new Error('Configuration must include "avatars" array');
            }
            if (typeof config.intervalHours !== 'number' || config.intervalHours <= 0) {
                throw new Error('Configuration must include valid "intervalHours" (positive number)');
            }

            // Apply defaults
            config.maxRetries = config.maxRetries || 3;
            config.retryDelayMs = config.retryDelayMs || 60000;
            config.processTimeoutMs = config.processTimeoutMs || 1800000; // 30 minutes
            config.inactivityTimeoutMs = config.inactivityTimeoutMs || 600000; // 10 minutes

            logger.info({
                intervalHours: config.intervalHours,
                avatarCount: config.avatars.length,
                enabledAvatars: config.avatars.filter(a => a.enabled).map(a => a.name)
            }, 'Configuration loaded');

            return config;
        } catch (error) {
            throw new Error(`Failed to parse configuration: ${error instanceof Error ? error.message : error}`);
        }
    }

    /**
     * Load scheduler state from file
     */
    private loadState(): SchedulerState {
        const defaultState: SchedulerState = {
            lastRunStartTime: null,
            lastRunEndTime: null,
            nextScheduledRun: null,
            isRunning: false,
            currentAvatar: null,
            runHistory: []
        };

        if (!fs.existsSync(this.statePath)) {
            return defaultState;
        }

        try {
            const content = fs.readFileSync(this.statePath, 'utf-8');
            return { ...defaultState, ...JSON.parse(content) };
        } catch {
            return defaultState;
        }
    }

    /**
     * Save scheduler state to file
     */
    private saveState(): void {
        try {
            fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 4));
        } catch (error) {
            logger.error({ error }, 'Failed to save scheduler state');
        }
    }

    /**
     * Ensure avatar data directory exists
     */
    private ensureAvatarDirectory(avatarName: string): void {
        const avatarPath = path.join(DATA_DIR, avatarName);
        if (!fs.existsSync(avatarPath)) {
            fs.mkdirSync(avatarPath, { recursive: true });
            logger.info({ avatarPath }, `Created directory for avatar: ${avatarName}`);
        }
    }

    /**
     * Spawn avatar process and wait for completion
     */
    private spawnAvatarProcess(avatarName: string): Promise<{ success: boolean; exitCode: number; output: string }> {
        return new Promise((resolve) => {
            const command = `npx ts-node src/index.ts --avatar=${avatarName}`;

            logger.info({ avatar: avatarName, command }, `Starting scan for avatar: ${avatarName}`);

            const child = spawn(command, {
                cwd: process.cwd(),
                stdio: ['ignore', 'pipe', 'pipe'],
                shell: true, // Required for Windows compatibility
                env: {
                    ...process.env,
                    AVATAR_NAME: avatarName
                }
            });

            this.currentProcess = child;
            let output = '';
            let lastActivityTime = Date.now();
            let killed = false;

            child.stdout.on('data', (data) => {
                lastActivityTime = Date.now();
                const line = data.toString();
                output += line;
                // Forward key log lines
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('[')) {
                    logger.debug({ avatar: avatarName }, trimmed);
                }
            });

            child.stderr.on('data', (data) => {
                lastActivityTime = Date.now();
                const line = data.toString();
                output += line;
                logger.warn({ avatar: avatarName }, line.trim());
            });

            // Activity-based timeout: kill only if no output for inactivityTimeoutMs
            const activityChecker = setInterval(() => {
                const inactiveMs = Date.now() - lastActivityTime;
                if (inactiveMs >= this.config.inactivityTimeoutMs && !killed) {
                    killed = true;
                    logger.error({ avatar: avatarName }, `Avatar ${avatarName} stuck - no output for ${formatDuration(inactiveMs)}, killing process`);

                    if (child.pid) {
                        treeKill(child.pid, 'SIGTERM', (err) => {
                            if (err) logger.error({ err }, 'Failed to kill process tree');
                        });
                        // Force kill after 5 seconds if still running
                        setTimeout(() => {
                            if (child.pid && !child.killed) {
                                treeKill(child.pid, 'SIGKILL');
                            }
                        }, 5000);
                    }
                }
            }, 60000); // Check every minute

            child.on('close', (code) => {
                clearInterval(activityChecker);
                this.currentProcess = null;
                resolve({
                    success: code === 0,
                    exitCode: code ?? -1,
                    output
                });
            });

            child.on('error', (err) => {
                clearInterval(activityChecker);
                this.currentProcess = null;
                logger.error({ err, avatar: avatarName }, 'Failed to spawn process');
                resolve({
                    success: false,
                    exitCode: -1,
                    output: `Spawn error: ${err.message}`
                });
            });
        });
    }

    /**
     * Run a single avatar with retry logic
     */
    private async runAvatar(avatarName: string): Promise<AvatarRunResult> {
        this.ensureAvatarDirectory(avatarName);
        this.state.currentAvatar = avatarName;
        this.saveState();

        for (let attempt = 1; attempt <= this.config.maxRetries; attempt++) {
            const startTime = getISOTimestamp();
            const startMs = Date.now();

            logger.info({ avatar: avatarName, attempt, maxRetries: this.config.maxRetries },
                `Running avatar ${avatarName} (attempt ${attempt}/${this.config.maxRetries})`);

            const result = await this.spawnAvatarProcess(avatarName);
            const endTime = getISOTimestamp();
            const durationMs = Date.now() - startMs;

            if (result.success) {
                logger.info({ avatar: avatarName, durationMs: formatDuration(durationMs) },
                    `Avatar ${avatarName} completed successfully`);
                return {
                    avatarName,
                    success: true,
                    startTime,
                    endTime,
                    durationMs,
                    exitCode: result.exitCode,
                    attempt
                };
            }

            logger.warn({ avatar: avatarName, attempt, exitCode: result.exitCode },
                `Avatar ${avatarName} failed on attempt ${attempt}`);

            if (attempt < this.config.maxRetries) {
                logger.info({ avatar: avatarName, delayMs: this.config.retryDelayMs },
                    `Retrying avatar ${avatarName} in ${formatDuration(this.config.retryDelayMs)}`);
                await sleep(this.config.retryDelayMs);
            }
        }

        // All retries exhausted
        return {
            avatarName,
            success: false,
            startTime: getISOTimestamp(),
            endTime: getISOTimestamp(),
            durationMs: 0,
            exitCode: -1,
            errorMessage: `Failed after ${this.config.maxRetries} attempts`,
            attempt: this.config.maxRetries
        };
    }

    /**
     * Run all enabled avatars sequentially
     */
    async runAllAvatars(): Promise<RunHistoryEntry> {
        const runId = generateRunId();
        const startTime = getISOTimestamp();
        const startMs = Date.now();

        this.state.isRunning = true;
        this.state.lastRunStartTime = startTime;
        this.saveState();

        const enabledAvatars = this.config.avatars.filter(a => a.enabled);
        logger.info({ runId, avatarCount: enabledAvatars.length },
            `Starting scheduled run for ${enabledAvatars.length} avatar(s)`);

        const results: AvatarRunResult[] = [];

        for (const avatar of enabledAvatars) {
            if (this.isShuttingDown) {
                logger.info({ avatar: avatar.name }, 'Shutdown requested, skipping remaining avatars');
                break;
            }

            const result = await this.runAvatar(avatar.name);
            results.push(result);
        }

        const endTime = getISOTimestamp();
        const durationMs = Date.now() - startMs;
        const successCount = results.filter(r => r.success).length;
        const failCount = results.filter(r => !r.success).length;

        let status: 'completed' | 'failed' | 'partial';
        if (failCount === 0) {
            status = 'completed';
        } else if (successCount === 0) {
            status = 'failed';
        } else {
            status = 'partial';
        }

        const historyEntry: RunHistoryEntry = {
            runId,
            startTime,
            endTime,
            durationMs,
            avatarsProcessed: results,
            status
        };

        // Update state
        this.state.isRunning = false;
        this.state.currentAvatar = null;
        this.state.lastRunEndTime = endTime;
        this.state.runHistory.unshift(historyEntry);
        // Keep only last 100 runs
        this.state.runHistory = this.state.runHistory.slice(0, 100);
        this.saveState();

        logger.info({
            runId,
            status,
            successCount,
            failCount,
            duration: formatDuration(durationMs)
        }, `Scheduled run ${status}: ${successCount} succeeded, ${failCount} failed`);

        return historyEntry;
    }

    /**
     * Calculate next scheduled run time
     */
    private getNextRunTime(): Date {
        const intervalMs = this.config.intervalHours * 60 * 60 * 1000;
        return new Date(Date.now() + intervalMs);
    }

    /**
     * Start the scheduler
     */
    start(): void {
        const intervalMs = this.config.intervalHours * 60 * 60 * 1000;

        logger.info({
            intervalHours: this.config.intervalHours,
            intervalMs
        }, `Starting scheduler with ${this.config.intervalHours} hour interval`);

        // Run immediately on start
        this.runAllAvatars().then(() => {
            // Update next scheduled run
            this.state.nextScheduledRun = this.getNextRunTime().toISOString();
            this.saveState();
            logger.info({ nextRun: this.state.nextScheduledRun }, 'Next scheduled run');
        });

        // Schedule subsequent runs
        this.intervalHandle = setInterval(async () => {
            if (this.state.isRunning) {
                logger.warn('Previous run still in progress, skipping this interval');
                return;
            }

            await this.runAllAvatars();

            // Update next scheduled run
            this.state.nextScheduledRun = this.getNextRunTime().toISOString();
            this.saveState();
            logger.info({ nextRun: this.state.nextScheduledRun }, 'Next scheduled run');
        }, intervalMs);

        // Handle graceful shutdown
        process.on('SIGINT', () => this.stop('SIGINT'));
        process.on('SIGTERM', () => this.stop('SIGTERM'));

        logger.info('Scheduler started. Press Ctrl+C to stop.');
    }

    /**
     * Stop the scheduler gracefully
     */
    async stop(signal?: string): Promise<void> {
        if (this.isShuttingDown) {
            logger.warn('Shutdown already in progress');
            return;
        }

        this.isShuttingDown = true;
        logger.info({ signal }, 'Stopping scheduler...');

        // Clear the interval
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }

        // Wait for current process to complete if running
        if (this.currentProcess && !this.currentProcess.killed) {
            logger.info('Waiting for current avatar process to complete...');
            this.currentProcess.kill('SIGTERM');

            // Wait up to 30 seconds for graceful shutdown
            await new Promise<void>((resolve) => {
                const timeout = setTimeout(() => {
                    if (this.currentProcess && !this.currentProcess.killed) {
                        logger.warn('Force killing avatar process');
                        this.currentProcess.kill('SIGKILL');
                    }
                    resolve();
                }, 30000);

                if (this.currentProcess) {
                    this.currentProcess.on('close', () => {
                        clearTimeout(timeout);
                        resolve();
                    });
                } else {
                    clearTimeout(timeout);
                    resolve();
                }
            });
        }

        // Update state
        this.state.isRunning = false;
        this.state.currentAvatar = null;
        this.state.nextScheduledRun = null;
        this.saveState();

        logger.info('Scheduler stopped');
        process.exit(0);
    }
}

// ============================================================================
// Main Entry Point
// ============================================================================

const CONFIG_PATH = path.join(process.cwd(), 'avatars.config.json');

try {
    const scheduler = new AvatarScheduler(CONFIG_PATH);
    scheduler.start();
} catch (error) {
    logger.fatal({ error }, 'Failed to start scheduler');
    process.exit(1);
}
