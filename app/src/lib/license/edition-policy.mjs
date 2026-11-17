/**
 * What each edition unlocks. One table, read by the desktop gates and mirrored in Kotlin (EditionPolicy.kt).
 * Free keeps everything needed to link and use your own machines. Nothing here ever locks a user out of
 * their own files: a lapsed or missing license only turns the paid extras back off.
 */

export const EDITION_ORDER = ["free", "pro", "elite", "enterprise"];

export const EDITION_NAMES = { free: "Free", pro: "Pro", elite: "Elite", enterprise: "Enterprise" };

/** Seconds are not used here. Remote access timer choices are minutes. */
export const POLICY = {
  free: {
    remoteAccess: false,
    publicAccess: false,
    remoteMinutes: [],
    sharedFolders: 3,
    defaultSeats: 0,
  },
  pro: {
    remoteAccess: true,
    publicAccess: true,
    remoteMinutes: [15, 60, 240],
    sharedFolders: 25,
    defaultSeats: 3,
  },
  elite: {
    remoteAccess: true,
    publicAccess: true,
    remoteMinutes: [15, 60, 240, 1440],
    sharedFolders: -1, // unlimited
    defaultSeats: 10,
  },
  enterprise: {
    remoteAccess: true,
    publicAccess: true,
    remoteMinutes: [15, 60, 240, 1440],
    sharedFolders: -1,
    defaultSeats: 0,
  },
};

export const FEATURES = {
  remote_access: "Remote access from a trusted device",
  public_access: "Public access over your own port forward",
  remote_24h: "24-hour remote sessions",
  shared_folders: "More shared folders",
};

/** The lowest edition that includes a feature, used for upgrade prompts. */
export function requiredEdition(feature) {
  switch (feature) {
    case "remote_access":
    case "public_access":
      return "pro";
    case "remote_24h":
      return "elite";
    case "shared_folders":
      return "pro";
    default:
      return "pro";
  }
}

/** @param {string} edition */
export function policyFor(edition) {
  return POLICY[edition] || POLICY.free;
}

/**
 * @param {string} edition effective edition (already "free" when the license is expired or unverified)
 * @param {string} feature
 */
export function editionAllows(edition, feature) {
  const p = policyFor(edition);
  switch (feature) {
    case "remote_access":
      return p.remoteAccess;
    case "public_access":
      return p.publicAccess;
    case "remote_24h":
      return p.remoteMinutes.includes(1440);
    default:
      return false;
  }
}

/** Is `minutes` an allowed remote access timer on this edition? */
export function remoteMinutesAllowed(edition, minutes) {
  return policyFor(edition).remoteMinutes.includes(Number(minutes));
}

/** Allowed number of shared folders for an edition. -1 is unlimited. */
export function sharedFolderLimit(edition) {
  return policyFor(edition).sharedFolders;
}

/**
 * A friendly upgrade message for a blocked feature. Same wording on desktop and phone.
 * @param {string} feature
 */
export function upgradeMessage(feature, current = "free") {
  const need = EDITION_NAMES[requiredEdition(feature)];
  switch (feature) {
    case "remote_access":
      return `Remote access is a ${need} feature. Your own machines still link and open each other for free. Upgrade to turn on time-limited remote access from a trusted device.`;
    case "public_access":
      return `Public access is a ${need} feature. Tailscale and your own machines keep working. Upgrade to open a port you forwarded yourself.`;
    case "remote_24h":
      return "24-hour remote sessions are an Elite feature. Pick 15 minutes, 1 hour or 4 hours, or upgrade to Elite.";
    case "shared_folders":
      return `You are at the shared folder limit for ${EDITION_NAMES[current] || "Free"}. Your existing folders keep working. Upgrade to share more.`;
    default:
      return `This is a ${need} feature.`;
  }
}
