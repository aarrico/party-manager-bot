import { config } from 'dotenv';
config();
import 'source-map-support/register.js';
import { ExtendedClient } from './shared/discord/ExtendedClient.js';
import { PrismaClient, Prisma } from './generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { getRoles } from './modules/role/repository/role.repository.js';
import { createActionRowOfButtons } from './shared/discord/buttons.js';
import { ActionRowBuilder, ButtonBuilder, Events } from 'discord.js';
import { setRoleCache } from './modules/role/domain/roleManager.js';
import { sessionScheduler } from './services/sessionScheduler.js';
import { createScopedLogger } from '#shared/logging/logger.js';
import { createAdminServer } from '#shared/http/adminServer.js';

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const appLogger = createScopedLogger('Bootstrap');
const schedulerLogger = createScopedLogger('SessionScheduler');
const shutdownLogger = createScopedLogger('Shutdown');
const prismaLogger = createScopedLogger('Prisma');
const prismaLogConfig: Prisma.LogDefinition[] = [
  { level: 'warn', emit: 'event' },
  { level: 'error', emit: 'event' },
];

const logPrismaQueries = process.env.LOG_PRISMA_QUERIES === 'true';

if (logPrismaQueries) {
  prismaLogConfig.push(
    { level: 'query', emit: 'event' },
    { level: 'info', emit: 'event' }
  );
}

export const client = new ExtendedClient();
export const prisma = new PrismaClient({ adapter, log: prismaLogConfig });
export let roleButtons: ActionRowBuilder<ButtonBuilder>[];

prisma.$on('warn', (event) => {
  prismaLogger.warn(event.message, { target: event.target });
});

prisma.$on('error', (event) => {
  prismaLogger.error(event.message, { target: event.target });
});

if (logPrismaQueries) {
  prisma.$on('info', (event) => {
    prismaLogger.info(event.message, { target: event.target });
  });

  prisma.$on('query', (event) => {
    prismaLogger.debug('Prisma query executed', {
      query: event.query,
      params: event.params,
      durationMs: event.duration,
      target: event.target,
    });
  });
}

await (async () => {
  try {
    const roles = await getRoles();
    setRoleCache(roles);
    roleButtons = createActionRowOfButtons(roles);

    client.once(Events.ClientReady, (readyClient) => {
      void client.start();
      appLogger.info('Discord client ready', { userTag: readyClient.user.tag });

      void (async () => {
        try {
          schedulerLogger.info('Starting session scheduler initialization...');
          await sessionScheduler.initializeExistingSessions();
          schedulerLogger.info(
            '✅ Session scheduler initialized successfully',
            {
              scheduledTasks: sessionScheduler.getScheduledTaskCount(),
            }
          );
        } catch (error) {
          schedulerLogger.error('❌ Failed to initialize session scheduler', {
            error,
          });
        }
      })();
    });

    await client.login(process.env.DISCORD_TOKEN);
  } catch (error) {
    appLogger.error('Failed during bootstrap', { error });
  }
})();

// HTTP server for health checks and admin API
const httpPort = parseInt(process.env.PORT || '3000', 10);
const httpServer = createAdminServer();
httpServer.listen(httpPort, () => {
  appLogger.info(`HTTP server listening on port ${httpPort}`);
});

// Graceful shutdown handling
async function gracefulShutdown(signal: string): Promise<void> {
  shutdownLogger.info(`${signal} received. Starting graceful shutdown...`);

  try {
    // Stop the session scheduler
    shutdownLogger.info('Stopping session scheduler...');
    if (sessionScheduler && typeof sessionScheduler.shutdown === 'function') {
      sessionScheduler.shutdown();
    }

    // Close HTTP server
    shutdownLogger.info('Closing HTTP server...');
    httpServer.close();

    // Destroy Discord client connection
    shutdownLogger.info('Closing Discord connection...');
    await client.destroy();

    // Disconnect from database
    shutdownLogger.info('Closing database connection...');
    await prisma.$disconnect();

    shutdownLogger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    shutdownLogger.error('Error during graceful shutdown', { error });
    process.exit(1);
  }
}

// Handle termination signals
process.on('SIGTERM', () => void gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => void gracefulShutdown('SIGINT'));
