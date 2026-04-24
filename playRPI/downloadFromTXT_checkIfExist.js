const fs = require('fs');
const https = require('https');
const path = require('path');

// 📂 Paths
const txtFilePath = './sphere/playRPI/tracksToDownload.txt';
const downloadDirectory = './sphere/playRPI/music';
const outputFilePath = './sphere/playRPI/downloadedTracks.txt';

// ✅ Ensure the music directory exists
if (!fs.existsSync(downloadDirectory)) {
  fs.mkdirSync(downloadDirectory, { recursive: true });
}

// 📌 Check if file already exists
function fileExists(filePath) {
  return fs.existsSync(filePath);
}

// 📌 Download a file with retries
function downloadFile(url, filePath, retries = 3) {
  return new Promise((resolve, reject) => {
    const attemptDownload = (attempt) => {
      console.log(`📥 Downloading (${attempt}/${retries}): ${url}`);

      const file = fs.createWriteStream(filePath);
      https.get(url, (response) => {
        if (response.statusCode !== 200) {
          console.error(`❌ HTTP ${response.statusCode}: ${url}`);
          return attempt < retries
            ? attemptDownload(attempt + 1)
            : reject(`Failed after ${retries} attempts: ${url}`);
        }

        response.pipe(file);
        file.on('finish', () => {
          file.close(() => resolve(filePath));
          console.log(`✅ Downloaded: ${filePath}`);
        });
      }).on('error', (err) => {
        console.error(`⚠️ Error: ${err.message}`);
        fs.unlink(filePath, () => {
          if (attempt < retries) {
            console.log(`🔁 Retrying (${attempt + 1}/${retries})`);
            attemptDownload(attempt + 1);
          } else {
            reject(`Failed after ${retries} attempts: ${url}`);
          }
        });
      });
    };

    attemptDownload(1);
  });
}

// 📌 Main download logic
async function downloadTracks() {
  const urls = fs.readFileSync(txtFilePath, 'utf-8').split('\n').filter(Boolean);
  const totalTracks = urls.length;

  let existingCount = 0;
  let downloadedCount = 0;
  let failedCount = 0;
  const downloadedFiles = [];

  console.log(`📜 Found ${totalTracks} track(s) in the list\n`);

  for (const url of urls) {
    const fileName = decodeURIComponent(path.basename(url));
    const filePath = path.join(downloadDirectory, fileName);

    if (fileExists(filePath)) {
      existingCount++;
      downloadedFiles.push(fileName); // Include even if already present
      continue;
    }

    try {
      await downloadFile(url, filePath);
      downloadedFiles.push(fileName);
      downloadedCount++;
    } catch (error) {
      console.error(`❌ Failed to download: ${url}`);
      failedCount++;
    }
  }

  // 📝 Save all available file names to a text file
  if (downloadedFiles.length > 0) {
    fs.writeFileSync(outputFilePath, downloadedFiles.join('\n'), 'utf-8');
    console.log(`📝 Saved list to ${outputFilePath}`);
  }

  // 📊 Final summary
  console.log(`\n============= SUMMARY =============`);
  console.log(`Total listed:     ${totalTracks}`);
  console.log(`Already present:  ${existingCount}`);
  console.log(`Downloaded:       ${downloadedCount}`);
  console.log(`Failed:           ${failedCount}`);
  console.log(`===================================\n`);
}

// 🚀 Run it
downloadTracks()
  .then(() => console.log('🎉 All done!'))
  .catch((err) => console.error('Unexpected error:', err));