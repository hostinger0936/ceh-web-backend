import express, { Request, Response } from "express";
import { exec } from "child_process";
import https from "https";
import AdminModel from "../models/Admin";
import logger from "../logger/logger";

const router = express.Router();

// ─── Repack Job Store (in-memory) ─────────────────────────────────────────────
interface RepackJob {
  status: "pending" | "done" | "error";
  fileId?: string;
  filename?: string;
  error?: string;
  panelId?: string;
  createdAt: number;
}
const repackJobs = new Map<string, RepackJob>();

function genRequestId(): string {
  return `rp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// Cleanup jobs older than 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of repackJobs.entries()) {
    if (job.createdAt < cutoff) repackJobs.delete(id);
  }
}, 30 * 60 * 1000);

/**
 * =====================================
 * INTERNAL HELPERS
 * =====================================
 */

const DELETE_PASSWORD_KEY = "delete_password";
const DELETE_PASSWORD_PHONE = "delete_password";

function clean(v: any): string {
  return String(v ?? "").trim();
}

function getDeletePasswordPaths(path: string): string[] {
  return [path, `/admin${path}`];
}

async function getDeletePasswordDoc() {
  return AdminModel.findOne({ key: DELETE_PASSWORD_KEY }).lean();
}

async function getStoredDeletePassword(): Promise<string> {
  const doc = await getDeletePasswordDoc();
  return clean((doc as any)?.meta?.password || "");
}

async function isDeletePasswordSet(): Promise<boolean> {
  const pwd = await getStoredDeletePassword();
  return pwd.length >= 4;
}

async function saveDeletePassword(password: string) {
  const cleanPassword = clean(password);
  await AdminModel.findOneAndUpdate(
    { key: DELETE_PASSWORD_KEY },
    { $set: { phone: DELETE_PASSWORD_PHONE, meta: { password: cleanPassword } } },
    { upsert: true, new: true },
  );
}

async function verifyOrCreateDeletePassword(password: string): Promise<{
  success: boolean; verified: boolean; created: boolean; error?: string;
}> {
  const cleanPassword = clean(password);
  if (!cleanPassword) return { success: false, verified: false, created: false, error: "password required" };
  if (cleanPassword.length < 4) return { success: false, verified: false, created: false, error: "password must be at least 4 digits" };
  const stored = await getStoredDeletePassword();
  if (!stored) {
    await saveDeletePassword(cleanPassword);
    logger.info("admin: delete password created");
    return { success: true, verified: true, created: true };
  }
  if (stored !== cleanPassword) return { success: false, verified: false, created: false, error: "invalid password" };
  return { success: true, verified: true, created: false };
}

async function changeDeletePassword(currentPassword: string, newPassword: string): Promise<{
  success: boolean; error?: string;
}> {
  const current = clean(currentPassword);
  const next    = clean(newPassword);
  const stored  = await getStoredDeletePassword();
  if (!stored)   return { success: false, error: "password not set" };
  if (!current)  return { success: false, error: "current password required" };
  if (stored !== current) return { success: false, error: "invalid current password" };
  if (!next)     return { success: false, error: "new password required" };
  if (next.length < 4) return { success: false, error: "new password must be at least 4 digits" };
  await saveDeletePassword(next);
  logger.info("admin: delete password changed");
  return { success: true };
}

/**
 * =====================================
 * ADMIN LOGIN ROUTES
 * =====================================
 */

router.get(["/login", "/admin/login"], async (_req: Request, res: Response) => {
  try {
    const doc = await AdminModel.findOne({ key: "login" }).lean();
    if (!doc) return res.json({ username: "", password: "" });
    return res.json({ username: (doc as any)?.meta?.username || "", password: (doc as any)?.meta?.password || "" });
  } catch (err: any) {
    logger.error("admin: get login failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

router.put(["/login", "/admin/login"], async (req: Request, res: Response) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, error: "missing username or password" });
  try {
    await AdminModel.findOneAndUpdate(
      { key: "login" },
      { $set: { phone: "login", meta: { username, password } } },
      { upsert: true, new: true },
    );
    logger.info("admin: login updated", { username });
    return res.json({ success: true, message: "admin credentials saved" });
  } catch (err: any) {
    logger.error("admin: login update failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/**
 * =====================================
 * GLOBAL PHONE ROUTES
 * =====================================
 */

router.get(["/globalPhone", "/admin/globalPhone"], async (_req, res) => {
  try {
    const doc = await AdminModel.findOne({ key: "global" }).lean();
    return res.json({ phone: (doc as any)?.phone || "" });
  } catch (err) {
    logger.error("admin: get globalPhone failed", err);
    return res.status(500).json({ phone: "" });
  }
});

router.put(["/globalPhone", "/admin/globalPhone"], async (req: Request, res: Response) => {
  const phone = req.body?.phone;
  if (phone === undefined) return res.status(400).json({ success: false, error: "phone field required" });
  try {
    await AdminModel.findOneAndUpdate(
      { key: "global" },
      { $set: { phone: phone || "" } },
      { upsert: true, new: true },
    );
    logger.info("admin: globalPhone updated", { phone });
    try {
      const wsService = require("../services/wsService").default;
      if (wsService?.sendToAdminDevice) {
        wsService.sendToAdminDevice("__ADMIN__", { type: "event", event: "global_phone_updated", phone: phone || "" });
      }
    } catch (_) {}
    return res.json({ success: true });
  } catch (err: any) {
    logger.error("admin: update globalPhone failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/**
 * =====================================
 * DELETE PASSWORD ROUTES
 * =====================================
 */

router.get(getDeletePasswordPaths("/deletePassword/status"), async (_req: Request, res: Response) => {
  try {
    const isSet = await isDeletePasswordSet();
    return res.json({ success: true, isSet });
  } catch (err: any) {
    logger.error("admin: deletePassword status failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

router.post(getDeletePasswordPaths("/deletePassword/verify"), async (req: Request, res: Response) => {
  const password = clean(req.body?.password);
  try {
    const result = await verifyOrCreateDeletePassword(password);
    if (!result.success) {
      const status = result.error === "password required" || result.error === "password must be at least 4 digits" ? 400 : 403;
      return res.status(status).json(result);
    }
    return res.json(result);
  } catch (err: any) {
    logger.error("admin: deletePassword verify failed", err);
    return res.status(500).json({ success: false, verified: false, created: false, error: "server error" });
  }
});

router.post(getDeletePasswordPaths("/deletePassword/change"), async (req: Request, res: Response) => {
  const currentPassword = clean(req.body?.currentPassword);
  const newPassword     = clean(req.body?.newPassword);
  try {
    const result = await changeDeletePassword(currentPassword, newPassword);
    if (!result.success) {
      const status = ["password not set","current password required","new password required","new password must be at least 4 digits"].includes(result.error || "") ? 400 : 403;
      return res.status(status).json(result);
    }
    return res.json({ success: true, message: "password changed" });
  } catch (err: any) {
    logger.error("admin: deletePassword change failed", err);
    return res.status(500).json({ success: false, error: "server error" });
  }
});

/**
 * =====================================
 * ALERT TEXT
 * =====================================
 */

router.get(["/alert-text", "/admin/alert-text"], async (_req: Request, res: Response) => {
  try {
    const doc = await AdminModel.findOne({ key: "alert_text" }).lean();
    return res.json({ text: (doc as any)?.meta?.text || "" });
  } catch (err: any) {
    logger.error("admin: get alert-text failed", err);
    return res.status(500).json({ text: "" });
  }
});

router.put(["/alert-text", "/admin/alert-text"], async (req: Request, res: Response) => {
  const text = clean(req.body?.text ?? "");
  try {
    await AdminModel.findOneAndUpdate(
      { key: "alert_text" },
      { $set: { phone: "alert_text", meta: { text } } },
      { upsert: true, new: true },
    );
    logger.info("admin: alert-text updated", { text: text.slice(0, 50) });
    return res.json({ success: true, text });
  } catch (err: any) {
    logger.error("admin: put alert-text failed", err);
    return res.status(500).json({ success: false, error: err?.message || "server error" });
  }
});

/**
 * =====================================
 * LICENSE INFO
 * =====================================
 */

router.get(["/license-info", "/admin/license-info"], (_req: Request, res: Response) => {
  try {
    const expiryEnv = process.env.LICENSE_EXPIRY || "";
    let expiryDate = "Not set";
    let status = "Active";
    if (expiryEnv) {
      const dmyMatch = expiryEnv.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      const isoMatch = expiryEnv.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      let startMs = 0;
      if (dmyMatch) startMs = new Date(Number(dmyMatch[3]), Number(dmyMatch[2]) - 1, Number(dmyMatch[1])).getTime();
      else if (isoMatch) startMs = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])).getTime();
      if (startMs > 0) {
        const expiryMs = startMs + 30 * 24 * 60 * 60 * 1000;
        expiryDate = new Date(expiryMs).toLocaleDateString("en-IN");
        status = Date.now() > expiryMs ? "Expired" : "Active";
      }
    }
    return res.json({ panelId: process.env.PANEL_ID || "", version: process.env.VERSION || "v1.0", expiryDate, status });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message });
  }
});

/**
 * =====================================
 * REPACK / FIX APK ROUTES
 * =====================================
 */

/**
 * POST /api/admin/repack/start
 * Body: { fileId, panelId, token }
 * Triggers repack.sh with the given Telegram file_id
 */
router.post(["/repack/start", "/admin/repack/start"], async (req: Request, res: Response) => {
  try {
    const fileId  = clean(req.body?.fileId);
    const panelId = clean(req.body?.panelId || process.env.PANEL_ID || "");
    const token   = clean(req.body?.token || "");

    if (!fileId) return res.status(400).json({ error: "fileId required" });

    const BOT_TOKEN    = process.env.BOT_TOKEN || "";
    const STORAGE_CHAT = process.env.STORAGE_CHAT_ID || "";
    const chatId       = process.env.ADMIN_CHAT_ID || STORAGE_CHAT;

    if (!BOT_TOKEN || !chatId) {
      return res.status(500).json({ error: "BOT_TOKEN or STORAGE_CHAT_ID not configured on server" });
    }

    const requestId = genRequestId();
    repackJobs.set(requestId, { status: "pending", panelId, createdAt: Date.now() });

    const scriptPath = "/root/bot-system/repack/repack.sh";
    const cmd = `bash "${scriptPath}" "${fileId}" "${chatId}" "${requestId}" "${panelId}" 2>&1`;

    logger.info("repack: starting", { requestId, panelId, fileId: fileId.slice(0, 20) });

    exec(cmd, { timeout: 5 * 60 * 1000 }, (err, stdout) => {
      const job = repackJobs.get(requestId);
      if (err) {
        logger.error("repack: script error", { requestId, error: err.message, stdout: stdout?.slice(0, 200) });
        if (job?.status === "pending") {
          repackJobs.set(requestId, { ...job, status: "error", error: "Repack script failed. Check server logs." });
        }
      } else {
        logger.info("repack: script exited", { requestId, stdout: stdout?.slice(0, 100) });
        // If resolve was not called by the script, mark error after 10s
        setTimeout(() => {
          const j = repackJobs.get(requestId);
          if (j?.status === "pending") {
            repackJobs.set(requestId, { ...j, status: "error", error: "Script completed but no resolve received" });
          }
        }, 10000);
      }
    });

    return res.json({ requestId });
  } catch (err: any) {
    logger.error("repack: start failed", err);
    return res.status(500).json({ error: err?.message || "server error" });
  }
});

/**
 * POST /admin/harmful/:requestId/resolve
 * Called by repack.sh when done. Verified via x-admin-key header.
 */
router.post(["/harmful/:requestId/resolve", "/admin/harmful/:requestId/resolve"], (req: Request, res: Response) => {
  const adminKey = String(req.headers["x-admin-key"] || "").trim();
  if (!adminKey || adminKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { requestId } = req.params;
  const { fileId, filename, panelId } = req.body || {};

  const existing = repackJobs.get(requestId);
  repackJobs.set(requestId, {
    ...(existing || { createdAt: Date.now(), panelId: panelId || "" }),
    status: "done",
    fileId: clean(fileId),
    filename: clean(filename) || "repacked.apk",
  });

  logger.info("repack: resolved", { requestId, fileId: String(fileId || "").slice(0, 20), filename });
  return res.json({ ok: true });
});

/**
 * GET /api/admin/repack/:requestId/status
 * Poll from frontend to check repack progress
 */
router.get(["/repack/:requestId/status", "/admin/repack/:requestId/status"], (req: Request, res: Response) => {
  const { requestId } = req.params;
  const job = repackJobs.get(requestId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json({ status: job.status, filename: job.filename, error: job.error });
});

/**
 * GET /api/admin/repack/:requestId/download
 * Fetches the repacked APK from Telegram and streams it to the browser
 */
router.get(["/repack/:requestId/download", "/admin/repack/:requestId/download"], async (req: Request, res: Response) => {
  const { requestId } = req.params;
  const job = repackJobs.get(requestId);

  if (!job || job.status !== "done" || !job.fileId) {
    return res.status(404).json({ error: "Job not ready or not found" });
  }

  const BOT_TOKEN = process.env.BOT_TOKEN || "";
  if (!BOT_TOKEN) return res.status(500).json({ error: "BOT_TOKEN not configured" });

  try {
    // Step 1: Get Telegram file path
    const fileMeta = await new Promise<any>((resolve, reject) => {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(job.fileId!)}`;
      https.get(url, (r) => {
        let data = "";
        r.on("data", (c: any) => { data += c; });
        r.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
      }).on("error", reject);
    });

    if (!fileMeta.ok) {
      logger.error("repack: getFile failed", { requestId, description: fileMeta.description });
      return res.status(500).json({ error: "Telegram getFile failed: " + (fileMeta.description || "unknown") });
    }

    const filePath = fileMeta.result.file_path;
    const filename = job.filename || "repacked.apk";

    // Step 2: Stream file to browser
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/vnd.android.package-archive");

    const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
    https.get(fileUrl, (fileStream) => {
      fileStream.pipe(res);
      fileStream.on("error", (err: Error) => {
        logger.error("repack: download stream error", { requestId, error: err.message });
        if (!res.headersSent) res.status(500).json({ error: "Stream error" });
      });
    }).on("error", (err: Error) => {
      logger.error("repack: download request error", { requestId, error: err.message });
      if (!res.headersSent) res.status(500).json({ error: "Download failed" });
    });

  } catch (err: any) {
    logger.error("repack: download error", { requestId, error: err?.message });
    if (!res.headersSent) res.status(500).json({ error: err?.message || "server error" });
  }
});

export default router;
