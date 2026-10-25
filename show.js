const FN = "https://cbtbnjbdcdqmvlolzdlt.supabase.co/functions/v1/cora-voice";
const q = new URLSearchParams(location.search);
const KEY = `${q.get("n")}.${q.get("t")}`;
const view = document.getElementById("view");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = (d) => d ? new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "No date";
document.getElementById("when").textContent = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
let last = "";

// Only https pages on ForgeX's own sites go in the frame. Anything else (javascript:, data:, other
// hosts) shows as a card instead, whatever the server sends.
const FRAME_HOSTS = ["forgex.ai", "futurexgtm.com"];
function safeFrameUrl(raw) {
  let u;
  try { u = new URL(String(raw ?? "")); } catch { return null; }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  return FRAME_HOSTS.some((h) => host === h || host.endsWith("." + h)) ? u.href : null;
}

function render(d) {
  if (!d) { view.innerHTML = '<div class="idle">Nothing on screen right now.</div>'; return; }
  if (d.kind === "webpage") {
    const url = safeFrameUrl(d.url);
    if (!url) { view.innerHTML = `<h1>${esc(d.title)}</h1><div class="idle">That page can't be shown here.</div>`; return; }
    view.innerHTML = `<h1>${esc(d.title)}</h1>`;
    const frame = document.createElement("iframe");
    frame.referrerPolicy = "no-referrer";
    frame.src = url;
    view.appendChild(frame);
  } else if (d.kind === "program") {
    const today = new Date().toISOString().slice(0, 10);
    view.innerHTML = `<h1>${esc(d.title)}</h1><div class="timeline">` +
      (d.tasks || []).slice(0, 9).map((t) => `<div class="row ${t.due && t.due < today ? "late" : ""}">
        <span class="due">${fmt(t.due)}</span><span>${esc(t.task)}</span>
        <span class="owner">${esc(t.owner || "")}</span><span class="stage">${esc(t.stage || "")}</span></div>`).join("") + "</div>";
  } else {
    view.innerHTML = `<h1>${esc(d.title)}</h1><ul class="bullets">` + (d.bullets || []).map((b) => `<li>${esc(b)}</li>`).join("") + "</ul>";
  }
}

async function poll() {
  try {
    const r = await fetch(`${FN}/display`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ meeting_key: KEY }) });
    const { display } = await r.json();
    const s = JSON.stringify(display);
    if (s !== last) { last = s; render(display); }
  } catch {}
  setTimeout(poll, 1500);
}
poll();
