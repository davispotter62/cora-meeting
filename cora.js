// Cora's in-meeting page. Recall.ai renders this as the bot's camera and gives it the meeting audio as
// its microphone. We read Recall's live transcript and only open an ElevenLabs voice session when
// someone says "Cora", so voice minutes are billed only while she is talking.
// @elevenlabs/client 0.16.0 (with livekit-client 2.22.3), bundled locally and loaded by index.html with
// an integrity hash, so no third-party CDN can change the code that runs on this origin.
const { Conversation } = window.ElevenLabsClient;
// simli-client 3.0.2, bundled locally (the CDNs can't build it: a filename-case bug in the package).
import { SimliClient, LogLevel } from "./simli-3.0.2.js";

const FN = "https://cbtbnjbdcdqmvlolzdlt.supabase.co/functions/v1/cora-voice";
const q = new URLSearchParams(location.search);
const N = q.get("n"), T = q.get("t"), TITLE = q.get("title") || "a meeting";
const WAKE = /\b(cora|kora|korah|corah|quora|coura|corra)\b/i;
const SELF = /cora \(forgex/i;

const stage = document.getElementById("stage");
const statusEl = document.getElementById("status");
const captionEl = document.getElementById("caption");
const setState = (s, label) => { stage.className = "stage " + s; statusEl.textContent = label; };

const transcript = [];   // [{speaker, text}]
let convo = null, starting = false, captionTimer = null;
let pending = null;      // the utterance that woke Cora: {speaker, text, timer, sent}
let alreadySpoke = false; // Cora has spoken in this meeting (no second introduction)
let followUntil = 0;      // after Cora answers, her asker can follow up without saying "Cora" again
let idleTimer = null;
let voiceMuted = false;   // the SDK's speaker is muted because Simli is playing her voice     // close the session once Cora is done, so room talk never reaches her

function remember(speaker, text) {
  transcript.push({ speaker, text });
  while (transcript.length > 40) transcript.shift();
}
const recent = () => transcript.slice(-25).map((u) => `${u.speaker}: ${u.text}`).join("\n") || "(nothing yet)";

function showCaption(text) {
  captionEl.textContent = text;
  clearTimeout(captionTimer);
  captionTimer = setTimeout(() => (captionEl.textContent = ""), 9000);
}

// ---- Avatar. Everything comes from one photo drawn on a plain 2D canvas (no WebGL, no video, so it
// renders the same in Recall's headless bot): breathing (CSS), blinks every few seconds, and the jaw
// opened by the loudness of her voice, syllable by syllable.
const face = document.getElementById("face");
const mouth = (() => {
  const cv = document.getElementById("mouth");
  const ctx = cv.getContext("2d");
  const img = new Image();
  let loaded = false;
  img.onload = () => { loaded = true; };
  img.src = "cora-lobby.jpg?v=1";   // 1280x720, the full frame
  // Her Simli face was built from the square of this photo around her head: x 292.6, width 714.4, full height.
  const SQ_X = 292.6, SQ_W = 714.4, FEATHER = 36;
  // Eyes in the 1280x720 photo: centre x, half width, lash line y, opening height.
  const EYES = [{ cx: 585, hw: 27, lash: 227, h: 14 }, { cx: 703, hw: 31, lash: 226, h: 14 }];
  function draw(openPx, blink, live) {
    if (!loaded) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(img, 0, 0, 1280, 720);
    if (live && live.videoWidth) {
      ctx.drawImage(live, SQ_X, 0, SQ_W, 720);
      // Blend the square's left and right edges into the lobby photo.
      for (let i = 0; i < FEATHER; i += 2) {
        ctx.globalAlpha = 1 - i / FEATHER;
        ctx.drawImage(img, SQ_X + i, 0, 2, 720, SQ_X + i, 0, 2, 720);
        ctx.drawImage(img, SQ_X + SQ_W - 2 - i, 0, 2, 720, SQ_X + SQ_W - 2 - i, 0, 2, 720);
      }
      ctx.globalAlpha = 1;
      return;
    }
    if (blink > 0.02) {
      for (const e of EYES) {
        for (let x = e.cx - e.hw; x < e.cx + e.hw; x += 1) {
          const k = Math.max(0, 1 - ((x - e.cx) / e.hw) ** 2) ** 0.8;
          const drop = blink * e.h * k;
          if (drop < 0.3) continue;
          ctx.drawImage(img, x, e.lash - 9, 1, 10, x, e.lash - 9, 1, 10 + drop);   // eyelid down over the eye
        }
      }
    }
  }
  return { draw, overlay() {} };
})();

// ---- Simli: her photoreal, lip-synced face. Opened when she is woken (in parallel with her voice),
// fed her voice audio, and closed a few seconds after she finishes, since Simli bills per minute.
// If it isn't configured or fails, the photo face above carries on.
const simVideo = document.getElementById("sim"), simAudio = document.getElementById("simAudio");
const SIMLI_MODE = q.get("simlimode") || "livekit";
let simli = null, simliReady = false, simliStarting = null, simliOff = false, simliStopTimer = null;
const b64ToU8 = (b64) => { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
function simliStart() {
  clearTimeout(simliStopTimer);
  if (simliOff || !N) return Promise.resolve(false);
  if (simliReady) return Promise.resolve(true);
  if (simliStarting) return simliStarting;
  simliStarting = (async () => {
    try {
      const r = await fetch(`${FN}/simli-token`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: N, t: T }) });
      const d = await r.json();
      if (!d.session_token) { if (d.error === "simli_not_configured") simliOff = true; return false; }
      const c = new SimliClient(d.session_token, simVideo, simAudio, null, q.get("simlidebug") ? LogLevel.DEBUG : LogLevel.ERROR, SIMLI_MODE);
      const ok = await new Promise((res) => {
        c.on("start", () => res(true));
        c.on("startup_error", (m) => { console.warn("simli startup_error", m); res(false); });
        c.on("error", (m) => { console.warn("simli error", m); res(false); });
        c.start().catch(() => res(false));
        setTimeout(() => res(false), 9000);
      });
      if (!ok) { try { c.stop(); } catch {} return false; }
      c.on("stop", () => { if (simli === c) { simli = null; simliReady = false; } });
      c.sendAudioData(new Uint8Array(6000));   // primes the stream, as Simli's own samples do
      simli = c; simliReady = true;
      simVideo.play().catch(() => {});
      return true;
    } catch (e) { console.error("simli", e); return false; }
    finally { simliStarting = null; }
  })();
  return simliStarting;
}
function simliStopSoon(ms = 20000) {
  clearTimeout(simliStopTimer);
  simliStopTimer = setTimeout(() => { const c = simli; simli = null; simliReady = false; try { c?.stop(); } catch {} }, ms);
}
const simliLive = () => simliReady && simVideo.videoWidth > 0 && simVideo.readyState >= 2;

let ac = null, ttsAnalyser = null, ttsBuf = null;
function ttsLevel() {
  if (!ttsAnalyser) return 0;
  ttsAnalyser.getByteTimeDomainData(ttsBuf);
  let sum = 0; for (const b of ttsBuf) { const x = (b - 128) / 128; sum += x * x; }
  return Math.sqrt(sum / ttsBuf.length);
}
// Route a spoken <audio> through an analyser so the face can follow it. It still plays out loud.
function trackAudio(el) {
  try {
    ac = ac || new AudioContext();
    const src = ac.createMediaElementSource(el);
    ttsAnalyser = ac.createAnalyser(); ttsAnalyser.fftSize = 512; ttsAnalyser.smoothingTimeConstant = 0;
    ttsBuf = new Uint8Array(ttsAnalyser.fftSize);
    src.connect(ttsAnalyser); ttsAnalyser.connect(ac.destination);
    ac.resume?.();
  } catch (e) { ttsAnalyser = null; }
}
let lastVoice = -1e9, open = 0, lastLevelSeen = -1e9;
const talkV = document.getElementById("talk");
let talkOK = talkV.readyState >= 3, talkMix = 0, wasTalking = false;   // it may be ready before this module runs
talkV.addEventListener("canplay", () => { talkOK = true; }, { once: true });
talkV.addEventListener("error", () => { talkOK = false; });
let blink = 0, nextBlink = performance.now() + 2500, blinkStart = 0;
const MAX_OPEN = 9;   // px of jaw drop at full volume (fallback face only; Simli does the real lips)
function avatarTick() {
  const now = performance.now();
  let level = ttsLevel();
  try { if (convo) level = Math.max(level, convo.getOutputVolume?.() || 0); } catch {}
  if (level > 0.02) { lastVoice = now; lastLevelSeen = now; }
  const saying = stage.classList.contains("speaking");
  let target = Math.min(1, Math.max(0, (level - 0.015) * 6));
  // If she is speaking but no volume is reaching the page (live voice in some browsers), animate
  // syllables on a speech-like rhythm so the mouth still moves.
  if (saying && now - lastLevelSeen > 350) {
    const t = now / 1000;
    const syll = Math.abs(Math.sin(t * 2 * Math.PI * 2.3 + Math.sin(t * 1.3) * 1.8));
    target = 0.15 + 0.75 * syll * (0.7 + 0.3 * Math.sin(t * 5.1));
    lastVoice = now;
  }
  target *= 0.88 + 0.12 * Math.sin(now / 47);
  open += (target - open) * (target > open ? 0.5 : 0.22);
  // Blink: 140ms close-open every 2.5-6s, sometimes a double.
  if (now > nextBlink) { blinkStart = now; nextBlink = now + 2500 + Math.random() * 3500; if (Math.random() < .15) nextBlink = now + 320; }
  const bt = (now - blinkStart) / 140;
  blink = bt < 0 || bt > 1 ? 0 : Math.sin(Math.PI * bt);
  const talking = now - lastVoice < 900;
  const live = simliLive() ? simVideo : null;
  // Runway talking clip: restart from frame 0 (identical to the photo) when she starts talking, loop
  // while she talks, fade back to the photo when she stops.
  if (talkOK && !live) {
    if (talking && !wasTalking) { talkV.currentTime = 0; talkV.play().catch(() => {}); }
    talkMix += ((talking ? 1 : 0) - talkMix) * (talking ? 0.6 : 0.2);
    // Loop by hand: the clip's last frame isn't its first, so fade into the photo (= frame 0) over
    // the final 0.35s, then restart from 0.
    if (talking && talkV.duration && talkV.currentTime >= talkV.duration - 0.06) { talkV.currentTime = 0; talkV.play().catch(() => {}); }
    if (!talking && talkMix < 0.01 && !talkV.paused) talkV.pause();
  } else talkMix = 0;
  wasTalking = talking;
  const edge = talkV.duration ? Math.min(1, Math.max(0, (talkV.duration - talkV.currentTime) / 0.35)) : 1;
  const mix = talkMix * edge;
  const useTalk = talkOK && mix > 0.01 ? talkV : null;
  mouth.draw(0, blink, live);
  face.classList.toggle("talking", talking);
}
setInterval(avatarTick, 33);   // a timer, not rAF: the bot's headless browser may throttle rAF
// Local check of the Simli face: coraSimliTest("test-voice.pcm") (16kHz 16-bit mono PCM).
window.coraSimliTest = async (url) => {
  const ok = await simliStart(); if (!ok) return "simli failed";
  const pcm = new Uint8Array(await (await fetch(url)).arrayBuffer());
  setState("speaking", "Speaking");
  for (let i = 0; i < pcm.length; i += 6000) simli.sendAudioData(pcm.subarray(i, i + 6000));
  setTimeout(() => setState("", "Listening"), pcm.length / 32 + 500);
  return "sent " + pcm.length;
};
// Local check: coraPlay("some.wav") plays a file through the face.
window.coraPlay = async (url) => {
  const audio = new Audio(url); trackAudio(audio); setState("speaking", "Speaking");
  await new Promise((done) => { audio.onended = done; audio.onerror = done; audio.play().catch(done); });
  setState("", "Listening");
};
// Preview without a meeting: ?demo=1 plays a line so the face can be checked.
window.coraDemo = async (text = "Hi everyone, I'm Cora, ForgeX's AI GTM analyst and chief of staff. Great to be co-hosting with Davis today.") => {
  const a = await fetch(`${FN}/tts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ meeting_key: `${N}.${T}`, text }) });
  if (!a.ok) return console.warn("tts", a.status);
  const audio = new Audio(URL.createObjectURL(await a.blob()));
  trackAudio(audio); setState("speaking", "Speaking"); showCaption(text);
  await new Promise((done) => { audio.onended = done; audio.onerror = done; audio.play().catch(done); });
  setState("", "Listening");
};

// Speed: connect the moment we hear "Cora" (even mid-sentence), with the mic muted. When the speaker
// finishes, hand over the full question as text and unmute for follow-ups. Avoids a double answer
// from the voice channel and saves the connection time.
async function connect(speaker) {
  if (convo || starting) return;
  starting = true;
  setState("thinking", "Listening");
  simliStart();
  try {
    const r = await fetch(`${FN}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: N, t: T }) });
    const { signed_url, internal, room } = await r.json();
    if (!signed_url) throw new Error("no session");
    convo = await Conversation.startSession({
      signedUrl: signed_url,
      libsampleratePath: "./libsamplerate-2.1.2.worklet.js",   // local copy; the SDK would otherwise fetch it from jsdelivr
      dynamicVariables: { meeting_title: TITLE, asked_by: speaker || "someone", recent_transcript: recent(), meeting_key: `${N}.${T}`, meeting_internal: internal ? "yes" : "no (outsiders may be present)", meeting_room: room || "Unknown room: assume outsiders may be present.", already_spoke: alreadySpoke ? "yes" : "no" },
      // The mic stays muted for the whole session: Cora only hears what is addressed to her, as text.
      // An open mic fed the whole room to her as one endless turn, so she never got to finish a task.
      onModeChange: ({ mode }) => {
        setState(mode === "speaking" ? "speaking" : "", mode === "speaking" ? "Speaking" : "Listening");
        if (mode === "speaking") alreadySpoke = true;
        if (mode === "listening" && pending?.sent) followUntil = Date.now() + 12000;
        touch();
      },
      // Her voice goes to Simli (which plays it with synced lips); the SDK's own playback is muted
      // while Simli is up, so she is never heard twice.
      onAudio: (b64) => {
        if (simliReady) { simli.sendAudioData(b64ToU8(b64)); if (!voiceMuted) { convo?.setVolume({ volume: 0 }); voiceMuted = true; } }
        else if (voiceMuted) { convo?.setVolume({ volume: 1 }); voiceMuted = false; }
      },
      onMessage: ({ source, message }) => { if (source === "ai" && message) { showCaption(message); remember("Cora", message); } touch(); },
      onDisconnect: () => { convo = null; pending = null; voiceMuted = false; clearTimeout(idleTimer); setState("", "Listening"); simliStopSoon(); },
      onError: () => { convo = null; pending = null; voiceMuted = false; clearTimeout(idleTimer); setState("", "Listening"); simliStopSoon(); },
    });
    convo.setMicMuted(true);
    if (simliReady) { convo.setVolume({ volume: 0 }); voiceMuted = true; }
    if (pending?.ready) send();
  } catch (e) {
    console.error(e);
    convo = null;
    setState("", "Listening");
    simliStopSoon(1000);
  } finally {
    starting = false;
  }
}

function send() {
  if (!pending || pending.sent || !convo) return;
  pending.sent = true;
  setState("thinking", "Thinking");
  convo.sendUserMessage(`${pending.speaker || "Someone"} said: "${pending.text}"`);
  touch();
}

// End the session after 30s with nothing from Cora and nobody talking to her. Tool calls keep it
// alive (each agent message resets the clock), and saying "Cora" opens a fresh one.
function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (convo) { try { convo.endSession(); } catch {} } }, 30000);
}

// The utterance is done when the transcript says it is final, or when it stops changing for 700ms.
function settle() {
  if (!pending) return;
  pending.ready = true;
  remember(pending.speaker || "Someone", pending.text);
  send();
}

let heard = function (speaker, text, final) {
  const waking = WAKE.test(text);
  // Session already open: pass along only what's addressed to Cora (her name, or her asker
  // following up right after she answered). Everything else in the room stays out.
  if (convo && pending?.sent) {
    if (final && (waking || (Date.now() < followUntil && speaker === pending.speaker))) {
      remember(speaker || "Someone", text);
      convo.sendUserMessage(`${speaker || "Someone"} said: "${text}"`);
      followUntil = 0;
      touch();
    } else if (final) remember(speaker || "Someone", text);
    return;
  }
  if (waking && !pending && !convo) pending = { speaker, text, sent: false, ready: false };
  if (pending && !pending.ready && (speaker === pending.speaker || !speaker)) {
    pending.text = text;
    clearTimeout(pending.timer);
    if (final) settle();
    else pending.timer = setTimeout(settle, 700);
  } else if (final) remember(speaker || "Someone", text);
  if (waking) connect(speaker);
}

function words(msg) {
  const d = msg?.transcript ?? msg?.data?.data ?? msg?.data ?? msg;
  const w = d?.words ?? [];
  const speaker = d?.speaker ?? d?.participant?.name ?? "";
  const isHost = d?.participant?.is_host === true;
  const zoomId = d?.participant?.extra_data?.zoom?.conf_user_id ?? "";
  const ev = String(msg?.event ?? "");
  const final = d?.is_final === false || /partial/.test(ev) ? false : true;
  return { text: w.map((x) => x.text).join(" ").trim(), speaker, final, isHost, zoomId };
}

function connectTranscript() {
  const ws = new WebSocket("wss://meeting-data.bot.recall.ai/api/v1/transcript");
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    const { text, speaker, final, isHost, zoomId } = words(msg);
    if (!text || SELF.test(speaker)) return;
    // Tell the server who is addressing Cora (host flag and Zoom account id), so actions on Davis's behalf only follow Davis.
    if (final && WAKE.test(text)) {
      fetch(`${FN}/heard`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ meeting_key: `${N}.${T}`, speaker, is_host: isHost, zoom_id: zoomId, text }) }).catch(() => {});
    }
    heard(speaker, text, final);
  };
  ws.onclose = () => setTimeout(connectTranscript, 1500);
}

// Results Cora's team finishes during the call come back as a "say" queue. Speak each one at a
// natural pause (nobody talking for 1.5s), never over a live conversation with Cora.
let lastHeard = Date.now(), speakingOut = false;
const _heard = heard;
heard = (speaker, text, final) => { lastHeard = Date.now(); _heard(speaker, text, final); };
async function sayLoop() {
  try {
    if (!convo && !starting && !speakingOut && Date.now() - lastHeard > 1500) {
      const r = await fetch(`${FN}/say-next`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ meeting_key: `${N}.${T}` }) });
      const { say } = await r.json();
      if (say) {
        speakingOut = true;
        const viaSimli = await simliStart();
        const a = await fetch(`${FN}/tts`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ meeting_key: `${N}.${T}`, text: say, pcm: viaSimli }) });
        if (a.ok && viaSimli && simliReady) {
          // 16kHz 16-bit PCM straight into her Simli face, which plays it with synced lips.
          const pcm = new Uint8Array(await a.arrayBuffer());
          setState("speaking", "Speaking");
          showCaption(say);
          remember("Cora", say);
          for (let i = 0; i < pcm.length; i += 6000) simli.sendAudioData(pcm.subarray(i, i + 6000));
          await new Promise((done) => setTimeout(done, pcm.length / 32 + 700));
          simliStopSoon();
        } else if (a.ok && !viaSimli) {
          const audio = new Audio(URL.createObjectURL(await a.blob()));
          trackAudio(audio);
          setState("speaking", "Speaking");
          showCaption(say);
          remember("Cora", say);
          await new Promise((done) => { audio.onended = done; audio.onerror = done; audio.play().catch(done); });
        }
        speakingOut = false;
        setState("", "Listening");
      }
    }
  } catch (e) { speakingOut = false; }
  setTimeout(sayLoop, 2500);
}

if (!N || !T) setState("", "Not connected");
else { setState("", "Listening"); connectTranscript(); sayLoop(); }
