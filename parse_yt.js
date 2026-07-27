const fs = require('fs');
const html = fs.readFileSync('raw_channel.html', 'utf8');
const match = html.match(/ytInitialData\s*=\s*({.*?});<\/script>/);
if (match) {
  const data = JSON.parse(match[1]);
  fs.writeFileSync('ytInitialData.json', JSON.stringify(data, null, 2));
  console.log("Parsed ytInitialData");
} else {
  console.log("No ytInitialData found");
}
