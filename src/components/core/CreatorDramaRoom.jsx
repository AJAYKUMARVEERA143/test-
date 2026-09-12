import { useState } from "react";
import { BookOpen, Loader2, Wand2 } from "lucide-react";
import { runDramaPipeline } from "../../services/creatorDramaWorkflow.js";
import CreatorCostPanel from "./CreatorCostPanel.jsx";
import CreatorStoryboardSceneList from "./CreatorStoryboardSceneList.jsx";
import "./CreatorNarrationRoom.css";
import "./CreatorDramaRoom.css";

const STYLES = ["cinematic", "flat", "3d", "sketch"];

function parseScript(episode) {
  const script = typeof episode?.script_json === "string" ? JSON.parse(episode.script_json) : episode?.script_json;
  return script || { sourceText: "", storyboard: [] };
}

export default function CreatorDramaRoom({ accountManager }) {
  const [title, setTitle] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [episodeCount, setEpisodeCount] = useState(2);
  const [style, setStyle] = useState("cinematic");

  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");

  const [project, setProject] = useState(null);
  const [episodes, setEpisodes] = useState([]);
  const [assets, setAssets] = useState(null);
  const [activeEpisodeId, setActiveEpisodeId] = useState("");
  const [costRefreshKey, setCostRefreshKey] = useState(0);

  async function submitPipeline(event) {
    event.preventDefault();
    if (!sourceText.trim() || !title.trim()) return;
    setRunning(true);
    setRunError("");
    try {
      const result = await runDramaPipeline({ title: title.trim(), sourceText, episodeCount: Number(episodeCount) || 1, style, manager: accountManager });
      setProject(result.project);
      setEpisodes(result.episodes);
      setAssets(result.assets);
      setActiveEpisodeId(result.episodes[0]?.id || "");
    } catch (err) {
      setRunError(String(err?.message || err));
    } finally {
      setRunning(false);
    }
  }

  function handleEpisodeUpdate(updated) {
    setEpisodes((current) => current.map((ep) => (ep.id === updated.id ? updated : ep)));
    setCostRefreshKey((key) => key + 1);
  }

  const activeEpisode = episodes.find((ep) => ep.id === activeEpisodeId) || null;
  const activeScript = activeEpisode ? parseScript(activeEpisode) : null;

  return (
    <section className="creator-narration-room" aria-label="Novel/screenplay drama">
      {project ? <CreatorCostPanel projectId={project.id} refreshKey={costRefreshKey} /> : null}

      <form className="creator-narration-source-form" onSubmit={submitPipeline}>
        <label>
          <span>Drama title</span>
          <input type="text" placeholder="e.g. The Last Signal" value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label>
          <span>Story / screenplay excerpt</span>
          <textarea
            rows={8}
            placeholder="Paste a story or screenplay excerpt..."
            value={sourceText}
            onChange={(event) => setSourceText(event.target.value)}
          />
        </label>
        <div className="creator-narration-source-row">
          <label>
            <span>Episodes</span>
            <input type="number" min="1" max="10" value={episodeCount} onChange={(event) => setEpisodeCount(event.target.value)} />
          </label>
          <label>
            <span>Visual style</span>
            <select value={style} onChange={(event) => setStyle(event.target.value)}>
              {STYLES.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
          <button type="submit" disabled={running || !sourceText.trim() || !title.trim()}>
            {running ? <Loader2 size={14} className="creator-narration-spin" /> : <Wand2 size={14} />} Extract &amp; plan
          </button>
        </div>
        {runError ? <div className="creator-narration-error">{runError}</div> : null}
      </form>

      {assets ? (
        <section className="creator-drama-lorebook" aria-label="Lorebook">
          <header><BookOpen size={14} /> <span>Lorebook</span></header>
          <div className="creator-drama-lorebook-grid">
            <article><b>{assets.character.length}</b><span>Characters</span></article>
            <article><b>{assets.scene.length}</b><span>Locations</span></article>
            <article><b>{assets.prop.length}</b><span>Props</span></article>
          </div>
          <p className="creator-narration-hint">Full details live in the Asset Library room — extraction reuses any existing asset with a matching name.</p>
        </section>
      ) : null}

      {episodes.length ? (
        <>
          <nav className="creator-drama-episode-tabs">
            {episodes.map((ep) => (
              <button
                key={ep.id}
                type="button"
                className={ep.id === activeEpisodeId ? "is-active" : ""}
                onClick={() => setActiveEpisodeId(ep.id)}
              >
                {ep.title || `Episode ${ep.episode_number}`}
              </button>
            ))}
          </nav>
          {activeEpisode ? (
            <CreatorStoryboardSceneList
              project={project}
              episode={activeEpisode}
              scenes={activeScript.storyboard}
              style={style}
              accountManager={accountManager}
              onEpisodeUpdate={handleEpisodeUpdate}
            />
          ) : null}
        </>
      ) : (
        <p className="creator-narration-hint">Paste a story excerpt above and extract to build a real, multi-episode plan.</p>
      )}
    </section>
  );
}
