const path = require("path");
require('dotenv').config()

const { BASE_ID, TABLE_ID } = process.env

// FLEXIBLE PLAYLIST CONFIGURATION - Easy to modify!
const playlistConfig = {
    // For 2 playlists (current setup):
    //playlists: [
    //  { name: 'day', file: path.resolve(__dirname, './tracksDay.txt'), startHour: 15, endHour: 16 },
    //  { name: 'night', file: path.resolve(__dirname, './tracksNight.txt'), startHour: 16, endHour: 2 }
    //],

    // For 1 playlist, replace above with:
    playlists: [
        // __dirname always points to the directory of the current file
        { name: 'all', file: path.resolve(__dirname, './tracksAllDay.txt'), startHour: 9, endHour: 2 }
    ],

    // For 3 playlists, replace above with:
    // playlists: [
    //   { name: 'morning', file: path.resolve(__dirname, './tracksMorning.txt'), startHour: 15, endHour: 18 },
    //   { name: 'evening', file: path.resolve(__dirname, './tracksEvening.txt'), startHour: 18, endHour: 22 },
    //   { name: 'night', file: path.resolve(__dirname, './tracksNight.txt'), startHour: 22, endHour: 2 }
    // ],

    stopHour: 2,
    startHour: 9,
    baseId: BASE_ID,
    tableId: TABLE_ID
};

module.exports = playlistConfig
