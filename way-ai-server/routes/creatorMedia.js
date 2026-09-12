// way-ai-server/routes/creatorMedia.js
// Creator Studio: authenticated media streaming. Deliberately NOT express.static
// — every request re-derives the path from the authenticated user's own storage
// directory and rejects any attempt to escape it (path traversal), rather than
// serving the whole storage root to anyone who guesses a URL.

const express = require("express");
const fs = require("fs");
const path = require("path");
const { STORAGE_ROOT } = require("./creatorUploads.js");

module.exports = (_db) => {
  const router = express.Router();

  // :relPath is a wildcard capturing the same relative path returned by the
  // upload route (e.g. "<userId>/uploads/<uuid>.png").
  router.get("/:relPath(*)", (req, res) => {
    const userId = String(req.user.id).replace(/[^a-zA-Z0-9_-]/g, "_");
    const requested = path.normalize(req.params.relPath || "");
    // The path must start with this user's own directory — no other user's
    // files are reachable even with a guessed/leaked path string.
    if (!requested.startsWith(`${userId}${path.sep}`) && !requested.startsWith(`${userId}/`)) {
      return res.status(403).json({ error: "Not authorized to access this file" });
    }
    const fullPath = path.join(STORAGE_ROOT, requested);
    const resolvedRoot = path.resolve(STORAGE_ROOT);
    const resolvedPath = path.resolve(fullPath);
    if (!resolvedPath.startsWith(resolvedRoot + path.sep)) {
      return res.status(400).json({ error: "Invalid path" });
    }
    fs.stat(resolvedPath, (err, stat) => {
      if (err || !stat.isFile()) return res.status(404).json({ error: "File not found" });
      res.sendFile(resolvedPath);
    });
  });

  return router;
};
