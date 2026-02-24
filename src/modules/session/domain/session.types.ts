import { PartyMember } from '#modules/party/domain/party.types.js';

export type SessionStatus =
  | 'SCHEDULED'
  | 'ACTIVE'
  | 'COMPLETED'
  | 'CANCELED'
  | 'FULL';

export type Session = {
  id: string; // Discord message ID
  name: string;
  date: Date;
  timezone: string;
  campaignId: string; // Discord channel ID where session message is posted
  guildId: string; // Discord guild ID from the associated campaign
  eventId?: string | null;
  status?: SessionStatus;
};

export interface CreateSessionData {
  id: string; // Discord message ID (empty string initially, set after message creation)
  name: string;
  date: Date;
  timezone: string;
  campaignId: string; // Discord channel ID
  eventId?: string | null;
  status?: SessionStatus;
}

export interface ListSessionsOptions {
  includeId?: boolean;
  includeTime?: boolean;
  includeCampaign?: boolean;
  includeUserRole?: boolean;
  userId?: string;
  campaignId?: string;
  includeRole?: boolean;
}

export interface ListSessionsResult {
  status: string;
  id: string;
  name: string;
  date: Date;
  userRole?: string;
  campaign?: string;
}

export interface SessionWithParty extends Session {
  partyMembers: PartyMember[];
}

export interface SessionWithPartyPrismaResult {
  id: string;
  name: string;
  date: Date;
  campaignId: string;
  partyMembers: {
    user: { id: string; username: string; channelId: string };
    role: string;
  }[];
}

// Types for session image generation
export interface PartyMemberImgInfo {
  userId: string;
  userAvatarURL: string;
  username: string;
  displayName: string; // Server-specific display name (nickname) or username fallback
  role: string;
}

export interface AvatarOptions {
  extension: 'png';
  forceStatic: boolean;
}
