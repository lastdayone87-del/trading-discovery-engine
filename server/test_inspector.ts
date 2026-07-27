
import { runChannelInspection } from './inspector';

const testChannels = [
  {
    name: "Discord link directly in the About description",
    youtubeUrl: "https://www.youtube.com/@ThePrimeagen", 
    data: {
      channelId: "UC8butISFwT-Wl7EV0hUK0BQ",
      channelBio: "",
      channelLinks: []
    }
  },
  {
    name: "No Discord anywhere",
    youtubeUrl: "https://www.youtube.com/@GoogleDevelopers",
    data: {
      channelId: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
      channelBio: "",
      channelLinks: []
    }
  },
  {
    name: "Discord link in the channel header links",
    youtubeUrl: "https://www.youtube.com/@fireship",
    data: {
      channelId: "UCENv8px8g345rD4X1Q98CqA",
      channelBio: "",
      channelLinks: []
    }
  }
];

async function runTests() {
  const results = [];
  for (const channel of testChannels) {
    console.log(`Testing: ${channel.name}`);
    const result = await runChannelInspection({
        ...channel.data,
        youtubeUrl: channel.youtubeUrl,
        enableDebug: true,
        forceLiveFetch: true
    });
    results.push({ name: channel.name, result });
    console.log(`Finished ${channel.name}`);
  }
  console.log(JSON.stringify(results, null, 2));
}

runTests().catch(console.error);
