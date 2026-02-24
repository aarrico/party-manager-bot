import { CronJob } from 'cron';
import {
  getSessionById,
  getSessions,
  updateSession,
} from '../modules/session/repository/session.repository.js';
import { SessionWithParty } from '../modules/session/domain/session.types.js';
import {
  getHoursBefore,
  getMinutesBefore,
  getHoursAfter,
  formatSessionDateLong,
  isFutureDate,
} from '../shared/datetime/dateUtils.js';
import { createScopedLogger } from '#shared/logging/logger.js';
import { getUserTimezone } from '../modules/user/repository/user.repository.js';
import { notifyParty } from '../shared/discord/messages.js';

const logger = createScopedLogger('SessionSchedulerService');

interface ScheduledTask {
  sessionId: string;
  reminderJob?: CronJob;
  cancellationJob?: CronJob;
  completionJob?: CronJob;
}

class SessionScheduler {
  private static instance: SessionScheduler;
  private scheduledTasks: Map<string, ScheduledTask> = new Map();

  private constructor() {}

  public static getInstance(): SessionScheduler {
    if (!SessionScheduler.instance) {
      SessionScheduler.instance = new SessionScheduler();
    }
    return SessionScheduler.instance;
  }

  public scheduleSessionTasks(sessionId: string, sessionDate: Date): void {
    this.cancelSessionTasks(sessionId);

    const reminderTime = getHoursBefore(sessionDate, 1); // 1 hour before
    const cancelTime = getMinutesBefore(sessionDate, 5); // 5 minutes before start
    const completionTime = getHoursAfter(sessionDate, 5); // 5 hours after start

    const task: ScheduledTask = { sessionId };

    logger.info('Scheduling tasks for session', {
      sessionId,
      sessionDate: sessionDate.toISOString(),
      reminderTime: reminderTime.toISOString(),
      cancelTime: cancelTime.toISOString(),
      completionTime: completionTime.toISOString(),
    });

    if (isFutureDate(reminderTime)) {
      const reminderJob = new CronJob(
        reminderTime,
        () => this.handleReminder(sessionId),
        null,
        true,
        'UTC'
      );
      task.reminderJob = reminderJob;
      logger.info('✅ Scheduled reminder job', {
        sessionId,
        reminderTime: reminderTime.toISOString(),
      });
    } else {
      logger.info('⏭️ Reminder time already passed, skipping', {
        sessionId,
        reminderTime: reminderTime.toISOString(),
      });
    }

    if (isFutureDate(cancelTime)) {
      const cancellationJob = new CronJob(
        cancelTime,
        () => this.handleCancellation(sessionId),
        null,
        true,
        'UTC'
      );
      task.cancellationJob = cancellationJob;
      logger.info('✅ Scheduled cancellation check job', {
        sessionId,
        cancelTime: cancelTime.toISOString(),
      });
    } else {
      logger.info('⏭️ Cancellation time already passed, skipping', {
        sessionId,
        cancelTime: cancelTime.toISOString(),
      });
    }

    if (isFutureDate(completionTime)) {
      const completionJob = new CronJob(
        completionTime,
        () => this.handleCompletion(sessionId),
        null,
        true,
        'UTC'
      );
      task.completionJob = completionJob;
      logger.info('✅ Scheduled completion job', {
        sessionId,
        completionTime: completionTime.toISOString(),
      });
    } else {
      logger.info('⏭️ Completion time already passed, skipping', {
        sessionId,
        completionTime: completionTime.toISOString(),
      });
    }

    if (task.reminderJob || task.cancellationJob || task.completionJob) {
      this.scheduledTasks.set(sessionId, task);
      logger.info('Session tasks registered', {
        sessionId,
        hasReminder: !!task.reminderJob,
        hasCancellation: !!task.cancellationJob,
        hasCompletion: !!task.completionJob,
      });
    } else {
      logger.info('No tasks scheduled, all times passed', { sessionId });
    }
  }

  public cancelSessionTasks(sessionId: string): void {
    const task = this.scheduledTasks.get(sessionId);
    if (task) {
      if (task.reminderJob) {
        task.reminderJob.stop();
      }
      if (task.cancellationJob) {
        task.cancellationJob.stop();
      }
      if (task.completionJob) {
        task.completionJob.stop();
      }
      this.scheduledTasks.delete(sessionId);
      logger.info('Canceled scheduled tasks', { sessionId });
    }
  }

  private clearReminderTask(sessionId: string): void {
    const task = this.scheduledTasks.get(sessionId);
    if (!task?.reminderJob) {
      return;
    }

    try {
      task.reminderJob.stop();
    } catch (error) {
      logger.error('Failed to stop reminder job', { sessionId, error });
    }

    task.reminderJob = undefined;

    if (!task.cancellationJob && !task.completionJob) {
      this.scheduledTasks.delete(sessionId);
      logger.info('Cleared reminder task; no other jobs remained', {
        sessionId,
      });
    } else {
      this.scheduledTasks.set(sessionId, task);
      logger.info('Cleared reminder task; other jobs still scheduled', {
        sessionId,
        hasCancellation: !!task.cancellationJob,
        hasCompletion: !!task.completionJob,
      });
    }
  }

  private async handleReminder(sessionId: string): Promise<void> {
    logger.info('Handling session reminder', { sessionId });

    try {
      const session = await getSessionById(sessionId, true);

      logger.debug('Session reminder context', {
        sessionId,
        sessionName: session.name,
        partySize: session.partyMembers.length,
      });

      // Send reminder DMs to party members (status will change to ACTIVE at 5 min mark)
      await this.sendSessionReminders(session);
      logger.info('Session reminder completed', { sessionId });
    } catch (error) {
      logger.error('Error handling reminder for session', { sessionId, error });
    } finally {
      this.clearReminderTask(sessionId);
    }
  }

  private async handleCancellation(sessionId: string): Promise<void> {
    logger.info('Handling session cancellation check', { sessionId });

    try {
      const session = await getSessionById(sessionId, true);

      const isPartyFull = session.partyMembers.length >= 6;
      logger.debug('Session cancellation context', {
        sessionId,
        sessionName: session.name,
        partySize: session.partyMembers.length,
        isPartyFull,
        willCancel: !isPartyFull,
      });

      if (!isPartyFull) {
        await this.cancelUnfilledSession(session);
      } else {
        logger.info('Session has full party; skipping cancellation', {
          sessionId,
          partySize: session.partyMembers.length,
        });

        try {
          await updateSession(session.id, { status: 'ACTIVE' });
          logger.info('Updated session status to ACTIVE after full party', {
            sessionId: session.id,
          });
        } catch (error) {
          logger.error('Failed to update session status to ACTIVE', {
            sessionId: session.id,
            error,
          });
        }

        try {
          const { regenerateSessionMessage } = await import(
            '../modules/session/controller/session.controller.js'
          );
          await regenerateSessionMessage(session.id);
          logger.info(
            'Regenerated and updated session message with ACTIVE status',
            {
              sessionId: session.id,
            }
          );
        } catch (error) {
          logger.error(
            'Failed to regenerate session message during cancellation handling',
            { sessionId: session.id, error }
          );
        }
      }

      this.cancelSessionTasks(sessionId);
      logger.info('Session cancellation check completed', {
        sessionId,
        wasCanceled: !isPartyFull,
      });
    } catch (error) {
      logger.error('Error handling cancellation for session', {
        sessionId,
        error,
      });
    }
  }

  private async handleCompletion(sessionId: string): Promise<void> {
    logger.info('Handling session auto-completion', { sessionId });

    try {
      const session = await getSessionById(sessionId, true);

      // Only auto-complete if session is still ACTIVE
      if (session.status !== 'ACTIVE') {
        logger.info('Session is not ACTIVE, skipping auto-completion', {
          sessionId,
          currentStatus: session.status,
        });
        return;
      }

      const { endSession } = await import(
        '../modules/session/controller/session.controller.js'
      );
      await endSession(sessionId);
      logger.info('Session auto-completed after 5 hours', { sessionId });
    } catch (error) {
      logger.error('Error handling auto-completion for session', {
        sessionId,
        error,
      });
    } finally {
      this.cancelSessionTasks(sessionId);
    }
  }

  private async sendSessionReminders(session: SessionWithParty): Promise<void> {
    logger.info('Sending session reminders', {
      sessionId: session.id,
      sessionName: session.name,
      partySize: session.partyMembers.length,
    });

    const partyMemberIds = session.partyMembers.map((member) => member.userId);

    await notifyParty(partyMemberIds, async (userId: string) => {
      const userTimezone = await getUserTimezone(userId);
      return this.createReminderMessage(session, userTimezone);
    });

    logger.info('Session reminders sent', { sessionId: session.id });
  }

  private async cancelUnfilledSession(
    session: SessionWithParty
  ): Promise<void> {
    logger.warn('Cancelling unfilled session', {
      sessionId: session.id,
      sessionName: session.name,
      partySize: session.partyMembers.length,
    });

    try {
      const { cancelSession } = await import(
        '../modules/session/controller/session.controller.js'
      );
      const cancellationReason = `Insufficient players (${session.partyMembers.length}/6)`;
      await cancelSession(session.id, cancellationReason);
      logger.info('Successfully canceled unfilled session', {
        sessionId: session.id,
      });
    } catch (error) {
      logger.error('Failed to cancel unfilled session', {
        sessionId: session.id,
        error,
      });

      // Try direct database update as fallback
      try {
        await updateSession(session.id, { status: 'CANCELED' });
        logger.warn('Fallback: updated session status to CANCELED directly', {
          sessionId: session.id,
        });
      } catch (fallbackError) {
        logger.error('Fallback cancellation update failed', {
          sessionId: session.id,
          error: fallbackError,
        });
      }
    }
  }

  private createReminderMessage(
    session: SessionWithParty,
    timezone: string
  ): string {
    const sessionTime = formatSessionDateLong(session.date, timezone);

    return (
      `⏰ **Session Reminder**\n\n` +
      `🎲 **[${session.name}](https://discord.com/channels/${session.guildId}/${session.campaignId}/${session.id})** starts in 1 hour!\n` +
      `📅 **Time:** ${sessionTime}\n` +
      `🏰 **Channel:** <#${session.campaignId}>\n` +
      `👥 **Party Size:** ${session.partyMembers.length}/6 members\n\n` +
      `See you at the table! 🎯`
    );
  }

  public async initializeExistingSessions(): Promise<void> {
    try {
      logger.info('🔄 Initializing session scheduler...');

      const allSessions = await getSessions({
        includeId: true,
        includeTime: true,
        includeCampaign: false,
        includeUserRole: false,
      });

      // Filter to only active/scheduled/full sessions
      const pendingSessions = allSessions.filter((session) =>
        ['SCHEDULED', 'FULL', 'ACTIVE'].includes(session.status)
      );

      logger.info('📅 Pending sessions found', {
        totalSessions: allSessions.length,
        pendingSessions: pendingSessions.length,
      });

      // Handle sessions that may have been missed during downtime
      await this.handleMissedSessions(pendingSessions);

      // Schedule future tasks for remaining valid sessions
      const futureSessions = pendingSessions.filter((session) =>
        isFutureDate(session.date)
      );

      if (futureSessions.length === 0) {
        logger.info('ℹ️  No future sessions to schedule');
      } else {
        for (const session of futureSessions) {
          logger.info('📝 Scheduling session', {
            sessionId: session.id,
            sessionDate: session.date.toISOString(),
          });
          this.scheduleSessionTasks(session.id, session.date);
        }
      }

      logger.info('✅ Session scheduler initialization complete', {
        scheduledSessions: futureSessions.length,
        totalTasks: this.scheduledTasks.size,
      });
    } catch (error) {
      logger.error('❌ Error initializing session scheduler', { error });
    }
  }

  /**
   * Handle sessions that may have been missed during bot downtime.
   * - ACTIVE sessions past completion window → auto-complete
   * - SCHEDULED/FULL sessions past start time with full party → mark ACTIVE and schedule completion
   * - SCHEDULED/FULL sessions past start time without full party → cancel
   */
  private async handleMissedSessions(
    sessions: { id: string; date: Date; status: string }[]
  ): Promise<void> {
    for (const session of sessions) {
      const sessionStart = session.date;
      const completionTime = getHoursAfter(sessionStart, 5);

      if (!isFutureDate(sessionStart)) {
        try {
          if (session.status === 'ACTIVE' && !isFutureDate(completionTime)) {
            logger.info(
              '🔧 Found ACTIVE session past completion window, auto-completing',
              {
                sessionId: session.id,
                sessionDate: sessionStart.toISOString(),
                completionTime: completionTime.toISOString(),
              }
            );

            const { endSession } = await import(
              '../modules/session/controller/session.controller.js'
            );
            await endSession(session.id);
            continue;
          }

          if (session.status === 'ACTIVE' && isFutureDate(completionTime)) {
            logger.info(
              '🔧 Found ACTIVE session within completion window, scheduling completion',
              {
                sessionId: session.id,
                completionTime: completionTime.toISOString(),
              }
            );
            this.scheduleSessionTasks(session.id, sessionStart);
            continue;
          }

          if (session.status === 'SCHEDULED' || session.status === 'FULL') {
            const fullSession = await getSessionById(session.id, true);
            const isPartyFull = fullSession.partyMembers.length >= 6;

            if (isPartyFull) {
              logger.info(
                '🔧 Found past SCHEDULED/FULL session with full party, marking ACTIVE',
                {
                  sessionId: session.id,
                  partySize: fullSession.partyMembers.length,
                }
              );

              await updateSession(session.id, { status: 'ACTIVE' });

              if (isFutureDate(completionTime)) {
                this.scheduleSessionTasks(session.id, sessionStart);
              } else {
                const { endSession } = await import(
                  '../modules/session/controller/session.controller.js'
                );
                await endSession(session.id);
              }
            } else {
              logger.info(
                '🔧 Found past SCHEDULED/FULL session without full party, canceling',
                {
                  sessionId: session.id,
                  partySize: fullSession.partyMembers.length,
                }
              );

              const { cancelSession } = await import(
                '../modules/session/controller/session.controller.js'
              );
              await cancelSession(
                session.id,
                'Session was not filled before start time (recovered after bot restart)'
              );
            }
          }
        } catch (error) {
          logger.error('❌ Error handling missed session', {
            sessionId: session.id,
            status: session.status,
            error,
          });
        }
      }
    }
  }

  public getScheduledTaskCount(): number {
    return this.scheduledTasks.size;
  }

  public shutdown(): void {
    logger.info('Shutting down session scheduler', {
      activeTasks: this.scheduledTasks.size,
    });

    for (const [sessionId, task] of this.scheduledTasks.entries()) {
      try {
        if (task.reminderJob) {
          task.reminderJob.stop();
        }
        if (task.cancellationJob) {
          task.cancellationJob.stop();
        }
        if (task.completionJob) {
          task.completionJob.stop();
        }
        logger.info('Stopped scheduled tasks for session', { sessionId });
      } catch (error) {
        logger.error('Error stopping tasks for session', { sessionId, error });
      }
    }

    this.scheduledTasks.clear();
    logger.info('Session scheduler shutdown complete');
  }
}

export const sessionScheduler = SessionScheduler.getInstance();
