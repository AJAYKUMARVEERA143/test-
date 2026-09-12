// Creator Studio Phase H — desktop-only local video composition via the
// user's own `ffmpeg` binary. Structurally mirrors codex_cli.rs/gemini_cli.rs:
// same Job Object sandbox reuse (job_sandbox::CommandSandbox), same
// kill-by-PID cancellation, same detect/run/cancel command shape. No
// workspace confinement here (unlike the CLI providers) — render inputs are
// caller-resolved local temp files (CreatorFfmpegAdapter.js downloads/decodes
// each scene's image+audio to disk before calling this), not files inside a
// code workspace.
//
// A composition is many short ffmpeg invocations, not one: each scene is
// rendered to its own clip (image looped for the scene's duration, with
// either its real voiceover or a matching-format silent audio track so every
// clip has identical stream layout), then all clips are concatenated with a
// stream copy (no re-encode) into the final MP4. Every clip in a scene needs
// the same audio layout for `-c copy` concat to work, which is why a silent
// scene still gets a synthetic silent track (`anullsrc`) rather than none.

use crate::job_sandbox::{self, CommandSandbox};
use crate::{apply_no_window_tokio, command_version, which_command};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command as TokioCommand;
use tokio::sync::Mutex as TokioMutex;

pub struct FfmpegState {
    pids: TokioMutex<HashMap<String, u32>>,
    cancelled: TokioMutex<std::collections::HashSet<String>>,
}

impl FfmpegState {
    pub fn new() -> Self {
        Self {
            pids: TokioMutex::new(HashMap::new()),
            cancelled: TokioMutex::new(std::collections::HashSet::new()),
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct FfmpegInfo {
    pub installed: bool,
    pub path: String,
    pub version: String,
}

// rename_all is required here, not cosmetic: Tauri's automatic camelCase<->
// snake_case conversion only applies to a command's own top-level argument
// names (call_id -> callId etc. on `creator_ffmpeg_render` itself); it does
// NOT recurse into nested struct fields like these, so without this the JS
// side's `imagePath`/`audioPath`/`durationSeconds` would silently fail to
// deserialize (confirmed live: omitting this produced "missing field
// `image_path`" even though the JS adapter's field names were correct).
#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegScene {
    /// Still image for the scene. Optional now that a scene can be an AI video
    /// clip instead; one of image_path / video_path must be set.
    #[serde(default)]
    pub image_path: String,
    /// An AI-generated (or uploaded) clip. Looped if shorter than the scene,
    /// trimmed if longer; its own soundtrack is dropped in favour of the
    /// voice-over so every clip has the same audio layout for the concat.
    #[serde(default)]
    pub video_path: Option<String>,
    pub audio_path: Option<String>,
    pub duration_seconds: f64,
    /// Short on-screen caption text (THE CREATOR's script generator has
    /// always produced this per scene — see WayCreatorScriptAdapter.js's
    /// "caption" field — but until now nothing ever burned it into the
    /// rendered video, so every export was silently missing captions).
    pub caption: Option<String>,
    /// Timed caption cues within the scene (seconds from the scene start).
    /// When absent, cues are derived from `caption` and spread across the
    /// scene in proportion to their length — the voice-over reads the same
    /// words at a roughly even pace, so the text keeps up with the voice.
    #[serde(default)]
    pub caption_cues: Option<Vec<CaptionCue>>,
    /// Where the caption sits: "top" | "center" | "bottom" (default). Vertical
    /// reels often need the text off the bottom third, which is where a
    /// platform's own UI (captions, buttons) sits.
    #[serde(default)]
    pub caption_position: Option<String>,
}

/// The drawtext `y` expression for a caption position.
pub(crate) fn caption_y(position: Option<&str>) -> &'static str {
    match position.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
        Some("top") => "160",
        Some("center") => "(h-text_h)/2",
        _ => "h-th-160",
    }
}

#[derive(Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptionCue {
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// Split a caption into short on-screen chunks and time them across the
/// scene, weighted by character count. Short chunks (≈5 words) read like the
/// word-by-word captions on reels instead of one static block of text.
pub(crate) fn derive_caption_cues(caption: &str, duration: f64, words_per_cue: usize) -> Vec<CaptionCue> {
    let words: Vec<&str> = caption.split_whitespace().collect();
    if words.is_empty() || duration <= 0.0 {
        return Vec::new();
    }
    let chunks: Vec<String> = words.chunks(words_per_cue.max(1)).map(|c| c.join(" ")).collect();
    let weights: Vec<f64> = chunks.iter().map(|c| c.chars().count().max(1) as f64).collect();
    let total: f64 = weights.iter().sum();
    let mut cues = Vec::with_capacity(chunks.len());
    let mut t = 0.0;
    for (chunk, weight) in chunks.into_iter().zip(weights) {
        let span = duration * weight / total;
        cues.push(CaptionCue { start: round3(t), end: round3((t + span).min(duration)), text: chunk });
        t += span;
    }
    cues
}

fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

/// drawtext filters for a scene's cues, each shown only inside its window.
pub(crate) fn caption_filters(cues: &[CaptionCue], font: &str, y: &str) -> String {
    cues.iter()
        .filter(|cue| !cue.text.trim().is_empty() && cue.end > cue.start)
        .map(|cue| {
            format!(
                ",drawtext=fontfile='{}':text='{}':fontsize=58:fontcolor=white:line_spacing=10:box=1:boxcolor=black@0.55:boxborderw=18:x=(w-text_w)/2:y={}:enable='between(t,{},{})'",
                escape_drawtext(font),
                escape_drawtext(&wrap_caption(cue.text.trim(), 26)),
                y,
                cue.start,
                cue.end,
            )
        })
        .collect()
}

/// ffmpeg arguments that render one scene to a clip with a fixed stream
/// layout: video from input 0, audio from input 1 (voice-over or silence).
pub(crate) fn scene_args(scene: &FfmpegScene, clip_path: &str, font: Option<&str>) -> Result<Vec<String>, String> {
    let duration = scene.duration_seconds.max(0.5);
    let video = scene.video_path.as_deref().map(str::trim).filter(|p| !p.is_empty());
    let image = scene.image_path.trim();
    let mut args: Vec<String> = vec!["-y".into()];
    match (video, image.is_empty()) {
        (Some(path), _) => args.extend(["-stream_loop", "-1", "-i", path].map(String::from)),
        (None, false) => args.extend(["-loop", "1", "-i", image].map(String::from)),
        (None, true) => return Err("Each scene needs an image or a video clip.".to_string()),
    }
    match &scene.audio_path {
        Some(audio) if !audio.trim().is_empty() => {
            args.push("-i".into());
            args.push(audio.clone());
        }
        _ => {
            args.extend(["-f", "lavfi", "-t"].map(String::from));
            args.push(duration.to_string());
            args.extend(["-i", "anullsrc=r=44100:cl=stereo"].map(String::from));
        }
    }
    let mut vf = String::from("scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p");
    if let Some(font) = font {
        let cues = match &scene.caption_cues {
            Some(cues) if !cues.is_empty() => cues.clone(),
            _ => derive_caption_cues(scene.caption.as_deref().unwrap_or(""), duration, 5),
        };
        vf.push_str(&caption_filters(&cues, font, caption_y(scene.caption_position.as_deref())));
    }
    args.extend(["-map", "0:v:0", "-map", "1:a:0", "-vf"].map(String::from));
    args.push(vf);
    let tune: &[&str] = if video.is_some() { &[] } else { &["-tune", "stillimage"] };
    args.extend(["-c:v", "libx264"].map(String::from));
    args.extend(tune.iter().map(|s| s.to_string()));
    args.extend(["-preset", "veryfast", "-pix_fmt", "yuv420p", "-ar", "44100", "-ac", "2", "-c:a", "aac", "-b:a", "192k", "-t"].map(String::from));
    args.push(duration.to_string());
    args.push(clip_path.to_string());
    Ok(args)
}

/// Background music under the voice-over with automatic ducking: the music is
/// compressed whenever the voice track is loud (sidechain), then mixed back in,
/// so it dips under speech and swells in the gaps. The video stream is copied.
pub(crate) fn duck_args(voiced_path: &str, bgm_path: &str, bgm_volume: f64, output_path: &str) -> Vec<String> {
    let volume = if bgm_volume.is_finite() { bgm_volume.clamp(0.02, 1.0) } else { 0.35 };
    let graph = format!(
        "[1:a]volume={volume},aformat=sample_rates=44100:channel_layouts=stereo[bg];\
         [0:a]aformat=sample_rates=44100:channel_layouts=stereo,asplit=2[vo][sc];\
         [bg][sc]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=350[duck];\
         [vo][duck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[a]"
    );
    vec![
        "-y".into(), "-i".into(), voiced_path.into(), "-stream_loop".into(), "-1".into(), "-i".into(), bgm_path.into(),
        "-filter_complex".into(), graph, "-map".into(), "0:v".into(), "-map".into(), "[a]".into(),
        "-c:v".into(), "copy".into(), "-c:a".into(), "aac".into(), "-b:a".into(), "192k".into(), "-shortest".into(),
        output_path.into(),
    ]
}

// ffmpeg's drawtext `text=` value uses its own escaping: backslash, single
// quote, colon, and percent all need a backslash before them, in that order
// so the escapes themselves don't get re-escaped. Reference: ffmpeg docs,
// "drawtext" filter, "Text expansion".
fn escape_drawtext(text: &str) -> String {
    text.replace('\\', "\\\\")
        .replace(':', "\\:")
        .replace('\'', "\\'")
        .replace('%', "\\%")
}

// drawtext has no built-in word-wrap — long captions would otherwise run off
// both edges of a 1080px-wide 9:16 frame. Wraps at a conservative width and
// joins with a literal newline, which drawtext renders as a real line break.
fn wrap_caption(text: &str, max_chars_per_line: usize) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let would_be = if current.is_empty() { word.to_string() } else { format!("{} {}", current, word) };
        // chars, not bytes: a Telugu letter is 3 bytes in UTF-8, so a byte
        // count broke every Telugu caption onto one word per line.
        if would_be.chars().count() > max_chars_per_line && !current.is_empty() {
            lines.push(current);
            current = word.to_string();
        } else {
            current = would_be;
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    lines.join("\n")
}

// drawtext needs a real font file path (fontfile=) rather than a font family
// name — Windows ffmpeg builds usually aren't compiled with fontconfig, so
// font= name lookup silently fails there. Checks a short list of common
// system font locations per platform and returns the first that exists;
// None means "render without captions" rather than fail the whole render.
fn find_system_font() -> Option<String> {
    // Nirmala UI first: it carries Telugu (and the other Indic scripts) as
    // well as Latin. With Arial first, every Telugu caption rendered as empty
    // boxes because Arial has no Telugu glyphs.
    let candidates: &[&str] = if cfg!(target_os = "windows") {
        &[
            "C:\\Windows\\Fonts\\NirmalaB.ttf",
            "C:\\Windows\\Fonts\\Nirmala.ttf",
            "C:\\Windows\\Fonts\\Nirmala.ttc",
            "C:\\Windows\\Fonts\\arialbd.ttf",
            "C:\\Windows\\Fonts\\arial.ttf",
            "C:\\Windows\\Fonts\\segoeuib.ttf",
        ]
    } else if cfg!(target_os = "macos") {
        &[
            "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
            "/System/Library/Fonts/Helvetica.ttc",
        ]
    } else {
        &[
            "/usr/share/fonts/truetype/noto/NotoSansTelugu-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        ]
    };
    candidates.iter().find(|path| std::path::Path::new(path).exists()).map(|path| path.to_string())
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegOutcome {
    pub success: bool,
    pub cancelled: bool,
    pub output_path: String,
    pub error: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FfmpegProgressEvent {
    call_id: String,
    scene_index: usize,
    total_scenes: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FfmpegDoneEvent {
    call_id: String,
    success: bool,
    cancelled: bool,
}

// Writes caller-supplied bytes (an already-fetched image/audio blob — image
// generation URLs and CapCut... audio's authenticated media route both need
// JS-side fetch/auth, which already exists in CreatorStudioApiClient.js; this
// command's only job is turning those bytes into a real local file ffmpeg's
// native process can read directly, since ffmpeg can't send an Authorization
// header or decode a data: URI itself) into the same per-call_id temp
// directory `creator_ffmpeg_render` uses, so every scene's inputs are ready
// before rendering starts.
#[tauri::command]
pub fn creator_ffmpeg_write_temp(call_id: String, index: u32, kind: String, extension: String, bytes: Vec<u8>) -> Result<String, String> {
    let dir = std::env::temp_dir().join(format!("way-creator-render-{}", call_id));
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create temp render directory: {}", e))?;
    let safe_kind = match kind.as_str() {
        "audio" => "audio",
        "video" => "video",
        "bgm" => "bgm",
        _ => "image",
    };
    let safe_ext: String = extension.chars().filter(|c| c.is_ascii_alphanumeric()).take(8).collect();
    let safe_ext = if safe_ext.is_empty() { "bin".to_string() } else { safe_ext };
    let file_path = dir.join(format!("{}_{:04}.{}", safe_kind, index, safe_ext));
    std::fs::write(&file_path, bytes).map_err(|e| format!("Failed to write temp file: {}", e))?;
    Ok(file_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn creator_ffmpeg_detect() -> Result<FfmpegInfo, String> {
    match which_command("ffmpeg") {
        Some(path) => {
            let version = command_version(&path, "ffmpeg");
            Ok(FfmpegInfo {
                installed: true,
                path,
                version,
            })
        }
        None => Ok(FfmpegInfo {
            installed: false,
            path: String::new(),
            version: String::new(),
        }),
    }
}

// Runs one ffmpeg invocation to completion under the same Job Object sandbox
// every other spawned command in this app uses, tracking its PID under
// `call_id` for the duration so `creator_ffmpeg_cancel` can reach it.
async fn run_tracked(
    command_path: &str,
    args: &[String],
    state: &State<'_, FfmpegState>,
    call_id: &str,
) -> Result<bool, String> {
    let mut cmd = TokioCommand::new(command_path);
    apply_no_window_tokio(&mut cmd);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to start ffmpeg: {}", e))?;

    let sandbox = match CommandSandbox::new() {
        Ok(sandbox) => match sandbox.assign_child(&child) {
            Ok(()) => Some(sandbox),
            Err(e) => {
                let _ = child.kill().await;
                return Err(format!("Failed to sandbox ffmpeg: {}", e));
            }
        },
        Err(e) => {
            let _ = child.kill().await;
            return Err(format!("Failed to sandbox ffmpeg: {}", e));
        }
    };
    let _sandboxed = sandbox.is_some() && job_sandbox::is_supported();

    if let Some(pid) = child.id() {
        state.pids.lock().await.insert(call_id.to_string(), pid);
    }

    // ffmpeg writes all its logging (including fatal errors) to stderr — drained
    // so a long render can't stall on a full OS pipe buffer, tail kept for the
    // caller to surface if the exit status is a failure.
    let stderr = child.stderr.take();
    let stderr_tail = Arc::new(TokioMutex::new(Vec::<String>::new()));
    if let Some(stderr) = stderr {
        let tail = stderr_tail.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut buf = tail.lock().await;
                buf.push(line);
                if buf.len() > 60 {
                    let overflow = buf.len() - 60;
                    buf.drain(0..overflow);
                }
            }
        });
    }

    let wait_result = child.wait().await;
    state.pids.lock().await.remove(call_id);
    drop(sandbox);

    match wait_result {
        Ok(status) if status.success() => Ok(true),
        Ok(_) => {
            let tail = stderr_tail.lock().await;
            Err(tail.join("\n"))
        }
        Err(e) => Err(format!("Failed to wait for ffmpeg: {}", e)),
    }
}

fn quote_concat_path(path: &str) -> String {
    // ffmpeg's concat demuxer file list uses single-quoted paths with '\'' as the
    // escape for an embedded quote — matches ffmpeg's own documented syntax.
    format!("file '{}'", path.replace('\'', "'\\''"))
}

#[tauri::command]
pub async fn creator_ffmpeg_render(
    app: AppHandle,
    state: State<'_, FfmpegState>,
    call_id: String,
    scenes: Vec<FfmpegScene>,
    output_path: String,
    bgm_path: Option<String>,
    bgm_volume: Option<f64>,
) -> Result<FfmpegOutcome, String> {
    if scenes.is_empty() {
        return Err("At least one scene is required to render.".to_string());
    }
    let Some(command_path) = which_command("ffmpeg") else {
        return Err("ffmpeg not found. Install it and make sure it's on PATH.".to_string());
    };

    state.cancelled.lock().await.remove(&call_id);

    let work_dir = std::env::temp_dir().join(format!("way-creator-render-{}", call_id));
    std::fs::create_dir_all(&work_dir)
        .map_err(|e| format!("Failed to create temp render directory: {}", e))?;
    // ffmpeg will not create the destination folder (e.g. Videos\Way AI).
    if let Some(parent) = std::path::Path::new(&output_path).parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create the output folder: {}", e))?;
        }
    }

    let finish = |app: &AppHandle, success: bool, cancelled: bool| {
        let _ = app.emit(
            "creator-ffmpeg-done",
            FfmpegDoneEvent { call_id: call_id.clone(), success, cancelled },
        );
    };
    let fail = |message: String| FfmpegOutcome { success: false, cancelled: false, output_path: String::new(), error: message };

    let mut clip_paths: Vec<PathBuf> = Vec::with_capacity(scenes.len());
    let total = scenes.len();
    // Looked up once, not per-scene — it's a filesystem check every scene
    // would otherwise repeat for the same answer.
    let caption_font = find_system_font();

    for (index, scene) in scenes.iter().enumerate() {
        if state.cancelled.lock().await.contains(&call_id) {
            let _ = std::fs::remove_dir_all(&work_dir);
            finish(&app, false, true);
            return Ok(FfmpegOutcome { success: false, cancelled: true, output_path: String::new(), error: String::new() });
        }

        let clip_path = work_dir.join(format!("scene_{:04}.mp4", index));
        let args = match scene_args(scene, &clip_path.to_string_lossy(), caption_font.as_deref()) {
            Ok(args) => args,
            Err(err) => {
                let _ = std::fs::remove_dir_all(&work_dir);
                finish(&app, false, false);
                return Ok(fail(format!("Scene {}: {}", index + 1, err)));
            }
        };
        if let Err(err) = run_tracked(&command_path, &args, &state, &call_id).await {
            let _ = std::fs::remove_dir_all(&work_dir);
            finish(&app, false, false);
            return Ok(fail(format!("Scene {} render failed: {}", index + 1, err)));
        }

        clip_paths.push(clip_path);
        let _ = app.emit(
            "creator-ffmpeg-progress",
            FfmpegProgressEvent { call_id: call_id.clone(), scene_index: index + 1, total_scenes: total },
        );
    }

    let concat_list_path = work_dir.join("concat.txt");
    let concat_body = clip_paths
        .iter()
        .map(|p| quote_concat_path(&p.to_string_lossy()))
        .collect::<Vec<_>>()
        .join("\n");
    {
        let mut file = tokio::fs::File::create(&concat_list_path)
            .await
            .map_err(|e| format!("Failed to write concat list: {}", e))?;
        file.write_all(concat_body.as_bytes())
            .await
            .map_err(|e| format!("Failed to write concat list: {}", e))?;
    }

    // With music, concat into a temp file and duck the music under it into the
    // final output; without, concat straight to the output as before.
    let bgm = bgm_path.as_deref().map(str::trim).filter(|p| !p.is_empty() && std::path::Path::new(p).exists());
    let voiced_path = if bgm.is_some() { work_dir.join("voiced.mp4").to_string_lossy().to_string() } else { output_path.clone() };
    let concat_args: Vec<String> = vec![
        "-y".into(), "-f".into(), "concat".into(), "-safe".into(), "0".into(),
        "-i".into(), concat_list_path.to_string_lossy().to_string(),
        "-c".into(), "copy".into(), voiced_path.clone(),
    ];

    let mut outcome = match run_tracked(&command_path, &concat_args, &state, &call_id).await {
        Ok(_) => FfmpegOutcome { success: true, cancelled: false, output_path: output_path.clone(), error: String::new() },
        Err(err) => fail(format!("Final concat failed: {}", err)),
    };

    if outcome.success {
        if let Some(bgm) = bgm {
            let args = duck_args(&voiced_path, bgm, bgm_volume.unwrap_or(0.35), &output_path);
            if let Err(err) = run_tracked(&command_path, &args, &state, &call_id).await {
                outcome = fail(format!("Background music mix failed: {}", err));
            }
        }
    }

    let _ = std::fs::remove_dir_all(&work_dir);
    state.cancelled.lock().await.remove(&call_id);
    finish(&app, outcome.success, false);
    Ok(outcome)
}
/// Play a finished render, or show it in its folder. Deliberately narrow: the
/// shell plugin's `open` only accepts http/mailto URLs, and widening its scope
/// to local paths would let any page script launch any file. This accepts
/// only an existing .mp4 file.
#[tauri::command]
pub fn creator_open_output(path: String, reveal: bool) -> Result<(), String> {
    let file = std::path::Path::new(&path);
    let is_mp4 = file.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("mp4")).unwrap_or(false);
    if !file.is_absolute() || !is_mp4 || !file.is_file() {
        return Err("Only a rendered .mp4 file can be opened here.".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        let mut cmd = std::process::Command::new("explorer.exe");
        if reveal {
            cmd.arg(format!("/select,{}", file.display()));
        } else {
            cmd.arg(file);
        }
        cmd.spawn().map(|_| ()).map_err(|e| format!("Could not open the video: {e}"))
    }
    #[cfg(target_os = "macos")]
    {
        let mut cmd = std::process::Command::new("open");
        if reveal { cmd.arg("-R"); }
        cmd.arg(file).spawn().map(|_| ()).map_err(|e| format!("Could not open the video: {e}"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let target = if reveal { file.parent().unwrap_or(file).to_path_buf() } else { file.to_path_buf() };
        std::process::Command::new("xdg-open").arg(target).spawn().map(|_| ()).map_err(|e| format!("Could not open the video: {e}"))
    }
}

#[cfg(target_os = "windows")]
async fn kill_pid_tree(pid: u32) -> Result<(), String> {
    let mut cmd = TokioCommand::new("taskkill");
    apply_no_window_tokio(&mut cmd);
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
    cmd.output()
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to cancel ffmpeg: {}", e))
}

#[cfg(not(target_os = "windows"))]
async fn kill_pid_tree(pid: u32) -> Result<(), String> {
    TokioCommand::new("kill")
        .args(["-9", &pid.to_string()])
        .output()
        .await
        .map(|_| ())
        .map_err(|e| format!("Failed to cancel ffmpeg: {}", e))
}

#[tauri::command]
pub async fn creator_ffmpeg_cancel(state: State<'_, FfmpegState>, call_id: String) -> Result<(), String> {
    state.cancelled.lock().await.insert(call_id.clone());
    let pid = state.pids.lock().await.remove(&call_id);
    match pid {
        Some(pid) => kill_pid_tree(pid).await,
        None => Ok(()), // between scenes, or already finished — the cancelled flag still stops the next one
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scene(image: &str, video: Option<&str>, audio: Option<&str>, caption: Option<&str>) -> FfmpegScene {
        FfmpegScene {
            image_path: image.to_string(),
            video_path: video.map(String::from),
            audio_path: audio.map(String::from),
            duration_seconds: 6.0,
            caption: caption.map(String::from),
            caption_cues: None,
            caption_position: None,
        }
    }

    #[test]
    fn cues_cover_the_scene_in_order_and_split_long_captions() {
        let cues = derive_caption_cues("AI is changing how we build apps every single day now", 6.0, 5);
        assert_eq!(cues.len(), 3);
        assert_eq!(cues[0].start, 0.0);
        assert!((cues.last().unwrap().end - 6.0).abs() < 0.01);
        for pair in cues.windows(2) {
            assert!((pair[0].end - pair[1].start).abs() < 0.01, "cues must be contiguous");
        }
    }

    #[test]
    fn telugu_captions_split_on_words_too() {
        let cues = derive_caption_cues("ఈ రోజు టెక్నాలజీ గురించి మాట్లాడదాం ఇది చాలా ముఖ్యం", 4.0, 3);
        assert_eq!(cues.len(), 3);
        assert_eq!(cues[0].text, "ఈ రోజు టెక్నాలజీ");
    }

    #[test]
    fn wrapping_counts_characters_not_bytes() {
        // 30 characters of Telugu is ~90 bytes; it must still fit two words a line.
        let wrapped = wrap_caption("ఈ రోజు టెక్నాలజీ గురించి", 26);
        assert_eq!(wrapped.lines().count(), 1, "{wrapped}");
        // "one two" / "three four" / "five six" / "seven"
        assert_eq!(wrap_caption("one two three four five six seven", 12).lines().count(), 4);
    }

    #[test]
    fn open_output_accepts_only_an_existing_mp4() {
        let dir = std::env::temp_dir().join("way-creator-open-test");
        std::fs::create_dir_all(&dir).unwrap();
        let exe = dir.join("evil.exe");
        std::fs::write(&exe, b"x").unwrap();
        assert!(creator_open_output(exe.to_string_lossy().to_string(), false).is_err());
        assert!(creator_open_output("relative/video.mp4".into(), false).is_err());
        assert!(creator_open_output(dir.join("missing.mp4").to_string_lossy().to_string(), true).is_err());
        assert!(creator_open_output(dir.to_string_lossy().to_string(), true).is_err(), "a folder is not a video");
    }

    #[test]
    fn empty_caption_has_no_cues() {
        assert!(derive_caption_cues("   ", 5.0, 5).is_empty());
    }

    #[test]
    fn caption_filters_are_time_gated_and_escaped() {
        let cues = vec![CaptionCue { start: 0.0, end: 1.5, text: "50% off: today".into() }];
        let f = caption_filters(&cues, "C:\\Windows\\Fonts\\Nirmala.ttc", caption_y(None));
        assert!(f.contains("enable='between(t,0,1.5)'"));
        assert!(f.contains("50\\% off\\: today"));
        assert!(f.contains("fontfile='C\\:\\\\Windows"));
    }

    #[test]
    fn caption_position_moves_the_text_and_defaults_to_the_bottom() {
        assert_eq!(caption_y(Some("top")), "160");
        assert_eq!(caption_y(Some("Center")), "(h-text_h)/2");
        assert_eq!(caption_y(Some("bottom")), "h-th-160");
        assert_eq!(caption_y(None), "h-th-160");
        assert_eq!(caption_y(Some("nonsense")), "h-th-160");
        let cues = vec![CaptionCue { start: 0.0, end: 1.0, text: "hi".into() }];
        assert!(caption_filters(&cues, "f.ttf", caption_y(Some("top"))).contains(":y=160:"));
    }

    #[test]
    fn video_scene_loops_the_clip_and_keeps_voice_audio() {
        let args = scene_args(&scene("", Some("clip.mp4"), Some("voice.wav"), None), "out.mp4", None).unwrap();
        let joined = args.join(" ");
        assert!(joined.contains("-stream_loop -1 -i clip.mp4 -i voice.wav"));
        assert!(joined.contains("-map 0:v:0 -map 1:a:0"), "the clip's own soundtrack must not leak in");
        assert!(!joined.contains("stillimage"));
        assert!(joined.ends_with("-t 6 out.mp4"));
    }

    #[test]
    fn image_scene_without_voice_gets_silence() {
        let args = scene_args(&scene("still.png", None, None, Some("hello world")), "out.mp4", Some("font.ttf")).unwrap();
        let joined = args.join(" ");
        assert!(joined.contains("-loop 1 -i still.png"));
        assert!(joined.contains("anullsrc=r=44100:cl=stereo"));
        assert!(joined.contains("tune stillimage"));
        assert!(joined.contains("drawtext"));
    }

    #[test]
    fn scene_needs_some_visual() {
        assert!(scene_args(&scene("", None, None, None), "out.mp4", None).is_err());
    }

    #[test]
    fn ducking_uses_the_voice_as_sidechain_and_copies_video() {
        let args = duck_args("voiced.mp4", "music.mp3", 0.4, "final.mp4");
        let joined = args.join(" ");
        assert!(joined.contains("sidechaincompress"));
        assert!(joined.contains("volume=0.4"));
        assert!(joined.contains("-stream_loop -1 -i music.mp3"));
        assert!(joined.contains("-c:v copy"));
        assert!(joined.ends_with("final.mp4"));
        assert!(duck_args("a", "b", f64::NAN, "c").join(" ").contains("volume=0.35"));
        assert!(duck_args("a", "b", 9.0, "c").join(" ").contains("volume=1"));
    }

    /// Real ffmpeg, real files: `cargo test creator_ffmpeg -- --ignored`.
    /// Builds a video scene and an image scene with Telugu captions, concats
    /// them, ducks music under them, and checks the result with ffprobe.
    #[test]
    #[ignore]
    fn renders_a_real_reel_with_captions_and_ducked_music() {
        use std::process::Command;
        let ffmpeg = crate::which_command("ffmpeg").expect("ffmpeg on PATH");
        let dir = std::env::temp_dir().join("way-creator-live-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = |name: &str| dir.join(name).to_string_lossy().to_string();
        let gen = |args: &[&str]| {
            let status = Command::new(&ffmpeg).args(args).status().unwrap();
            assert!(status.success(), "fixture generation failed: {:?}", args);
        };
        gen(&["-y", "-f", "lavfi", "-i", "testsrc=size=640x360:rate=25", "-t", "2", &p("clip.mp4")]);
        gen(&["-y", "-f", "lavfi", "-i", "color=c=navy:s=720x1280", "-frames:v", "1", &p("still.png")]);
        gen(&["-y", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "3", &p("voice.wav")]);
        gen(&["-y", "-f", "lavfi", "-i", "sine=frequency=220:sample_rate=44100", "-t", "2", &p("music.mp3")]);

        let font = find_system_font();
        let scenes = [
            FfmpegScene { image_path: String::new(), video_path: Some(p("clip.mp4")), audio_path: Some(p("voice.wav")),
                duration_seconds: 3.0, caption: Some("ఈ రోజు టెక్నాలజీ గురించి మాట్లాడదాం".into()), caption_cues: None, caption_position: None },
            FfmpegScene { image_path: p("still.png"), video_path: None, audio_path: None,
                duration_seconds: 2.0, caption: Some("Way AI Creator test".into()), caption_cues: None, caption_position: Some("top".into()) },
        ];
        let mut list = String::new();
        for (i, scene) in scenes.iter().enumerate() {
            let clip = p(&format!("scene_{i}.mp4"));
            let args = scene_args(scene, &clip, font.as_deref()).unwrap();
            let out = Command::new(&ffmpeg).args(&args).output().unwrap();
            assert!(out.status.success(), "scene {i} failed:\n{}", String::from_utf8_lossy(&out.stderr));
            list.push_str(&format!("file '{}'\n", clip));
        }
        std::fs::write(p("list.txt"), list).unwrap();
        let concat = Command::new(&ffmpeg)
            .args(["-y", "-f", "concat", "-safe", "0", "-i", &p("list.txt"), "-c", "copy", &p("voiced.mp4")])
            .output().unwrap();
        assert!(concat.status.success(), "concat failed:\n{}", String::from_utf8_lossy(&concat.stderr));
        let duck = Command::new(&ffmpeg).args(duck_args(&p("voiced.mp4"), &p("music.mp3"), 0.35, &p("final.mp4"))).output().unwrap();
        assert!(duck.status.success(), "duck failed:\n{}", String::from_utf8_lossy(&duck.stderr));

        let probe = std::path::Path::new(&ffmpeg).with_file_name(if cfg!(windows) { "ffprobe.exe" } else { "ffprobe" });
        let info = Command::new(&probe)
            .args(["-v", "error", "-show_entries", "stream=codec_type,width,height:format=duration", "-of", "json", &p("final.mp4")])
            .output().unwrap();
        let text = String::from_utf8_lossy(&info.stdout).to_string();
        assert!(text.contains("\"codec_type\": \"video\"") && text.contains("\"codec_type\": \"audio\""), "{text}");
        assert!(text.contains("\"width\": 1080") && text.contains("\"height\": 1920"), "{text}");
        let duration: f64 = text.split("\"duration\": \"").nth(1).and_then(|s| s.split('"').next()).and_then(|s| s.parse().ok()).unwrap();
        assert!((duration - 5.0).abs() < 0.4, "expected ~5s, got {duration}");
        println!("LIVE RENDER OK: {} ({duration:.2}s)", p("final.mp4"));
    }
}