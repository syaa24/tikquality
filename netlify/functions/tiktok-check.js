exports.handler = async (event) => {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  let url = event.queryStringParameters?.url;
  if (!url && event.body) {
    try {
      url = JSON.parse(event.body).url;
    } catch (_) {}
  }

  if (!url || !url.includes("tiktok.com")) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: "Masukkan URL video TikTok yang valid." }),
    };
  }

  try {
    // 1. Coba ambil data langsung dari HTML rehydration TikTok (paling lengkap: bitrateInfo, GearName, VQScore jika ada)
    const htmlData = await fetchFromTikTokHtml(url).catch(() => null);

    // 2. Ambil data dari TikWM public API sebagai pelengkap / fallback
    const tikwmRes = await fetch(
      `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`
    );
    const tikwmJson = await tikwmRes.json();
    const tw = tikwmJson?.code === 0 ? tikwmJson.data : null;

    if (!htmlData && !tw) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          ok: false,
          error: "Gagal mengambil data video. Pastikan video bersifat publik dan link benar.",
        }),
      };
    }

    const item = htmlData || {};
    const video = item.video || {};
    const stats = item.stats || {};
    const author = item.author || tw?.author || {};
    const music = item.music || tw?.music_info || {};

    // Cari info stream kualitas tertinggi dari bitrateInfo TikTok
    let bestStream = null;
    if (Array.isArray(video.bitrateInfo) && video.bitrateInfo.length > 0) {
      const sorted = [...video.bitrateInfo].sort((a, b) => (b.Bitrate || 0) - (a.Bitrate || 0));
      const top = sorted[0];
      const addr = top.PlayAddr || {};
      bestStream = {
        gearName: top.GearName || "unknown",
        qualityType: top.QualityType ?? null,
        bitrateMbps: top.Bitrate ? (top.Bitrate / 1_000_000).toFixed(1) : null,
        codec: top.CodecType || "h264",
        sizeMb: addr.DataSize ? (addr.DataSize / (1024 * 1024)).toFixed(1) : null,
        width: addr.Width || video.width || null,
        height: addr.Height || video.height || null,
      };
    }

    const width = bestStream?.width || video.width || null;
    const height = bestStream?.height || video.height || null;
    const durationSec = item.video?.duration || tw?.duration || 0;
    const sizeBytes = tw?.hd_size || tw?.size || null;
    const estBitrateMbps =
      bestStream?.bitrateMbps ||
      (sizeBytes && durationSec ? ((sizeBytes * 8) / durationSec / 1_000_000).toFixed(1) : null);

    const payload = {
      ok: true,
      data: {
        id: item.id || tw?.id || "-",
        createTime: item.createTime || tw?.create_time || null,
        author: {
          nickname: author.nickname || "-",
          uniqueId: author.uniqueId || author.unique_id || "-",
        },
        sound: {
          title: music.title || "Sound",
          duration: music.duration || durationSec,
        },
        statistics: {
          views: stats.playCount ?? tw?.play_count ?? 0,
          likes: stats.diggCount ?? tw?.digg_count ?? 0,
          comments: stats.commentCount ?? tw?.comment_count ?? 0,
          favorites: stats.collectCount ?? tw?.collect_count ?? 0,
          shares: stats.shareCount ?? tw?.share_count ?? 0,
          downloads: tw?.download_count ?? 0,
        },
        information: {
          id: item.id || tw?.id || "-",
          source: item.video?.sourcePlatform || "Web / API",
          region: item.locationCreated || tw?.region || "Unknown",
          shadowBan: "N/A (Butuh API privat)",
        },
        quality: {
          resolution: width && height ? `${width}x${height}` : "Unknown",
          fps: video.fps || (bestStream?.gearName?.includes("60") ? 60 : null),
          gearName: bestStream?.gearName || (tw?.hdplay ? "hdplay (1080p)" : "play"),
          bitrateMbps: estBitrateMbps,
          codec: bestStream?.codec || "h264",
          sizeMb: bestStream?.sizeMb || (sizeBytes ? (sizeBytes / (1024 * 1024)).toFixed(1) : null),
          vqScore: video.VQScore ?? "N/A (Tidak diekspos publik)",
          hdUrl: tw?.hdplay || tw?.play || null,
        },
        categories: item.diversificationLabels || [],
        note: "Catatan: Shadow ban & VQ Score penuh hanya tersedia via session/API privat TikTok seperti bot Telegram.",
      },
    };

    return { statusCode: 200, headers, body: JSON.stringify(payload) };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: err.message }),
    };
  }
};

async function fetchFromTikTokHtml(targetUrl) {
  const res = await fetch(targetUrl, {
    redirect: "follow",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  const html = await res.text();
  const match = html.match(
    /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!match) return null;
  const json = JSON.parse(match[1]);
  return json?.__DEFAULT_SCOPE__?.["webapp.video-detail"]?.itemInfo?.itemStruct || null;
}