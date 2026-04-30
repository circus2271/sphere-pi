const fs = require('fs');
const path = require('path');

const playlistConfig = require('./_playlistConfig');

// helper functions
// (functions that don't modify app's state)
function collectStats(currentTrackName, likeDislikeService, currentTrackIndex) {
    const timestamp =  new Date().toLocaleString('ru-RU')

    const data = {
        'baseId': playlistConfig.baseId,
        'tableId': getCurrentPlaylistTableId(),
        'trackName': currentTrackName,
        'Played at': timestamp,
        'Index in a playlist': currentTrackIndex,
        'Playlist name': getCurrentPlaylistName(),
    }

    if (likeDislikeService.scheduled) {
        data['newStatus'] = likeDislikeService.newStatus
    }

    return data
}

const basePath = 'https://europe-central2-sphere-385104.cloudfunctions.net'
const updateRecordApiEndpoint = `${basePath}/updateRecordStatus`
const updateSongStatsApiEndpoint = `${basePath}/updateSongStats`

const sendLikeDislike = async data => {

    try {

        const response = await send(updateRecordApiEndpoint, data)

        return response.json()

    } catch (error) {
        console.log(error)
    }
}

const sendSongStats = async data => {

    try {

        const response = await send(updateSongStatsApiEndpoint, data)

        return response.text()

    } catch (error) {
        console.log(error)
    }
}

function send(url, data) {
    return fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(data)
    })
}

function parseTracksList (data) {
    if (!fs.existsSync(data)) {
        console.log(`Playlist file not found: ${data}`);
        return [];
    }

    var arrayList = fs.readFileSync(data, 'utf8').split(/\r\n|\r|\n/g);

    for (var j = 0; j < arrayList.length; j++) {
        if (arrayList[j].trim() !== '') {
            arrayList[j] = path.resolve(__dirname, 'music',  arrayList[j]);
            // arrayList[j] = '/home/spherepi-peremena/sphere/playRPI/music/' + arrayList[j];
        }
    }

    // Filter out empty lines
    return arrayList.filter(track => track.includes('/music/'));
}

function shuffle(array) {
    var currentIndex = array.length, temporaryValue, randomIndex;

    while (0 !== currentIndex) {
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex -= 1;
        temporaryValue = array[currentIndex];
        array[currentIndex] = array[randomIndex];
        array[randomIndex] = temporaryValue;
    }

    return array;
}

//////////////////////////////////////////////////fs function deleting from dislikes
function deletingTrackFromTXT(trackName) {
    const currentPlaylistConfig = getCurrentPlaylistConfig();
    if (!currentPlaylistConfig) return;

    const pathToFile = currentPlaylistConfig.file;

    let lines = fs.readFileSync(pathToFile, 'utf8')
        .split(/\r?\n/)
        .filter(line => line.trim() !== '' && line.trim() !== trackName.trim());

    fs.writeFileSync(pathToFile, lines.join('\n'), 'utf8');
    console.log(`DISLIKE from ${currentPlaylistConfig.name.toUpperCase()} playlist`);
}

// Helper function to get current playlist configuration
function getCurrentPlaylistConfig() {
    const currentHour = new Date().getHours();

    for (const playlist of playlistConfig.playlists) {
        if (isHourInRange(currentHour, playlist.startHour, playlist.endHour)) {
            return playlist;
        }
    }
    return null;
}

// Helper function to get current playlist name
function getCurrentPlaylistName() {
    const config = getCurrentPlaylistConfig();
    return config ? config.name : 'unknown';
}

function getCurrentPlaylistTableId() {
    const config = getCurrentPlaylistConfig();
    // return config ? config.tableId : 'unknown';
    return config.tableId;
}

// Helper function to check if hour is within range (handles midnight rollover)
function isHourInRange(hour, startHour, endHour) {
    if (startHour <= endHour) {
        // Same day range (e.g., 15-18)
        return hour >= startHour && hour < endHour;
    } else {
        // Crosses midnight (e.g., 22-2)
        return hour >= startHour || hour < endHour;
    }
}

module.exports = {
    parseTracksList,
    shuffle,
    deletingTrackFromTXT,
    getCurrentPlaylistConfig,
    // getCurrentPlaylistName,
    // isHourInRange,
    collectStats,
    sendLikeDislike,
    sendSongStats
}
