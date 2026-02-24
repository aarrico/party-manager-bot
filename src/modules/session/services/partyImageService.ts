import { Guild } from 'discord.js';
import {
  getSession,
  getParty,
} from '#modules/session/repository/session.repository.js';
import { PartyMember } from '#modules/party/domain/party.types.js';
import {
  AvatarOptions,
  PartyMemberImgInfo,
} from '#modules/session/domain/session.types.js';
import { client } from '#app/index.js';
import {
  safeGuildFetch,
  safeUserFetch,
  safeGuildMemberFetch,
} from '#shared/discord/discordErrorHandler.js';
import { createScopedLogger } from '#shared/logging/logger.js';

const logger = createScopedLogger('PartyImageService');

export const convertPartyToImgInfo = async (
  party: PartyMember[],
  guildId: string
): Promise<PartyMemberImgInfo[]> => {
  const avatarOptions: AvatarOptions = {
    extension: 'png',
    forceStatic: true,
  };

  let guild: Guild | null = null;
  try {
    guild = await safeGuildFetch(client, guildId);
  } catch (error) {
    logger.warn('Could not fetch guild for party image conversion', {
      guildId,
      error,
    });
  }

  return Promise.all(
    party.map(async (member) => {
      try {
        const user = await safeUserFetch(client, member.userId);
        let displayName = member.username;
        let avatarURL = user.displayAvatarURL(avatarOptions);

        if (guild) {
          try {
            const guildMember = await safeGuildMemberFetch(
              guild,
              member.userId
            );
            displayName = guildMember.displayName;
            avatarURL = guildMember.displayAvatarURL(avatarOptions);
          } catch (guildMemberError) {
            logger.debug(
              'Could not fetch guild member, using user-level data',
              {
                userId: member.userId,
                guildId: guild.id,
                error: guildMemberError,
              }
            );
          }
        }

        return {
          userId: member.userId,
          username: member.username,
          displayName,
          userAvatarURL: avatarURL,
          role: member.role,
        };
      } catch (error) {
        logger.warn('Could not fetch avatar for user avatar rendering', {
          userId: member.userId,
          error,
        });
        return {
          userId: member.userId,
          username: member.username,
          displayName: member.username,
          userAvatarURL: `https://cdn.discordapp.com/embed/avatars/${member.userId.slice(-1)}.png`,
          role: member.role,
        };
      }
    })
  );
};

export const getPartyInfoForImg = async (
  sessionId: string
): Promise<PartyMemberImgInfo[]> => {
  const session = await getSession(sessionId);
  const party = await getParty(sessionId);
  return convertPartyToImgInfo(party, session.guildId);
};
