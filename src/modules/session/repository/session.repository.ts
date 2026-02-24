import { prisma } from '#app/index.js';
import { PartyMember } from '#modules/party/domain/party.types.js';
import {
  ListSessionsOptions,
  ListSessionsResult,
  Session,
  SessionWithParty,
  CreateSessionData,
  SessionStatus,
} from '#modules/session/domain/session.types.js';
import { RoleType, Session as PrismaSession } from '#generated/prisma/client.js';
import { createScopedLogger } from '#shared/logging/logger.js';

const logger = createScopedLogger('SessionRepository');

export const createSession = async (
  sessionData: CreateSessionData,
  userId: string,
  party?: PartyMember[]
): Promise<PrismaSession> => {
  const { campaignId, ...session } = sessionData;

  logger.debug('Creating session in database', {
    sessionId: sessionData.id,
    sessionName: sessionData.name,
    campaignId,
    creatorUserId: userId,
    partySize: party?.length ?? 1,
  });

  // Build party members to create - always include the GM, then add any provided party members
  const partyMembersToCreate: { userId: string; roleId: RoleType }[] = [
    {
      userId,
      roleId: RoleType.GAME_MASTER,
    },
  ];

  // Add additional party members if provided (excluding GM)
  if (party && party.length > 0) {
    party.forEach((member) => {
      if (member.role !== RoleType.GAME_MASTER) {
        partyMembersToCreate.push({
          userId: member.userId,
          roleId: member.role,
        });
      }
    });
  }

  const createdSession = await prisma.session.create({
    data: {
      ...session,
      campaign: { connect: { id: campaignId } },
      partyMembers: {
        create: partyMembersToCreate,
      },
    },
  });

  logger.info('Session created in database', {
    sessionId: createdSession.id,
    sessionName: createdSession.name,
    partyMembersCreated: partyMembersToCreate.length,
  });

  return createdSession;
};

export const getSession = async (
  sessionId: string
): Promise<SessionWithParty> => {
  const session = await prisma.session.findUniqueOrThrow({
    where: { id: sessionId },
    include: {
      campaign: { select: { guildId: true } },
      partyMembers: {
        select: {
          user: true,
          role: true,
        },
      },
    },
  });

  const partyMembers = session.partyMembers.map((member) => ({
    userId: member.user.id,
    username: member.user.username,
    channelId: member.user.channelId,
    role: member.role.id,
  }));

  return {
    id: session.id,
    name: session.name,
    date: session.date,
    campaignId: session.campaignId,
    guildId: session.campaign.guildId,
    eventId: session.eventId ?? undefined,
    timezone: session.timezone ?? 'America/Los_Angeles',
    status: session.status as SessionStatus,
    partyMembers: partyMembers,
  };
};

export const getParty = async (sessionId: string): Promise<PartyMember[]> => {
  const session = await prisma.session.findFirst({
    where: { id: sessionId },
    select: { partyMembers: { select: { user: true, role: true } } },
  });

  if (!session) {
    throw new Error(`Cannot find party for ${sessionId}`);
  }

  const partyMembers = session.partyMembers.map((partyMember) => ({
    userId: partyMember.user.id,
    username: partyMember.user.username,
    channelId: partyMember.user.channelId,
    role: partyMember.role.id,
  }));

  return partyMembers;
};

export const getSessions = async (
  options: ListSessionsOptions
): Promise<ListSessionsResult[]> => {
  const {
    userId = '',
    campaignId = '',
    includeCampaign = false,
    includeUserRole = false,
  } = options;
  const sessions = await prisma.session.findMany({
    where: {
      ...(userId && { partyMembers: { some: { userId } } }),
      ...(campaignId && { campaignId }),
    },
    include: {
      ...(includeCampaign && {
        campaign: {
          select: {
            name: true,
          },
        },
      }),
      ...(userId && {
        partyMembers: { select: { userId: true, roleId: true } },
      }),
    },
  });

  return sessions.map((s) => {
    return {
      ...(includeCampaign && { campaign: s.campaign.name }),
      ...(includeUserRole && {
        userRole: s.partyMembers.find((pm) => pm.userId === userId)?.roleId,
      }),
      id: s.id,
      name: s.name,
      date: s.date,
      status: s.status,
    };
  });
};

export function getSessionById(
  id: string,
  includeParty: true
): Promise<SessionWithParty>;
export function getSessionById(
  id: string,
  includeParty?: false
): Promise<Session>;
export function getSessionById(
  id: string,
  includeParty?: boolean
): Promise<Session | SessionWithParty>;

export async function getSessionById(
  id: string,
  includeParty = false
): Promise<Session | SessionWithParty> {
  if (!includeParty) {
    const session = await prisma.session.findUniqueOrThrow({
      where: { id },
      include: { campaign: { select: { guildId: true } } },
    });

    return {
      id: session.id,
      name: session.name,
      date: session.date,
      campaignId: session.campaignId,
      guildId: session.campaign.guildId,
      eventId: session.eventId ?? undefined,
      status: session.status as SessionStatus,
      timezone: session.timezone ?? 'America/Los_Angeles',
    };
  }

  const session = await prisma.session.findUniqueOrThrow({
    where: { id },
    include: {
      campaign: { select: { guildId: true } },
      partyMembers: {
        include: {
          user: true,
          role: true,
        },
      },
    },
  });

  return {
    id: session.id,
    name: session.name,
    date: session.date,
    campaignId: session.campaignId,
    guildId: session.campaign.guildId,
    eventId: session.eventId ?? undefined,
    status: session.status as SessionStatus,
    timezone: session.timezone ?? 'America/Los_Angeles',
    partyMembers: session.partyMembers.map((member) => ({
      userId: member.user.id,
      username: member.user.username,
      channelId: member.user.channelId,
      role: member.role.id,
    })),
  };
}

export const deleteSessionById = async (id: string): Promise<PrismaSession> =>
  prisma.session.delete({ where: { id } });

export const updateSession = async (
  sessionId: string,
  data: Partial<CreateSessionData>
): Promise<PrismaSession> => {
  const updateData = {
    ...(data.name && { name: data.name }),
    ...(data.date && {
      date: data.date,
    }),
    ...(data.campaignId && {
      campaign: {
        connect: {
          id: data.campaignId,
        },
      },
    }),
    ...(data.eventId !== undefined && { eventId: data.eventId }),
    ...(data.status && { status: data.status }),
  };

  logger.debug('Updating session', { sessionId, updateData });

  const updatedSession = await prisma.session.update({
    where: { id: sessionId },
    data: updateData,
  });

  logger.info('Session updated', { sessionId });

  return updatedSession;
};

export const isUserInActiveSession = async (
  userId: string,
  excludeSessionId?: string,
  campaignId?: string
): Promise<boolean> => {
  const count = await prisma.session.count({
    where: {
      ...(excludeSessionId && { id: { not: excludeSessionId } }),
      ...(campaignId && { campaignId }),
      status: { in: ['SCHEDULED', 'ACTIVE', 'FULL'] },
      partyMembers: {
        some: { userId },
      },
    },
  });

  return count > 0;
};

export const isUserHostingOnDate = async (
  userId: string,
  date: Date,
  campaignId: string,
  timezone: string
): Promise<boolean> => {
  const result = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*)::int as count
    FROM session s
    JOIN party_member pm ON s.id = pm.session_id
    WHERE s.campaign_id = ${campaignId}
      AND pm.user_id = ${userId}
      AND pm.role_id = 'GAME_MASTER'
      AND s.status IN ('SCHEDULED', 'ACTIVE', 'FULL')
      AND DATE(s.date AT TIME ZONE ${timezone}) = DATE(${date}::timestamptz AT TIME ZONE ${timezone})
  `;

  return Number(result[0].count) > 0;
};

export const isUserMemberOnDate = async (
  userId: string,
  date: Date,
  campaignId: string,
  timezone: string
): Promise<boolean> => {
  const result = await prisma.$queryRaw<[{ count: bigint }]>`
    SELECT COUNT(*)::int as count
    FROM session s
    JOIN party_member pm ON s.id = pm.session_id
    WHERE s.campaign_id = ${campaignId}
      AND pm.user_id = ${userId}
      AND pm.role_id != 'GAME_MASTER'
      AND s.status IN ('SCHEDULED', 'ACTIVE', 'FULL')
      AND DATE(s.date AT TIME ZONE ${timezone}) = DATE(${date}::timestamptz AT TIME ZONE ${timezone})
  `;

  return Number(result[0].count) > 0;
};

/**
 * Get active sessions (not completed or canceled) for a guild, optionally filtered by campaign.
 */
export const getActiveSessionsForGuild = async (
  guildId: string,
  campaignId?: string
): Promise<
  {
    id: string;
    name: string;
    date: Date;
    timezone: string;
    campaignId: string;
    campaignName: string;
  }[]
> => {
  const sessions = await prisma.session.findMany({
    where: {
      campaign: { guildId },
      ...(campaignId && { campaignId }),
      status: { notIn: ['COMPLETED', 'CANCELED'] },
    },
    orderBy: { date: 'asc' },
    take: 25,
    include: {
      campaign: { select: { name: true } },
    },
  });

  return sessions.map((session) => ({
    id: session.id,
    name: session.name,
    date: session.date,
    timezone: session.timezone,
    campaignId: session.campaignId,
    campaignName: session.campaign.name,
  }));
};

/**
 * Get completed or canceled sessions for a guild/campaign.
 */
export const getCompletedSessionsForGuild = async (
  guildId: string,
  campaignId?: string
): Promise<
  {
    id: string;
    name: string;
    date: Date;
    timezone: string;
    campaignId: string;
    campaignName: string;
  }[]
> => {
  const sessions = await prisma.session.findMany({
    where: {
      campaign: { guildId },
      ...(campaignId && { campaignId }),
      status: { in: ['COMPLETED', 'CANCELED'] },
    },
    orderBy: { date: 'desc' },
    take: 25,
    include: { campaign: { select: { name: true } } },
  });

  return sessions.map((session) => ({
    id: session.id,
    name: session.name,
    date: session.date,
    timezone: session.timezone,
    campaignId: session.campaignId,
    campaignName: session.campaign.name,
  }));
};

/**
 * Get the most recent completed or canceled session in a specific channel.
 */
export const getLastCompletedSessionInChannel = async (
  channelId: string
): Promise<PrismaSession | null> => {
  return await prisma.session.findFirst({
    where: {
      campaignId: channelId,
      status: { in: ['COMPLETED', 'CANCELED'] },
    },
    orderBy: { date: 'desc' },
  });
};

/**
 * Get active sessions (not completed or canceled) for a specific campaign (channel) ID.
 */
export const getActiveSessionsByCampaignId = async (
  campaignId: string
): Promise<PrismaSession[]> => {
  return await prisma.session.findMany({
    where: {
      campaignId,
      status: { notIn: ['COMPLETED', 'CANCELED'] },
    },
  });
};

/**
 * Get the active session in a channel with party members included.
 * Returns null if no active session exists.
 * Since there should only be one active session per channel, returns the first found.
 */
export const getActiveSessionInChannel = async (
  channelId: string
): Promise<PrismaSession | null> => {
  const session = await prisma.session.findFirst({
    where: {
      campaignId: channelId,
      status: { notIn: ['COMPLETED', 'CANCELED'] },
    },
  });

  if (!session) {
    return null;
  }

  return session;
};

export const isUserGameMaster = async (
  userId: string,
  sessionId: string
): Promise<boolean> => {
  return !!(await prisma.partyMember.findFirst({
    where: {
      sessionId,
      userId,
      roleId: RoleType.GAME_MASTER,
    },
  }));
};
