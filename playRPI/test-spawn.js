var soundplayer = require("sound-player");
var options = {
    filename: '/home/spherepi-peremena/test.mp3',
    gain: 0,
    debug: true,
    player: "mpg123",	
device: "plughw:2,0"
};

console.log("Attempting to create player...");
var player = new soundplayer(options);

console.log("Attempting to play...");
player.play();

player.once('complete', function() { 
    console.log('SUCCESS: Track completed'); 
});

player.once('error', function(err) { 
    console.log('ERROR:', err); 
});

setTimeout(() => {
    console.log("Timeout reached");
    process.exit(0);
}, 5000);
