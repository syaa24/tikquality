const worker = new Worker("/worker.js");

const pyStatus = document.getElementById("pyStatus");
const videoInput = document.getElementById("videoInput");
const multiplierInput = document.getElementById("multiplierInput");
const commentInput = document.getElementById("commentInput");
const transformBtn = document.getElementById("transformBtn");
const inspectOnlyBtn = document.getElementById("inspectOnlyBtn");
const downloadBtn = document.getElementById("downloadBtn");
const consoleLog = document.getElementById("consoleLog");
const verifyResult = document.getElementById("verifyResult");

let pyReady = false;
let currentDownloadUrl = null;

// Tabs
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.remove("border-cyan-400", "text-cyan-300");
      b.classList.add("border-transparent", "text-slate-400");
    });
    btn.classList.add("border-cyan-400", "text-cyan-300");
    btn.classList.remove("border-transparent", "text-slate-400");

    ["enhancer", "checker", "compare"].forEach((t) => {
      document.getElementById(`tab-${t}`).classList.toggle("hidden", btn.dataset.tab !== t);
    });
  });
});

function updateButtons() {
  const hasFile = videoInput.files.length > 0;
  transformBtn.disabled = !(pyReady && hasFile);
  inspectOnlyBtn.disabled = !(pyReady && hasFile);
}

videoInput.addEventListener("change", updateButtons);

worker.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "status") {
    pyStatus.textContent = msg.message;
  } else if (msg.type === "ready") {
    pyReady = true;
    pyStatus.textContent = "Python Ready (100% Native Logic)";
    pyStatus.className =
      "text-xs px-3 py-1.5 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 w-fit";
    updateButtons();
  } else if (msg.type === "error") {
    pyStatus.textContent = "Error";
    consoleLog.textContent = (msg.logs || "") + "\n[!] ERROR: " + msg.error;
    transformBtn.disabled = false;
  } else if (msg.type === "done") {
    pyStatus.textContent = "Selesai!";
    consoleLog.textContent = msg.logs;

    if (currentDownloadUrl) URL.revokeObjectURL(currentDownloadUrl);
    const blob = new Blob([msg.outputBuffer], { type: "video/mp4" });
    currentDownloadUrl = URL.createObjectURL(blob);

    const origName = videoInput.files[0]?.name || "video.mp4";
    const outName = origName.replace(/\.mp4$/i, "") + "_1080p60.mp4";
    downloadBtn.href = currentDownloadUrl;
    downloadBtn.download = outName;
    downloadBtn.classList.remove("hidden");

    renderCompareVerify(msg.before, msg.after);
    updateButtons();
  } else if (msg.type === "inspected") {
    renderSingleVerify(msg.info);
    updateButtons();
  }
};

transformBtn.addEventListener("click", async () => {
  const file = videoInput.files[0];
  if (!file) return;
  downloadBtn.classList.add("hidden");
  transformBtn.disabled = true;
  consoleLog.textContent = `[*] Membaca ${file.name} (${file.size.toLocaleString()} bytes)...`;

  const buffer = await file.arrayBuffer();
  worker.postMessage(
    {
      type: "transform",
      data: {
        buffer,
        multiplier: parseInt(multiplierInput.value, 10) || 10,
        comment: commentInput.value || "TK8vY5VqBA6hUlo1yuGvNA",
      },
    },
    [buffer]
  );
});

inspectOnlyBtn.addEventListener("click", async () => {
  const file = videoInput.files[0];
  if (!file) return;
  const buffer = await file.arrayBuffer();
  worker.postMessage({ type: "inspect", data: { buffer } }, [buffer]);
});

function infoCard(title, info, accentClass) {
  return `
    <div class="bg-slate-900 border border-slate-800 rounded-xl p-4 space-y-2 text-xs">
      <div class="font-semibold text-sm ${accentClass}">${title}</div>
      <div class="grid grid-cols-2 gap-y-1.5 text-slate-300 font-mono">
        <span class="text-slate-400">Brand:</span><span>${info.brand}</span>
        <span class="text-slate-400">Fast-Start (moov<mdat):</span><span>${info.fast_start ? "Yes" : "No"}</span>
        <span class="text-slate-400">Resolusi:</span><span>${info.resolution}</span>
        <span class="text-slate-400">FPS / Durasi:</span><span>${info.fps} fps • ${info.duration_sec}s</span>
        <span class="text-slate-400">Real / Ghost Frames:</span><span>${info.real_frames} / +${info.ghost_frames}</span>
        <span class="text-slate-400">Declared Frames:</span><span class="text-cyan-300 font-bold">${info.declared_frames}</span>
        <span class="text-slate-400">Bitrate / Size:</span><span>${info.bitrate_mbps} Mbps • ${info.size_mb} MB</span>
        <span class="text-slate-400">avcC High Ext:</span><span>${info.avcc_high_ext ? "Yes" : "No"}</span>
        <span class="text-slate-400">Audio Handler:</span><span>${info.audio_handler}</span>
        <span class="text-slate-400">Padding NAL:</span><span>${info.has_padding_nal ? "Present (8B)" : "No"}</span>
        <span class="text-slate-400">Comment Tag:</span><span class="truncate">${info.comment}</span>
      </div>
    </div>`;
}

function renderCompareVerify(before, after) {
  verifyResult.classList.remove("hidden");
  verifyResult.innerHTML =
    infoCard("Sebelum Transform (Input)", before, "text-slate-300") +
    infoCard("Sesudah Transform (Siap Upload)", after, "text-emerald-400");
}

function renderSingleVerify(info) {
  verifyResult.classList.remove("hidden");
  verifyResult.innerHTML = infoCard("Hasil Inspeksi MP4", info, "text-cyan-400");
}

// TikTok URL Checker
document.getElementById("checkUrlBtn").addEventListener("click", async () => {
  const url = document.getElementById("tiktokUrlInput").value.trim();
  const card = document.getElementById("tiktokAnalyticsCard");
  if (!url) return;

  card.classList.remove("hidden");
  card.innerHTML = `<div class="text-cyan-300">Mengambil analytics dari TikTok...</div>`;

  try {
    const res = await fetch(`/.netlify/functions/tiktok-check?url=${encodeURIComponent(url)}`);
    const json = await res.json();
    if (!json.ok) {
      card.innerHTML = `<div class="text-rose-400">[!] ${json.error}</div>`;
      return;
    }

    const d = json.data;
    const dateStr = d.createTime
      ? new Date(d.createTime * 1000).toUTCString().replace("GMT", "")
      : "-";

    card.innerHTML = `
      <div class="text-sky-400 font-bold">📹 VIDEO • ANALYTICS</div>
      <div class="text-slate-300 text-xs">@${d.author.uniqueId} (${d.author.nickname}) • 📅 ${dateStr}</div>
      <div class="text-sky-300">🎵 Sound • ${d.sound.title} (${d.sound.duration}s)</div>

      <div class="space-y-1">
        <div class="font-bold text-white">📊 Statistics</div>
        <div>• 👁 ${Number(d.statistics.views).toLocaleString()} Views</div>
        <div>• ❤️ ${Number(d.statistics.likes).toLocaleString()} Likes</div>
        <div>• 💬 ${Number(d.statistics.comments).toLocaleString()} Comments</div>
        <div>• 🔖 ${Number(d.statistics.favorites).toLocaleString()} Favorites</div>
        <div>• ↪️ ${Number(d.statistics.shares).toLocaleString()} Shares</div>
        <div>• ⬇️ ${Number(d.statistics.downloads).toLocaleString()} Downloads</div>
      </div>

      <div class="space-y-1">
        <div class="font-bold text-white">ℹ️ Information</div>
        <div>• ID | <span class="text-sky-400">${d.information.id}</span></div>
        <div>• Source | <span class="text-sky-400">${d.information.source}</span></div>
        <div>• Region | <span class="text-sky-400">${d.information.region}</span></div>
        <div>• Shadow ban | <span class="text-amber-300">${d.information.shadowBan}</span></div>
      </div>

      <div class="space-y-1">
        <div class="font-bold text-white">⭐ Quality</div>
        <div class="bg-slate-900/80 border border-slate-700 rounded-lg p-3 space-y-1">
          <div class="text-sky-400">🌐 📱 ${d.quality.gearName}</div>
          <div>${d.quality.resolution}${d.quality.fps ? `p${d.quality.fps}` : ""} • ${d.quality.bitrateMbps || "?"} MBps • ${d.quality.codec} • ${d.quality.sizeMb || "?"} MB</div>
        </div>
        <div>| Original | <span class="text-sky-400">${d.quality.resolution}</span></div>
        <div>| VQ Score | <span class="text-amber-300">${d.quality.vqScore}</span></div>
      </div>

      ${d.categories.length ? `<div><div class="font-bold text-white">🏷 Categories</div>${d.categories.map(c => `<div>| <span class="text-sky-400">${c}</span></div>`).join("")}</div>` : ""}

      <div class="text-[11px] text-slate-400 pt-2 border-t border-slate-700">${d.note}</div>
    `;
  } catch (err) {
    card.innerHTML = `<div class="text-rose-400">[!] Error: ${err.message}</div>`;
  }
});

// Byte Compare
document.getElementById("compareBtn").addEventListener("click", async () => {
  const f1 = document.getElementById("cmpFile1").files[0];
  const f2 = document.getElementById("cmpFile2").files[0];
  const out = document.getElementById("compareResult");
  if (!f1 || !f2) return;

  const [b1, b2] = await Promise.all([f1.arrayBuffer(), f2.arrayBuffer()]);
  const a = new Uint8Array(b1);
  const b = new Uint8Array(b2);

  if (a.length !== b.length) {
    out.innerHTML = `<span class="text-rose-400">[-] Ukuran berbeda: ${a.length.toLocaleString()} vs ${b.length.toLocaleString()} bytes</span>`;
    return;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      out.innerHTML = `<span class="text-rose-400">[-] Berbeda pertama kali di byte ke-${i}</span>`;
      return;
    }
  }
  out.innerHTML = `<span class="text-emerald-400">[+] PERFECT MATCH — 100% byte-for-byte identical (${a.length.toLocaleString()} bytes)!</span>`;
});