const path = require("path");

// FLEXIBLE PLAYLIST CONFIGURATION - Easy to modify!
const playlistConfig = {
    // For 2 playlists (current setup):
    //playlists: [
    //  { name: 'day', file: path.resolve(__dirname, './tracksDay.txt'), startHour: 15, endHour: 16, tableId: '' },
    //  { name: 'night', file: path.resolve(__dirname, './tracksNight.txt'), startHour: 16, endHour: 2, tableId: '' }
    //],

    // For 1 playlist, replace above with:
    playlists: [
        // __dirname always points to the directory of the current file
        { name: 'all', file: path.resolve(__dirname, './tracksAllDay.txt'), startHour: 9, endHour: 2, tableId: '' }
    ],

    // For 3 playlists, replace above with:
    // playlists: [
    //   { name: 'morning', file: path.resolve(__dirname, './tracksMorning.txt'), startHour: 15, endHour: 18, tableId: '' },
    //   { name: 'evening', file: path.resolve(__dirname, './tracksEvening.txt'), startHour: 18, endHour: 22, tableId: '' },
    //   { name: 'night', file: path.resolve(__dirname, './tracksNight.txt'), startHour: 22, endHour: 2, tableId: '' }
    // ],

    stopHour: 2,
    startHour: 9,
    baseId: '',
};

module.exports = playlistConfig
