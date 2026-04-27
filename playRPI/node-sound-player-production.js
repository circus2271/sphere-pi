///////////modules for player
var fs = require('fs');
var soundplayer = require('sound-player');
const loudness = require('mwl-loudness');
var volume = 0;
const playlistConfig = require('./_playlistConfig')
const likeDislikeService = require('./_likeDislikeService')
const {parseTracksList, shuffle, getCurrentPlaylistConfig, collectStats, deletingTrackFromTXT, sendLikeDislike, sendSongStats} = require('./_helpers')
///////////modules for server
const express = require('express')
const path = require('path');

////////////variables for player
var i = 0;
var currentPlaylist, allPlaylists = {}, currentTrackName, player;


var options = {
    gain: 0,
    debug: false,
    player: 'mpg123',
}

////////////variables and settings for server
const app = express();
const port = process.env.PORT || 3333;
const static_path = path.join(__dirname, 'public');
app.use(express.static(static_path));
app.use(express.urlencoded({ extended: true })); 

////////////////////////////////////////////////////server
app.post('/request', (req, res) => {
      if (req.body.value == 'like') {
        likeDislikeService.scheduleLikeDislike({newStatus: 'Like'})
        console.log('if like condition occured');
      } else if (req.body.value == 'dislike') {
        likeDislikeService.scheduleLikeDislike({newStatus: 'Dislike'})
        console.log('if dislike condition occured');
        // deletingTrackFromTXT(currentTrackName);
      } else if (req.body.value == 'volumeDown') {
          if (volume == 0) {
            res.send('min');
            return;
          }
          else {
            volume = volume - 2;
            loudness.setVolume(volume);
            res.send(''+volume);
            return;
          }
        }
      else if (req.body.value == 'volumeUp') {
          if (volume == 100) {
            res.send('max');
            return;
          }
          else {
            volume = volume + 2;
            loudness.setVolume(volume);
            res.send(''+volume);
            return;
          }
        }
      
      // Find current playlist name for response
      const currentPlaylistName = getCurrentPlaylistName();
      var arrayResponse = [currentTrackName, currentPlaylistName + ' list'];
      res.send(arrayResponse);
})

app.get('/volumeData', (req, res) => {
  res.send(''+volume);
})

const server = app.listen(port, () => {
  console.log(`server is running at ${port}`);
});


/////////////////////////////////////////////////player
function checkingOnReboot() {
  var currentTime = new Date;
  const currentHour = currentTime.getHours();
  
  // Check if we're in any playlist time range
  const activePlaylist = getCurrentPlaylistConfig();
  
  if (activePlaylist) {
    console.log(`Music time - ${activePlaylist.name} playlist active`);
    playerInitialization();
  } else { 
    console.log('Not music time - stopping');
    server.close();
    return;
  }
}

checkingOnReboot();

function playerInitialization() {
  console.log('playerInitialization called');
  console.log('Current working directory:', process.cwd());
  
  loudness.setVolume(volume);

  // Load all configured playlists
  playlistConfig.playlists.forEach(playlistConf => {
    console.log(`Loading ${playlistConf.name} playlist: ${fs.existsSync(playlistConf.file)}`);
    allPlaylists[playlistConf.name] = parseTracksList(playlistConf.file);
    shuffle(allPlaylists[playlistConf.name]);
  });

  // Set current playlist based on time
  const activePlaylistConfig = getCurrentPlaylistConfig();
  if (activePlaylistConfig) {
    currentPlaylist = allPlaylists[activePlaylistConfig.name];
    console.log(`Active playlist: ${activePlaylistConfig.name}`);
  }

  playSong();
}     

function playSong () {
  if (!currentPlaylist || currentPlaylist.length === 0) {
    console.log('No tracks in current playlist');
    return;
  }

  options.filename = currentPlaylist[i];
  currentTrackName = currentPlaylist[i].split('music/')[1];
  
  console.log('playSong called, track:', currentTrackName);
  console.log('Full path:', options.filename);
  console.log('File exists:', fs.existsSync(options.filename));

  player = new soundplayer(options);

  player.play();
  player.once('complete', function(){
    const stats = collectStats(currentTrackName, likeDislikeService, i);

    if (stats.newStatus) {
      if (stats.newStatus === 'Dislike') {
        deletingTrackFromTXT(currentTrackName);
      }

      // use here the same object, although it may be not the best name for it
      sendLikeDislike(stats)
      likeDislikeService.resetLikeDislikeScheduledValues()
    }

    // to hopefully bypass airtable's 5 requests per second limit
    setTimeout(() => {
      sendSongStats(stats)
    }, 2000)
    loadNextTrack();
  });

  player.once('error', function(err) {
    console.log('Error on player occurred:', err);
    console.log('Skipping to next track...');
    loadNextTrack(); // Skip to next track on error
  });
}

function loadNextTrack() {
  // Check if playlist should change
  const activePlaylistConfig = getCurrentPlaylistConfig();

  if (!activePlaylistConfig) {
    console.log('No active playlist - stopping');
    process.exit(0);
    return;
  }

  const newPlaylist = allPlaylists[activePlaylistConfig.name];

  // If playlist changed, switch and reset index
  if (newPlaylist !== currentPlaylist) {
    console.log(`Switching to ${activePlaylistConfig.name} playlist`);
    currentPlaylist = newPlaylist;
    i = 0;
  } else {
    // Continue with current playlist
    if (i >= currentPlaylist.length - 1) {
      i = 0;
    } else {
      i += 1;
    }
  }

  playSong();
}
