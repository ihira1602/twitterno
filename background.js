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

function buildFilename(username, index, sourceUrl) {
  let ext = ".jpg";
  try {
    const parsed = new URL(sourceUrl);
    const format = parsed.searchParams.get("format");
    if (format && /^[a-zA-Z0-9]+$/.test(format)) {
      ext = `.${format.toLowerCase()}`;
    }
  } catch (_error) {
    // keep default extension
  }
  return `twitterno/${username}/${String(index).padStart(4, "0")}${ext}`;
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

async function scrapeStep(tabId) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: () => {
      const urls = new Set();
      const images = document.querySelectorAll('a[href*="/photo/"] img');

      for (const img of images) {
        const raw = img.currentSrc || img.src || "";
        if (!raw || !raw.includes("pbs.twimg.com/media")) continue;
        try {
          const url = new URL(raw, location.href);
          url.searchParams.set("name", "orig");
          urls.add(url.toString());
        } catch (_error) {
          // ignore invalid URL
        }
      }

      const scroller = document.scrollingElement || document.documentElement;
      const before = scroller.scrollTop;
      window.scrollBy(0, Math.round(window.innerHeight * 0.92));
      const after = scroller.scrollTop;

      return {
        urls: Array.from(urls),
        before,
        after,
        scrollHeight: scroller.scrollHeight,
      };
    },
  });

  return result?.result || { urls: [], before: 0, after: 0, scrollHeight: 0 };
}

async function runJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;

  let tabId = null;
  const found = new Set();
  let downloadedCount = 0;
  let failedCount = 0;

  try {
    await updateJob(job, { status: "running", startedAt: nowIso() });
    addLog(job, `mediaページを開きます: ${buildMediaUrl(job.username)}`);
    await persistJob(job);

    const tab = await chrome.tabs.create({ url: buildMediaUrl(job.username), active: false });
    tabId = tab.id;
    await waitForTabComplete(tabId);
    addLog(job, "読み込み完了。画像探索を開始します。");
    await persistJob(job);

    let idleRounds = 0;
    for (let i = 0; i < job.maxScrolls; i += 1) {
      const beforeCount = found.size;
      const step = await scrapeStep(tabId);

      for (const url of step.urls) {
        found.add(url);
      }

      const hasGrowth = found.size > beforeCount;
      idleRounds = hasGrowth ? 0 : idleRounds + 1;

      await updateJob(job, {
        foundCount: found.size,
        currentScroll: i + 1,
      });

      if ((i + 1) % 10 === 0 || hasGrowth) {
        addLog(job, `スクロール ${i + 1}/${job.maxScrolls}, 収集画像 ${found.size}`);
        await persistJob(job);
      }

      if (idleRounds >= MAX_IDLE_ROUNDS) {
        addLog(job, `新規画像が増えないため探索を終了します (${MAX_IDLE_ROUNDS} 回連続)。`);
        await persistJob(job);
        break;
      }

      await delay(job.delayMs);
    }

    if (found.size === 0) {
      addLog(job, "画像が見つかりませんでした。");
      await updateJob(job, { status: "completed", finishedAt: nowIso() });
      return;
    }

    addLog(job, `${found.size} 件の画像をダウンロードします。`);
    await persistJob(job);

    let index = 1;
    for (const url of found) {
      try {
        await chrome.downloads.download({
          url,
          filename: buildFilename(job.username, index, url),
          conflictAction: "uniquify",
          saveAs: false,
        });
        downloadedCount += 1;
      } catch (error) {
        failedCount += 1;
        addLog(job, `ダウンロード失敗: ${serializeError(error)}`);
      }

      if (index % 10 === 0 || index === found.size) {
        await updateJob(job, {
          downloadedCount,
          failedCount,
        });
      }
      index += 1;
    }

    addLog(job, `完了: 成功 ${downloadedCount} / 失敗 ${failedCount}`);
    await updateJob(job, {
      status: "completed",
      finishedAt: nowIso(),
      foundCount: found.size,
      downloadedCount,
      failedCount,
    });
  } catch (error) {
    addLog(job, `エラー: ${serializeError(error)}`);
    await updateJob(job, {
      status: "failed",
      error: serializeError(error),
      finishedAt: nowIso(),
      downloadedCount,
      failedCount,
      foundCount: found.size,
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
  const id = crypto.randomUUID();

  const job = {
    id,
    username,
    status: "queued",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    startedAt: null,
    finishedAt: null,
    currentScroll: 0,
    maxScrolls,
    delayMs,
    foundCount: 0,
    downloadedCount: 0,
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
