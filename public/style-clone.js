(() => {
  // === FIX TAB SWITCHING OTOMATIS UNTUK SEMUA TAB ===
  const tabBtns = document.querySelectorAll('.tab-btn');

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      tabBtns.forEach((b) => {
        const active = b.dataset.tab === target;
        b.classList.toggle('border-cyan-400', active);
        b.classList.toggle('text-cyan-300', active);
        b.classList.toggle('border-transparent', !active);
        b.classList.toggle('text-slate-400', !active);
      });
      document.querySelectorAll('section[id^="tab-"]').forEach((sec) => {
        sec.classList.toggle('hidden', sec.id !== `tab-${target}`);
      });
    });
  });

  // === COLOR & RATIO CLONE LOGIC ===
  const refInput = document.getElementById('refVideoInput');
  const targetInput = document.getElementById('targetVideoInput');
  const refInfo = document.getElementById('refInfo');
  const targetInfo = document.getElementById('targetInfo');
  const ratioModeSelect = document.getElementById('ratioModeSelect');
  const lutStrengthInput = document.getElementById('lutStrengthInput');
  const lutStrengthVal = document.getElementById('lutStrengthVal');
  const sharpenSelect = document.getElementById('sharpenSelect');
  const cloneRunBtn = document.getElementById('cloneRunBtn');
  const cloneDownloadBtn = document.getElementById('cloneDownloadBtn');
  const sendToEnhancerBtn = document.getElementById('sendToEnhancerBtn');
  const clonePreviewBox = document.getElementById('clonePreviewBox');
  const refPreviewVideo = document.getElementById('refPreviewVideo');
  const cloneOutputVideo = document.getElementById('cloneOutputVideo');
  const cloneLog = document.getElementById('cloneLog');
  const ffmpegStatus = document.getElementById('ffmpegStatus');

  let refMeta = null;
  let targetMeta = null;
  let lastClonedFile = null;
  let cloneWorker = null;

  function log(msg) {
    cloneLog.textContent += `\n${msg}`;
    cloneLog.scrollTop = cloneLog.scrollHeight;
  }

  function resetLog(msg) {
    cloneLog.textContent = msg;
  }

  function gcd(a, b) {
    return b === 0 ? a : gcd(b, a % b);
  }

  async function inspectVideoMeta(file) {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.src = url;
    await new Promise((resolve, reject) => {
      v.onloadedmetadata = resolve;
      v.onerror = () => reject(new Error('Gagal membaca metadata video.'));
    });
    const w = v.videoWidth;
    const h = v.videoHeight;
    const dur = v.duration;
    const d = gcd(w, h) || 1;
    URL.revokeObjectURL(url);
    return { width: w, height: h, duration: dur, ratioText: `${w / d}:${h / d}` };
  }

  async function sampleVideoPixels(file, sampleCount = 5) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    await new Promise((res) => (video.onloadedmetadata = res));

    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const pixels = [];
    const dur = video.duration || 1;
    for (let i = 1; i <= sampleCount; i++) {
      video.currentTime = (dur * i) / (sampleCount + 1);
      await new Promise((res) => (video.onseeked = res));
      ctx.drawImage(video, 0, 0, 128, 128);
      const data = ctx.getImageData(0, 0, 128, 128).data;
      for (let p = 0; p < data.length; p += 4) {
        pixels.push([data[p], data[p + 1], data[p + 2]]);
      }
    }
    URL.revokeObjectURL(url);
    return pixels;
  }

  function buildHistogramMap(srcPixels, refPixels, ch) {
    const srcHist = new Uint32Array(256);
    const refHist = new Uint32Array(256);
    for (let i = 0; i < srcPixels.length; i++) srcHist[srcPixels[i][ch]]++;
    for (let i = 0; i < refPixels.length; i++) refHist[refPixels[i][ch]]++;

    const srcCdf = new Float64Array(256);
    const refCdf = new Float64Array(256);
    let sAcc = 0;
    let rAcc = 0;
    for (let i = 0; i < 256; i++) {
      sAcc += srcHist[i];
      rAcc += refHist[i];
      srcCdf[i] = sAcc / srcPixels.length;
      refCdf[i] = rAcc / refPixels.length;
    }

    const map = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      let best = 0;
      let minDiff = 999;
      for (let j = 0; j < 256; j++) {
        const diff = Math.abs(srcCdf[i] - refCdf[j]);
        if (diff < minDiff) {
          minDiff = diff;
          best = j;
        }
      }
      map[i] = best;
    }
    return map;
  }

  function generateCubeLUT(srcPixels, refPixels, strength = 0.85, size = 17) {
    const mapR = buildHistogramMap(srcPixels, refPixels, 0);
    const mapG = buildHistogramMap(srcPixels, refPixels, 1);
    const mapB = buildHistogramMap(srcPixels, refPixels, 2);

    const lines = [`TITLE "TikQuality Color Clone"`, `LUT_3D_SIZE ${size}`];
    for (let b = 0; b < size; b++) {
      const bv = Math.round((b / (size - 1)) * 255);
      const outB = (bv * (1 - strength) + mapB[bv] * strength) / 255;
      for (let g = 0; g < size; g++) {
        const gv = Math.round((g / (size - 1)) * 255);
        const outG = (gv * (1 - strength) + mapG[gv] * strength) / 255;
        for (let r = 0; r < size; r++) {
          const rv = Math.round((r / (size - 1)) * 255);
          const outR = (rv * (1 - strength) + mapR[rv] * strength) / 255;
          lines.push(`${outR.toFixed(6)} ${outG.toFixed(6)} ${outB.toFixed(6)}`);
        }
      }
    }
    return lines.join('\n') + '\n';
  }

  function updateButtonState() {
    cloneRunBtn.disabled = !(refInput.files[0] && targetInput.files[0]);
  }

  lutStrengthInput.addEventListener('input', () => {
    lutStrengthVal.textContent = `${lutStrengthInput.value}%`;
  });

  refInput.addEventListener('change', async () => {
    const file = refInput.files[0];
    if (!file) return;
    try {
      refMeta = await inspectVideoMeta(file);
      refInfo.textContent = `${refMeta.width}x${refMeta.height} (${refMeta.ratioText}) • ${refMeta.duration.toFixed(1)}s`;
      refPreviewVideo.src = URL.createObjectURL(file);
    } catch (e) {
      refInfo.textContent = e.message;
    }
    updateButtonState();
  });

  targetInput.addEventListener('change', async () => {
    const file = targetInput.files[0];
    if (!file) return;
    try {
      targetMeta = await inspectVideoMeta(file);
      targetInfo.textContent = `${targetMeta.width}x${targetMeta.height} (${targetMeta.ratioText}) • ${targetMeta.duration.toFixed(1)}s`;
    } catch (e) {
      targetInfo.textContent = e.message;
    }
    updateButtonState();
  });

  cloneRunBtn.addEventListener('click', async () => {
    const refFile = refInput.files[0];
    const targetFile = targetInput.files[0];
    if (!refFile || !targetFile) return;

    cloneRunBtn.disabled = true;
    cloneDownloadBtn.classList.add('hidden');
    sendToEnhancerBtn.classList.add('hidden');
    ffmpegStatus.textContent = 'Memproses...';
    ffmpegStatus.className = 'text-xs px-2.5 py-1 rounded-full bg-amber-500/20 text-amber-300 w-fit';
    resetLog('[*] Menganalisis frame & warna Video Referensi vs Target...');

    try {
      const [refPixels, targetPixels] = await Promise.all([
        sampleVideoPixels(refFile, 5),
        sampleVideoPixels(targetFile, 5),
      ]);

      const strength = Number(lutStrengthInput.value) / 100;
      const cubeText = generateCubeLUT(targetPixels, refPixels, strength, 17);
      log(`[+] 3D LUT (.cube) berhasil dibuat (Strength: ${lutStrengthInput.value}%).`);

      let outW = refMeta.width % 2 === 0 ? refMeta.width : refMeta.width - 1;
      let outH = refMeta.height % 2 === 0 ? refMeta.height : refMeta.height - 1;
      if (ratioModeSelect.value === 'none') {
        outW = targetMeta.width % 2 === 0 ? targetMeta.width : targetMeta.width - 1;
        outH = targetMeta.height % 2 === 0 ? targetMeta.height : targetMeta.height - 1;
      }

      log(`[*] Target output dimensi: ${outW}x${outH} (Mode: ${ratioModeSelect.value})`);
      log('[*] Memuat FFmpeg Worker & mulai render (tunggu sebentar)...');

      if (!cloneWorker) {
        cloneWorker = new Worker('/clone-worker.js');
      }

      const targetBuffer = await targetFile.arrayBuffer();
      const resultBytes = await new Promise((resolve, reject) => {
        cloneWorker.onmessage = (ev) => {
          const d = ev.data;
          if (d.type === 'log') log(d.message);
          else if (d.type === 'done') resolve(d.buffer);
          else if (d.type === 'error') reject(new Error(d.message));
        };
        cloneWorker.onerror = (err) => reject(new Error(err.message || 'Worker error'));

        cloneWorker.postMessage(
          {
            targetBuffer,
            cubeText,
            outW,
            outH,
            ratioMode: ratioModeSelect.value,
            sharpen: sharpenSelect.value,
            applyLut: strength > 0,
          },
          [targetBuffer]
        );
      });

      const outBlob = new Blob([resultBytes], { type: 'video/mp4' });
      const outName = targetFile.name.replace(/\.[^.]+$/, '') + '_cloned.mp4';
      lastClonedFile = new File([outBlob], outName, { type: 'video/mp4' });

      const outUrl = URL.createObjectURL(outBlob);
      cloneOutputVideo.src = outUrl;
      cloneDownloadBtn.href = outUrl;
      cloneDownloadBtn.download = outName;

      clonePreviewBox.classList.remove('hidden');
      cloneDownloadBtn.classList.remove('hidden');
      sendToEnhancerBtn.classList.remove('hidden');

      ffmpegStatus.textContent = 'Selesai!';
      ffmpegStatus.className = 'text-xs px-2.5 py-1 rounded-full bg-emerald-500/20 text-emerald-300 w-fit';
      log(`[+] Selesai! Ukuran hasil: ${(outBlob.size / 1024 / 1024).toFixed(2)} MB`);
    } catch (err) {
      ffmpegStatus.textContent = 'Error';
      ffmpegStatus.className = 'text-xs px-2.5 py-1 rounded-full bg-rose-500/20 text-rose-300 w-fit';
      log(`[!] ERROR: ${err.message}`);
    } finally {
      cloneRunBtn.disabled = false;
    }
  });

  sendToEnhancerBtn.addEventListener('click', () => {
    if (!lastClonedFile) return;
    const dt = new DataTransfer();
    dt.items.add(lastClonedFile);
    const videoInput = document.getElementById('videoInput');
    videoInput.files = dt.files;
    videoInput.dispatchEvent(new Event('change', { bubbles: true }));

    const enhancerTabBtn = document.querySelector('.tab-btn[data-tab="enhancer"]');
    if (enhancerTabBtn) enhancerTabBtn.click();
  });
})();
