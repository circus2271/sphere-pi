# playRPI

Raspberry Pi music player with Airtable integration.

## How it works

On boot, the player syncs with Airtable to download any new tracks, then plays music according to a time-based playlist schedule. A small Express server runs alongside the player to handle like/dislike votes and volume control from the web UI.

## Setup

1. Copy `example.playlistConfig.js` to `_playlistConfig.js` and fill in your values:
   - `baseId` — Airtable base ID
   - `tableId` per playlist — Airtable table ID for each playlist
   - `startHour` / `endHour` — when each playlist is active (24h, handles midnight rollover)
   - `file` — path to the `.txt` file listing track filenames

2. Create a `.env` file if needed (see `.gitignore` for gitignored files).

3. Install dependencies:
   ```
   npm install
   ```

4. Run:
   ```
   node node-sound-player-production.js
   ```

## Boot sequence

1. **Airtable sync** — fetches the track list for each configured playlist from the `getPlaylistTracks` serverless function, downloads any missing mp3s into `music/`, and overwrites the `.txt` playlist files with locally available tracks.
2. **Time check** — if the current time is outside all playlist windows, the process exits.
3. **Playback** — shuffles the active playlist and starts playing.

If the sync fails (network down, function error), the player falls back to whatever tracks are already in `music/` and continues.

## Serverless function contract

The Airtable sync expects a `getPlaylistTracks` Cloud Function to be deployed:

```
POST https://europe-central2-sphere-385104.cloudfunctions.net/getPlaylistTracks

Request body:
{
  "baseId": "appXXXXXXXXXXXXXX",
  "tableId": "tblXXXXXXXXXXXXXX"
}

Response:
{
  "tracks": [
    { "name": "Artist - Title.mp3", "url": "https://..." },
    ...
  ]
}
```

- `name` must be the plain filename (no path) — it will be saved to `music/<name>`
- `url` is the direct download link (from the long-text field in Airtable)
- Only return **active** tracks — disliked tracks should be excluded on the server side, as the returned list overwrites the local playlist on every boot

## Existing Cloud Functions

| Endpoint | Purpose |
|---|---|
| `POST /updateRecordStatus` | Records a like or dislike for a track |
| `POST /updateSongStats` | Records play stats (timestamp, index, device) |
| `POST /getPlaylistTracks` | Returns the track list for a playlist *(needs implementing)* |

## File structure

```
playRPI/
  node-sound-player-production.js  — main entry point
  _airtableSync.js                 — boot-time sync with Airtable
  _helpers.js                      — stats, API calls, playlist utilities
  _likeDislikeService.js           — tracks pending like/dislike per song
  _playlistConfig.js               — your config (gitignored)
  example.playlistConfig.js        — config template
  music/                           — downloaded mp3s (gitignored)
  public/                          — web UI served by Express
```
