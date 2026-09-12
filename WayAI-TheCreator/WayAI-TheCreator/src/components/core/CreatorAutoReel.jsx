import { useCallback, useEffect, useRef, useState } from "react";
import { Clapperboard, FolderOpen, Loader2, Music, Play, RotateCw, Square } from "lucide-react";
import { parseCreatorRequest, runCreatorPipeline } from "./creatorAutoPipeline.js";
import { createCreatorRuntime } from "./creatorAutoRuntime.js";
import { isRenderAvailable } from "../../lib/CreatorFfmpegAdapter.js";
import "./CreatorAutoReel.css";

const LENGTHS = [15, 30, 60];
const STAGES = [
  ["script", "Script"],
  ["visual", "Clips"],
  ["voice", "Voice-over"],
  ["render", "Edit & render"],
  ["done", "Saved"],
];

function routeLabel(route) {
  if (!route) return "";
  if (route.startsWith("video:")) {
    const r = route.slice(6);
    return { gemini: "Google Veo", higgsfield: "Higgsfield", huggingface: "Hugging Face", waycloud: "Way AI Cloud", byok: "AI clip" }[r] || "AI clip";
  }
  if (route.startsWith("image:")) return "AI still";
  return route === "card" ? "Title card" : route;
}

// The shell plugin only opens http(s) URLs, so local files go through the
// desktop's own narrow command, which accepts nothing but a rendered .mp4.
async function openOutput(path, reveal) {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("creator_open_output", { path, reveal });
  } catch {
    /* browser build: nothing to open */
  }
}

/**
 * One prompt → a finished vertical reel on disk. `startSignal` ({id, text})
 * lets NOVA start a run by voice ("30 second technology reel tayaru chey").
 */
export default function CreatorAutoReel({ manager, startSignal }) {
  const [prompt, setPrompt] = useState("30 second reel about how AI is changing small businesses");
  const [seconds, setSeconds] = useState(30);
  const [language, setLanguage] = useState("en");
  const [music, setMusic] = useState(null);
  const [running, setRunning] = useState(false);
  const [stage, setStage] = useState("");
  const [message, setMessage] = useState("");
  const [scenes, setScenes] = useState([]);
  const [result, setResult] = useState(null);
  // The finished scenes with their media, so the timeline below can change
  // durations, caption text and caption placement and re-render without
  // regenerating anything.
  const [cut, setCut] = useState([]);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef(null);
  const lastSignal = useRef(null);
  const canRender = isRenderAvailable();

  const start = useCallback(async (text, overrides = {}) => {
    if (running) return;
    const parsed = parseCreatorRequest(text);
    const plan = {
      ...parsed,
      durationSeconds: overrides.durationSeconds ?? parsed.durationSeconds,
      language: overrides.language ?? parsed.language,
    };
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setError("");
    setResult(null);
    setScenes([]);
    try {
      const deps = createCreatorRuntime({ manager, music });
      const out = await runCreatorPipeline(plan, deps, (step) => {
        setStage(step.stage);
        setMessage(step.message);
      }, { signal: controller.signal });
      setScenes(out.report.scenes);
      setCut(out.scenes.map((scene, index) => ({
        ...scene,
        captionPosition: scene.captionPosition || "bottom",
        beat: out.report.scenes[index]?.beat || scene.beat,
      })));
      setResult(out);
    } catch (err) {
      setStage("");
      setError(err?.cancelled ? "Cancelled." : (err?.message || String(err)));
      if (err?.report?.scenes) setScenes(err.report.scenes);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [manager, music, running]);

  // NOVA voice trigger: run once per new signal, using what was said.
  useEffect(() => {
    if (!startSignal?.id || startSignal.id === lastSignal.current || !startSignal.text) return;
    lastSignal.current = startSignal.id;
    const parsed = parseCreatorRequest(startSignal.text);
    setPrompt(startSignal.text);
    setSeconds(parsed.durationSeconds);
    setLanguage(parsed.language);
    start(startSignal.text);
  }, [startSignal?.id, startSignal?.text, start]);

  // Re-cut: same clips, same voice-over, new timings/captions.
  const reRender = useCallback(async () => {
    if (!cut.length || rendering) return;
    setRendering(true);
    setError("");
    try {
      const deps = createCreatorRuntime({ manager, music });
      const outputPath = await deps.outputPath(`way-reel-edit-${Date.now()}.mp4`);
      const outcome = await deps.render({
        // Dropping captionCues makes the renderer re-time the words across the
        // scene's new duration instead of keeping the original spacing.
        scenes: cut.map(({ captionCues, ...scene }) => scene),
        outputPath,
        bgm: music,
        onProgress: (p) => setMessage(`Rendering scene ${p.sceneIndex}/${p.totalScenes}…`),
      });
      if (!outcome?.success) throw new Error(outcome?.error || "Render failed");
      setResult((prev) => ({ ...prev, outputPath }));
      setMessage("");
    } catch (err) {
      setError(err?.message || String(err));
    } finally {
      setRendering(false);
    }
  }, [cut, manager, music, rendering]);

  const editScene = (index, patch) => setCut((prev) => prev.map((scene, i) => (i === index ? { ...scene, ...patch } : scene)));

  const stageIndex = STAGES.findIndex(([id]) => id === stage);
  const totalSeconds = (cut.length ? cut.map((s) => s.durationSeconds) : scenes.map((s) => s.seconds)).reduce((n, v) => n + (Number(v) || 0), 0);

  return (
    <section className="auto-reel" aria-label="Auto reel">
      <header className="auto-reel-head">
        <div>
          <h2><Clapperboard size={18} /> Auto reel</h2>
          <p>Describe the video. The Creator writes it, gets clips, records the voice-over, edits and saves an .mp4 — using the accounts you have connected, and Way AI Cloud for the rest.</p>
        </div>
      </header>

      <div className="auto-reel-form">
        <label htmlFor="auto-reel-prompt">What is the reel about?</label>
        <textarea
          id="auto-reel-prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={3}
          disabled={running}
        />
        <div className="auto-reel-options">
          <div className="auto-reel-chips" role="group" aria-label="Length">
            {LENGTHS.map((n) => (
              <button key={n} type="button" className={seconds === n ? "is-on" : ""} onClick={() => setSeconds(n)} disabled={running}>{n}s</button>
            ))}
          </div>
          <div className="auto-reel-chips" role="group" aria-label="Voice-over language">
            <button type="button" className={language === "en" ? "is-on" : ""} onClick={() => setLanguage("en")} disabled={running}>English</button>
            <button type="button" className={language === "te" ? "is-on" : ""} onClick={() => setLanguage("te")} disabled={running}>తెలుగు</button>
          </div>
          <label className="auto-reel-music" htmlFor="auto-reel-music">
            <Music size={14} /> {music ? music.name : "Add music (optional)"}
            <input id="auto-reel-music" type="file" accept="audio/*" onChange={(e) => setMusic(e.target.files?.[0] || null)} disabled={running} />
          </label>
        </div>
        <div className="auto-reel-actions">
          {running ? (
            <button type="button" className="auto-reel-cancel" onClick={() => abortRef.current?.abort()}>
              <Square size={14} /> Cancel
            </button>
          ) : (
            <button type="button" className="auto-reel-go" onClick={() => start(prompt, { durationSeconds: seconds, language })} disabled={!prompt.trim()}>
              <Play size={14} /> Create reel
            </button>
          )}
          {!canRender ? <small className="auto-reel-note">Rendering runs in the desktop app (needs ffmpeg).</small> : null}
        </div>
      </div>

      {(running || stage || error) ? (
        <ol className="auto-reel-stages" aria-label="Progress">
          {STAGES.map(([id, label], i) => {
            const state = error && i === stageIndex ? "error" : i < stageIndex || stage === "done" ? "done" : i === stageIndex ? "active" : "todo";
            return (
              <li key={id} className={`is-${state}`}>
                {state === "active" && running ? <Loader2 size={13} className="creator-spin" /> : <span className="dot" />}
                {label}
              </li>
            );
          })}
        </ol>
      ) : null}
      {message && running ? <p className="auto-reel-message" role="status">{message}</p> : null}
      {error ? <p className="auto-reel-error" role="alert">{error}</p> : null}

      {scenes.length ? (
        <div className="auto-reel-timeline" aria-label="Timeline">
          <div className="track-label">Video</div>
          <div className="track">
            {scenes.map((s) => (
              <div key={s.index} className="clip" style={{ flexGrow: Math.max(1, Number(cut[s.index]?.durationSeconds ?? s.seconds) || 1) }} title={s.fallbacks?.join(" | ") || ""}>
                <b>{s.beat}</b>
                <span>{routeLabel(s.visual)} · {Number(cut[s.index]?.durationSeconds ?? s.seconds).toFixed(1)}s</span>
              </div>
            ))}
          </div>
          <div className="track-label">Voice</div>
          <div className="track">
            {scenes.map((s) => (
              <div key={s.index} className={`bar${s.voice && s.voice !== "none" && !String(s.voice).startsWith("none") ? "" : " is-empty"}`} style={{ flexGrow: Math.max(1, Number(cut[s.index]?.durationSeconds ?? s.seconds) || 1) }} />
            ))}
          </div>
          <div className="track-label">Music</div>
          <div className="track"><div className={`bar music${music ? "" : " is-empty"}`} style={{ flexGrow: 1 }}>{music ? "ducked under voice" : "none"}</div></div>
          <div className="auto-reel-total">{totalSeconds.toFixed(1)}s · captions timed to the voice-over</div>
        </div>
      ) : null}

      {cut.length ? (
        <div className="auto-reel-cut" aria-label="Edit the cut">
          <div className="auto-reel-cut-head">
            <h3>Edit the cut</h3>
            <span>Change timing and captions, then re-render. The clips and voice-over are reused — nothing is generated again.</span>
          </div>
          {cut.map((scene, index) => (
            <div className="auto-reel-cut-row" key={scene.index ?? index}>
              <b>{scene.beat || `Scene ${index + 1}`}</b>
              <label>
                <span>Seconds</span>
                <input
                  type="number"
                  min="1"
                  max="30"
                  step="0.5"
                  value={scene.durationSeconds ?? 4}
                  disabled={rendering}
                  onChange={(e) => editScene(index, { durationSeconds: Math.min(30, Math.max(1, Number(e.target.value) || 1)) })}
                />
              </label>
              <label className="auto-reel-cut-caption">
                <span>Caption</span>
                <input
                  type="text"
                  value={scene.caption || ""}
                  disabled={rendering}
                  placeholder="No caption on this scene"
                  onChange={(e) => editScene(index, { caption: e.target.value })}
                />
              </label>
              <label>
                <span>Position</span>
                <select value={scene.captionPosition || "bottom"} disabled={rendering} onChange={(e) => editScene(index, { captionPosition: e.target.value })}>
                  <option value="top">Top</option>
                  <option value="center">Center</option>
                  <option value="bottom">Bottom</option>
                </select>
              </label>
            </div>
          ))}
          <div className="auto-reel-actions">
            <button type="button" className="auto-reel-go" onClick={reRender} disabled={rendering || running}>
              {rendering ? <Loader2 size={14} className="creator-spin" /> : <RotateCw size={14} />} {rendering ? "Rendering…" : "Re-render with these edits"}
            </button>
            <button
              type="button"
              disabled={rendering}
              onClick={() => setCut((prev) => prev.map((scene) => ({ ...scene, captionPosition: "bottom" })))}
            >
              All captions to bottom
            </button>
          </div>
        </div>
      ) : null}

      {result ? (
        <div className="auto-reel-result">
          <div>
            <b>Saved</b>
            <code>{result.outputPath}</code>
          </div>
          <div className="auto-reel-actions">
            <button type="button" className="auto-reel-go" onClick={() => openOutput(result.outputPath, false)}><Play size={14} /> Play</button>
            <button type="button" onClick={() => openOutput(result.outputPath, true)}><FolderOpen size={14} /> Show in folder</button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
