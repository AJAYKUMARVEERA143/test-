// Data-fetching hook for the Creator Studio asset library — wraps
// CreatorStudioApiClient.js so components stay declarative. Global scope only
// for now (no projectId): per-project asset scoping lands in Phase F's
// Lorebook view once local Creator projects and the new creator_projects
// MySQL table have a real mapping between them.
import { useCallback, useEffect, useState } from "react";
import * as CreatorStudioApiClient from "../../services/CreatorStudioApiClient.js";

export function useCreatorAssetLibrary({ assetType = "" } = {}) {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const rows = await CreatorStudioApiClient.listAssets({ assetType: assetType || undefined });
      setAssets(rows || []);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, [assetType]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Each action reports its own failure through `error` and re-throws for
  // callers that care. Without this, a click straight onto an async action
  // (Remove) surfaced as an unhandled rejection overlay instead of a message.
  const createAsset = useCallback(async (payload) => {
    setError("");
    try {
      const asset = await CreatorStudioApiClient.createAsset(payload);
      setAssets((prev) => [asset, ...prev]);
      return asset;
    } catch (err) {
      setError(String(err?.message || err));
      throw err;
    }
  }, []);

  const removeAsset = useCallback(async (id) => {
    setError("");
    try {
      await CreatorStudioApiClient.deleteAsset(id);
      setAssets((prev) => prev.filter((asset) => asset.id !== id));
    } catch (err) {
      setError(`Could not remove it: ${String(err?.message || err)}`);
    }
  }, []);

  const updateAsset = useCallback(async (id, payload) => {
    setError("");
    try {
      const updated = await CreatorStudioApiClient.updateAsset(id, payload);
      setAssets((prev) => prev.map((asset) => (asset.id === id ? updated : asset)));
      return updated;
    } catch (err) {
      setError(String(err?.message || err));
      throw err;
    }
  }, []);

  return { assets, loading, error, refresh, createAsset, removeAsset, updateAsset };
}
