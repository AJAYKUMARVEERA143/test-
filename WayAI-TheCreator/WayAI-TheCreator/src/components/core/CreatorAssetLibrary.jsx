import { useState } from "react";
import { Loader2, Plus, Trash2 } from "lucide-react";
import { useCreatorAssetLibrary } from "./creatorAssetLibraryEngine.js";

const ASSET_TYPES = [
  { id: "character", label: "Characters" },
  { id: "scene", label: "Scenes" },
  { id: "prop", label: "Props" },
  { id: "product", label: "Products" },
];

function NewAssetForm({ assetType, onCreate }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await onCreate({ assetType, name: name.trim(), definition: { description: description.trim() } });
      setName("");
      setDescription("");
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="creator-new-asset-form" onSubmit={submit} style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
      <input
        type="text"
        placeholder={`New ${assetType} name…`}
        value={name}
        onChange={(event) => setName(event.target.value)}
        style={{ flex: "1 1 200px" }}
      />
      <input
        type="text"
        placeholder="Short description (optional)"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        style={{ flex: "2 1 280px" }}
      />
      <button type="submit" disabled={busy || !name.trim()}>
        {busy ? <Loader2 size={14} className="creator-spin" /> : <Plus size={14} />} Add
      </button>
      {error ? <div className="creator-error" style={{ flexBasis: "100%" }}>{error}</div> : null}
    </form>
  );
}

export function CreatorAssetLibrary() {
  const [activeType, setActiveType] = useState("character");
  const { assets, loading, error, createAsset, removeAsset } = useCreatorAssetLibrary({ assetType: activeType });

  return (
    <section className="creator-footage-room" aria-label="Creator asset library">
      <nav style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {ASSET_TYPES.map((type) => (
          <button
            key={type.id}
            type="button"
            className={activeType === type.id ? "is-active" : ""}
            onClick={() => setActiveType(type.id)}
          >
            {type.label}
          </button>
        ))}
      </nav>

      <NewAssetForm assetType={activeType} onCreate={createAsset} />

      {error ? <div className="creator-error">{error}</div> : null}
      {loading ? (
        <div className="creator-asset-grid">
          <Loader2 size={16} className="creator-spin" />
        </div>
      ) : assets.length === 0 ? (
        <p className="creator-muted">No {activeType} assets yet — add one above.</p>
      ) : (
        <div className="creator-asset-grid">
          {assets.map((asset) => {
            const definition = typeof asset.definition_json === "string" ? JSON.parse(asset.definition_json) : asset.definition_json;
            return (
              <article key={asset.id} className="creator-asset-card">
                <span>{asset.asset_type}</span>
                <h4>{asset.name}</h4>
                <p>{definition?.description || "No description yet."}</p>
                <small>{asset.source === "generated" ? "generated" : "uploaded"}</small>
                <button
                  type="button"
                  title="Delete asset"
                  onClick={() => removeAsset(asset.id)}
                  style={{ marginTop: 8, display: "inline-flex", alignItems: "center", gap: 4 }}
                >
                  <Trash2 size={12} /> Remove
                </button>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default CreatorAssetLibrary;
