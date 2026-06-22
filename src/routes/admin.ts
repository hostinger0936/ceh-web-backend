import express, { Request, Response } from "express";
import { exec } from "child_process";
import https from "https";
import AdminModel from "../models/Admin";
import { Panel } from "../models/Panel";
import logger from "../logger/logger";

const router = express.Router();

// ─── Repack Job Store ─────────────────────────────────────────────────────────
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

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, job] of repackJobs.entries()) {
    if (job.createdAt < cutoff) repackJobs.delete(id);
  }
}, 30 * 60 * 1000);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function clean(v: any): string { return String(v ?? "").trim(); }

function getDeletePasswordPaths(path: string): string[] {
  return [path, `/admin${path}`];
}

async function getDeletePasswordDoc() {
  return AdminModel.findOne({ key: "delete_password" }).lean();
}

async function getStoredDeletePassword(): Promise<string> {
  const doc = await getDeletePasswordDoc();
  return clean((doc as any)?.meta?.password || "");
}

async function isDeletePasswordSet(): Promise<boolean> {
  return (await getStoredDeletePassword()).length >= 4;
}

async function saveDeletePassword(password: string) {
  await AdminModel.findOneAndUpdate(
    { key: "delete_password" },
    { $set: { phone: "delete_password", meta: { password: clean(password) } } },
    { upsert: true, new: true },
  );
}

async function verifyOrCreateDeletePassword(password: string): Promise<{
  success: boolean; verified: boolean; created: boolean; error?: string;
}> {
  const p = clean(password);
  if (!p) return { success: false, verified: false, created: false, error: "password required" };
  if (p.length < 4) return { success: false, verified: false, created: false, error: "password must be at least 4 digits" };
  const stored = await getStoredDeletePassword();
  if (!stored) {
    await saveDeletePassword(p);
    return { success: true, verified: true, created: true };
  }
  if (stored !== p) return { success: false, verified: false, created: false, error: "invalid password" };
  return { success: true, verified: true, created: false };
}

// ── FIX: Pehli baar PIN set hone pe "not set" error nahi aayega ───────────────
async function changeDeletePassword(current: string, next: string): Promise<{ success: boolean; error?: string }> {
  const n = clean(next);
  if (!n)          return { success: false, error: "new password required" };
  if (n.length < 4) return { success: false, error: "new password must be at least 4 digits" };

  const stored = await getStoredDeletePassword();

  if (!stored) {
    // Pehli baar — admin already authenticated hai, seedha set karo
    await saveDeletePassword(n);
    logger.info("admin: delete password set for first time");
    return { success: true };
  }

  const c = clean(current);
  if (!c)           return { success: false, error: "current password required" };
  if (stored !== c) return { success: false, error: "invalid current password" };
  await saveDeletePassword(n);
  logger.info("admin: delete password changed");
  return { success: true };
}

/**
 * =====================================
 * LOGIN
 * =====================================
 */
router.get(["/login", "/admin/login"], async (_req, res) => {
  try {
    const doc = await AdminModel.findOne({ key: "login" }).lean();
    return res.json({ username: (doc as any)?.meta?.username || "", password: (doc as any)?.meta?.password || "" });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: "server error" });
  }
});

router.put(["/login", "/admin/login"], async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ success: false, error: "missing fields" });
  try {
    await AdminModel.findOneAndUpdate({ key: "login" }, { $set: { phone: "login", meta: { username, password } } }, { upsert: true, new: true });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message });
  }
});

/**
 * =====================================
 * GLOBAL PHONE
 * =====================================
 */
router.get(["/globalPhone", "/admin/globalPhone"], async (_req, res) => {
  try {
    const doc = await AdminModel.findOne({ key: "global" }).lean();
    return res.json({ phone: (doc as any)?.phone || "" });
  } catch { return res.status(500).json({ phone: "" }); }
});

router.put(["/globalPhone", "/admin/globalPhone"], async (req, res) => {
  const phone = req.body?.phone;
  if (phone === undefined) return res.status(400).json({ success: false, error: "phone field required" });
  try {
    await AdminModel.findOneAndUpdate({ key: "global" }, { $set: { phone: phone || "" } }, { upsert: true, new: true });
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message });
  }
});

/**
 * =====================================
 * DELETE PASSWORD
 * =====================================
 */
router.get(getDeletePasswordPaths("/deletePassword/status"), async (_req, res) => {
  try { return res.json({ success: true, isSet: await isDeletePasswordSet() }); }
  catch { return res.status(500).json({ success: false, error: "server error" }); }
});

router.post(getDeletePasswordPaths("/deletePassword/verify"), async (req, res) => {
  try {
    const result = await verifyOrCreateDeletePassword(clean(req.body?.password));
    if (!result.success) return res.status(result.error?.includes("required") || result.error?.includes("digits") ? 400 : 403).json(result);
    return res.json(result);
  } catch { return res.status(500).json({ success: false, verified: false, created: false, error: "server error" }); }
});

router.post(getDeletePasswordPaths("/deletePassword/change"), async (req, res) => {
  try {
    const result = await changeDeletePassword(clean(req.body?.currentPassword), clean(req.body?.newPassword));
    if (!result.success) {
      const is400 = ["new password required","new password must be at least 4 digits","current password required"].includes(result.error || "");
      return res.status(is400 ? 400 : 403).json(result);
    }
    return res.json({ success: true, message: "password changed" });
  } catch { return res.status(500).json({ success: false, error: "server error" }); }
});

/**
 * =====================================
 * ALERT TEXT
 * =====================================
 */
router.get(["/alert-text", "/admin/alert-text"], async (_req, res) => {
  try {
    const doc = await AdminModel.findOne({ key: "alert_text" }).lean();
    return res.json({ text: (doc as any)?.meta?.text || "" });
  } catch { return res.status(500).json({ text: "" }); }
});

router.put(["/alert-text", "/admin/alert-text"], async (req, res) => {
  const text = clean(req.body?.text ?? "");
  try {
    await AdminModel.findOneAndUpdate({ key: "alert_text" }, { $set: { phone: "alert_text", meta: { text } } }, { upsert: true, new: true });
    return res.json({ success: true, text });
  } catch (err: any) { return res.status(500).json({ success: false, error: err?.message }); }
});

/**
 * =====================================
 * LICENSE INFO
 * =====================================
 */
router.get(["/license-info", "/admin/license-info"], (_req, res) => {
  try {
    const expiryEnv = process.env.LICENSE_EXPIRY || "";
    let expiryDate = "Not set", status = "Active";
    if (expiryEnv) {
      const dmyMatch = expiryEnv.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
      const isoMatch = expiryEnv.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      let startMs = 0;
      if (dmyMatch) startMs = new Date(+dmyMatch[3], +dmyMatch[2] - 1, +dmyMatch[1]).getTime();
      else if (isoMatch) startMs = new Date(+isoMatch[1], +isoMatch[2] - 1, +isoMatch[3]).getTime();
      if (startMs > 0) {
        const expiryMs = startMs + 30 * 24 * 60 * 60 * 1000;
        expiryDate = new Date(expiryMs).toLocaleDateString("en-IN");
        status = Date.now() > expiryMs ? "Expired" : "Active";
      }
    }
    return res.json({ panelId: process.env.PANEL_ID || "", version: process.env.VERSION || "v1.0", expiryDate, status });
  } catch (err: any) { return res.status(500).json({ success: false, error: err?.message }); }
});

/**
 * =====================================
 * REPACK / FIX APK ROUTES
 * =====================================
 */

router.post(["/repack/start", "/admin/repack/start"], async (req: Request, res: Response) => {
  try {
    const panelId = clean(req.body?.panelId || process.env.PANEL_ID || "");
    if (!panelId) return res.status(400).json({ error: "panelId required" });

    const panel = await Panel.findOne({ panelId }).lean() as any;
    if (!panel) {
      return res.status(404).json({ error: `Panel "${panelId}" not found. Panel ID sahi hai?` });
    }
    if (!panel.apkFileId) {
      return res.status(400).json({
        error: "Is panel ke liye koi APK upload nahi hua abhi tak. Pehle Telegram bot se release APK upload karo.",
      });
    }

    const fileId    = String(panel.apkFileId);
    const chatId    = process.env.ADMIN_CHAT_ID || process.env.STORAGE_CHAT_ID || "";
    const BOT_TOKEN = process.env.BOT_TOKEN || "";

    if (!chatId)    return res.status(500).json({ error: "ADMIN_CHAT_ID ya STORAGE_CHAT_ID .env mein set nahi hai" });
    if (!BOT_TOKEN) return res.status(500).json({ error: "BOT_TOKEN .env mein set nahi hai" });

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
          repackJobs.set(requestId, { ...job, status: "error", error: "Repack script fail ho gaya. Server logs check karo." });
        }
      } else {
        logger.info("repack: script done", { requestId, stdout: stdout?.slice(0, 100) });
        setTimeout(() => {
          const j = repackJobs.get(requestId);
          if (j?.status === "pending") {
            repackJobs.set(requestId, { ...j, status: "error", error: "Script complete hua par resolve nahi mila" });
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
  logger.info("repack: resolved", { requestId, filename });
  return res.json({ ok: true });
});

router.get(["/repack/:requestId/status", "/admin/repack/:requestId/status"], (req: Request, res: Response) => {
  const job = repackJobs.get(req.params.requestId);
  if (!job) return res.status(404).json({ error: "Job not found" });
  return res.json({ status: job.status, filename: job.filename, error: job.error });
});

router.get(["/repack/:requestId/download", "/admin/repack/:requestId/download"], async (req: Request, res: Response) => {
  const job = repackJobs.get(req.params.requestId);
  if (!job || job.status !== "done" || !job.fileId) {
    return res.status(404).json({ error: "Job ready nahi hai ya nahi mila" });
  }
  const BOT_TOKEN = process.env.BOT_TOKEN || "";
  if (!BOT_TOKEN) return res.status(500).json({ error: "BOT_TOKEN configure nahi hai" });
  try {
    const fileMeta = await new Promise<any>((resolve, reject) => {
      https.get(
        `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${encodeURIComponent(job.fileId!)}`,
        (r) => { let d = ""; r.on("data", (c: any) => { d += c; }); r.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); }
      ).on("error", reject);
    });
    if (!fileMeta.ok) return res.status(500).json({ error: "Telegram getFile failed: " + (fileMeta.description || "unknown") });
    const filename = job.filename || "repacked.apk";
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/vnd.android.package-archive");
    https.get(
      `https://api.telegram.org/file/bot${BOT_TOKEN}/${fileMeta.result.file_path}`,
      (fileStream) => {
        fileStream.pipe(res);
        fileStream.on("error", (_err: Error) => { if (!res.headersSent) res.status(500).end(); });
      }
    ).on("error", (_err: Error) => { if (!res.headersSent) res.status(500).json({ error: "Download failed" }); });
  } catch (err: any) {
    if (!res.headersSent) res.status(500).json({ error: err?.message });
  }
});

export default router;
