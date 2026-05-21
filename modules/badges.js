const BADGES = [
  { key: 'rank_cadet', name: 'Cadet' },
  { key: 'rank_commando', name: 'Commando' },
  { key: 'rank_seal', name: 'Seal' },
  { key: 'rank_vanguard', name: 'Vanguard' },
];

const BADGE_NAME_SET = new Set(BADGES.map(badge => badge.name));

function normalizeBadgeNames(names) {
  return [...new Set((names || []).filter(Boolean))].sort();
}

function extractBadgeNames(profile) {
  const badges = Array.isArray(profile?.badges) ? profile.badges : [];
  return normalizeBadgeNames(badges
    .map(badge => badge?.badge__name || badge?.name || '')
    .filter(name => BADGE_NAME_SET.has(name)));
}

function getMintableBadges(profile) {
  const badges = Array.isArray(profile?.badges) ? profile.badges : [];
  const mintableNames = badges
    .filter(badge => {
      const name = badge?.badge__name || badge?.name || '';
      const txHash = String(badge?.nft_tx_hash || '').trim();
      return BADGE_NAME_SET.has(name) && !txHash;
    })
    .map(badge => badge?.badge__name || badge?.name || '');

  return BADGES.filter(badge => mintableNames.includes(badge.name));
}

function getMintedBadgeNames(profile) {
  const badges = Array.isArray(profile?.badges) ? profile.badges : [];
  return normalizeBadgeNames(badges
    .filter(badge => {
      const name = badge?.badge__name || badge?.name || '';
      const txHash = String(badge?.nft_tx_hash || '').trim();
      return BADGE_NAME_SET.has(name) && !!txHash;
    })
    .map(badge => badge?.badge__name || badge?.name || ''));
}

function buildBadgeStatus(profile) {
  const targetBadges = extractBadgeNames(profile);
  const mintedBadges = getMintedBadgeNames(profile);
  const unmintedBadges = normalizeBadgeNames(getMintableBadges(profile).map(badge => badge.name));

  return {
    target_badges: targetBadges,
    minted_badges: mintedBadges,
    unminted_badges: unmintedBadges,
  };
}

module.exports = {
  BADGES,
  normalizeBadgeNames,
  extractBadgeNames,
  getMintedBadgeNames,
  getMintableBadges,
  buildBadgeStatus,
};
