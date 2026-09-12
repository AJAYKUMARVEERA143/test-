import { useState } from "react";
import { Image as ImageIcon, Loader2, Mic, Volume2 } from "lucide-react";
import { fetchMediaBlobUrl } from "../../services/CreatorStudioApiClient.js";
import { generateSceneImage, generateSceneVoiceover } from "../../services/creatorNarrationWorkflow.js";
import "./CreatorNarrationRoom.css";

function SceneAudioPlayer({ relPath }) {
  const [blobUrl, setBlobUrl] = useState("");
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const url = await fetchMediaBlobUrl(relPath);
      setBlobUrl(url);
    } finally {
      setLoading(false);
    }
  }

  if (blobUrl) return <audio controls src={blobUrl} style={{ width: "100%" }} />;
  return (
    <button type="button" onClick={load} disabled={loading} className="creator-narration-scene-btn">
      {loading ? <Loader2 size={12} className="creator-narration-spin" /> : <Volume2 size={12} />} Load voiceover
    </button>
  );
}

/**
 * Per-scene image/voiceover generation grid, shared by CreatorNarrationRoom.jsx
 * (Phase F1, one episode) and CreatorDramaRoom.jsx (Phase F2, many episodes) —
 * both drive scenes shaped by StoryboardBuilder.js, so the generation loop
 * (createTask -> WayIllustrateAdapter/WayTtsAdapter -> completeTask ->
 * recordVersion) is identical regardless of which pipeline built the scene.
 */
export default function CreatorStoryboardSceneList({ project, episode, scenes, style = "cinematic", accountManager, onEpisodeUpdate }) {
  const [sceneBusy, setSceneBusy] = useState({}); // { [order]: "image" | "audio" }
  const [sceneError, setSceneError] = useState({});

  async function handleGenerateImage(scene) {
    setSceneBusy((state) => ({ ...state, [scene.order]: "image" }));
    setSceneError((state) => ({ ...state, [scene.order]: "" }));
    try {
      const { episode: updated } = await generateSceneImage({ project, episode, scene, style }, accountManager);
      onEpisodeUpdate?.(updated);
    } catch (err) {
      setSceneError((state) => ({ ...state, [scene.order]: String(err?.message || err) }));
    } finally {
      setSceneBusy((state) => ({ ...state, [scene.order]: null }));
    }
  }

  async function handleGenerateVoiceover(scene) {
    setSceneBusy((state) => ({ ...state, [scene.order]: "audio" }));
    setSceneError((state) => ({ ...state, [scene.order]: "" }));
    try {
      const { episode: updated } = await generateSceneVoiceover({ project, episode, scene }, accountManager);
      onEpisodeUpdate?.(updated);
    } catch (err) {
      setSceneError((state) => ({ ...state, [scene.order]: String(err?.message || err) }));
    } finally {
      setSceneBusy((state) => ({ ...state, [scene.order]: null }));
    }
  }

  if (!scenes?.length) {
    return <p className="creator-narration-hint">No scenes yet.</p>;
  }

  return (
    <ol className="creator-narration-scene-list">
      {scenes.map((scene) => (
        <li key={scene.order} className="creator-narration-scene">
          <div className="creator-narration-scene-head">
            <b>Scene {scene.order}</b>
            <small>{scene.durationSeconds}s</small>
          </div>
          <p className="creator-narration-scene-narration">{scene.narration}</p>

          <div className="creator-narration-scene-media">
            <div className="creator-narration-scene-media-block">
              {scene.imageUrl ? (
                <img src={scene.imageUrl} alt={scene.caption} />
              ) : (
                <button
                  type="button"
                  className="creator-narration-scene-btn"
                  onClick={() => handleGenerateImage(scene)}
                  disabled={!!sceneBusy[scene.order]}
                >
                  {sceneBusy[scene.order] === "image" ? <Loader2 size={12} className="creator-narration-spin" /> : <ImageIcon size={12} />} Generate image
                </button>
              )}
            </div>
            <div className="creator-narration-scene-media-block">
              {scene.audioUrl ? (
                <SceneAudioPlayer relPath={scene.audioUrl} />
              ) : (
                <button
                  type="button"
                  className="creator-narration-scene-btn"
                  onClick={() => handleGenerateVoiceover(scene)}
                  disabled={!!sceneBusy[scene.order]}
                >
                  {sceneBusy[scene.order] === "audio" ? <Loader2 size={12} className="creator-narration-spin" /> : <Mic size={12} />} Generate voiceover
                </button>
              )}
            </div>
          </div>
          {sceneError[scene.order] ? <div className="creator-narration-error">{sceneError[scene.order]}</div> : null}
        </li>
      ))}
    </ol>
  );
}
