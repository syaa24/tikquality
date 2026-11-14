importScripts('https://unpkg.com/@ffmpeg/ffmpeg@0.11.6/dist/ffmpeg.min.js');

const { createFFmpeg } = self.FFmpeg;
let ffmpeg = null;

async function ensureFFmpeg() {
  if (!ffmpeg) {
    ffmpeg = createFFmpeg({
      log: false,
      mainName: 'main',
      corePath: 'https://unpkg.com/@ffmpeg/core-st@0.11.1/dist/ffmpeg-core.js',
    });
    ffmpeg.setLogger(({ type, message }) => {
      if (type === 'fferr' && (message.includes('frame=') || message.includes('Error'))) {
        self.postMessage({ type: 'log', message: `[ffmpeg] ${message.trim()}` });
      }
    });
    self.postMessage({ type: 'log', message: '[*] Mengunduh FFmpeg Core (~25MB, sekali saja)...' });
    await ffmpeg.load();
  }
}

self.onmessage = async (ev) => {
  try {
    await ensureFFmpeg();
    const { targetBuffer, cubeText, outW, outH, ratioMode, sharpen, applyLut } = ev.data;

    ffmpeg.FS('writeFile', 'input.mp4', new Uint8Array(targetBuffer));
    if (applyLut) {
      ffmpeg.FS('writeFile', 'match.cube', new TextEncoder().encode(cubeText));
    }

    const postFilters = [];
    if (applyLut) postFilters.push('lut3d=match.cube');
    if (sharpen && sharpen !== '0') {
      postFilters.push(`unsharp=5:5:${sharpen}:5:5:0.0`);
    }
    const postChain = postFilters.length ? `,${postFilters.join(',')}` : '';

    let vfArg;
    if (ratioMode === 'crop') {
      vfArg = `scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH}${postChain}`;
    } else if (ratioMode === 'blur') {
      vfArg =
        `split[bg][fg];` +
        `[bg]scale=${outW}:${outH}:force_original_aspect_ratio=increase,crop=${outW}:${outH},boxblur=20:5[bg_blur];` +
        `[fg]scale=${outW}:${outH}:force_original_aspect_ratio=decrease[fg_fit];` +
        `[bg_blur][fg_fit]overlay=(W-w)/2:(H-h)/2${postChain}`;
    } else {
      vfArg = postFilters.length ? postFilters.join(',') : 'null';
    }

    const args = ['-i', 'input.mp4'];
    if (ratioMode === 'blur') {
      args.push('-filter_complex', vfArg);
    } else if (vfArg !== 'null') {
      args.push('-vf', vfArg);
    }

    args.push(
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      '-crf', '18',
      '-preset', 'veryfast',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-movflags', '+faststart',
      'output.mp4'
    );

    self.postMessage({ type: 'log', message: '[*] Rendering video...' });
    await ffmpeg.run(...args);

    const outData = ffmpeg.FS('readFile', 'output.mp4');
    try { ffmpeg.FS('unlink', 'input.mp4'); } catch (_) {}
    try { ffmpeg.FS('unlink', 'output.mp4'); } catch (_) {}
    try { ffmpeg.FS('unlink', 'match.cube'); } catch (_) {}

    const copy = new Uint8Array(outData);
    self.postMessage({ type: 'done', buffer: copy.buffer }, [copy.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};