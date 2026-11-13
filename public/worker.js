/* global loadPyodide */
importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js");

let pyodide = null;

async function initPyodide() {
  if (pyodide) return pyodide;

  postMessage({ type: "status", message: "Memuat Python (Pyodide)..." });
  pyodide = await loadPyodide();

  // Buat struktur package tiktok_quality di virtual filesystem Pyodide
  pyodide.FS.mkdirTree("/home/pyodide/tiktok_quality/mp4");

  const files = [
    ["/py/tiktok_quality/__init__.py", "/home/pyodide/tiktok_quality/__init__.py"],
    ["/py/tiktok_quality/transform.py", "/home/pyodide/tiktok_quality/transform.py"],
    ["/py/tiktok_quality/mp4/__init__.py", "/home/pyodide/tiktok_quality/mp4/__init__.py"],
    ["/py/tiktok_quality/mp4/parser.py", "/home/pyodide/tiktok_quality/mp4/parser.py"],
    ["/py/tiktok_quality/mp4/builder.py", "/home/pyodide/tiktok_quality/mp4/builder.py"],
  ];

  for (const [url, dest] of files) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gagal memuat ${url} (${res.status})`);
    const text = await res.text();
    pyodide.FS.writeFile(dest, text);
  }

  // Wrapper helper Python untuk menjalankan transform & inspect MP4
  await pyodide.runPythonAsync(`
import io, os, sys, struct, json
from tiktok_quality.transform import transform, PADDING_NAL
from tiktok_quality.mp4.parser import (
    find_box, find_box_path, find_track_by_handler,
    parse_stsz, parse_stts, read_u32, read_u16
)

def run_transform_web(input_bytes, multiplier, comment):
    in_path = "/tmp/input.mp4"
    out_path = "/tmp/output.mp4"
    with open(in_path, "wb") as f:
        f.write(bytes(input_bytes))

    buf = io.StringIO()
    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout = buf
    sys.stderr = buf
    try:
        stats = transform(in_path, out_path, multiplier=int(multiplier), comment=str(comment), verbose=True)
        with open(out_path, "rb") as f:
            out_bytes = f.read()
        info_before = inspect_mp4_bytes(bytes(input_bytes))
        info_after = inspect_mp4_bytes(out_bytes)
        return {
            "ok": True,
            "logs": buf.getvalue(),
            "stats": stats,
            "before": info_before,
            "after": info_after,
            "output": out_bytes,
        }
    except SystemExit as e:
        return {"ok": False, "logs": buf.getvalue(), "error": f"Transform gagal (exit code {e.code}). Pastikan file adalah MP4 H.264/AVC yang valid."}
    except Exception as e:
        return {"ok": False, "logs": buf.getvalue(), "error": str(e)}
    finally:
        sys.stdout = old_out
        sys.stderr = old_err
        for p in (in_path, out_path):
            if os.path.exists(p):
                os.remove(p)

def inspect_mp4_bytes(data):
    data = bytes(data)
    size = len(data)
    ftyp_pos, ftyp_size = find_box(data, "ftyp")
    moov_pos, moov_size = find_box(data, "moov")
    mdat_pos, mdat_size = find_box(data, "mdat")

    brand = data[ftyp_pos + 8:ftyp_pos + 12].decode("latin-1", "replace") if ftyp_pos is not None else "?"
    fast_start = (moov_pos is not None and mdat_pos is not None and moov_pos < mdat_pos)

    vt_pos, vt_size = find_track_by_handler(data, moov_pos, moov_size, b"vide") if moov_pos is not None else (None, None)
    width = height = fps = declared_frames = real_frames = ghost_frames = v_bitrate_mbps = 0
    duration_sec = 0.0
    avcc_ext = False
    comment_tag = "-"

    if vt_pos is not None:
        vt_start, vt_end = vt_pos + 8, vt_pos + vt_size
        stbl_pos, stbl_size = find_box_path(data, ["mdia", "minf", "stbl"], vt_start, vt_end)
        sb_start, sb_end = stbl_pos + 8, stbl_pos + stbl_size
        stsz_pos, _ = find_box(data, "stsz", sb_start, sb_end)
        stts_pos, _ = find_box(data, "stts", sb_start, sb_end)
        stsd_pos, stsd_size = find_box(data, "stsd", sb_start, sb_end)
        mdhd_pos, _ = find_box_path(data, ["mdia", "mdhd"], vt_start, vt_end)

        sizes = parse_stsz(data, stsz_pos)
        stts = parse_stts(data, stts_pos)
        declared_frames = len(sizes)
        ghost_frames = sum(1 for s in sizes if s == 8)
        real_frames = declared_frames - ghost_frames

        timescale = read_u32(data, mdhd_pos + 20)
        duration = read_u32(data, mdhd_pos + 24)
        duration_sec = round(duration / timescale, 2) if timescale else 0
        delta = stts[0][1] if stts else 0
        fps = round(timescale / delta, 2) if delta else 0

        stsd_content = data[stsd_pos + 8:stsd_pos + stsd_size]
        if len(stsd_content) >= 44:
            width = read_u16(stsd_content, 40)
            height = read_u16(stsd_content, 42)
        avcc_ext = b"\\xfd\\xf8\\xf8\\x00" in stsd_content
        if duration_sec > 0:
            v_bytes = sum(s for s in sizes if s != 8)
            v_bitrate_mbps = round((v_bytes * 8) / duration_sec / 1_000_000, 2)

    # Audio handler
    audio_handler = "-"
    if moov_pos is not None:
        at_pos, at_size = find_track_by_handler(data, moov_pos, moov_size, b"soun")
        if at_pos is not None:
            hdlr_pos, hdlr_size = find_box_path(data, ["mdia", "hdlr"], at_pos + 8, at_pos + at_size)
            if hdlr_pos is not None:
                audio_handler = data[hdlr_pos + 32:hdlr_pos + hdlr_size].split(b"\\x00")[0].decode("utf-8", "replace")

    # Comment tag
    if moov_pos is not None:
        udta_pos, udta_size = find_box(data, "udta", moov_pos + 8, moov_pos + moov_size)
        if udta_pos is not None:
            udta_bytes = data[udta_pos:udta_pos + udta_size]
            idx = udta_bytes.find(b"\\xa9cmt")
            if idx != -1 and idx + 20 <= len(udta_bytes):
                d_size = read_u32(udta_bytes, idx + 4)
                comment_tag = udta_bytes[idx + 20:idx + 4 + d_size].decode("utf-8", "replace")

    has_padding_nal = (mdat_pos is not None and data[mdat_pos + mdat_size - 8:mdat_pos + mdat_size] == PADDING_NAL)

    return {
        "size_bytes": size,
        "size_mb": round(size / (1024 * 1024), 2),
        "brand": brand,
        "fast_start": fast_start,
        "resolution": f"{width}x{height}",
        "fps": fps,
        "duration_sec": duration_sec,
        "real_frames": real_frames,
        "ghost_frames": ghost_frames,
        "declared_frames": declared_frames,
        "bitrate_mbps": v_bitrate_mbps,
        "avcc_high_ext": avcc_ext,
        "audio_handler": audio_handler,
        "comment": comment_tag,
        "has_padding_nal": has_padding_nal,
    }
`);

  postMessage({ type: "ready" });
}

onmessage = async (e) => {
  const { type, data } = e.data;
  try {
    await initPyodide();

    if (type === "transform") {
      postMessage({ type: "status", message: "Memproses MP4 container dengan Python..." });
      const pyBytes = pyodide.toPy(new Uint8Array(data.buffer));
      const fn = pyodide.globals.get("run_transform_web");
      const resProxy = fn(pyBytes, data.multiplier, data.comment);
      const res = resProxy.toJs({ dict_converter: Object.fromEntries });
      pyBytes.destroy();
      resProxy.destroy();

      if (!res.ok) {
        postMessage({ type: "error", error: res.error, logs: res.logs });
        return;
      }

      const outUint8 = new Uint8Array(res.output);
      postMessage(
        {
          type: "done",
          logs: res.logs,
          stats: res.stats,
          before: res.before,
          after: res.after,
          outputBuffer: outUint8.buffer,
        },
        [outUint8.buffer]
      );
    } else if (type === "inspect") {
      const pyBytes = pyodide.toPy(new Uint8Array(data.buffer));
      const fn = pyodide.globals.get("inspect_mp4_bytes");
      const resProxy = fn(pyBytes);
      const info = resProxy.toJs({ dict_converter: Object.fromEntries });
      pyBytes.destroy();
      resProxy.destroy();
      postMessage({ type: "inspected", info });
    }
  } catch (err) {
    postMessage({ type: "error", error: err.message || String(err) });
  }
};

initPyodide().catch((err) => {
  postMessage({ type: "error", error: "Gagal inisialisasi Pyodide: " + err.message });
});
