/**
 * Meeting Recorder — Crow's Nest panel.
 *
 * Captures the meeting's own audio (a shared tab or window) plus the
 * microphone, mixes them in WebAudio, and uploads Opus every 15 seconds to the
 * companion routes. On stop, a detached worker transcribes the recording
 * locally. The page also accepts a recording made some other way.
 *
 * A browser only offers tab audio in a secure context, so this page needs to be
 * reached over HTTPS or on localhost. It says so on screen when it is not.
 */

const API = "/dashboard/meeting-recorder-api";

export default {
  id: "meeting-recorder",
  name: "Meeting Recorder",
  icon: "mic",
  route: "/dashboard/meeting-recorder",
  navOrder: 17,

  async handler(req, res, { layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const componentsPath = join(appRoot, "servers/gateway/dashboard/shared/components.js");
    const { escapeHtml, section } = await import(pathToFileURL(componentsPath).href);

    // Installed copy first (an alternate instance sets CROW_HOME), repo second.
    const { homedir } = await import("node:os");
    const { existsSync } = await import("node:fs");
    const storeCandidates = [
      join(process.env.CROW_HOME || join(homedir(), ".crow"),
        "bundles", "meeting-recorder", "server", "store.js"),
      join(appRoot, "bundles/meeting-recorder/server/store.js"),
    ];
    const storePath = storeCandidates.find((p) => existsSync(p));
    if (!storePath) throw new Error("meeting-recorder: store.js not found");
    const { listSessions } = await import(pathToFileURL(storePath).href);

    const sessions = listSessions(12);
    const clock = (s) => {
      const t = Math.floor(s || 0);
      return t >= 3600
        ? `${Math.floor(t / 3600)}:${String(Math.floor((t % 3600) / 60)).padStart(2, "0")}`
        : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`;
    };

    const rows = sessions.length
      ? sessions
          .map((s) => {
            const state =
              s.state === "done"
                ? `<span class="mr-ok">done</span>`
                : s.state === "failed"
                  ? `<span class="mr-bad">failed</span>`
                  : `<span class="mr-run">${escapeHtml(s.state || "")}</span>`;
            const detail =
              s.state === "done"
                ? `${s.word_count || 0} words`
                : escapeHtml(s.progress || s.error || "");
            return `<tr><td>${escapeHtml(s.title || "Untitled")}</td>
              <td>${escapeHtml((s.started_at || "").slice(0, 16).replace("T", " "))}</td>
              <td>${clock(s.duration_seconds)}</td><td>${state}</td><td>${detail}</td>
              <td><code>${escapeHtml(s.id || "")}</code></td></tr>`;
          })
          .join("")
      : `<tr><td colspan="6" class="mr-muted">Nothing recorded yet.</td></tr>`;

    const content = `
<style>
  .mr-card { background: var(--surface, #fff); border: 1px solid var(--border, #d5dee7);
             border-radius: 10px; padding: 14px 16px; margin: 12px 0; }
  .mr-row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .mr-hint { color: var(--text-muted, #5a6b7b); font-size: 12.5px; margin: 4px 0 0; }
  .mr-meterwrap { height: 12px; background: var(--border, #e2e8f0); border-radius: 6px;
                  overflow: hidden; margin: 10px 0 4px; }
  .mr-meter { height: 100%; width: 0%; background: var(--accent, #2b7ba8); transition: width .1s linear; }
  .mr-big { font-size: 30px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .mr-warn { border-left: 4px solid #b7791f; padding: 8px 11px; margin: 10px 0; font-size: 13.5px; }
  .mr-good { border-left: 4px solid #1b7a4b; padding: 8px 11px; margin: 10px 0; font-size: 13.5px; }
  .mr-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%;
            background: #ac1f2e; margin-right: 7px; animation: mrpulse 1.4s infinite; }
  @keyframes mrpulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
  .mr-ok { color: #1b7a4b; font-weight: 600; } .mr-bad { color: #ac1f2e; font-weight: 600; }
  .mr-run { color: #b7791f; font-weight: 600; }
  .mr-muted { color: var(--text-muted, #5a6b7b); }
  .mr-card input[type=text], .mr-card textarea { width: 100%; padding: 8px 10px;
    border: 1px solid var(--border, #d5dee7); border-radius: 6px; font: inherit; }
  .mr-card textarea { min-height: 70px; }
  .mr-checks label { display: flex; gap: 8px; align-items: flex-start; margin: 8px 0; font-size: 14px; }
</style>

<div class="mr-warn" id="mr-insecure" hidden>
  This page is not in a secure context, so the browser will not hand over meeting audio.
  Reach the dashboard over HTTPS or on localhost, then reload.
</div>

<div class="mr-card" id="mr-setup">
  <label for="mr-title"><b>What is this meeting</b></label>
  <input type="text" id="mr-title" placeholder="Untitled meeting">
  <div class="mr-checks">
    <label><input type="checkbox" id="mr-src-tab" checked>
      <span><b>Meeting audio</b><br><span class="mr-hint">Pick the tab or window the meeting is
      playing in and tick <i>Share tab audio</i> in the picker. On Windows, sharing a whole screen
      also carries system sound.</span></span></label>
    <label><input type="checkbox" id="mr-src-mic" checked>
      <span><b>My microphone</b><br><span class="mr-hint">Catches what you say, including questions
      you ask.</span></span></label>
  </div>
  <div class="mr-row" style="margin-top:12px">
    <button class="btn btn-primary" id="mr-start">Start recording</button>
  </div>
  <p class="mr-hint" id="mr-setup-msg"></p>
</div>

<div class="mr-card" id="mr-live" hidden>
  <div class="mr-row" style="justify-content:space-between">
    <div><span class="mr-dot"></span><span class="mr-big" id="mr-elapsed">0:00</span></div>
    <button class="btn" id="mr-stop">Stop and transcribe</button>
  </div>
  <div class="mr-meterwrap"><div class="mr-meter" id="mr-meter"></div></div>
  <p class="mr-hint" id="mr-stat">starting…</p>
  <div class="mr-warn" id="mr-silence" hidden>No sound has reached the recorder yet. If the meeting
    audio is the part you need, stop, start again, and tick <b>Share tab audio</b>.</div>
  <label for="mr-notes" style="margin-top:12px"><b>Notes while you listen</b></label>
  <textarea id="mr-notes" placeholder="Decisions, questions, anything worth flagging."></textarea>
</div>

<div class="mr-card" id="mr-done" hidden>
  <div class="mr-good" id="mr-done-msg">Recording saved. Transcribing now.</div>
  <p class="mr-hint" id="mr-done-detail"></p>
  <div class="mr-row"><button class="btn" id="mr-again">Record another</button></div>
</div>

<div class="mr-card" id="mr-upload-card">
  <label for="mr-file"><b>Or transcribe a recording you already have</b></label>
  <p class="mr-hint" style="margin-bottom:8px">Any audio or video file. It takes the same path and
    lands in the same place.</p>
  <input type="file" id="mr-file" accept="audio/*,video/*">
  <input type="text" id="mr-file-title" placeholder="What is this recording" style="margin-top:8px">
  <div class="mr-row" style="margin-top:10px">
    <button class="btn" id="mr-upload">Upload and transcribe</button>
  </div>
  <div class="mr-meterwrap" id="mr-up-wrap" hidden><div class="mr-meter" id="mr-up-bar"></div></div>
  <p class="mr-hint" id="mr-upload-msg"></p>
</div>

${section(
  "Recent recordings",
  `<table class="data-table"><thead><tr><th>Meeting</th><th>Started</th><th>Length</th>
     <th>State</th><th></th><th>Session</th></tr></thead><tbody>${rows}</tbody></table>`
)}

<script>
(() => {
  const API = ${JSON.stringify(API)};
  const $ = (id) => document.getElementById(id);
  const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");

  let rec = null, sid = null, t0 = 0, timer = null, streams = [], ac = null;
  let uploaded = 0, chunks = 0, sawSound = false, stopping = false;

  if (!window.isSecureContext) $("mr-insecure").hidden = false;

  async function start() {
    $("mr-setup-msg").textContent = "";
    const wantTab = $("mr-src-tab").checked, wantMic = $("mr-src-mic").checked;
    if (!wantTab && !wantMic) { $("mr-setup-msg").textContent = "Pick at least one source."; return; }

    ac = new AudioContext();
    const mix = ac.createMediaStreamDestination();
    const sources = [];
    try {
      if (wantTab) {
        // Chrome only offers tab or system audio when video is requested too.
        // The video track is never recorded; it just surfaces the audio option.
        const disp = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
        streams.push(disp);
        if (!disp.getAudioTracks().length) {
          disp.getTracks().forEach((t) => t.stop());
          streams = [];
          $("mr-setup-msg").textContent =
            "That share carried no audio. Start again and tick \\u201cShare tab audio\\u201d.";
          return;
        }
        ac.createMediaStreamSource(new MediaStream(disp.getAudioTracks())).connect(mix);
        sources.push("meeting");
        disp.getVideoTracks()[0].addEventListener("ended", () => { if (rec && !stopping) stop(); });
      }
      if (wantMic) {
        const mic = await navigator.mediaDevices.getUserMedia({ audio: true });
        streams.push(mic);
        ac.createMediaStreamSource(mic).connect(mix);
        sources.push("microphone");
      }
    } catch (err) {
      cleanup();
      $("mr-setup-msg").textContent = "Could not start capture: " + err.message;
      return;
    }

    const res = await fetch(API + "/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: $("mr-title").value || "Untitled meeting", sources }),
    });
    sid = (await res.json()).id;

    // Level meter, so silence is visible rather than discovered afterwards.
    const analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    ac.createMediaStreamSource(mix.stream).connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    (function draw() {
      if (!rec) return;
      analyser.getByteTimeDomainData(buf);
      let m = 0;
      for (const v of buf) m = Math.max(m, Math.abs(v - 128));
      if (m > 4) sawSound = true;
      $("mr-meter").style.width = Math.min(100, (m / 60) * 100) + "%";
      requestAnimationFrame(draw);
    })();

    rec = new MediaRecorder(mix.stream, { mimeType: "audio/webm;codecs=opus", audioBitsPerSecond: 48000 });
    rec.ondataavailable = async (e) => {
      if (!e.data || !e.data.size) return;
      chunks++;
      try {
        await fetch(API + "/chunk?id=" + encodeURIComponent(sid), {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: e.data,
        });
        uploaded += e.data.size;
      } catch (err) {
        $("mr-stat").textContent = "Upload failed, still recording locally: " + err.message;
      }
    };
    rec.start(15000);
    t0 = Date.now();
    $("mr-setup").hidden = true; $("mr-upload-card").hidden = true;
    $("mr-live").hidden = false; $("mr-done").hidden = true;
    timer = setInterval(tick, 500);
    tick();
  }

  function tick() {
    const s = (Date.now() - t0) / 1000;
    $("mr-elapsed").textContent = fmt(s);
    $("mr-stat").textContent = chunks + " chunk" + (chunks === 1 ? "" : "s") + " uploaded \\u00b7 "
      + (uploaded / 1e6).toFixed(1) + " MB";
    $("mr-silence").hidden = sawSound || s < 20;
  }

  async function stop() {
    if (!rec || stopping) return;
    stopping = true;
    $("mr-stop").disabled = true;
    const seconds = Math.round((Date.now() - t0) / 1000);
    await new Promise((done) => { rec.onstop = done; rec.stop(); });
    clearInterval(timer);
    cleanup();
    const res = await fetch(API + "/finish?id=" + encodeURIComponent(sid), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ duration_seconds: seconds, notes: $("mr-notes").value }),
    });
    const meta = await res.json();
    $("mr-live").hidden = true; $("mr-done").hidden = false;
    $("mr-done-detail").textContent = fmt(seconds) + " recorded \\u00b7 session " + meta.id;
    poll(meta.id);
    stopping = false;
  }

  async function poll(id) {
    for (let i = 0; i < 720; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        const m = await (await fetch(API + "/status?id=" + encodeURIComponent(id))).json();
        if (m.state === "done") {
          $("mr-done-msg").textContent = "Transcript ready: " + (m.word_count || 0) + " words in "
            + Math.max(1, Math.round((m.transcribe_seconds || 0) / 60)) + " min. Reload for the list.";
          return;
        }
        if (m.state === "failed") {
          $("mr-done-msg").textContent = "Transcription failed: " + (m.error || "unknown");
          return;
        }
        if (m.progress) $("mr-done-detail").textContent = m.progress;
      } catch (e) { /* keep polling */ }
    }
  }

  async function upload() {
    const f = $("mr-file").files[0];
    if (!f) { $("mr-upload-msg").textContent = "Pick a file first."; return; }
    $("mr-upload").disabled = true;
    $("mr-up-wrap").hidden = false;
    $("mr-upload-msg").textContent = "Uploading " + (f.size / 1e6).toFixed(0) + " MB\\u2026";
    const url = API + "/upload?name=" + encodeURIComponent(f.name)
      + "&title=" + encodeURIComponent($("mr-file-title").value || f.name);
    // XHR rather than fetch: a long upload wants a progress bar.
    const meta = await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) $("mr-up-bar").style.width = (e.loaded / e.total) * 100 + "%";
      };
      xhr.onload = () => (xhr.status === 200 ? resolve(JSON.parse(xhr.responseText))
                                             : reject(new Error("HTTP " + xhr.status)));
      xhr.onerror = () => reject(new Error("network error"));
      xhr.send(f);
    }).catch((err) => { $("mr-upload-msg").textContent = "Upload failed: " + err.message; return null; });
    $("mr-upload").disabled = false;
    if (!meta) return;
    $("mr-upload-msg").textContent = "";
    $("mr-setup").hidden = true; $("mr-upload-card").hidden = true; $("mr-done").hidden = false;
    $("mr-done-msg").textContent = "Uploaded. Transcribing now.";
    $("mr-done-detail").textContent = f.name + " \\u00b7 session " + meta.id;
    poll(meta.id);
  }

  function cleanup() {
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    streams = [];
    if (ac) { ac.close().catch(() => {}); ac = null; }
    rec = null;
  }

  window.addEventListener("beforeunload", (e) => { if (rec) { e.preventDefault(); e.returnValue = ""; } });
  $("mr-start").addEventListener("click", start);
  $("mr-stop").addEventListener("click", stop);
  $("mr-upload").addEventListener("click", upload);
  $("mr-again").addEventListener("click", () => {
    $("mr-done").hidden = true; $("mr-setup").hidden = false; $("mr-upload-card").hidden = false;
    $("mr-stop").disabled = false; $("mr-up-wrap").hidden = true; $("mr-up-bar").style.width = "0%";
    $("mr-file").value = ""; uploaded = 0; chunks = 0; sawSound = false; $("mr-notes").value = "";
  });
})();
</script>`;

    return layout({ title: "Meeting Recorder", content });
  },
};
