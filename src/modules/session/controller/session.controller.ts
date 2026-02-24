import {
  createSession as createSessionInDb,
  getLastCompletedSessionInChannel,
  getParty,
  getSession,
  getSessionById,
  getSessions,
  updateSession,
  isUserInActiveSession,
  isUserHostingOnDate,
  isUserMemberOnDate,
} from '#modules/session/repository/session.repository.js';
import {
  sendNewSessionMessage,
  getRoleButtonsForSession,
  createPartyMemberEmbed,
} from '#modules/session/presentation/sessionMessages.js';
import { sendEphemeralReply, notifyParty } from '#shared/discord/messages.js';
import { client } from '#app/index.js';
import { ExtendedInteraction } from '#shared/types/discord.js';
import {
  PartyMember,
  RoleSelectionStatus,
} from '#modules/party/domain/party.types.js';
import {
  ListSessionsOptions,
  ListSessionsResult,
  Session,
  SessionStatus,
  CreateSessionData,
} from '#modules/session/domain/session.types.js';
import {
  BotCommandOptionInfo,
  BotDialogs,
  BotAttachmentFileNames,
} from '#shared/messages/botDialogStrings.js';
import { getImgAttachmentBuilderFromBuffer } from '#shared/files/attachmentBuilders.js';
import DateChecker from '#shared/datetime/dateChecker.js';
import {
  addUserToPartyIfNotFull,
  updatePartyMemberRole,
  upsertUser,
  getUserTimezone,
} from '#modules/user/repository/user.repository.js';
import { deletePartyMember } from '#modules/party/repository/partyMember.repository.js';
import { ChannelType, Guild, TextChannel } from 'discord.js';
import {
  createScheduledEvent,
  updateScheduledEvent,
  deleteScheduledEvent,
} from '#modules/session/services/scheduledEventService.js';
import { RoleType } from '#generated/prisma/client.js';
import { sessionScheduler } from '#services/sessionScheduler.js';
import { createSessionImage } from '#shared/messages/sessionImage.js';
import {
  areDatesEqual,
  formatSessionDateLong,
  isFutureDate,
} from '#shared/datetime/dateUtils.js';
import { sanitizeUserInput } from '#shared/validation/sanitizeUserInput.js';
import {
  safeChannelFetch,
  safeMessageFetch,
  safeMessageEdit,
  safeUserFetch,
  safeCreateDM,
} from '#shared/discord/discordErrorHandler.js';
import { createScopedLogger } from '#shared/logging/logger.js';
import { upsertCampaign } from '#app/modules/campaign/repository/campaign.repository.js';
import { getNextSessionName } from '#modules/session/domain/sessionNameUtils.js';
import { getPartyInfoForImg } from '#modules/session/services/partyImageService.js';

const logger = createScopedLogger('SessionController');

export const initSession = async (
  guild: Guild,
  sessionChannel: TextChannel,
  sessionName: string,
  date: Date,
  userId: string,
  timezone: string,
  party: PartyMember[]
): Promise<Session> => {
  logger.info('Initializing new session', {
    guildId: guild.id,
    guildName: guild.name,
    channelId: sessionChannel.id,
    channelName: sessionChannel.name,
    sessionName,
    scheduledDate: date.toISOString(),
    timezone,
    creatorUserId: userId,
    initialPartySize: party.length,
  });

  // Step 1: Ensure campaign (channel) exists in database
  const campaign = await upsertCampaign({
    id: sessionChannel.id,
    guildId: guild.id,
    name: sessionChannel.name,
  });
  logger.info('Campaign upserted', {
    campaignId: campaign.id,
    campaignName: campaign.name,
    guildId: campaign.guildId,
  });

  // Step 2: Create temporary session object for message generation (id will be set after message creation)
  const tempSession: Session = {
    id: '', // Will be set after message creation
    name: sessionName,
    date,
    campaignId: campaign.id,
    guildId: guild.id,
    status: 'SCHEDULED' as SessionStatus,
    timezone,
  };

  // Step 3: Send the session message first to get the message ID
  let messageId: string = '';
  try {
    messageId = await sendNewSessionMessage(tempSession, sessionChannel, party);
    logger.info('Session message created', {
      messageId,
      channelId: sessionChannel.id,
    });
  } catch (error) {
    logger.error('Failed to send new session message', {
      sessionName,
      channelId: sessionChannel.id,
      error,
    });
    throw new Error('Failed to create session message. Please try again.');
  }

  // Step 4: Create session in database with message ID as the session ID
  const newSession: CreateSessionData = {
    id: messageId,
    name: sessionName,
    date,
    campaignId: campaign.id,
    timezone,
  };

  const session = await createSessionInDb(newSession, userId, party);
  logger.info('Session created in database', {
    sessionId: session.id,
    sessionName: session.name,
    campaignId: session.campaignId,
    partySize: party.length,
  });

  const sessionForReturn: Session = {
    id: session.id,
    name: session.name,
    date: session.date,
    campaignId: session.campaignId,
    guildId: guild.id,
    status: session.status as SessionStatus,
    timezone: session.timezone ?? 'America/Los_Angeles',
    eventId: session.eventId,
  };

  sessionScheduler.scheduleSessionTasks(session.id, session.date);
  logger.info('Session initialization complete', {
    sessionId: session.id,
    sessionName: session.name,
    scheduledDate: session.date.toISOString(),
    partySize: party.length,
  });

  return sessionForReturn;
};

/**
 * Creates a new session from scratch.
 * Performs validation, database calls, and user setup before initializing the session.
 */
export const createSession = async (
  guild: Guild,
  sessionChannel: TextChannel,
  sessionName: string,
  date: Date,
  username: string,
  userId: string,
  timezone: string
): Promise<Session> => {
  logger.debug('createSession called', {
    guildId: guild.id,
    channelId: sessionChannel.id,
    sessionName,
    userId,
    username,
  });

  // Validate session parameters (note: campaignId validation now uses channelId)
  const validationError = await isSessionValid(
    sessionChannel.id,
    date,
    userId,
    timezone
  );
  if (validationError) {
    logger.warn('Session validation failed', {
      guildId: guild.id,
      channelId: sessionChannel.id,
      sessionName,
      userId,
      validationError,
    });
    throw new Error(validationError);
  }

  // Fetch user and create DM channel
  const user = await safeUserFetch(client, userId);
  const dmChannel = await safeCreateDM(user);
  await upsertUser(userId, username, dmChannel.id);

  // Initialize party with just the game master
  const party: PartyMember[] = [
    {
      userId,
      username,
      channelId: dmChannel.id,
      role: RoleType.GAME_MASTER,
    },
  ];

  // Initialize the session with all data
  return await initSession(
    guild,
    sessionChannel,
    sessionName,
    date,
    userId,
    timezone,
    party
  );
};

/**
 * Continues the most recent completed/canceled session in a channel.
 * Finds the last session, generates the next session name, and creates a new session with the same party.
 */
export const continueSessionInChannel = async (
  guild: Guild,
  sessionChannel: TextChannel,
  date: Date,
  username: string,
  userId: string,
  timezone: string
): Promise<{ session: Session; party: PartyMember[] }> => {
  // Find the last completed/canceled session in this channel
  const lastSession = await getLastCompletedSessionInChannel(sessionChannel.id);

  if (!lastSession) {
    throw new Error(
      'No completed or canceled sessions found in this channel to continue.'
    );
  }

  logger.info('Found last session to continue', {
    sessionId: lastSession.id,
    sessionName: lastSession.name,
    channelId: sessionChannel.id,
  });

  // Fetch the full session with party members
  const existingSession = await getSessionById(lastSession.id, true);

  // Use existing session's timezone if not provided
  const effectiveTimezone =
    timezone || existingSession.timezone || 'America/Los_Angeles';

  // Generate the next session name
  const newSessionName = getNextSessionName(existingSession.name);

  return continueSession(
    guild,
    sessionChannel,
    existingSession,
    newSessionName,
    date,
    username,
    userId,
    effectiveTimezone
  );
};

/**
 * Continues an existing session by creating a new session with copied party members.
 * Performs validation, copies party data, and creates the new session as a new message in the same channel.
 */
const continueSession = async (
  guild: Guild,
  sessionChannel: TextChannel,
  existingSession: Session & { partyMembers: PartyMember[] },
  newSessionName: string,
  date: Date,
  username: string,
  userId: string,
  timezone: string
): Promise<{ session: Session; party: PartyMember[] }> => {
  logger.info('Continuing session', {
    previousSessionId: existingSession.id,
    previousSessionName: existingSession.name,
    newSessionName,
    channelId: sessionChannel.id,
    guildId: guild.id,
    userId,
    carryOverPartySize: existingSession.partyMembers.length,
  });

  const validationError = await isSessionValid(
    sessionChannel.id,
    date,
    userId,
    timezone
  );
  if (validationError) {
    logger.warn('Session continuation validation failed', {
      previousSessionId: existingSession.id,
      userId,
      validationError,
    });
    throw new Error(validationError);
  }

  // Fetch GM user and ensure DM channel exists
  const user = await safeUserFetch(client, userId);
  const dmChannel = await safeCreateDM(user);
  await upsertUser(userId, username, dmChannel.id);

  // Copy party from existing session (Game Master will be added by initSession)
  const party: PartyMember[] = [
    {
      userId,
      username,
      channelId: dmChannel.id,
      role: RoleType.GAME_MASTER,
    },
  ];

  existingSession.partyMembers.forEach((member) => {
    if (member.userId !== userId) {
      party.push({
        userId: member.userId,
        username: member.username,
        channelId: member.channelId,
        role: member.role,
      });
    }
  });

  const session = await initSession(
    guild,
    sessionChannel,
    newSessionName,
    date,
    userId,
    timezone,
    party
  );

  // If party is already full, create Discord scheduled event and update status
  if (party.length >= 6) {
    logger.info('Continued session has full party, creating scheduled event', {
      sessionId: session.id,
      partySize: party.length,
    });

    try {
      await updateSession(session.id, { status: 'FULL' });
      logger.info('Updated continued session status to FULL', {
        sessionId: session.id,
      });

      const eventId = await createScheduledEvent(
        guild.id,
        sessionChannel.name,
        date,
        session.id
      );

      if (eventId) {
        await updateSession(session.id, { eventId });
        logger.info('Created scheduled event for continued session', {
          sessionId: session.id,
          eventId,
        });
      }

      // Regenerate session message with FULL status
      await regenerateSessionMessage(session.id);
    } catch (error) {
      logger.error('Failed to create scheduled event for continued session', {
        sessionId: session.id,
        error,
      });
      // Continue - event creation is optional
    }
  }

  return { session, party };
};

export const cancelSession = async (sessionId: string, reason: string) => {
  logger.info('Canceling session', { sessionId, reason });

  const session = await getSession(sessionId);
  logger.debug('Session to cancel', {
    sessionId,
    sessionName: session.name,
    status: session.status,
    partySize: session.partyMembers.length,
  });

  // Cancel any scheduled tasks first
  sessionScheduler.cancelSessionTasks(sessionId);
  logger.info('Canceled scheduled tasks for session', { sessionId });

  // Delete Discord scheduled event if it exists (non-blocking)
  if (session.eventId) {
    try {
      await deleteScheduledEvent(session.guildId, session.eventId);
      logger.info('Deleted scheduled event for canceled session', {
        sessionId,
        eventId: session.eventId,
      });
    } catch (error) {
      logger.error('Failed to delete scheduled event for session', {
        sessionId,
        error,
      });
      // Continue - event deletion is optional
    }
  }

  // Update database status - this should happen regardless of other failures
  try {
    await updateSession(sessionId, { status: 'CANCELED' });
    logger.info('Updated session status to CANCELED', { sessionId });
  } catch (error) {
    logger.error('Failed to update session status to CANCELED', {
      sessionId,
      error,
    });
    throw error; // Re-throw since this is critical
  }

  // Regenerate the session message with canceled status and reason
  try {
    await regenerateSessionMessage(
      sessionId,
      `❌ **CANCELED** - ${session.name}\n${reason}`
    );
    logger.info('Updated Discord message for canceled session', {
      sessionId,
    });
  } catch (error) {
    logger.error('Failed to update Discord message for canceled session', {
      sessionId,
      error,
    });
    // Don't throw - message update failure shouldn't prevent cancellation
  }

  try {
    await notifyParty(
      session.partyMembers.map((member) => member.userId),
      async (userId: string) => {
        const userTimezone = await getUserTimezone(userId);
        const sessionTime = formatSessionDateLong(session.date, userTimezone);

        return (
          `❌ **Session Canceled**\n\n` +
          `🎲 **[${session.name}](https://discord.com/channels/${session.guildId}/${session.campaignId}/${session.id})** has been canceled.\n` +
          `📅 **Was scheduled for:** ${sessionTime}\n` +
          `❗ **Reason:** ${reason}\n\n` +
          `We apologize for any inconvenience. 🎯`
        );
      }
    );
    logger.info('Notified party members about session cancellation', {
      sessionId,
    });
  } catch (error) {
    logger.error('Failed to notify party members about session cancellation', {
      sessionId,
      error,
    });
    // Don't throw - notification failure shouldn't prevent cancellation
  }

  logger.info('Session cancellation complete', {
    sessionId,
    sessionName: session.name,
    reason,
  });
};

export const endSession = async (sessionId: string) => {
  logger.info('Ending session', { sessionId });

  const session = await getSession(sessionId);
  logger.debug('Session to end', {
    sessionId,
    sessionName: session.name,
    status: session.status,
  });

  // Cancel any scheduled tasks
  sessionScheduler.cancelSessionTasks(sessionId);
  logger.info('Canceled scheduled tasks for session', { sessionId });

  // Delete Discord scheduled event if it exists (non-blocking)
  if (session.eventId) {
    try {
      await deleteScheduledEvent(session.guildId, session.eventId);
      logger.info('Deleted scheduled event for ended session', {
        sessionId,
        eventId: session.eventId,
      });
    } catch (error) {
      logger.error('Failed to delete scheduled event for session', {
        sessionId,
        error,
      });
      // Continue - event deletion is optional
    }
  }

  // Update database status
  try {
    await updateSession(sessionId, { status: 'COMPLETED' });
    logger.info('Updated session status to COMPLETED', { sessionId });
  } catch (error) {
    logger.error('Failed to update session status to COMPLETED', {
      sessionId,
      error,
    });
    throw error; // Re-throw since this is critical
  }

  // Regenerate the session message with completed status
  try {
    await regenerateSessionMessage(sessionId);
    logger.info('Regenerated session message with COMPLETED status', {
      sessionId,
    });
  } catch (error) {
    logger.error('Failed to regenerate session message', {
      sessionId,
      error,
    });
    // Don't throw - message update failure shouldn't prevent completion
  }

  logger.info('Session ended successfully', {
    sessionId,
    sessionName: session.name,
  });
};

export const modifySession = async (interaction: ExtendedInteraction) => {
  try {
    const sessionId = interaction.options.getString(
      BotCommandOptionInfo.ModifySession_ChannelName,
      true
    );
    const rawNewSessionName = interaction?.options?.get('new-session-name')
      ?.value as string;
    const newSessionName = rawNewSessionName
      ? sanitizeUserInput(rawNewSessionName)
      : undefined;

    if (rawNewSessionName && !newSessionName) {
      await sendEphemeralReply(
        BotDialogs.createSessionInvalidSessionName,
        interaction
      );
      return;
    }

    const session = await getSessionById(sessionId);

    // Ensure user exists in database before getting their timezone
    const user = await safeUserFetch(client, interaction.user.id);
    const dmChannel = await safeCreateDM(user);
    const username =
      sanitizeUserInput(interaction.user.displayName) ||
      interaction.user.username;
    await upsertUser(interaction.user.id, username, dmChannel.id);

    // Get timezone from command or user's stored timezone
    let timezone = interaction.options.getString(
      BotCommandOptionInfo.CreateSession_TimezoneName
    );

    if (!timezone) {
      timezone = await getUserTimezone(interaction.user.id);
    }

    const newProposedDate = DateChecker(interaction, timezone);
    let dateChanged = false;
    let nameChanged = false;

    if (newProposedDate) {
      if (!areDatesEqual(session.date, newProposedDate)) {
        session.date = newProposedDate;
        dateChanged = true;
      }
    }

    if (newSessionName && newSessionName !== session.name) {
      session.name = newSessionName;
      nameChanged = true;
    }

    await updateSession(sessionId, session);

    if (dateChanged) {
      sessionScheduler.scheduleSessionTasks(sessionId, session.date);
      logger.info('Rescheduled session tasks', {
        sessionId,
        date: session.date.toISOString(),
      });
    }

    if (session.eventId && (dateChanged || nameChanged)) {
      try {
        const updates: { name?: string; scheduledStartTime?: Date } = {};
        if (nameChanged) updates.name = session.name;
        if (dateChanged) updates.scheduledStartTime = session.date;

        const eventIdString = session.eventId;
        const success = await updateScheduledEvent(
          session.guildId,
          eventIdString,
          updates
        );
        if (success) {
          logger.info('Updated scheduled event for session', {
            sessionId,
            eventId: eventIdString,
          });
        }
      } catch (error) {
        logger.error('Failed to update scheduled event for session', {
          sessionId,
          error,
        });
        // Continue - event update is optional
      }
    }

    if (dateChanged || nameChanged) {
      try {
        await regenerateSessionMessage(sessionId);
        logger.info('Regenerated session message after modification', {
          sessionId,
        });
      } catch (error) {
        logger.error('Failed to regenerate session message', {
          sessionId,
          error,
        });
        // Continue - message update failure shouldn't prevent modification
      }
    }

    logger.info('Session modification complete', {
      sessionId,
      sessionName: session.name,
      dateChanged,
      nameChanged,
    });

    await sendEphemeralReply(
      BotDialogs.sessions.updated(session.name),
      interaction
    );
  } catch (error) {
    logger.error('Error modifying session', { error });
    await sendEphemeralReply(
      'An error occurred while modifying the session.',
      interaction
    );
  }
};

export const processRoleSelection = async (
  newPartyMember: PartyMember,
  sessionId: string
): Promise<RoleSelectionStatus> => {
  const session = await getSession(sessionId);
  const { date, partyMembers: party, status, campaignId, timezone } = session;

  logger.debug('Processing role selection', {
    sessionId,
    userId: newPartyMember.userId,
    username: newPartyMember.username,
    role: newPartyMember.role,
    partySize: party.length,
  });

  if (status && status !== 'SCHEDULED') {
    logger.info('Rejected role selection: session locked', {
      sessionId,
      status,
    });
    return RoleSelectionStatus.LOCKED;
  }

  if (!isFutureDate(date)) {
    logger.info('Rejected role selection: session expired', { sessionId });
    return RoleSelectionStatus.EXPIRED;
  }

  if (newPartyMember.role === RoleType.GAME_MASTER) {
    logger.info('Rejected role selection: GM role not allowed', {
      sessionId,
      userId: newPartyMember.userId,
    });
    return RoleSelectionStatus.INVALID;
  }

  // Check if user is already in this party BEFORE other checks
  const existingMember = party.find(
    (member) => member.userId === newPartyMember.userId
  );

  // If user is already in the party, handle role change/removal
  if (existingMember) {
    if (existingMember.role === newPartyMember.role) {
      logger.info('Removing user from party (same role selected)', {
        sessionId,
        userId: existingMember.userId,
      });
      await deletePartyMember(existingMember.userId, sessionId);
      return RoleSelectionStatus.REMOVED_FROM_PARTY;
    }

    logger.info('Changing user role', {
      sessionId,
      userId: existingMember.userId,
      fromRole: existingMember.role,
      toRole: newPartyMember.role,
    });
    await updatePartyMemberRole(
      newPartyMember.userId,
      sessionId,
      newPartyMember.role
    );
    return RoleSelectionStatus.ROLE_CHANGED;
  }

  // User is NOT in the party - check if they can join
  const isInAnotherSession = await isUserInActiveSession(
    newPartyMember.userId,
    sessionId,
    campaignId
  );

  if (isInAnotherSession) {
    logger.info('Rejected role selection: user already in another session', {
      sessionId,
      userId: newPartyMember.userId,
    });
    return RoleSelectionStatus.ALREADY_IN_SESSION;
  }

  const isHostingOnSameDay = await isUserHostingOnDate(
    newPartyMember.userId,
    date,
    campaignId,
    timezone
  );

  if (isHostingOnSameDay) {
    logger.info('Rejected role selection: user hosting on same day', {
      sessionId,
      userId: newPartyMember.userId,
    });
    return RoleSelectionStatus.HOSTING_SAME_DAY;
  }

  // Use atomic add to prevent race condition where two users
  // could both pass a "party full" check simultaneously
  logger.info('Adding user to party', {
    sessionId,
    userId: newPartyMember.userId,
    role: newPartyMember.role,
  });

  const wasAdded = await addUserToPartyIfNotFull(
    newPartyMember.userId,
    sessionId,
    newPartyMember.role,
    newPartyMember.username
  );

  if (!wasAdded) {
    logger.info('Rejected role selection: party full (atomic check)', {
      sessionId,
      userId: newPartyMember.userId,
    });
    return RoleSelectionStatus.PARTY_FULL;
  }

  return RoleSelectionStatus.ADDED_TO_PARTY;
};

export const listSessions = async (
  options: ListSessionsOptions
): Promise<ListSessionsResult[]> => {
  let sessions: ListSessionsResult[] = [];
  try {
    sessions = await getSessions(options);
  } catch (error) {
    logger.error('Failed to list sessions', { error, options });
  }

  return sessions;
};

export const formatSessionsAsStr = (
  sessions: ListSessionsResult[],
  options: ListSessionsOptions,
  delimiter = ', '
): string => {
  const {
    includeTime,
    includeCampaign,
    includeId,
    includeRole = false,
  } = options;
  const headerParts = [
    'Session Name',
    includeId && 'Session Channel ID',
    includeTime && 'Scheduled Date',
    includeCampaign && 'Campaign Name',
    includeRole && 'User Role',
  ].filter(Boolean);
  const header = headerParts.join('\t');

  const data = sessions.map((session) => {
    const row = [session.name];
    if (includeId) row.push(session.id);
    if (includeTime) row.push(session.date.toUTCString());
    if (includeCampaign && session.campaign) {
      row.push(session.campaign);
    }
    if (includeRole && session.userRole) row.push(session.userRole);
    return row;
  });

  return [[header], ...data].map((row) => row.join(delimiter)).join('\n');
};

const isSessionValid = async (
  campaignId: string, // channelId where sessions are posted
  date: Date,
  userId: string,
  timezone: string
): Promise<string> => {
  if (!campaignId) {
    return BotDialogs.createSessionInvalidGuild;
  }

  if (!date || isNaN(date.getTime())) {
    return BotDialogs.createSessionInvalidDate;
  }
  if (!isFutureDate(date)) {
    return BotDialogs.createSessionDateMustBeFuture;
  }

  if (!userId) {
    return BotDialogs.createSessionInvalidUserId;
  }

  // Check if the user is already hosting a session on the same day in this campaign (channel)
  const isHostingOnSameDay = await isUserHostingOnDate(
    userId,
    date,
    campaignId,
    timezone
  );
  if (isHostingOnSameDay) {
    return BotDialogs.createSessionHostingMultipleSessions;
  }

  // Check if the user is a member of another session on the same day in this campaign (channel)
  const isMemberOnSameDay = await isUserMemberOnDate(
    userId,
    date,
    campaignId,
    timezone
  );
  if (isMemberOnSameDay) {
    return BotDialogs.createSessionAlreadyMemberSameDay;
  }

  return '';
};

export const regenerateSessionMessage = async (
  sessionId: string,
  descriptionOverride?: string
): Promise<void> => {
  logger.debug('Regenerating session message', { sessionId });

  const session = await getSessionById(sessionId);
  const sessionChannel = await safeChannelFetch(client, session.campaignId);

  if (!sessionChannel || sessionChannel.type !== ChannelType.GuildText) {
    throw new Error('Session channel not found or is not a text channel');
  }

  const partyForImg = await getPartyInfoForImg(sessionId);
  const imageBuffer = await createSessionImage(session, partyForImg);

  const attachment = getImgAttachmentBuilderFromBuffer(
    imageBuffer,
    BotAttachmentFileNames.CurrentSession
  );

  const party = await getParty(sessionId);
  const embed = createPartyMemberEmbed(party, session.name, session.status);
  embed.setDescription(
    descriptionOverride ??
      BotDialogs.sessions.scheduled(
        session.date,
        session.timezone ?? 'America/Los_Angeles'
      )
  );

  const message = await safeMessageFetch(sessionChannel, session.id);
  await safeMessageEdit(message, {
    embeds: [embed],
    files: [attachment],
    components: getRoleButtonsForSession(session.status),
  });

  logger.info('Session message regenerated and updated', {
    sessionId,
    messageId: session.id,
    status: session.status,
  });
};
