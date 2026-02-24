import { Campaign } from '#generated/prisma/client.js';
import { prisma } from '#app/index.js';
export const upsertCampaign = async (campaignData: {
  id: string;
  guildId: string;
  name: string;
}): Promise<Campaign> => {
  return await prisma.campaign.upsert({
    where: { id: campaignData.id },
    create: {
      id: campaignData.id,
      guildId: campaignData.guildId,
      name: campaignData.name,
    },
    update: {
      name: campaignData.name,
      guildId: campaignData.guildId,
      updatedAt: new Date(),
    },
  });
};

export const getCampaignById = async (
  campaignId: string
): Promise<Campaign | null> => {
  return await prisma.campaign.findUnique({
    where: { id: campaignId },
  });
};

export const getAllCampaigns = async (): Promise<Campaign[]> => {
  return await prisma.campaign.findMany({
    orderBy: { name: 'asc' },
  });
};

/**
 * Get campaign details including guildId for a given campaignId (channel ID).
 * Useful for generating Discord URLs and accessing guild-level features like scheduled events.
 */
export const getCampaignWithGuildId = async (
  campaignId: string
): Promise<{ id: string; name: string; guildId: string } | null> => {
  return await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, name: true, guildId: true },
  });
};
