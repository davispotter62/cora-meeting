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
// When her voice session won't start (e.g. ElevenLabs out of credits), back off instead of retrying on
// every partial transcript, and tell Davis privately once every 10 minutes so she never just goes silent.
let voiceDownUntil = 0, lastVoiceNote = 0;
function voiceDown(text) {
  voiceDownUntil = Date.now() + 60000;
  if (Date.now() - lastVoiceNote < 600000) return;
  lastVoiceNote = Date.now();
  fetch(`${FN}/voice-down`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ meeting_key: `${N}.${T}`, text: text || "" }) }).catch(() => {});
}
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
// face=trinity: her Trinity-2 Simli face fills the frame. Default (legacy): the old lobby
// photo with the Simli square inside it. always=1 keeps the face live (idle motion) all meeting.
const FULL_FACE = q.get("face") === "trinity";
const FACE_ALWAYS = q.get("always") === "1";
const mouth = (() => {
  const cv = document.getElementById("mouth");
  const ctx = cv.getContext("2d");
  const img = new Image();
  let loaded = false;
  img.onload = () => { loaded = true; };
  img.src = FULL_FACE ? "cora-studio.jpg?v=1" : "cora-lobby.jpg?v=1";   // 1280x720, the full frame
  // Her Simli face was built from the square of this photo around her head: x 292.6, width 714.4, full height.
  const SQ_X = 292.6, SQ_W = 714.4, FEATHER = 36;
  // Eyes in the 1280x720 photo: centre x, half width, lash line y, opening height.
  const EYES = [{ cx: 585, hw: 27, lash: 227, h: 14 }, { cx: 703, hw: 31, lash: 226, h: 14 }];
  // Trinity faces stream the whole framed portrait, so they fill the frame (cover). The last live
  // frame stays up between answers, so the still and the moving face never jump.
  const still = document.createElement("canvas"); still.width = 1280; still.height = 720;
  const sctx = still.getContext("2d"); let haveStill = false;
  // Fit the whole video in the frame (no zoom-in crop); the side gaps are filled by stretching the
  // video's own left and right edge columns, which on a plain studio background reads as more wall.
  function cover(c, src, w, h) {
    const s = Math.min(1280 / w, 720 / h), dw = w * s, dh = h * s, x = (1280 - dw) / 2, y = (720 - dh) / 2;
    if (x > 1) {
      c.drawImage(src, 0, 0, 2, h, 0, y, x + 1, dh);
      c.drawImage(src, w - 2, 0, 2, h, x + dw - 1, y, x + 1, dh);
    }
    if (y > 1) {
      c.drawImage(src, 0, 0, w, 2, 0, 0, 1280, y + 1);
      c.drawImage(src, 0, h - 2, w, 2, 0, y + dh - 1, 1280, y + 1);
    }
    c.drawImage(src, x, y, dw, dh);
  }
  function draw(openPx, blink, live) {
    if (!loaded) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    if (FULL_FACE) {
      if (live && live.videoWidth) { cover(ctx, live, live.videoWidth, live.videoHeight); cover(sctx, live, live.videoWidth, live.videoHeight); haveStill = true; }
      else if (haveStill) ctx.drawImage(still, 0, 0);
      else cover(ctx, img, img.naturalWidth || 1280, img.naturalHeight || 720);
      return;
    }
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
      c.on("stop", () => { if (simli === c) { simli = null; simliReady = false; if (FACE_ALWAYS) setTimeout(() => simliStart(), 1500); } });
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
  if (FACE_ALWAYS) return;   // stays live; it is restarted below whenever Simli ends the session
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
  if (convo || starting || Date.now() < voiceDownUntil) return;
  starting = true;
  let live = false;   // the agent has actually done something in this session
  const failed = () => { if (!live) voiceDown(pending?.text); };
  setState("thinking", "Listening");
  simliStart();
  try {
    const r = await fetch(`${FN}/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ n: N, t: T, speaker: speaker || "", zoom_id: lastZoomId }) });
    const { signed_url, internal, room, person_history } = await r.json();
    if (!signed_url) throw new Error("no session");
    convo = await Conversation.startSession({
      signedUrl: signed_url,
      libsampleratePath: "./libsamplerate-2.1.2.worklet.js",   // local copy; the SDK would otherwise fetch it from jsdelivr
      dynamicVariables: { meeting_title: TITLE, asked_by: speaker || "someone", recent_transcript: recent(), meeting_key: `${N}.${T}`, meeting_internal: internal ? "yes" : "no (outsiders may be present)", meeting_room: room || "Unknown room: assume outsiders may be present.", already_spoke: alreadySpoke ? "yes" : "no", person_history: person_history || "(none)" },
      // The mic stays muted for the whole session: Cora only hears what is addressed to her, as text.
      // An open mic fed the whole room to her as one endless turn, so she never got to finish a task.
      onModeChange: ({ mode }) => {
        if (dropOld && mode === "listening") endDrop();   // the cut-off answer has finished streaming
        if (dropOld) return;
        setState(mode === "speaking" ? "speaking" : "", mode === "speaking" ? "Speaking" : "Listening");
        live = true;
        if (mode === "speaking") alreadySpoke = true;
        if (mode === "listening" && pending?.sent) followUntil = Date.now() + 12000;
        touch();
      },
      // Her voice goes to Simli (which plays it with synced lips); the SDK's own playback is muted
      // while Simli is up, so she is never heard twice.
      onAudio: (b64) => {
        if (dropOld) return;   // the rest of an answer she was cut off from
        lastAudioAt = Date.now();
        if (simliReady) { simli.sendAudioData(b64ToU8(b64)); if (!voiceMuted) { convo?.setVolume({ volume: 0 }); voiceMuted = true; } }
        else if (voiceMuted) { convo?.setVolume({ volume: 1 }); voiceMuted = false; }
      },
      onInterruption: () => { try { simli?.ClearBuffer(); } catch {} endDrop(); },
      onMessage: ({ source, message }) => { live = true; if (source === "ai" && message) { showCaption(message); remember("Cora", message); said("cora", message); } touch(); },
      onDisconnect: () => { failed(); convo = null; pending = null; voiceMuted = false; clearTimeout(idleTimer); setState("", "Listening"); simliStopSoon(); },
      onError: () => { failed(); convo = null; pending = null; voiceMuted = false; clearTimeout(idleTimer); setState("", "Listening"); simliStopSoon(); },
    });
    // Connected = her voice service is up. A session that connects and then ends quietly (she skipped
    // her turn because she was told to stop, or nobody followed up) is not a failure (Nov 12 2026).
    live = true;
    convo.setMicMuted(true);
    if (simliReady) { convo.setVolume({ volume: 0 }); voiceMuted = true; }
    if (pending?.ready) send();
  } catch (e) {
    console.error(e);
    failed();
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

// One Cora memory: what Cora says, and follow-ups to her, join the asker's history on the server
// (which decides who the asker is; the page only reports the words).
function said(role, text) {
  fetch(`${FN}/said`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ meeting_key: `${N}.${T}`, role, text }) }).catch(() => {});
}
let lastZoomId = "";

// "Cora, stop" cuts her off on the spot (Nov 12 2026). Handled here, not by the agent: by the time the
// agent hears it, seconds of her answer are already queued in the face. Only short commands count, so a
// question like "Cora, how do we stop chasing MQLs?" still goes through to her.
const STOP_HARD = /\b(stop talking|stop|that'?s enough|enough|hold on|hold up|be quiet|quiet|shush|hush|zip it|cut it)\b/;
const STOP_SOFT = /^(thanks|thank you|thanks so much|thank you so much|that'?s (good|great|perfect|it|fine|plenty)|got it|perfect|great|nice|awesome|love it)$/;
const STOP_FILLER = new Set(["thanks", "thank", "you", "talking", "please", "there", "it", "a", "sec", "second", "minute", "moment", "for", "can", "go", "ahead", "and", "just", "right", "i", "think", "we're", "were", "good", "that's", "thats"]);
function isStop(text, speakingNow) {
  const t = text.toLowerCase().replace(/[^a-z' ]/g, " ").replace(/\s+/g, " ").trim();
  const core = t.replace(new RegExp(WAKE.source, "gi"), " ").replace(/\b(hey|hi|ok|okay|please|you can|now|alright|all right|so)\b/g, " ").replace(/\s+/g, " ").trim();
  // Hard stop: a stop phrase plus nothing but filler ("Cora, stop", "hey Cora thanks you can stop talking").
  const rest = core.replace(new RegExp(STOP_HARD.source, "g"), " ").trim().split(/\s+/).filter(Boolean);
  const hard = STOP_HARD.test(core) && rest.every((w) => STOP_FILLER.has(w));
  if (WAKE.test(text)) return hard || (speakingNow && STOP_SOFT.test(core));
  return speakingNow && hard && t.split(" ").length <= 4;   // a bare "stop" counts only while she is talking
}
let stoppedAt = 0, outAudio = null;
// Cutting her off never ends the conversation (Nov 12 2026, Davis: "never make her go mute"). Her face's
// queued audio is cleared and the rest of that answer is dropped, but the session stays open so she
// acknowledges in a few words and answers whatever comes next, like a person who got interrupted.
let dropOld = false, dropTimer = null;
function endDrop() {
  dropOld = false; clearTimeout(dropTimer);
  if (convo && !simliReady) { try { convo.setVolume({ volume: 1 }); } catch {} }
}
function cutVoice() {
  try { simli?.ClearBuffer(); } catch {}
  try { outAudio?.pause(); } catch {}
  clearTimeout(captionTimer); captionEl.textContent = "";
  if (convo) {
    dropOld = true; clearTimeout(dropTimer); dropTimer = setTimeout(endDrop, 20000);
    try { convo.setVolume({ volume: 0 }); } catch {}
  }
  setState(convo ? "thinking" : "", "Listening");
}
const isSpeaking = () => speakingOut || stage.className.includes("speaking") || Date.now() - lastAudioAt < 6000;

let heard = function (speaker, text, final) {
  if (isStop(text, isSpeaking())) {
    if (Date.now() - stoppedAt > 1500) { stoppedAt = Date.now(); cutVoice(); }   // cut on the partial, fast
    if (!final) return;
    remember(speaker || "Someone", text);
    if (convo) {
      pending = { speaker, text, sent: true, ready: true };
      convo.sendUserMessage(`${speaker || "Someone"} cut you off: "${text}". Drop that answer. Acknowledge in two to four words, then wait for them.`);
      followUntil = Date.now() + 20000;   // they can carry on without saying "Cora" again
      touch();
    }
    return;
  }
  const waking = WAKE.test(text);
  // Session already open: pass along only what's addressed to Cora (her name, or her asker
  // following up right after she answered). Everything else in the room stays out.
  if (convo && pending?.sent) {
    if (final && (waking || (Date.now() < followUntil && speaker === pending.speaker))) {
      remember(speaker || "Someone", text);
      if (!waking) said("person", text); // wake lines are already logged by /heard
      if (isSpeaking()) cutVoice();   // talking over her: she stops and takes the new question
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
    if (WAKE.test(text)) lastZoomId = zoomId || "";
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
          trackAudio(audio); outAudio = audio;
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

// Always-on face: open Simli as soon as the page loads, and reopen it if it drops.
if (FACE_ALWAYS) { setTimeout(() => simliStart(), 1500); setInterval(() => { if (!simliReady && !simliStarting) simliStart(); }, 20000); }
