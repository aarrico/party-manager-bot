import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RoleType } from '#generated/prisma/client.js';
import {
  RoleSelectionStatus,
  type PartyMember,
} from '#modules/party/domain/party.types.js';
import type {
  ListSessionsOptions,
  ListSessionsResult,
  SessionWithParty,
} from '#modules/session/domain/session.types.js';

// Mock all external dependencies before importing the module under test
vi.mock('#modules/session/repository/session.repository.js');
vi.mock('#modules/user/repository/user.repository.js');
vi.mock('#modules/party/repository/partyMember.repository.js');
vi.mock('#modules/session/presentation/sessionMessages.js');
vi.mock('#modules/session/services/scheduledEventService.js');
vi.mock('#modules/session/services/partyImageService.js');
vi.mock('#shared/discord/messages.js');
vi.mock('#shared/discord/discordErrorHandler.js');
vi.mock('#shared/files/attachmentBuilders.js');
vi.mock('#shared/messages/sessionImage.js');
vi.mock('#shared/logging/logger.js', () => ({
  createScopedLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));
vi.mock('#app/index.js', () => ({
  client: {},
  prisma: {},
}));
vi.mock('#services/sessionScheduler.js', () => ({
  sessionScheduler: {
    scheduleSessionTasks: vi.fn(),
    cancelSessionTasks: vi.fn(),
  },
}));
vi.mock('#app/modules/campaign/repository/campaign.repository.js');

import {
  processRoleSelection,
  formatSessionsAsStr,
} from './session.controller.js';
import { getSession } from '#modules/session/repository/session.repository.js';
import { addUserToPartyIfNotFull } from '#modules/user/repository/user.repository.js';
import { deletePartyMember } from '#modules/party/repository/partyMember.repository.js';
import {
  isUserInActiveSession,
  isUserHostingOnDate,
} from '#modules/session/repository/session.repository.js';

const mockedGetSession = vi.mocked(getSession);
const mockedAddUserToPartyIfNotFull = vi.mocked(addUserToPartyIfNotFull);
const mockedDeletePartyMember = vi.mocked(deletePartyMember);
const mockedIsUserInActiveSession = vi.mocked(isUserInActiveSession);
const mockedIsUserHostingOnDate = vi.mocked(isUserHostingOnDate);

// Helper to create a mock session
function mockSession(
  overrides: Partial<SessionWithParty> = {}
): SessionWithParty {
  return {
    id: 'session-1',
    name: 'Test Session',
    date: new Date(Date.now() + 86400000), // tomorrow
    timezone: 'America/Los_Angeles',
    campaignId: 'channel-1',
    guildId: 'guild-1',
    status: 'SCHEDULED',
    partyMembers: [
      {
        userId: 'gm-user',
        username: 'GameMaster',
        role: RoleType.GAME_MASTER,
        channelId: 'dm-channel-gm',
      },
    ],
    ...overrides,
  };
}

function mockPartyMember(overrides: Partial<PartyMember> = {}): PartyMember {
  return {
    userId: 'new-user',
    username: 'NewPlayer',
    role: RoleType.TANK,
    channelId: 'dm-channel-new',
    ...overrides,
  };
}

describe('processRoleSelection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns LOCKED when session is not SCHEDULED', async () => {
    mockedGetSession.mockResolvedValue(mockSession({ status: 'ACTIVE' }));

    const result = await processRoleSelection(
      mockPartyMember(),
      'session-1'
    );
    expect(result).toBe(RoleSelectionStatus.LOCKED);
  });

  it('returns EXPIRED when session date is in the past', async () => {
    mockedGetSession.mockResolvedValue(
      mockSession({ date: new Date('2020-01-01') })
    );

    const result = await processRoleSelection(
      mockPartyMember(),
      'session-1'
    );
    expect(result).toBe(RoleSelectionStatus.EXPIRED);
  });

  it('returns INVALID when selecting GAME_MASTER role', async () => {
    mockedGetSession.mockResolvedValue(mockSession());

    const result = await processRoleSelection(
      mockPartyMember({ role: RoleType.GAME_MASTER }),
      'session-1'
    );
    expect(result).toBe(RoleSelectionStatus.INVALID);
  });

  it('returns REMOVED_FROM_PARTY when user selects their current role', async () => {
    mockedGetSession.mockResolvedValue(
      mockSession({
        partyMembers: [
          {
            userId: 'gm-user',
            username: 'GM',
            role: RoleType.GAME_MASTER,
            channelId: 'dm-gm',
          },
          {
            userId: 'existing-user',
            username: 'Player',
            role: RoleType.TANK,
            channelId: 'dm-player',
          },
        ],
      })
    );
    mockedDeletePartyMember.mockResolvedValue(undefined);

    const result = await processRoleSelection(
      mockPartyMember({ userId: 'existing-user', role: RoleType.TANK }),
      'session-1'
    );
    expect(result).toBe(RoleSelectionStatus.REMOVED_FROM_PARTY);
    expect(mockedDeletePartyMember).toHaveBeenCalledWith(
      'existing-user',
      'session-1'
    );
  });

  it('returns ROLE_CHANGED when user selects a different role', async () => {
    mockedGetSession.mockResolvedValue(
      mockSession({
        partyMembers: [
          {
            userId: 'gm-user',
            username: 'GM',
            role: RoleType.GAME_MASTER,
            channelId: 'dm-gm',
          },
          {
            userId: 'existing-user',
            username: 'Player',
            role: RoleType.TANK,
            channelId: 'dm-player',
          },
        ],
      })
    );

    const result = await processRoleSelection(
      mockPartyMember({ userId: 'existing-user', role: RoleType.SUPPORT }),
      'session-1'
    );
    expect(result).toBe(RoleSelectionStatus.ROLE_CHANGED);
  });

  it('returns ALREADY_IN_SESSION when user is in another active session', async () => {
    mockedGetSession.mockResolvedValue(mockSession());
    mockedIsUserInActiveSession.mockResolvedValue(true);

    const result = await processRoleSelection(
      mockPartyMember(),
      'session-1'
    );
    expect(result).toBe(RoleSelectionStatus.ALREADY_IN_SESSION);
  });

  it('returns HOSTING_SAME_DAY when user is hosting another session that day', async () => {
    mockedGetSession.mockResolvedValue(mockSession());
    mockedIsUserInActiveSession.mockResolvedValue(false);
    mockedIsUserHostingOnDate.mockResolvedValue(true);

    const result = await processRoleSelection(
      mockPartyMember(),
      'session-1'
    );
    expect(result).toBe(RoleSelectionStatus.HOSTING_SAME_DAY);
  });

  it('returns ADDED_TO_PARTY on successful join', async () => {
    mockedGetSession.mockResolvedValue(mockSession());
    mockedIsUserInActiveSession.mockResolvedValue(false);
    mockedIsUserHostingOnDate.mockResolvedValue(false);
    mockedAddUserToPartyIfNotFull.mockResolvedValue(true);

    const result = await processRoleSelection(
      mockPartyMember(),
      'session-1'
    );
    expect(result).toBe(RoleSelectionStatus.ADDED_TO_PARTY);
  });

  it('returns PARTY_FULL when atomic add fails', async () => {
    mockedGetSession.mockResolvedValue(mockSession());
    mockedIsUserInActiveSession.mockResolvedValue(false);
    mockedIsUserHostingOnDate.mockResolvedValue(false);
    mockedAddUserToPartyIfNotFull.mockResolvedValue(false);

    const result = await processRoleSelection(
      mockPartyMember(),
      'session-1'
    );
    expect(result).toBe(RoleSelectionStatus.PARTY_FULL);
  });
});

describe('formatSessionsAsStr', () => {
  const sessions: ListSessionsResult[] = [
    {
      id: 'sess-1',
      name: "Dragon's Lair",
      date: new Date('2025-06-15T19:00:00Z'),
      status: 'SCHEDULED',
      campaign: 'Main Campaign',
      userRole: 'TANK',
    },
    {
      id: 'sess-2',
      name: 'Goblin Cave',
      date: new Date('2025-06-20T20:00:00Z'),
      status: 'FULL',
    },
  ];

  it('formats with name only by default', () => {
    const options: ListSessionsOptions = {};
    const result = formatSessionsAsStr(sessions, options);
    expect(result).toContain('Session Name');
    expect(result).toContain("Dragon's Lair");
    expect(result).toContain('Goblin Cave');
  });

  it('includes session ID when requested', () => {
    const options: ListSessionsOptions = { includeId: true };
    const result = formatSessionsAsStr(sessions, options);
    expect(result).toContain('Session Channel ID');
    expect(result).toContain('sess-1');
  });

  it('includes time when requested', () => {
    const options: ListSessionsOptions = { includeTime: true };
    const result = formatSessionsAsStr(sessions, options);
    expect(result).toContain('Scheduled Date');
  });

  it('includes campaign when requested', () => {
    const options: ListSessionsOptions = { includeCampaign: true };
    const result = formatSessionsAsStr(sessions, options);
    expect(result).toContain('Campaign Name');
    expect(result).toContain('Main Campaign');
  });

  it('uses custom delimiter', () => {
    const options: ListSessionsOptions = {};
    const result = formatSessionsAsStr(sessions, options, ' | ');
    expect(result).toContain('Session Name');
    // Each row uses the delimiter
    const lines = result.split('\n');
    expect(lines.length).toBe(3); // header + 2 sessions
  });
});
