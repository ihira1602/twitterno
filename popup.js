const form = document.getElementById("download-form");
const accountInput = document.getElementById("account-input");
const maxScrollsInput = document.getElementById("max-scrolls");
const delayMsInput = document.getElementById("delay-ms");
const includeVideosInput = document.getElementById("include-videos");
const startButton = document.getElementById("start-button");

const statusCard = document.getElementById("status-card");
const logsCard = document.getElementById("logs-card");
const jobIdText = document.getElementById("job-id");
const jobStatusText = document.getElementById("job-status");
const foundCountText = document.getElementById("found-count");
const foundImageCountText = document.getElementById("found-image-count");
const foundVideoCountText = document.getElementById("found-video-count");
const downloadedCountText = document.getElementById("downloaded-count");
const downloadedImageCountText = document.getElementById(
    "downloaded-image-count",
);
const downloadedVideoCountText = document.getElementById(
    "downloaded-video-count",
);
const failedCountText = document.getElementById("failed-count");
const scrollProgressText = document.getElementById("scroll-progress");
const errorText = document.getElementById("error-text");
const logsText = document.getElementById("logs");

let activeJobId = "";
let pollTimer = null;

function setSubmitting(isSubmitting) {
    startButton.disabled = isSubmitting;
    startButton.textContent = isSubmitting
        ? "実行中..."
        : "収集してダウンロード";
}

function showStatusUI() {
    statusCard.classList.remove("hidden");
    logsCard.classList.remove("hidden");
}

function renderJob(job) {
    showStatusUI();
    jobIdText.textContent = job.id || "-";
    jobStatusText.textContent = job.status || "-";
    foundCountText.textContent = String(job.foundCount || 0);
    foundImageCountText.textContent = String(job.foundImageCount || 0);
    foundVideoCountText.textContent = String(job.foundVideoCount || 0);
    downloadedCountText.textContent = String(job.downloadedCount || 0);
    downloadedImageCountText.textContent = String(
        job.downloadedImageCount || 0,
    );
    downloadedVideoCountText.textContent = String(
        job.downloadedVideoCount || 0,
    );
    failedCountText.textContent = String(job.failedCount || 0);
    scrollProgressText.textContent = `${job.currentScroll || 0}/${job.maxScrolls || 0}`;
    errorText.textContent = job.error || "-";
    logsText.textContent = Array.isArray(job.logs) ? job.logs.join("\n") : "";
    logsText.scrollTop = logsText.scrollHeight;

    const done = job.status === "completed" || job.status === "failed";
    setSubmitting(!done && job.status !== "queued");
}

async function requestStatus(jobId) {
    return chrome.runtime.sendMessage({ type: "status", jobId });
}

function stopPolling() {
    if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
    }
}

function startPolling(jobId) {
    stopPolling();
    activeJobId = jobId;
    pollOnce();
    pollTimer = setInterval(pollOnce, 1000);
}

async function pollOnce() {
    if (!activeJobId) return;
    const response = await requestStatus(activeJobId);
    if (!response?.ok) return;

    const job = response.job;
    renderJob(job);
    if (job.status === "completed" || job.status === "failed") {
        setSubmitting(false);
        stopPolling();
    }
}

form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = accountInput.value.trim();
    if (!input) {
        return;
    }

    setSubmitting(true);
    showStatusUI();
    errorText.textContent = "-";
    logsText.textContent = "";

    const response = await chrome.runtime.sendMessage({
        type: "start",
        input,
        maxScrolls: maxScrollsInput.value,
        delayMs: delayMsInput.value,
        includeVideos: includeVideosInput.checked,
    });

    if (!response?.ok) {
        setSubmitting(false);
        errorText.textContent = response?.error || "開始に失敗しました。";
        return;
    }

    startPolling(response.jobId);
});

async function loadLastJob() {
    const response = await chrome.runtime.sendMessage({ type: "last-job" });
    if (!response?.ok || !response.jobId) return;
    startPolling(response.jobId);
}

loadLastJob();
