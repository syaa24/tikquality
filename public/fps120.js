(() => {
  const fps120Input = document.getElementById('fps120Input');
  const fps120DetectInfo = document.getElementById('fps120DetectInfo');
  const fps120ModeSelect = document.getElementById('fps120ModeSelect');
  const fps120ProcessBtn = document.getElementById('fps120ProcessBtn');
  const fps120DownloadBtn = document.getElementById('fps120DownloadBtn');
  const fps120PreviewBox = document.getElementById('fps120PreviewBox');
  const fps120PreviewVideo = document.getElementById('fps120PreviewVideo');
  const fps120Log = document.getElementById('fps120Log');

  let currentFile = null;
  let currentBytes = null;
  let detectedFps = null;

  function readU32(buf, off) {
    return (
      ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0
    );
  }

  function writeU32(buf, off, val) {
    buf[off] = (val >>> 24) & 0xff;
    buf[off + 1] = (val >>> 16) & 0xff;
    buf[off + 2] = (val >>> 8) & 0xff;
    buf[off + 3] = val & 0xff;
  }

  function readU64BigInt(buf, off) {
    let val = 0n;
    for (let i = 0; i < 8; i++) {
      val = (val << 8n) | BigInt(buf[off + i]);
    }
    return val;
  }

  function writeU64BigInt(buf, off, val) {
    let v = val;
    for (let i = 7; i >= 0; i--) {
      buf[off + i] = Number(v & 0xffn);
      v >>= 8n;
    }
  }

  function boxType(buf, off) {
    return String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
  }

  function iterateBoxes(buf, start, end, callback) {
    let pos = start;
    while (pos + 8 <= end) {
      let size = readU32(buf, pos);
      let hdrSize = 8;
      if (size === 1) {
        if (pos + 16 > end) break;
        size = Number(readU64BigInt(buf, pos + 8));
        hdrSize = 16;
      } else if (size === 0) {
        size = end - pos;
      }
      if (size < hdrSize || pos + size > end) break;
      const type = boxType(buf, pos);
      callback(type, pos, size, hdrSize);
      pos += size;
    }
  }

  function findChildBox(buf, start, end, targetType) {
    let found = null;
    iterateBoxes(buf, start, end, (type, pos, size, hdrSize) => {
      if (!found && type === targetType) {
        found = { pos, size, hdrSize };
      }
    });
    return found;
  }

  function detectVideoInfo(buf) {
    const moov = findChildBox(buf, 0, buf.length, 'moov');
    if (!moov) throw new Error('Box moov tidak ditemukan (bukan file MP4 valid).');

    let fps = 0;
    let durationSec = 0;

    iterateBoxes(buf, moov.pos + moov.hdrSize, moov.pos + moov.size, (type, pos, size, hdrSize) => {
      if (type !== 'trak' || fps > 0) return;
      const mdia = findChildBox(buf, pos + hdrSize, pos + size, 'mdia');
      if (!mdia) return;

      const hdlr = findChildBox(buf, mdia.pos + mdia.hdrSize, mdia.pos + mdia.size, 'hdlr');
      if (!hdlr) return;
      const handler = String.fromCharCode(
        buf[hdlr.pos + 16],
        buf[hdlr.pos + 17],
        buf[hdlr.pos + 18],
        buf[hdlr.pos + 19]
      );
      if (handler !== 'vide') return;

      const mdhd = findChildBox(buf, mdia.pos + mdia.hdrSize, mdia.pos + mdia.size, 'mdhd');
      if (!mdhd) return;
      const ver = buf[mdhd.pos + 8];
      const vTimescale = ver === 0 ? readU32(buf, mdhd.pos + 20) : readU32(buf, mdhd.pos + 28);
      const vDuration =
        ver === 0 ? readU32(buf, mdhd.pos + 24) : Number(readU64BigInt(buf, mdhd.pos + 32));
      if (vTimescale > 0) durationSec = vDuration / vTimescale;

      const minf = findChildBox(buf, mdia.pos + mdia.hdrSize, mdia.pos + mdia.size, 'minf');
      if (!minf) return;
      const stbl = findChildBox(buf, minf.pos + minf.hdrSize, minf.pos + minf.size, 'stbl');
      if (!stbl) return;
      const stts = findChildBox(buf, stbl.pos + stbl.hdrSize, stbl.pos + stbl.size, 'stts');
      if (!stts) return;

      const entryCount = readU32(buf, stts.pos + 12);
      let totalFrames = 0;
      let totalTicks = 0;
      for (let i = 0; i < entryCount; i++) {
        const cnt = readU32(buf, stts.pos + 16 + i * 8);
        const delta = readU32(buf, stts.pos + 20 + i * 8);
        totalFrames += cnt;
        totalTicks += cnt * delta;
      }
      if (totalTicks > 0 && vTimescale > 0) {
        fps = (totalFrames * vTimescale) / totalTicks;
      }
    });

    return { fps, durationSec };
  }

  function patchMvhdBox(buf, pos, divider) {
    const version = buf[pos + 8];
    const tsOff = version === 0 ? pos + 20 : pos + 28;
    const durOff = version === 0 ? pos + 24 : pos + 32;

    const oldTs = readU32(buf, tsOff);
    const newTs = Math.max(1, Math.floor(oldTs / divider));
    writeU32(buf, tsOff, newTs);

    if (version === 0) {
      const oldDur = readU32(buf, durOff);
      writeU32(buf, durOff, Math.floor(oldDur / divider));
    } else {
      const oldDur = readU64BigInt(buf, durOff);
      writeU64BigInt(buf, durOff, oldDur / BigInt(divider));
    }
  }

  function patchMdhdBox(buf, pos, divider) {
    const version = buf[pos + 8];
    const tsOff = version === 0 ? pos + 20 : pos + 28;
    const durOff = version === 0 ? pos + 24 : pos + 32;

    const oldTs = readU32(buf, tsOff);
    const newTs = Math.max(1, Math.floor(oldTs / divider));
    writeU32(buf, tsOff, newTs);

    if (version === 0) {
      const oldDur = readU32(buf, durOff);
      writeU32(buf, durOff, Math.floor(oldDur / divider));
    } else {
      const oldDur = readU64BigInt(buf, durOff);
      writeU64BigInt(buf, durOff, oldDur / BigInt(divider));
    }
  }

  function apply120FpsPatch(origBytes, divider) {
    const buf = new Uint8Array(origBytes);
    const moov = findChildBox(buf, 0, buf.length, 'moov');
    if (!moov) throw new Error('Box moov tidak ditemukan.');

    let mvhdCount = 0;
    let mdhdCount = 0;

    function walkMoov(start, end) {
      iterateBoxes(buf, start, end, (type, pos, size, hdrSize) => {
        if (type === 'mvhd') {
          patchMvhdBox(buf, pos, divider);
          mvhdCount++;
        } else if (type === 'mdhd') {
          patchMdhdBox(buf, pos, divider);
          mdhdCount++;
        } else if (type === 'trak' || type === 'mdia') {
          walkMoov(pos + hdrSize, pos + size);
        }
      });
    }

    walkMoov(moov.pos + moov.hdrSize, moov.pos + moov.size);
    return { buf, mvhdCount, mdhdCount };
  }

  fps120Input.addEventListener('change', async () => {
    const file = fps120Input.files[0];
    fps120DownloadBtn.classList.add('hidden');
    fps120PreviewBox.classList.add('hidden');

    if (!file) {
      fps120ProcessBtn.disabled = true;
      return;
    }

    currentFile = file;
    fps120Log.textContent = `[*] Membaca ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)...`;

    try {
      const ab = await file.arrayBuffer();
      currentBytes = new Uint8Array(ab);
      const info = detectVideoInfo(currentBytes);
      detectedFps = Math.round(info.fps * 100) / 100;

      fps120DetectInfo.textContent = `Terdeteksi: ${detectedFps.toFixed(2)} FPS • Durasi: ${info.durationSec.toFixed(2)}s`;
      if (detectedFps >= 55 && detectedFps <= 65) {
        fps120DetectInfo.textContent += ' (Cocok -> Auto Divider ÷2)';
      } else if (detectedFps >= 110 && detectedFps <= 130) {
        fps120DetectInfo.textContent += ' (Cocok -> Auto Divider ÷4)';
      } else {
        fps120DetectInfo.textContent += ' (Bukan 60/120 FPS — pilih mode manual jika tetap ingin patch)';
      }

      fps120Log.textContent += `\n[+] File siap. FPS terdeteksi: ${detectedFps.toFixed(2)} FPS`;
      fps120ProcessBtn.disabled = false;
    } catch (err) {
      fps120DetectInfo.textContent = `Error: ${err.message}`;
      fps120Log.textContent = `[!] ERROR: ${err.message}`;
      fps120ProcessBtn.disabled = true;
    }
  });

  fps120ProcessBtn.addEventListener('click', () => {
    if (!currentBytes || !currentFile) return;

    let divider = 2;
    const mode = fps120ModeSelect.value;

    if (mode === 'auto') {
      if (detectedFps >= 110) {
        divider = 4;
      } else if (detectedFps >= 55) {
        divider = 2;
      } else {
        fps120Log.textContent += `\n[!] Video terdeteksi ${detectedFps} FPS (bukan 60/120 FPS). Ubah mode ke Paksa ÷2 atau ÷4 jika tetap ingin memproses.`;
        return;
      }
    } else {
      divider = Number(mode);
    }

    try {
      const { buf, mvhdCount, mdhdCount } = apply120FpsPatch(currentBytes, divider);
      if (mvhdCount === 0 && mdhdCount === 0) {
        throw new Error('Box mvhd/mdhd tidak ditemukan.');
      }

      const outName = currentFile.name.replace(/\.mp4$/i, '') + '_patched.mp4';
      const blob = new Blob([buf], { type: 'video/mp4' });
      const url = URL.createObjectURL(blob);

      fps120DownloadBtn.href = url;
      fps120DownloadBtn.download = outName;
      fps120DownloadBtn.classList.remove('hidden');

      fps120PreviewVideo.src = url;
      fps120PreviewBox.classList.remove('hidden');

      fps120Log.textContent +=
        `\n[+] Successfully Patched!` +
        `\n[+] Original FPS: ${detectedFps.toFixed(2)} | Divider: ÷${divider} (Target terbaca: ${(detectedFps / divider).toFixed(2)} FPS)` +
        `\n[+] mvhd patched: ${mvhdCount}, mdhd patched: ${mdhdCount}` +
        `\n[+] Output: ${outName} (Upload wajib lewat PC!)`;
    } catch (err) {
      fps120Log.textContent += `\n[!] ERROR: ${err.message}`;
    }
  });
})();