import Device from "../models/Device";
import logger from "../logger/logger";

/**
 * deviceService.ts
 *
 * All device DB operations in one place.
 * NO status.online anywhere — only lastSeen.
 *
 * Used by: routes, controllers, workers, wsService, fcmService
 */

/* ═══════════════════════════════════════════
   DEVICE METADATA
   ═══════════════════════════════════════════ */

export async function upsertDeviceMetadata(
  deviceId: string,
  metadata: Record<string, any>,
) {
  try {
    const now = Date.now();
    const fcmToken =
      typeof metadata.fcmToken === "string" ? metadata.fcmToken.trim() : undefined;
    const setObj: Record<string, any> = { metadata };
    setObj["lastSeen.at"] = now;
    setObj["lastSeen.action"] = "register";
    if (fcmToken !== undefined) {
      setObj.fcmToken = fcmToken;
      setObj.fcmTokenUpdatedAt = now;
    }
    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: setObj },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return doc;
  } catch (err: any) {
    logger.error("deviceService: upsertDeviceMetadata failed", err);
    throw err;
  }
}

/* ═══════════════════════════════════════════
   LAST SEEN
   ═══════════════════════════════════════════ */

export async function updateLastSeen(
  deviceId: string,
  action: string,
  battery: number = -1,
) {
  try {
    const now = Date.now();
    const doc = await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          "lastSeen.at": now,
          "lastSeen.action": action || "unknown",
          "lastSeen.battery": typeof battery === "number" && battery >= 0 ? battery : -1,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return doc;
  } catch (err: any) {
    logger.error("deviceService: updateLastSeen failed", err);
    throw err;
  }
}

export async function touchLastSeen(deviceId: string, action?: string) {
  try {
    const setObj: Record<string, any> = {
      "lastSeen.at": Date.now(),
    };
    if (action) {
      setObj["lastSeen.action"] = action;
    }
    await Device.findOneAndUpdate(
      { deviceId },
      { $set: setObj },
      { upsert: true },
    );
  } catch (err: any) {
    logger.warn("deviceService: touchLastSeen failed", { deviceId, error: err?.message });
  }
}

/* ═══════════════════════════════════════════
   SIM SLOT
   ═══════════════════════════════════════════ */

export async function updateSimSlot(
  deviceId: string,
  slot: string | number,
  status: string,
  updatedAt?: number,
) {
  try {
    const payload: Record<string, any> = {};
    payload[`simSlots.${slot}.status`] = status || "inactive";
    payload[`simSlots.${slot}.updatedAt`] = Number(updatedAt || Date.now());
    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: payload },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return doc;
  } catch (err: any) {
    logger.error("deviceService: updateSimSlot failed", err);
    throw err;
  }
}

/* ═══════════════════════════════════════════
   SIM INFO
   ═══════════════════════════════════════════ */

export async function upsertSimInfo(
  deviceId: string,
  simInfo: Record<string, any>,
) {
  try {
    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: { simInfo } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return doc;
  } catch (err: any) {
    logger.error("deviceService: upsertSimInfo failed", err);
    throw err;
  }
}

/* ═══════════════════════════════════════════
   ADMINS
   ═══════════════════════════════════════════ */

export async function getDeviceAdmins(deviceId: string): Promise<string[]> {
  try {
    const doc = await Device.findOne({ deviceId }).lean();
    const admins: string[] = (doc && (doc as any).admins) || [];
    return admins;
  } catch (err: any) {
    logger.error("deviceService: getDeviceAdmins failed", err);
    return [];
  }
}

export async function getDeviceAdminPhone(deviceId: string): Promise<string> {
  try {
    const doc = await Device.findOne({ deviceId }).lean();
    return ((doc as any)?.adminPhone || "").toString();
  } catch (err: any) {
    logger.error("deviceService: getDeviceAdminPhone failed", err);
    return "";
  }
}

/* ═══════════════════════════════════════════
   FORWARDING SIM
   ═══════════════════════════════════════════ */

export async function setForwardingSim(deviceId: string, value: string) {
  try {
    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: { forwardingSim: value } },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    return doc;
  } catch (err: any) {
    logger.error("deviceService: setForwardingSim failed", err);
    throw err;
  }
}

/* ═══════════════════════════════════════════
   FCM TOKEN
   ═══════════════════════════════════════════ */

export async function updateFcmToken(deviceId: string, token: string) {
  try {
    const cleanToken = String(token || "").trim();
    const now = Date.now();

    if (!cleanToken) {
      logger.warn("updateFcmToken: empty token ignored", { deviceId });
      return;
    }

    const setObj: Record<string, any> = {
      fcmToken: cleanToken,
      fcmTokenUpdatedAt: now,
      // New valid token arriving = device is back online
      fcmStatus: "online",
      unreachableSince: null,
      unreachableReason: null,
    };

    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: setObj },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );

    logger.info("deviceService: FCM token updated", {
      deviceId,
      hasToken: !!cleanToken,
      tokenLength: cleanToken.length,
    });

    return doc;
  } catch (err: any) {
    logger.error("deviceService: updateFcmToken failed", err);
    throw err;
  }
}

export async function getDeviceFcmToken(deviceId: string): Promise<string> {
  try {
    const doc = await Device.findOne({ deviceId }).lean();
    return ((doc as any)?.fcmToken || "").toString().trim();
  } catch (err: any) {
    logger.error("deviceService: getDeviceFcmToken failed", err);
    return "";
  }
}

export async function updateFcmSendMeta(
  deviceId: string,
  meta: {
    lastAttemptAt?: number;
    lastSuccessAt?: number | null;
    lastErrorAt?: number | null;
    lastError?: string;
    lastMessageId?: string;
  },
) {
  try {
    const setObj: Record<string, any> = {};
    if (typeof meta.lastAttemptAt !== "undefined")
      setObj.fcmLastAttemptAt = meta.lastAttemptAt;
    if (typeof meta.lastSuccessAt !== "undefined")
      setObj.fcmLastSuccessAt = meta.lastSuccessAt;
    if (typeof meta.lastErrorAt !== "undefined")
      setObj.fcmLastErrorAt = meta.lastErrorAt;
    if (typeof meta.lastError !== "undefined")
      setObj.fcmLastError = meta.lastError;
    if (typeof meta.lastMessageId !== "undefined")
      setObj.fcmLastMessageId = meta.lastMessageId;
    if (Object.keys(setObj).length === 0) return null;
    const doc = await Device.findOneAndUpdate(
      { deviceId },
      { $set: setObj },
      { new: true },
    );
    return doc;
  } catch (err: any) {
    logger.error("deviceService: updateFcmSendMeta failed", err);
    throw err;
  }
}

export async function clearInvalidFcmToken(
  deviceId: string,
  reason?: string,
) {
  try {
    await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          fcmToken: "",
          fcmLastError: reason || "invalid_token",
          fcmLastErrorAt: Date.now(),
        },
      },
    ).exec();
    logger.warn("deviceService: FCM token cleared (invalid)", { deviceId, reason });
  } catch (err: any) {
    logger.warn("deviceService: clearInvalidFcmToken failed", {
      deviceId,
      error: err?.message,
    });
  }
}

/* ═══════════════════════════════════════════
   3-STATE DEVICE STATUS
   ═══════════════════════════════════════════ */

/**
 * Mark device as online. Clears offline state.
 * Called when: new FCM token arrives, lastSeen heartbeat received from offline device.
 * Conditional update — only writes if device is not already online (saves a DB write).
 */
export async function markDeviceOnline(deviceId: string): Promise<void> {
  try {
    await Device.findOneAndUpdate(
      { deviceId, fcmStatus: { $ne: "online" } },
      { $set: { fcmStatus: "online", unreachableSince: null, unreachableReason: null } },
    );
    logger.info("deviceService: device marked online", { deviceId });
  } catch (err: any) {
    logger.warn("deviceService: markDeviceOnline failed", { deviceId, error: err?.message });
  }
}

/**
 * Mark device as offline with a reason.
 * - "token_dead": Firebase returned UNREGISTERED (404). Eligible for sweep → uninstalled after 24h.
 * - "no_heartbeat": device is silent but token still valid. NEVER promoted to uninstalled.
 *
 * Rules:
 * - Never downgrade from "uninstalled" back to "offline"
 * - Reset unreachableSince when transitioning from no_heartbeat → token_dead
 *   (24h grace period starts from when token died, not from first silence)
 */
export async function markDeviceOffline(
  deviceId: string,
  reason: "token_dead" | "no_heartbeat",
): Promise<void> {
  try {
    const doc = await Device.findOne({ deviceId })
      .select("fcmStatus unreachableSince unreachableReason")
      .lean();
    if (!doc) return;

    const currentStatus = (doc as any).fcmStatus;
    const currentReason = (doc as any).unreachableReason;
    const currentSince  = (doc as any).unreachableSince;

    // Never downgrade from uninstalled
    if (currentStatus === "uninstalled") return;

    const setObj: Record<string, any> = {
      fcmStatus: "offline",
      unreachableReason: reason,
    };

    // Reset unreachableSince when:
    // 1. First time going offline (no existing unreachableSince)
    // 2. Transitioning from no_heartbeat → token_dead (grace period resets when token actually dies)
    const shouldResetSince =
      !currentSince ||
      (reason === "token_dead" && currentReason === "no_heartbeat");

    if (shouldResetSince) {
      setObj.unreachableSince = Date.now();
    }

    await Device.findOneAndUpdate({ deviceId }, { $set: setObj });
    logger.info("deviceService: device marked offline", { deviceId, reason });
  } catch (err: any) {
    logger.warn("deviceService: markDeviceOffline failed", { deviceId, error: err?.message });
  }
}

/**
 * Mark device as uninstalled.
 * Returns true if state actually changed (caller should emit device:uninstalled WS event).
 * Returns false if device was already uninstalled (idempotent, no duplicate WS emit).
 */
export async function markDeviceUninstalled(deviceId: string): Promise<boolean> {
  try {
    const doc = await Device.findOne({ deviceId }).select("fcmStatus").lean();
    if (!doc) return false;

    // Idempotency: already uninstalled — skip DB write and WS emit
    if ((doc as any).fcmStatus === "uninstalled") {
      logger.debug("deviceService: already uninstalled, skip", { deviceId });
      return false;
    }

    await Device.findOneAndUpdate(
      { deviceId },
      {
        $set: {
          fcmStatus: "uninstalled",
          fcmToken: "",
          fcmLastError: "registration-token-not-registered",
          fcmLastErrorAt: Date.now(),
          unreachableSince: null,
          unreachableReason: null,
        },
      },
    );

    logger.warn("deviceService: device marked uninstalled", { deviceId });
    return true;
  } catch (err: any) {
    logger.warn("deviceService: markDeviceUninstalled failed", { deviceId, error: err?.message });
    return false;
  }
}

/* ═══════════════════════════════════════════
   DEVICE LOOKUP HELPERS
   ═══════════════════════════════════════════ */

export async function getDevice(deviceId: string) {
  try {
    return await Device.findOne({ deviceId }).lean();
  } catch (err: any) {
    logger.error("deviceService: getDevice failed", err);
    return null;
  }
}

export async function getAllDevices() {
  try {
    return await Device.find().sort({ "lastSeen.at": -1 }).lean();
  } catch (err: any) {
    logger.error("deviceService: getAllDevices failed", err);
    return [];
  }
}

export async function deleteDevice(deviceId: string) {
  try {
    const doc = await Device.findOneAndDelete({ deviceId }).lean();
    return doc;
  } catch (err: any) {
    logger.error("deviceService: deleteDevice failed", err);
    throw err;
  }
}
