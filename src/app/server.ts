import logger from './services/logger.service';
import { config } from 'dotenv';
import { connectToDB } from './db';
import { configureExpressApp } from './app';
import { planService } from './services/plan.service';

import { createServer } from 'http';
import mongoose from 'mongoose';
import { initializeSocketService } from './services/socket.service';
import { validateEncryptionKey } from './config/encryption-config';
import { subscriptionExpiryReminderJob } from './jobs/subscription-expiry-reminder.job';
import { notificationArchivalJob } from './jobs/notification-archival.job';
import { sessionCleanupJob } from './jobs/session-cleanup.job';
import { permissionExpiryJob } from './jobs/permission-expiry.job';
import { auditLogRetentionJob } from './jobs/audit-log-retention.job';
import { analyticsReportScheduleJob } from './jobs/analytics-report-schedule.job';

const DEFAULT_PORT = 3000;

/**
 * Validate that all required environment variables are set
 * @throws Error if any required variable is missing
 */
function validateEnvironmentVariables(): void {
  const required = [
    'MONGO_URI',
    'ACCESS_TOKEN_SECRET',
    'REFRESH_TOKEN_SECRET',
    'ENCRYPTION_KEY',
  ];

  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}\n` +
        'Please check your .env file and ensure all required variables are set.\n' +
        'See .env.example for reference.'
    );
  }

  validateEncryptionKey(process.env.ENCRYPTION_KEY);

  logger.info('[server]: Environment variables validated successfully ✓');
}

const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Railway (and most hosts) send SIGTERM on every redeploy. Stop scheduled jobs,
 * close Socket.IO and the HTTP server so in-flight requests can finish, then
 * close MongoDB. A hard timeout guarantees the process still exits.
 */
function registerGracefulShutdown(closeServer: () => Promise<void>): void {
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[server]: ${signal} received, shutting down gracefully`);

    const forceExit = setTimeout(() => {
      logger.error('[server]: Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceExit.unref();

    try {
      subscriptionExpiryReminderJob.stop();
      notificationArchivalJob.stop();
      sessionCleanupJob.stop();
      permissionExpiryJob.stop();
      auditLogRetentionJob.stop();
      analyticsReportScheduleJob.stop();
      await closeServer();
      await mongoose.connection.close();
      logger.info('[server]: Shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error('[server]: Error during shutdown', error as Error);
      process.exit(1);
    }
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

async function startServer() {
  try {
    config();
    if (process.env.NODE_ENV !== 'production') {
    }

    // Validate environment variables before starting
    validateEnvironmentVariables();

    await connectToDB();

    // Seed default subscription plans
    await planService.seedDefaultPlans();

    const app = configureExpressApp();
    const httpServer = createServer(app);

    // Initialize WebSockets
    const socketService = initializeSocketService(httpServer);

    const port = process.env.PORT ?? DEFAULT_PORT;
    httpServer.listen(port, () => {
      logger.info(`[server]: Server is running at http://localhost:${port}`);
      subscriptionExpiryReminderJob.start();
      notificationArchivalJob.start();
      sessionCleanupJob.start();
      permissionExpiryJob.start();
      auditLogRetentionJob.start();
      analyticsReportScheduleJob.start();
    });

    registerGracefulShutdown(() => socketService.close());
  } catch (error) {
    logger.error('Failed to start server:', error as Error);
    process.exit(1);
  }
}

startServer().catch((error) => {
  logger.error('Failed to start server:', error as Error);
  process.exit(1);
});
