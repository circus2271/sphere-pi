const fs = require('fs');
const https = require('https');
const http = require('http');
const path = require('path');
const fetch = require('node-fetch');

const basePath = 'https://europe-central2-sphere-385104.cloudfunctions.net';
const getPlaylistTracksEndpoint = `${basePath}/getPlaylistTracks`;

const musicDir = path.resolve(__dirname, 'music');

const RETRIES = 3;
const RETRY_DELAY_MS = 3000;
const DOWNLOAD_TIMEOUT_MS = 30000;
const MIN_FILE_SIZE_BYTES = 100 * 1024; // 100 KB

function safeUnlink(filePath) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function downloadFile(url, finalPath) {
    const tempPath = `${finalPath}.part`;

    return new Promise((resolve, reject) => {
        let settled = false;

        const settleOnce = (fn, val) => {
            if (settled) return;
            settled = true;
            fn(val);
        };

        const attemptDownload = (attempt) => {
            if (settled) return;
            console.log(`  Downloading (${attempt}/${RETRIES}): ${path.basename(finalPath)}`);

            safeUnlink(tempPath);
            const file = fs.createWriteStream(tempPath);
            let req = null;
            let res = null;

            const cleanup = () => {
                try { if (res) res.removeAllListeners(); } catch {}
                try { if (req) req.removeAllListeners(); } catch {}
                try { file.removeAllListeners(); } catch {}
            };

            const fail = async (msg) => {
                if (settled) return;
                try { if (res) res.destroy(); } catch {}
                try { if (req) req.destroy(); } catch {}
                file.close(() => {
                    safeUnlink(tempPath);
                    cleanup();
                    if (attempt < RETRIES) {
                        console.log(`  Retry in ${RETRY_DELAY_MS}ms (${msg})`);
                        setTimeout(() => attemptDownload(attempt + 1), RETRY_DELAY_MS);
                    } else {
                        settleOnce(reject, new Error(msg));
                    }
                });
            };

            const lib = url.startsWith('https') ? https : http;
            req = lib.get(url, (response) => {
                res = response;

                if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume();
                    file.close(() => {
                        safeUnlink(tempPath);
                        cleanup();
                        // follow redirect as new attempt on same count
                        url = new URL(res.headers.location, url).toString();
                        setTimeout(() => attemptDownload(attempt), 0);
                    });
                    return;
                }

                if (res.statusCode !== 200) {
                    res.resume();
                    fail(`HTTP ${res.statusCode}`);
                    return;
                }

                req.setTimeout(DOWNLOAD_TIMEOUT_MS, () => fail(`timeout after ${DOWNLOAD_TIMEOUT_MS}ms`));
                res.on('error', e => fail(`response error: ${e.message}`));
                file.on('error', e => fail(`file error: ${e.message}`));
                res.pipe(file);

                file.on('finish', () => {
                    if (settled) return;
                    file.close(() => {
                        const actualSize = (() => { try { return fs.statSync(tempPath).size; } catch { return 0; } })();
                        const contentLength = res.headers['content-length'];
                        const expected = contentLength ? parseInt(contentLength, 10) : null;

                        if (expected !== null && actualSize !== expected) {
                            fail(`incomplete: got ${actualSize}B, expected ${expected}B`);
                            return;
                        }
                        if (expected === null && actualSize < MIN_FILE_SIZE_BYTES) {
                            fail(`file too small: ${actualSize}B`);
                            return;
                        }

                        fs.rename(tempPath, finalPath, err => {
                            cleanup();
                            if (err) {
                                safeUnlink(tempPath);
                                settleOnce(reject, new Error(`rename failed: ${err.message}`));
                            } else {
                                settleOnce(resolve, finalPath);
                            }
                        });
                    });
                });
            });

            req.on('error', e => fail(`request error: ${e.message}`));
        };

        attemptDownload(1);
    });
}

async function fetchTrackList(baseId, tableId) {
    const response = await fetch(getPlaylistTracksEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseId, tableId }),
    });

    if (!response.ok) {
        throw new Error(`getPlaylistTracks returned HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!Array.isArray(data.tracks)) {
        throw new Error('getPlaylistTracks response missing "tracks" array');
    }

    return data.tracks; // [{ name, url }]
}

async function syncPlaylist(baseId, playlistConf) {
    console.log(`[sync] Fetching track list for playlist: ${playlistConf.name}`);

    const tracks = await fetchTrackList(baseId, playlistConf.tableId);
    console.log(`[sync] ${tracks.length} track(s) in Airtable for "${playlistConf.name}"`);

    if (!fs.existsSync(musicDir)) {
        fs.mkdirSync(musicDir, { recursive: true });
    }

    const locallyAvailable = [];
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;

    for (const track of tracks) {
        const filePath = path.join(musicDir, track.name);

        if (fs.existsSync(filePath)) {
            locallyAvailable.push(track.name);
            skipped++;
            continue;
        }

        try {
            await downloadFile(track.url, filePath);
            locallyAvailable.push(track.name);
            downloaded++;
        } catch (err) {
            console.error(`[sync] Failed to download "${track.name}": ${err.message}`);
            failed++;
        }
    }

    // Overwrite the playlist txt file with tracks available locally
    fs.writeFileSync(playlistConf.file, locallyAvailable.join('\n'), 'utf-8');

    console.log(`[sync] "${playlistConf.name}": ${skipped} already present, ${downloaded} downloaded, ${failed} failed`);
    return { downloaded, skipped, failed };
}

async function syncAllPlaylists(playlistConfig) {
    const playlists = playlistConfig.playlists.filter(p => p.tableId);

    if (playlists.length === 0) {
        console.log('[sync] No playlists have a tableId — skipping Airtable sync');
        return;
    }

    console.log(`[sync] Starting Airtable sync for ${playlists.length} playlist(s)`);

    for (const playlistConf of playlists) {
        try {
            await syncPlaylist(playlistConfig.baseId, playlistConf);
        } catch (err) {
            console.error(`[sync] Failed to sync playlist "${playlistConf.name}": ${err.message}`);
            console.log(`[sync] Continuing with existing local tracks for "${playlistConf.name}"`);
        }
    }

    console.log('[sync] Airtable sync complete');
}

module.exports = { syncAllPlaylists };
