// way-ai-server/routes/creatorUploads.js
// Creator Studio: file upload (product/reference images for now). Writes under
// CREATOR_STORAGE_PATH, one subfolder per user — never express.static-exposed;
// serving goes through creatorMedia.js's authenticated, ownership-checked route
// instead of a direct filesystem URL.

const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

const STORAGE_ROOT = process.env.CREATOR_STORAGE_PATH || path.join(__dirname, "..", "storage", "creator");
const ALLOWED_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "audio/mpeg", "audio/mp3", "audio/wav"]);
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10MB

function userUploadDir(userId) {
  const dir = path.join(STORAGE_ROOT, String(userId).replace(/[^a-zA-Z0-9_-]/g, "_"), "uploads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const storage = multer.diskStorage({
  destination: (req, _file, cb) => cb(null, userUploadDir(req.user.id)),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase().slice(0, 10);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_FILE_BYTES, files: 6 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
    cb(null, true);
  },
});

module.exports = (_db) => {
  const router = express.Router();

  router.post("/", (req, res) => {
    upload.array("files", 6)(req, res, (err) => {
      if (err) return res.status(400).json({ error: err.message });
      const files = (req.files || []).map((file) => ({
        // Relative path only — the media route resolves this against the
        // authenticated user's own storage dir, never a caller-supplied path.
        path: path.relative(STORAGE_ROOT, file.path).replace(/\\/g, "/"),
        originalName: file.originalname,
        size: file.size,
        mimeType: file.mimetype,
      }));
      res.status(201).json({ files });
    });
  });

  return router;
};

module.exports.STORAGE_ROOT = STORAGE_ROOT;
