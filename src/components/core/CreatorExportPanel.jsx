import { useEffect, useState } from "react";
import { Calendar, Clapperboard, Download, Loader2, MonitorPlay, Send, Square, X } from "lucide-react";
import { listProjects, listEpisodes, downloadCapCutDraft } from "../../services/CreatorStudioApiClient.js";
import { isRenderAvailable, renderEpisode } from "../../lib/CreatorFfmpegAdapter.js";
import { cancelScheduled, isInstagramAvailable, listScheduled, publishNow, schedulePost } from "../../lib/InstagramAdapter.js";
import "./CreatorExportPanel.css";

function parseScript(episode) {
  const script = typeof episode?.script_json === "string" ? JSON.parse(episode.script_json) : episode?.script_json;
  return script || { storyboard: [] };
}

function slugText(value = "episode") {
  return String(value || "episode").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "episode";
}

// The connected Instagram account lives in Accounts (BYOK, same as every
// other provider — see PROVIDERS.instagram in AccountManager.js and the
// "Connect" button on its account row in App.jsx), not something this room
// connects on its own. This just reads whichever one is already linked.
function findLinkedInstagramAccount(manager) {
  const accounts = manager?.getAll?.() || [];
  return accounts.find((acc) => acc.provider === "instagram" && acc.igUserId) || null;
}

export default function CreatorExportPanel({ manager }) {
  const [projects, setProjects] = useState([]);
  const [projectId, setProjectId] = useState("");
  const [episodes, setEpisodes] = useState([]);
  const [episodeId, setEpisodeId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState("");
  const [renderProgress, setRenderProgress] = useState(null);
  const [renderResult, setRenderResult] = useState(null);
  const [abortController, setAbortController] = useState(null);

  const [igAccount, setIgAccount] = useState(() => findLinkedInstagramAccount(manager));
  const [igCaption, setIgCaption] = useState("");
  const [igScheduleAt, setIgScheduleAt] = useState("");
  const [igBusy, setIgBusy] = useState(false);
  const [igError, setIgError] = useState("");
  const [igResult, setIgResult] = useState(null);
  const [igScheduled, setIgScheduled] = useState([]);

  const refreshScheduled = () => {
    if (!isInstagramAvailable()) return;
    listScheduled().then(setIgScheduled).catch(() => {});
  };

  useEffect(() => {
    if (!isInstagramAvailable()) return;
    refreshScheduled();
    const timer = setInterval(refreshScheduled, 30000); // catches results as scheduled posts fire in the background
    return () => clearInterval(timer);
  }, []);

  // manager.getAll() is a snapshot, not reactive — re-check whenever the
  // Export room mounts/remounts (e.g. navigating back to it after connecting
  // Instagram in Accounts) rather than only once.
  useEffect(() => {
    setIgAccount(findLinkedInstagramAccount(manager));
  }, [manager]);

  useEffect(() => {
    listProjects({ limit: 200 })
      .then((rows) => {
        setProjects(rows || []);
        if (rows?.length) setProjectId(rows[0].id);
      })
      .catch((err) => setError(String(err?.message || err)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!projectId) { setEpisodes([]); setEpisodeId(""); return; }
    listEpisodes(projectId)
      .then((rows) => {
        setEpisodes(rows || []);
        setEpisodeId(rows?.[0]?.id || "");
      })
      .catch((err) => setError(String(err?.message || err)));
  }, [projectId]);

  const episode = episodes.find((ep) => ep.id === episodeId) || null;
  const script = episode ? parseScript(episode) : { storyboard: [] };
  const readyScenes = script.storyboard.filter((scene) => scene.imageUrl).length;
  const totalScenes = script.storyboard.length;

  async function handleExport() {
    if (!projectId || !episodeId) return;
    setExporting(true);
    setExportError("");
    try {
      const filename = `${slugText(episode?.title || "episode")}-capcut-draft.zip`;
      await downloadCapCutDraft(projectId, episodeId, filename);
    } catch (err) {
      setExportError(String(err?.message || err));
    } finally {
      setExporting(false);
    }
  }

  async function handleRender() {
    if (!episode) return;
    setRenderError("");
    setRenderResult(null);
    setRenderProgress(null);

    let outputPath;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      outputPath = await save({
        defaultPath: `${slugText(episode.title || "episode")}.mp4`,
        filters: [{ name: "MP4 video", extensions: ["mp4"] }],
      });
    } catch (err) {
      setRenderError(String(err?.message || err));
      return;
    }
    if (!outputPath) return; // user cancelled the save dialog

    const controller = new AbortController();
    setAbortController(controller);
    setRendering(true);
    try {
      const outcome = await renderEpisode({
        scenes: script.storyboard,
        outputPath,
        onProgress: (payload) => setRenderProgress(payload),
        signal: controller.signal,
      });
      if (outcome.cancelled) {
        setRenderError("Render cancelled.");
      } else if (!outcome.success) {
        setRenderError(outcome.error || "Render failed.");
      } else {
        setRenderResult(outcome.outputPath);
      }
    } catch (err) {
      setRenderError(String(err?.message || err));
    } finally {
      setRendering(false);
      setAbortController(null);
    }
  }

  function handleCancelRender() {
    abortController?.abort();
  }

  async function handlePublishNow() {
    if (!renderResult || !igAccount) return;
    setIgBusy(true);
    setIgError("");
    setIgResult(null);
    try {
      const outcome = await publishNow({ videoPath: renderResult, caption: igCaption, account: igAccount });
      if (outcome.success) setIgResult({ ok: true, message: `Posted! Media id ${outcome.permalink}` });
      else setIgError(outcome.error || "Instagram publish failed.");
    } catch (err) {
      setIgError(String(err?.message || err));
    } finally {
      setIgBusy(false);
    }
  }

  async function handleSchedule() {
    if (!renderResult || !igAccount || !igScheduleAt) return;
    const scheduledAt = new Date(igScheduleAt);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= Date.now()) {
      setIgError("Pick a future date/time to schedule for.");
      return;
    }
    setIgBusy(true);
    setIgError("");
    setIgResult(null);
    try {
      await schedulePost({ videoPath: renderResult, caption: igCaption, account: igAccount, scheduledAt });
      setIgResult({ ok: true, message: `Scheduled for ${scheduledAt.toLocaleString()}.` });
      setIgScheduleAt("");
      refreshScheduled();
    } catch (err) {
      setIgError(String(err?.message || err));
    } finally {
      setIgBusy(false);
    }
  }

  async function handleCancelScheduled(id) {
    await cancelScheduled(id).catch(() => {});
    refreshScheduled();
  }

  if (loading) return <div className="creator-export-loading"><Loader2 size={18} className="creator-export-spin" /></div>;

  return (
    <section className="creator-export-room" aria-label="Export">
      {error ? <div className="creator-export-error">{error}</div> : null}

      <div className="creator-export-pickers">
        <label>
          <span>Project</span>
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        <label>
          <span>Episode</span>
          <select value={episodeId} onChange={(event) => setEpisodeId(event.target.value)}>
            {episodes.map((ep) => <option key={ep.id} value={ep.id}>{ep.title || `Episode ${ep.episode_number}`}</option>)}
          </select>
        </label>
      </div>

      {episode ? (
        <>
          <p className="creator-export-hint">{readyScenes} of {totalScenes} scenes have a generated image{totalScenes && readyScenes < totalScenes ? " — generate the rest for a complete export" : ""}.</p>

          <section className="creator-export-card">
            <header><Clapperboard size={15} /> <span>CapCut draft export</span></header>
            <p className="creator-export-hint">
              Downloads a best-effort CapCut-compatible draft (.zip). CapCut's draft format isn't officially
              published, so this targets the widely-documented community structure — verify by importing it into
              CapCut; if a clip shows offline, use CapCut's "Relink media" and point it at the matching file in
              the draft's materials folder.
            </p>
            <button type="button" onClick={handleExport} disabled={exporting || !readyScenes}>
              {exporting ? <Loader2 size={14} className="creator-export-spin" /> : <Download size={14} />} Download CapCut draft
            </button>
            {exportError ? <div className="creator-export-error">{exportError}</div> : null}
          </section>

          <section className="creator-export-card">
            <header><MonitorPlay size={15} /> <span>Local render (desktop only)</span></header>
            {isRenderAvailable() ? (
              <>
                <p className="creator-export-hint">Composes every scene's image, voiceover, and caption into one local MP4 using your own ffmpeg install.</p>
                {rendering ? (
                  <>
                    <p className="creator-export-hint">
                      {renderProgress ? `Rendering scene ${renderProgress.sceneIndex} of ${renderProgress.totalScenes}...` : "Starting render..."}
                    </p>
                    <button type="button" onClick={handleCancelRender} className="creator-export-cancel-btn">
                      <Square size={13} /> Cancel render
                    </button>
                  </>
                ) : (
                  <button type="button" onClick={handleRender} disabled={!readyScenes}>
                    <MonitorPlay size={14} /> Render locally
                  </button>
                )}
                {renderError ? <div className="creator-export-error">{renderError}</div> : null}
                {renderResult ? <div className="creator-export-success">Rendered to {renderResult}</div> : null}
              </>
            ) : (
              <p className="creator-export-hint">Local rendering needs the desktop app and a local ffmpeg install — use CapCut draft export above on web.</p>
            )}
          </section>

          {isInstagramAvailable() && (
            <section className="creator-export-card">
              <header><Send size={15} /> <span>Publish to Instagram</span></header>

              {!igAccount ? (
                <p className="creator-export-hint">
                  No Instagram account connected yet — go to <strong>Accounts → Instagram</strong>, paste your Meta
                  Developer App's APP_ID:APP_SECRET, save, then click <strong>Connect</strong> on that account row to
                  link it via Meta login. Come back here once that's done.
                </p>
              ) : (
                <>
                  <p className="creator-export-hint">Connected as <strong>@{igAccount.igUsername || igAccount.igPageName}</strong>.</p>

                  {renderResult ? (
                    <>
                      <label className="creator-export-ig-field">
                        <span>Caption</span>
                        <textarea rows={3} value={igCaption} onChange={(event) => setIgCaption(event.target.value)} placeholder="Write a caption for this reel…" />
                      </label>
                      <div className="creator-export-ig-schedule-row">
                        <input type="datetime-local" value={igScheduleAt} onChange={(event) => setIgScheduleAt(event.target.value)} />
                        <button type="button" onClick={handleSchedule} disabled={igBusy || !igScheduleAt}>
                          <Calendar size={14} /> Schedule
                        </button>
                        <button type="button" onClick={handlePublishNow} disabled={igBusy}>
                          {igBusy ? <Loader2 size={14} className="creator-export-spin" /> : <Send size={14} />} Post now
                        </button>
                      </div>
                    </>
                  ) : (
                    <p className="creator-export-hint">Render locally above first — publishing needs a real rendered MP4.</p>
                  )}

                  {igError ? <div className="creator-export-error">{igError}</div> : null}
                  {igResult?.ok ? <div className="creator-export-success">{igResult.message}</div> : null}

                  {igScheduled.length > 0 && (
                    <div className="creator-export-ig-queue">
                      <span className="creator-export-ig-queue-title">Scheduled posts</span>
                      {igScheduled.map((post) => (
                        <div key={post.id} className={`creator-export-ig-queue-item is-${post.status}`}>
                          <span className="creator-export-ig-queue-when">{new Date(post.scheduledAtMs).toLocaleString()}</span>
                          <span className="creator-export-ig-queue-status">{post.status}{post.resultMessage ? ` — ${post.resultMessage}` : ""}</span>
                          {post.status === "pending" && (
                            <button type="button" onClick={() => handleCancelScheduled(post.id)} title="Cancel" className="creator-export-ig-queue-cancel">
                              <X size={12} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </>
      ) : (
        <p className="creator-export-hint">No episodes yet for this project — build one in the Narration or Drama room first.</p>
      )}
    </section>
  );
}
