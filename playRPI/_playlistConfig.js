const path = require("path");

// FLEXIBLE PLAYLIST CONFIGURATION - Easy to modify!
const _playlistConfig = {
    // For 2 playlists (current setup):
    //playlists: [
    //  { name: 'day', file: '/home/spherepi-peremena/sphere/playRPI/tracksDay.txt', startHour: 15, endHour: 16 },
    //  { name: 'night', file: '/home/spherepi-peremena/sphere/playRPI/tracksNight.txt', startHour: 16, endHour: 2 }
    //],

    // For 1 playlist, replace above with:
    playlists: [
        // { name: 'all', file: '/home/spherepi-peremena/sphere/playRPI/tracksAllDay.txt', startHour: 9, endHour: 2 }
        // __dirname always points to the directory of the current file
        { name: 'all', file: path.resolve(__dirname, './tracksAllDay.txt'), startHour: 9, endHour: 2 }
    ],

    // For 3 playlists, replace above with:
    // playlists: [
    //   { name: 'morning', file: '/home/spherepi-peremena/sphere/playRPI/tracksMorning.txt', startHour: 15, endHour: 18 },
    //   { name: 'evening', file: '/home/spherepi-peremena/sphere/playRPI/tracksEvening.txt', startHour: 18, endHour: 22 },
    //   { name: 'night', file: '/home/spherepi-peremena/sphere/playRPI/tracksNight.txt', startHour: 22, endHour: 2 }
    // ],

    stopHour: 2,
    startHour: 9,
    baseId: ''
};

module.exports = _playlistConfig