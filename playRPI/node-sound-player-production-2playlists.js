///////////modules for player
var fs = require('fs');
var soundplayer = require("sound-player");
const loudness = require('mwl-loudness');
var volume = 0;

///////////modules for server
const express = require("express")
const path = require("path");

////////////variables for player
var i = 0;
var playingList, dayList, nightList, currentTrackName, currentTrackPath, player;
//const hourForPlayingList2 = 18;
//здесь учесть время, когда музыку нужно вырубать. если время отключения меньше 00 то ниже в функциях checkingOnReboot, playerInitialization тоже условия нужно поменять

const hourForStartingMusic = 5;
const hourStartNightPlaylist = 16;

const hourForStoppingMusic = 2;

const dayListPath = '/home/spherepi-peremena/sphere/playRPI/tracksDay.txt';
const nightListPath = '/home/spherepi-peremena/sphere/playRPI/tracksNight.txt';

var options = {
    gain: 0,
    debug: false,
    //player: "/usr/bin/mpg123",
    player: "mpg123",
}

////////////variables and settings for server
const app = express();
const port = process.env.PORT || 3333;
// Setting path for public directory
const static_path = path.join(__dirname, "public");
app.use(express.static(static_path));
app.use(express.urlencoded({ extended: true })); 

////////////////////////////////////////////////////server
// Handling request
app.post("/request", (req, res) => {

      //console.log(req.body.value);

      if (req.body.value == 'like') {
        console.log("if like condition occured");
        //console.log(playingList);
      } else if (req.body.value == 'dislike') {
        console.log("if dislike condition occured");
        deletingTrackFromTXT(currentTrackName);
      } else if (req.body.value == 'volumeDown') {
        
          //checkin if it is already 0 volume
          if (volume == 0) {
            //sending MAX to client
            res.send("min");
            return;
          }
          else {
            volume = volume - 2;
            loudness.setVolume(volume);
            //sending volume data 
            res.send(""+volume);
            return;
          }
        
        }
      else if (req.body.value == 'volumeUp') {
        
        //checkin if it is already MAX (100) volume
          if (volume == 100) {
            //sending MAX to client
            res.send("max");
            return;
          }
          else {
            volume = volume + 2;
            loudness.setVolume(volume);
            //sending volume data 
            res.send(""+volume);
            return;
          }
        
        }
      
      if (playingList == dayList) {
        var arrayResponse = [currentTrackName, "Day list"];
        res.send(arrayResponse);
        }
      else {
        var arrayResponse = [currentTrackName, "Night list"];
        res.send(arrayResponse);
        }  
      
      //res.json([{	value_recieved: req.body.value,designation_recieved: req.designation.body}])
})

//sending volume data
app.get('/volumeData', (req, res) => {
  res.send(""+volume);
  })


// Server Setup
const server = app.listen(port, () => {
//console.log(`server is running at ${port}`);
});

//////////////////////////////////////////////////fs function deleting from dislikes
function deletingTrackFromTXT(trackName) {
  const pathToFile = (playingList === dayList) ? dayListPath : nightListPath;
  
  // Read lines into array
  let lines = fs.readFileSync(pathToFile, 'utf8')
    .split(/\r?\n/)
    .filter(line => line.trim() !== '' && line.trim() !== trackName.trim()); // remove exact match

  // Write back joined with newlines
  fs.writeFileSync(pathToFile, lines.join('\n'), 'utf8');

  console.log((playingList === dayList) ? "DAYLIST DISLIKE" : "NIGHTLIST DISLIKE");
}


/////////////////////////////////////////////////player
function checkingOnReboot() {

  var currentTime = new Date;
  //здесь учесть время, когда музыку нужно вырубать
  if ( (currentTime.getHours() >= hourForStartingMusic) || (currentTime.getHours() < hourForStoppingMusic) ) {
    //console.log("its music time");
    playerInitialization();
  } else { 
  //console.log("its not the time for music");
  server.close();
  return;
  }

}

checkingOnReboot();

function playerInitialization() {
  
            console.log("playerInitialization called1");
  console.log("Current working directory:", process.cwd());
  
  // Check if files exist
  console.log("Day list exists:", fs.existsSync(dayListPath));
  console.log("Night list exists:", fs.existsSync(nightListPath));
  
          loudness.setVolume(volume);

          dayList = parseTracksList(dayListPath);
          nightList = parseTracksList(nightListPath);

          shuffle(dayList);
          shuffle(nightList);
          
          
          
          //console.log(dayList)
          //console.log(nightList)

          var currentTime = new Date();
          var currentHour = currentTime.getHours();

          if (currentHour >= hourForStartingMusic && currentHour < hourStartNightPlaylist) {
            console.log('day time')
            playingList = dayList;
          } else if (currentHour != hourForStoppingMusic) {
            playingList = nightList;
            console.log('night time')
          } 
          

          playSong();
}     

function loadNextTrack() {

      var currentTime = new Date();
      var currentHour = currentTime.getHours();

      // Исправленная логика выбора плейлиста
          if (currentHour >= hourForStartingMusic && currentHour < hourStartNightPlaylist) {
            console.log('day time')
            playingList = dayList;
          } else if (currentHour != hourForStoppingMusic) {
            playingList = nightList;
            console.log('night time')
          } else {
            process.exit(0);
            return;
          }

      // Переход к следующему треку или начало сначала
      if (i >= playingList.length - 1) {
          i = 0;
      } else {
          i += 1;
      }

      playSong();
}
 
  
      
function playSong () {
  

            options.filename = playingList[i];
          currentTrackName = playingList[i].split("music/")[1];
          
                      console.log("playSong called, track:", currentTrackName);
  console.log("Full path:", options.filename);
  console.log("File exists:", fs.existsSync(options.filename));
            

          player = new soundplayer(options);


          //options.filename = playingList[i];
          //currentTrackName = playingList[i].split("music/")[1];
          
          //console.log('------- i = '+ i + '    track name=' + currentTrackName);
          //console.log(playingList==dayList);
          //console.log(playingList==nightList);

          player.play();
          player.once('complete', function(){
            loadNextTrack();
            });

           player.once('error', function(err) {
            //console.log('Error on player occurred:', err);
           });
      }; 

function parseTracksList (data) {

            var arrayList = fs.readFileSync(data, 'utf8').split(/\r\n|\r|\n/g);
         
            for (var i=0;i<arrayList.length;i++) {
                arrayList[i]="/home/spherepi-peremena/sphere/playRPI/music/"+arrayList[i];
            }
            return arrayList;
}

function shuffle(array) {
              var currentIndex = array.length, temporaryValue, randomIndex;

             // While there remain elements to shuffle...
              while (0 !== currentIndex) {
               // Pick a remaining element...
              randomIndex = Math.floor(Math.random() * currentIndex);
              currentIndex -= 1;
              // And swap it with the current element.
              temporaryValue = array[currentIndex];
              array[currentIndex] = array[randomIndex];
              array[randomIndex] = temporaryValue;
              }

              return array;
}









