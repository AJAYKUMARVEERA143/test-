import { useCallback, useEffect, useState } from "react";
import { Loader2, Scissors } from "lucide-react";
import { ensureNarrationEpisode, buildNarrationStoryboard } from "../../services/creatorNarrationWorkflow.js";
import CreatorCostPanel from "./CreatorCostPanel.jsx";
import CreatorStoryboardSceneList from "./CreatorStoryboardSceneList.jsx";
import "./CreatorNarrationRoom.css";

const STYLES = ["cinematic", "flat", "3d", "sketch"];

function parseScript(episode) {
  const script = typeof episode?.script_json === "string" ? JSON.parse(episode.script_json) : episode?.script_json;
  return script || { sourceText: "", segments: [], storyboard: [] };
}

export default function CreatorNarrationRoom({ accountManager }) {
  const [project, setProject] = useState(null);
  const [episode, setEpisode] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [sourceText, setSourceText] = useState("");
  const [style, setStyle] = useState("cinematic");
  const [splitting, setSplitting] = useState(false);
  const [splitError, setSplitError] = useState("");
  const [costRefreshKey, setCostRefreshKey] = useState(0);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    setLoadError("");
    try {
      const { project: proj, episode: ep } = await ensureNarrationEpisode();
      setProject(proj);
      setEpisode(ep);
      const script = parseScript(ep);
      setSourceText(script.sourceText || "");
    } catch (err) {
      setLoadError(String(err?.message || err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  const script = parseScript(episode);

  async function submitSplit(event) {
    event.preventDefault();
    if (!project || !episode) return;
    setSplitting(true);
    setSplitError("");
    try {
      const updated = await buildNarrationStoryboard({ project, episode, sourceText, style });
      setEpisode(updated);
    } catch (err) {
      setSplitError(String(err?.message || err));
    } finally {
      setSplitting(false);
    }
  }

  function handleEpisodeUpdate(updated) {
    setEpisode(updated);
    setCostRefreshKey((key) => key + 1);
  }

  if (loading) return <div className="creator-narration-loading"><Loader2 size={18} className="creator-narration-spin" /></div>;
  if (loadError) return <div className="creator-narration-error">{loadError}</div>;

  return (
    <section className="creator-narration-room" aria-label="Narrated short video">
      <CreatorCostPanel projectId={project?.id} refreshKey={costRefreshKey} />

      <form className="creator-narration-source-form" onSubmit={submitSplit}>
        <label>
          <span>Source narration</span>
          <textarea
            rows={6}
            placeholder="Paste the narration or story text for this short..."
            value={sourceText}
            onChange={(event) => setSourceText(event.target.value)}
          />
        </label>
        <div className="creator-narration-source-row">
          <label>
            <span>Visual style</span>
            <select value={style} onChange={(event) => setStyle(event.target.value)}>
              {STYLES.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <button type="submit" disabled={splitting || !sourceText.trim()}>
            {splitting ? <Loader2 size={14} className="creator-narration-spin" /> : <Scissors size={14} />} Split into storyboard
          </button>
        </div>
        {splitError ? <div className="creator-narration-error">{splitError}</div> : null}
      </form>

      {script.storyboard?.length ? (
        <CreatorStoryboardSceneList
          project={project}
          episode={episode}
          scenes={script.storyboard}
          style={style}
          accountManager={accountManager}
          onEpisodeUpdate={handleEpisodeUpdate}
        />
      ) : (
        <p className="creator-narration-hint">Paste narration text above and split it to build a scene-by-scene storyboard.</p>
      )}
    </section>
  );
}
