///////////modules for player
var fs = require('fs');
var soundplayer = require("sound-player");
const loudness = require('mwl-loudness');
var volume = 0;
const playlistConfig = require('./playlistConfig')

///////////modules for server
const express = require("express")
const path = require("path");

////////////variables for player
var i = 0;
var currentPlaylist, allPlaylists = {}, currentTrackName, currentTrackPath, player;


var options = {
    gain: 0,
    debug: false,
    player: "mpg123",
}

////////////variables and settings for server
const app = express();
const port = process.env.PORT || 3333;
const static_path = path.join(__dirname, "public");
app.use(express.static(static_path));
app.use(express.urlencoded({ extended: true })); 

////////////////////////////////////////////////////server
app.post("/request", (req, res) => {
      if (req.body.value == 'like') {
        scheduleLikeDislike({newStatus: 'Like'})
        console.log("if like condition occured");
      } else if (req.body.value == 'dislike') {
        scheduleLikeDislike({newStatus: 'Dislike'})
        console.log("if dislike condition occured");
        // deletingTrackFromTXT(currentTrackName);
      } else if (req.body.value == 'volumeDown') {
          if (volume == 0) {
            res.send("min");
            return;
          }
          else {
            volume = volume - 2;
            loudness.setVolume(volume);
            res.send(""+volume);
            return;
          }
        }
      else if (req.body.value == 'volumeUp') {
          if (volume == 100) {
            res.send("max");
            return;
          }
          else {
            volume = volume + 2;
            loudness.setVolume(volume);
            res.send(""+volume);
            return;
          }
        }
      
      // Find current playlist name for response
      const currentPlaylistName = getCurrentPlaylistName();
      var arrayResponse = [currentTrackName, currentPlaylistName + " list"];
      res.send(arrayResponse);
})

app.get('/volumeData', (req, res) => {
  res.send(""+volume);
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
    console.log("Not music time - stopping");
    server.close();
    return;
  }
}

checkingOnReboot();

function playerInitialization() {
  console.log("playerInitialization called");
  console.log("Current working directory:", process.cwd());
  
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
    console.log("No tracks in current playlist");
    return;
  }

  options.filename = currentPlaylist[i];
  currentTrackName = currentPlaylist[i].split("music/")[1];
  
  console.log("playSong called, track:", currentTrackName);
  console.log("Full path:", options.filename);
  console.log("File exists:", fs.existsSync(options.filename));

  player = new soundplayer(options);

  player.play();
  player.once('complete', function(){
    const stats = collectStats();

    if (likeDislikeStatus.scheduled) {
      if (likeDislikeStatus.newStatus === 'Dislike') {
        deletingTrackFromTXT(currentTrackName);
      }

      // use here the same object, although it may be not the best name for it
      sendLikeDislike(stats)
      resetLikeDislikeScheduledValues()
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

function sendLikeDislike(status) {
  // fetch()
}
//
function collectStats() {
  const timestamp =  new Date().toLocaleString('ru-RU')

  const data = {
    "baseId": playlistConfig.baseId,
    "trackName": currentTrackName,
    "Played at": timestamp,
    "Index in a playlist":i,
    "Playlist name":getCurrentPlaylistName(),
    "newStatus": likeDislikeStatus.newStatus
  }

  return data
}

async function sendSongStats(data) {
  try {
    const updateSongStatsApiEndpoint = 'https://pi-stats-1025869845226.europe-west1.run.app/'

    const response = await fetch(updateSongStatsApiEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data)
    })

    console.log(1.1)
    const text = await response
    console.log(1.)
    console.log(text)

    return text

  } catch (error) {
    console.log(11)
  }
}




//       sendSongStats()



function loadNextTrack() {
  // Check if playlist should change
  const activePlaylistConfig = getCurrentPlaylistConfig();

  if (!activePlaylistConfig) {
    console.log("No active playlist - stopping");
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

// helper functions
// (functions that don't modify app's state)
function parseTracksList (data) {
  if (!fs.existsSync(data)) {
    console.log(`Playlist file not found: ${data}`);
    return [];
  }
  
  var arrayList = fs.readFileSync(data, 'utf8').split(/\r\n|\r|\n/g);
  
  for (var j = 0; j < arrayList.length; j++) {
    if (arrayList[j].trim() !== '') {
      arrayList[j] = path.resolve(__dirname, 'music',  arrayList[j]);
      // arrayList[j] = "/home/spherepi-peremena/sphere/playRPI/music/" + arrayList[j];
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

// like dislike status

let likeDislikeStatus = {
  scheduled: false,
  newStatus: null
}

// parse an object parameter and get its newStatus key
const scheduleLikeDislike = ({ newStatus }) => {
  // make sure first letter is capitalized
  const firstLetter = newStatus[0].toUpperCase()
  const status = firstLetter + newStatus.toLowerCase().slice(1)

  likeDislikeStatus = {
    scheduled: true,
    newStatus: status
  }
}

const resetLikeDislikeScheduledValues = () => {
  // clean up
  likeDislikeStatus = {
    scheduled: false,
    newStatus: null
  }
}
