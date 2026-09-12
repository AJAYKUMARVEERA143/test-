import { useCallback, useEffect, useState } from "react";
import { History, Loader2, RotateCcw } from "lucide-react";
import { listVersions } from "../../services/CreatorStudioApiClient.js";
import "./CreatorVersionHistory.css";

/**
 * Version history for one resource (an asset, a shot, an episode video, ...).
 * Regeneration never overwrites — creatorProductWorkflow.js (and future
 * pipeline phases) call CreatorStudioApiClient.recordVersion() on every
 * successful generation, so this always has something to show once a
 * resource has been generated at least once.
 */
export default function CreatorVersionHistory({ resourceType, resourceId, onRevert }) {
  const [versions, setVersions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revertingId, setRevertingId] = useState("");

  const refresh = useCallback(async () => {
    if (!resourceType || !resourceId) return;
    setLoading(true);
    setError("");
    try {
      const rows = await listVersions(resourceType, resourceId);
      setVersions(rows || []);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [resourceType, resourceId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  async function handleRevert(version) {
    if (!onRevert) return;
    setRevertingId(version.id);
    try {
      await onRevert(version);
    } finally {
      setRevertingId("");
    }
  }

  if (!resourceType || !resourceId) return null;

  return (
    <section className="creator-version-history" aria-label="Version history">
      <header>
        <History size={14} /> <span>Version history</span>
      </header>
      {error ? <div className="creator-version-error">{error}</div> : null}
      {loading ? (
        <div className="creator-version-loading"><Loader2 size={14} className="creator-version-spin" /></div>
      ) : versions.length === 0 ? (
        <p className="creator-version-empty">No versions yet — generate once to start history.</p>
      ) : (
        <ol className="creator-version-list">
          {versions.map((version, index) => (
            <li key={version.id} className={index === 0 ? "is-current" : ""}>
              <div className="creator-version-thumb">
                <img src={version.file_path} alt={`Version ${version.version}`} />
              </div>
              <div className="creator-version-meta">
                <b>v{version.version}</b>
                <small>{new Date(version.created_at).toLocaleString()}</small>
              </div>
              {index === 0 ? (
                <span className="creator-version-current-badge">Current</span>
              ) : (
                <button
                  type="button"
                  onClick={() => handleRevert(version)}
                  disabled={revertingId === version.id}
                >
                  {revertingId === version.id ? <Loader2 size={12} className="creator-version-spin" /> : <RotateCcw size={12} />} Revert
                </button>
              )}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
