const DEFAULT_MAX_SCROLLS = 120;
const DEFAULT_DELAY_MS = 1200;
const MAX_IDLE_ROUNDS = 8;
const USERNAME_REGEX = /^[A-Za-z0-9_]{1,15}$/;
const jobs = new Map();

function nowIso() {
  return new Date().toISOString();
}

function normalizeUsername(input) {
  const value = (input || "").trim();
  if (!value) return "";
  if (value.startsWith("@")) return value.slice(1);
  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      if (host === "x.com" || host === "www.x.com" || host === "twitter.com" || host === "www.twitter.com") {
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length > 0) {
          return parts[0].replace(/^@/, "");
        }
      }
    } catch (_error) {
      return "";
    }
  }
  return value;
}

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMediaUrl(username) {
  return `https://x.com/${username}/media`;
}

function guessExtFromUrl(sourceUrl) {
  try {
    const parsed = new URL(sourceUrl);

    const format = parsed.searchParams.get("format");
    if (format && /^[a-zA-Z0-9]{2,8}$/.test(format)) {
      return `.${format.toLowerCase()}`;
    }

    const extMatch = parsed.pathname.match(/\.([a-zA-Z0-9]{2,8})$/);
    if (extMatch) {
      return `.${extMatch[1].toLowerCase()}`;
    }
  } catch (_error) {
    // fall through
  }
  return "";
}

function buildFilename(username, index, sourceUrl, mediaType) {
  const fallbackExt = mediaType === "video" ? ".mp4" : ".jpg";
  const ext = guessExtFromUrl(sourceUrl) || fallbackExt;
  const suffix = mediaType === "video" ? "video" : "image";
  return `twitterno/${username}/${String(index).padStart(4, "0")}-${suffix}${ext}`;
}

function summarizeFound(found) {
  let foundImageCount = 0;
  let foundVideoCount = 0;

  for (const item of found.values()) {
    if (item.mediaType === "video") {
      foundVideoCount += 1;
    } else {
      foundImageCount += 1;
    }
  }

  return {
    foundCount: found.size,
    foundImageCount,
    foundVideoCount,
  };
}

async function persistJob(job) {
  await chrome.storage.local.set({
    [`job:${job.id}`]: job,
    lastJobId: job.id,
  });
}

function addLog(job, message) {
  job.logs.push(`[${new Date().toLocaleTimeString()}] ${message}`);
  if (job.logs.length > 300) {
    job.logs = job.logs.slice(-300);
  }
}

async function updateJob(job, patch) {
  Object.assign(job, patch, { updatedAt: nowIso() });
  jobs.set(job.id, job);
  await persistJob(job);
}

function serializeError(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

function waitForTabComplete(tabId, timeoutMs = 40000) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("タブの読み込みがタイムアウトしました。"));
    }, timeoutMs);

    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId || changeInfo.status !== "complete" || done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

async function scrapeStep(tabId, includeVideos) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    args: [Boolean(includeVideos)],
    func: (includeVideosInPage) => {
      const imageUrls = new Set();
      const videoUrls = new Set();

      const addImage = (raw) => {
        if (!raw) return;
        try {
          const url = new URL(raw, location.href);
          if (url.hostname !== "pbs.twimg.com") return;
          if (!url.pathname.includes("/media/")) return;
          url.searchParams.set("name", "orig");
          imageUrls.add(url.toString());
        } catch (_error) {
          // ignore invalid URL
        }
      };

      const addVideo = (raw) => {
        if (!raw || raw.startsWith("blob:")) return;
        try {
          const url = new URL(raw, location.href);
          if (url.hostname !== "video.twimg.com") return;

          const lowerPath = url.pathname.toLowerCase();
          if (lowerPath.endsWith(".m3u8")) return;
          if (!lowerPath.includes(".mp4")) return;

          videoUrls.add(url.toString());
        } catch (_error) {
          // ignore invalid URL
        }
      };

      const imageNodes = document.querySelectorAll('a[href*="/photo/"] img, img[src*="pbs.twimg.com/media"]');
      for (const img of imageNodes) {
        addImage(img.currentSrc || img.src || "");
      }

      if (includeVideosInPage) {
        const videoNodes = document.querySelectorAll("video");
        for (const video of videoNodes) {
          addVideo(video.currentSrc || "");
          addVideo(video.src || "");

          const sourceNodes = video.querySelectorAll("source[src]");
          for (const source of sourceNodes) {
            addVideo(source.src || source.getAttribute("src") || "");
          }
        }
      }

      const scroller = document.scrollingElement || document.documentElement;
      const before = scroller.scrollTop;
      window.scrollBy(0, Math.round(window.innerHeight * 0.92));
      const after = scroller.scrollTop;

      return {
        imageUrls: Array.from(imageUrls),
        videoUrls: Array.from(videoUrls),
        before,
        after,
        scrollHeight: scroller.scrollHeight,
      };
    },
  });

  return result?.result || { imageUrls: [], videoUrls: [], before: 0, after: 0, scrollHeight: 0 };
}

async function runJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  let tabId = null;
  const found = new Map();
  let downloadedCount = 0;
  let downloadedImageCount = 0;
  let downloadedVideoCount = 0;
  let failedCount = 0;

  try {
    await updateJob(job, { status: "running", startedAt: nowIso() });
    addLog(job, `mediaページを開きます: ${buildMediaUrl(job.username)}`);
    addLog(job, job.includeVideos ? "画像+動画の探索を開始します。" : "画像のみ探索します。");
    await persistJob(job);

    const tab = await chrome.tabs.create({ url: buildMediaUrl(job.username), active: false });
    tabId = tab.id;
    await waitForTabComplete(tabId);
    addLog(job, "読み込み完了。メディア探索を実行中...");
    await persistJob(job);

    let idleRounds = 0;
    for (let i = 0; i < job.maxScrolls; i += 1) {
      const beforeCount = found.size;
      const step = await scrapeStep(tabId, job.includeVideos);

      for (const url of step.imageUrls) {
        const key = `image:${url}`;
        if (!found.has(key)) {
          found.set(key, { url, mediaType: "image" });
        }
      }

      if (job.includeVideos) {
        for (const url of step.videoUrls) {
          const key = `video:${url}`;
          if (!found.has(key)) {
            found.set(key, { url, mediaType: "video" });
          }
        }
      }

      const summary = summarizeFound(found);
      const hasGrowth = found.size > beforeCount;
      idleRounds = hasGrowth ? 0 : idleRounds + 1;

      await updateJob(job, {
        ...summary,
        currentScroll: i + 1,
      });

      if ((i + 1) % 10 === 0 || hasGrowth) {
        addLog(
          job,
          `スクロール ${i + 1}/${job.maxScrolls}, 収集メディア ${summary.foundCount} (画像 ${summary.foundImageCount}, 動画 ${summary.foundVideoCount})`
        );
        await persistJob(job);
      }

      if (idleRounds >= MAX_IDLE_ROUNDS) {
        addLog(job, `新規メディアが増えないため探索を終了します (${MAX_IDLE_ROUNDS} 回連続)。`);
        await persistJob(job);
        break;
      }

      await delay(job.delayMs);
    }

    const summary = summarizeFound(found);
    if (summary.foundCount === 0) {
      addLog(job, "メディアが見つかりませんでした。");
      await updateJob(job, {
        status: "completed",
        finishedAt: nowIso(),
        ...summary,
      });
      return;
    }

    addLog(job, `${summary.foundCount} 件のメディアをダウンロードします。`);
    await persistJob(job);

    const entries = Array.from(found.values());
    let index = 1;
    for (const item of entries) {
      try {
        await chrome.downloads.download({
          url: item.url,
          filename: buildFilename(job.username, index, item.url, item.mediaType),
          conflictAction: "uniquify",
          saveAs: false,
        });

        downloadedCount += 1;
        if (item.mediaType === "video") {
          downloadedVideoCount += 1;
        } else {
          downloadedImageCount += 1;
        }
      } catch (error) {
        failedCount += 1;
        addLog(job, `ダウンロード失敗: ${serializeError(error)}`);
      }

      if (index % 10 === 0 || index === entries.length) {
        await updateJob(job, {
          ...summary,
          downloadedCount,
          downloadedImageCount,
          downloadedVideoCount,
          failedCount,
        });
      }
      index += 1;
    }

    addLog(
      job,
      `完了: 成功 ${downloadedCount} (画像 ${downloadedImageCount}, 動画 ${downloadedVideoCount}) / 失敗 ${failedCount}`
    );
    await updateJob(job, {
      status: "completed",
      finishedAt: nowIso(),
      ...summary,
      downloadedCount,
      downloadedImageCount,
      downloadedVideoCount,
      failedCount,
    });
  } catch (error) {
    const summary = summarizeFound(found);
    addLog(job, `エラー: ${serializeError(error)}`);
    await updateJob(job, {
      status: "failed",
      error: serializeError(error),
      finishedAt: nowIso(),
      ...summary,
      downloadedCount,
      downloadedImageCount,
      downloadedVideoCount,
      failedCount,
    });
  } finally {
    if (tabId !== null) {
      try {
        await chrome.tabs.remove(tabId);
      } catch (_error) {
        // tab might already be closed
      }
    }
  }
}

async function getJob(jobId) {
  if (jobs.has(jobId)) {
    return jobs.get(jobId);
  }
  const data = await chrome.storage.local.get(`job:${jobId}`);
  const restored = data[`job:${jobId}`];
  if (restored) {
    jobs.set(jobId, restored);
    return restored;
  }
  return null;
}

async function startJob(payload) {
  const username = normalizeUsername(payload?.input || "");
  if (!USERNAME_REGEX.test(username)) {
    return { ok: false, error: "有効なTwitter/Xユーザー名を入力してください。" };
  }

  const maxScrolls = clampInt(payload?.maxScrolls, DEFAULT_MAX_SCROLLS, 10, 2000);
  const delayMs = clampInt(payload?.delayMs, DEFAULT_DELAY_MS, 300, 10000);
  const includeVideos = payload?.includeVideos !== false;
  const id = crypto.randomUUID();

  const job = {
    id,
    username,
    includeVideos,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    currentScroll: 0,
    maxScrolls,
    delayMs,
    foundCount: 0,
    foundImageCount: 0,
    foundVideoCount: 0,
    downloadedCount: 0,
    downloadedImageCount: 0,
    downloadedVideoCount: 0,
    failedCount: 0,
    error: "",
    logs: [],
  };

  addLog(job, `ジョブ作成: @${username}`);
  jobs.set(id, job);
  await persistJob(job);

  runJob(id);
  return { ok: true, jobId: id };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") {
    sendResponse({ ok: false, error: "invalid message" });
    return false;
  }

  if (message.type === "start") {
    startJob(message)
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  }

  if (message.type === "status") {
    getJob(message.jobId)
      .then((job) => {
        if (!job) {
          sendResponse({ ok: false, error: "job not found" });
          return;
        }
        sendResponse({ ok: true, job });
      })
      .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  }

  if (message.type === "last-job") {
    chrome.storage.local
      .get("lastJobId")
      .then((data) => sendResponse({ ok: true, jobId: data.lastJobId || "" }))
      .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
    return true;
  }

  sendResponse({ ok: false, error: "unsupported message type" });
  return false;
});
