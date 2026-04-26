const fs = require('fs');
const https = require('https');
const path = require('path');

// 📂 Paths (same as your script)
const txtFilePath = path.resolve(__dirname, './tracksToDownload.txt');
const downloadDirectory = path.resolve(__dirname, './music');
const outputFilePath = path.resolve(__dirname, './downloadedTracks.txt');

// 🌩️ Fallback base (Yandex Cloud)
const FALLBACK_BASE = 'https://storage.yandexcloud.net/sphere-bucket/musicLibrary/';

// 🔧 Network knobs
const RETRIES = 3;
const TIMEOUT_MS = 10000;               // stall timeout while downloading
const MAX_REDIRECTS = 3;
const MAIN_RESPONSE_TIMEOUT_MS = 2000;  // if main doesn't respond in 2s -> fallback
const MIN_FILE_SIZE_BYTES = 100 * 1024; // 100 KB — anything smaller is considered corrupted
const RETRY_DELAY_MS = 2000;            // delay between retries

// ✅ Ensure the music directory exists
if (!fs.existsSync(downloadDirectory)) {
  fs.mkdirSync(downloadDirectory, { recursive: true });
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function safeUnlink(filePath) {
  try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

// Extract encoded filename from URL (keeps %20 etc.)
function getEncodedFileNameFromUrl(url) {
  const u = new URL(url);
  const parts = u.pathname.split('/');
  return parts[parts.length - 1] || '';
}

// Wait until server sends ANY response headers (TTFB). If not in ms -> reject.
// We use GET and immediately destroy the request once headers arrive.
function waitForHeaders(url, ms) {
  return new Promise((resolve, reject) => {
    let done = false;

    const finish = (err) => {
      if (done) return;
      done = true;
      err ? reject(err) : resolve(true);
    };

    const req = https.get(url, (res) => {
      // Got headers => main server responded
      res.resume(); // don't download body
      finish(null);
      try { req.destroy(); } catch {}
    });

    req.on('error', (e) => finish(e));

    req.setTimeout(ms, () => {
      try { req.destroy(new Error(`no response headers within ${ms}ms`)); } catch {}
      finish(new Error(`no response headers within ${ms}ms`));
    });
  });
}

/**
 * Robust downloader:
 * - Writes to temp ".part" then renames (prevents corrupted "exists")
 * - Retries
 * - Timeout for stalls
 * - Redirect support
 * - "Settle once" so you don't see late ghost logs after success
 */
function downloadFile(url, finalPath, retries = RETRIES, timeoutMs = TIMEOUT_MS, redirectsLeft = MAX_REDIRECTS) {
  const tempPath = `${finalPath}.part`;

  return new Promise((resolve, reject) => {
    let settled = false;

    const settleOnce = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };

    const attemptDownload = (attempt, currentUrl, redirectsRemaining) => {
      if (settled) return;

      console.log(`📥 Downloading (${attempt}/${retries}): ${currentUrl}`);

      safeUnlink(tempPath);

      const file = fs.createWriteStream(tempPath);
      let req = null;
      let res = null;

      const cleanup = () => {
        try { if (res) res.removeAllListeners(); } catch {}
        try { if (req) req.removeAllListeners(); } catch {}
        try { file.removeAllListeners(); } catch {}
      };

      const fail = (msg) => {
        if (settled) return;

        try { if (res) res.destroy(); } catch {}
        try { if (req) req.destroy(); } catch {}

        file.close(() => {
          safeUnlink(tempPath);
          cleanup();

          const isRetryable = !msg.startsWith('HTTP 4');
          if (attempt < retries && isRetryable) {
            console.log(`🔁 Retrying (${attempt + 1}/${retries}) in ${RETRY_DELAY_MS}ms after: ${msg}`);
            setTimeout(() => attemptDownload(attempt + 1, currentUrl, redirectsRemaining), RETRY_DELAY_MS);
            return;
          }
          return settleOnce(reject, msg);
        });
      };

      req = https.get(currentUrl, (response) => {
        res = response;

        // Redirects
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const nextUrl = new URL(res.headers.location, currentUrl).toString();
          file.close(() => {
            safeUnlink(tempPath);
            cleanup();
            if (redirectsRemaining <= 0) return fail('too many redirects');
            console.log(`➡️ Redirect ${res.statusCode} -> ${nextUrl}`);
            return attemptDownload(attempt, nextUrl, redirectsRemaining - 1);
          });
          return;
        }

        if (res.statusCode !== 200) {
          res.resume();
          return fail(`HTTP ${res.statusCode}`);
        }

        // Stall timeout while downloading
        req.setTimeout(timeoutMs, () => fail(`timeout after ${timeoutMs}ms`));

        res.on('aborted', () => fail('response aborted'));
        res.on('error', (e) => fail(`response error: ${e.message}`));
        file.on('error', (e) => fail(`file error: ${e.message}`));

        res.pipe(file);

        file.on('finish', () => {
          if (settled) return;

          file.close(() => {
            const actualSize = (() => { try { return fs.statSync(tempPath).size; } catch { return 0; } })();
            const contentLength = res.headers['content-length'];
            const expected = contentLength ? parseInt(contentLength, 10) : null;

            const integrityMsg =
              (expected !== null && actualSize !== expected)
                ? `incomplete: got ${actualSize}B, expected ${expected}B`
              : (expected === null && actualSize < MIN_FILE_SIZE_BYTES)
                ? `file too small: ${actualSize}B (min ${MIN_FILE_SIZE_BYTES}B)`
              : null;

            if (integrityMsg) {
              console.log(`⚠️  ${integrityMsg}`);
              safeUnlink(tempPath);
              cleanup();
              if (attempt < retries) {
                console.log(`🔁 Retrying (${attempt + 1}/${retries}) in ${RETRY_DELAY_MS}ms`);
                setTimeout(() => attemptDownload(attempt + 1, currentUrl, redirectsRemaining), RETRY_DELAY_MS);
                return;
              }
              return settleOnce(reject, integrityMsg);
            }

            fs.rename(tempPath, finalPath, (err) => {
              cleanup();
              if (err) {
                safeUnlink(tempPath);
                return settleOnce(reject, `rename failed: ${err.message}`);
              }
              console.log(`✅ Downloaded: ${finalPath}`);
              return settleOnce(resolve, finalPath);
            });
          });
        });
      });

      req.on('error', (e) => fail(`request error: ${e.message}`));
    };

    attemptDownload(1, url, redirectsLeft);
  });
}

// ✅ YOUR RULE IMPLEMENTED HERE:
// 1) Try to get headers from MAIN within 6s
// 2) If not -> switch to FALLBACK immediately
// 3) If main responded -> download from main (with retries). If it still fails -> fallback.
async function downloadFileWithSmartFallback(originalUrl, filePath, fileName) {
  const encodedName = getEncodedFileNameFromUrl(originalUrl);
  const fallbackUrl = FALLBACK_BASE + encodedName;

  // Step A: decide server based on "respond within 6s?"
  let useFallbackFirst = false;
  try {
    await waitForHeaders(originalUrl, MAIN_RESPONSE_TIMEOUT_MS);
    console.log(`⏱️ Main responded < ${MAIN_RESPONSE_TIMEOUT_MS}ms — use MAIN for ${fileName}`);
  } catch (e) {
    useFallbackFirst = true;
    console.log(`🌩️ Main did NOT respond in ${MAIN_RESPONSE_TIMEOUT_MS}ms — switch to FALLBACK for ${fileName}`);
  }

  // Step B: download
  if (useFallbackFirst) {
    await downloadFile(fallbackUrl, filePath);
    return { used: 'fallback', url: fallbackUrl };
  }

  // Main responded in time → try main download, if it fails after retries → fallback
  try {
    await downloadFile(originalUrl, filePath);
    return { used: 'original', url: originalUrl };
  } catch (e) {
    console.log(`🌩️ Main download failed after retries — trying FALLBACK: ${fallbackUrl}`);
    await downloadFile(fallbackUrl, filePath);
    return { used: 'fallback', url: fallbackUrl };
  }
}

// 📌 Main download logic
async function downloadTracks() {
  const urls = fs.readFileSync(txtFilePath, 'utf-8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  const totalTracks = urls.length;

  let existingCount = 0;
  let downloadedCount = 0;
  let failedCount = 0;
  let fallbackUsedCount = 0;

  const downloadedFiles = [];

  console.log(`📜 Found ${totalTracks} track(s) in the list\n`);

  for (const url of urls) {
    const encodedName = getEncodedFileNameFromUrl(url);

    let fileName = encodedName;
    try { fileName = decodeURIComponent(encodedName); } catch {}

    const filePath = path.join(downloadDirectory, fileName);

    console.log(`\n🎵 Track: ${fileName}`);

    if (fileExists(filePath)) {
      console.log(`⏩ Skipping (already exists): ${fileName}`);
      existingCount++;
      downloadedFiles.push(fileName); // keep your behavior
      continue;
    }

    try {
      const res = await downloadFileWithSmartFallback(url, filePath, fileName);
      downloadedFiles.push(fileName);
      downloadedCount++;

      if (res.used === 'fallback') {
        fallbackUsedCount++;
        console.log(`🛰️ Used fallback server for: ${fileName}`);
      }
    } catch (error) {
      console.error(`❌ Failed both main & fallback: ${url}`);
      failedCount++;
      // cleanup leftover .part if any
      safeUnlink(`${filePath}.part`);
    }
  }

  if (downloadedFiles.length > 0) {
    fs.writeFileSync(outputFilePath, downloadedFiles.join('\n'), 'utf-8');
    console.log(`\n📝 Saved list to ${outputFilePath}`);
  }

  console.log(`\n============= SUMMARY =============`);
  console.log(`Total listed:       ${totalTracks}`);
  console.log(`Already present:    ${existingCount}`);
  console.log(`Downloaded:         ${downloadedCount}`);
  console.log(`Fallback used:      ${fallbackUsedCount}`);
  console.log(`Failed:             ${failedCount}`);
  console.log(`===================================\n`);
}

// 🚀 Run it
downloadTracks()
  .then(() => console.log('🎉 All done!'))
  .catch((err) => console.error('Unexpected error:', err));
