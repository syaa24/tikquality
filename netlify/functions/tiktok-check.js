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
    const htmlData = await fetchFromTikTokHtml(url).catch(() => null);
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

    // Pisahkan stream kualitas Browser (h264) dan Phone (bytevc1/h264 tertinggi)
    const bitrateList = Array.isArray(video.bitrateInfo) ? video.bitrateInfo : [];
    const sorted = [...bitrateList].sort((a, b) => (b.Bitrate || 0) - (a.Bitrate || 0));

    const topStream = sorted[0] || null;
    const h264Stream = sorted.find((s) => (s.CodecType || "").toLowerCase().includes("h264")) || topStream;
    const phoneStream = sorted.find((s) => (s.CodecType || "").toLowerCase().includes("bytevc")) || topStream;

    const formatStreamLabel = (s) => {
      if (!s) return null;
      const w = s.PlayAddr?.Width || video.width;
      const h = s.PlayAddr?.Height || video.height;
      const resH = w && h ? Math.min(w, h) : null;
      const fps = video.fps || (s.GearName?.includes("60") ? 60 : "");
      return resH ? `${resH}p${fps}` : s.GearName;
    };

    const addr = topStream?.PlayAddr || {};
    const width = addr.Width || video.width || null;
    const height = addr.Height || video.height || null;
    const durationSec = video.duration || tw?.duration || 0;
    const sizeBytes = addr.DataSize || tw?.hd_size || tw?.size || null;
    const estBitrateMbps = topStream?.Bitrate
      ? (topStream.Bitrate / 1_000_000).toFixed(1)
      : sizeBytes && durationSec
      ? ((sizeBytes * 8) / durationSec / 1_000_000).toFixed(1)
      : null;

    // Cek sinyal pembatasan (Public Restriction Check)
    let shadowStatus = "No (Public signals)";
    if (!htmlData && tw) {
      shadowStatus = "Unknown (Web HTML diblokir)";
    } else if (item.privateItem || item.secret || item.forFriend) {
      shadowStatus = "Yes (Private / Hidden)";
    } else if (item.shareEnabled === false || item.itemControl?.can_share === false) {
      shadowStatus = "Yes (Share Restricted)";
    } else if (item.isContentClassified) {
      shadowStatus = "Warning (Content Classified)";
    }

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
          source: video.sourcePlatform || (topStream?.GearName?.includes("original") ? "Browser / Original" : "TikTok"),
          region: item.locationCreated || tw?.region || "Unknown",
          shadowBan: shadowStatus,
        },
        quality: {
          browser: formatStreamLabel(h264Stream) || (tw?.hdplay ? "1080p" : "540p"),
          phone: formatStreamLabel(phoneStream) || (tw?.hdplay ? "1080p" : "540p"),
          resolution: width && height ? `${width}x${height}` : "Unknown",
          fps: video.fps || (topStream?.GearName?.includes("60") ? 60 : null),
          gearName: topStream?.GearName || (tw?.hdplay ? "hdplay" : "play"),
          bitrateMbps: estBitrateMbps,
          codec: topStream?.CodecType || "h264",
          sizeMb: sizeBytes ? (sizeBytes / (1024 * 1024)).toFixed(1) : null,
          vqScore: video.VQScore ?? "0",
        },
        categories: item.diversificationLabels || [],
        note: "Status Shadow ban di atas dicek dari flag pembatasan publik TikTok (private/share/classified). Cek internal FYP butuh API privat TikTok.",
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
