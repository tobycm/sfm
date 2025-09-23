import { App } from "@slack/bolt";
import { BunSqliteKeyValue } from "bun-sqlite-key-value";

console.log("Hello via Bun!");

const apiKey = "4fe5ea349553b84027c2b0d1c950a41f";
const fetchInterval = 5 * 1000;

interface NowPlayingResponse {
  recenttracks?: {
    track?: Array<{
      name: string;
      artist: { "#text": string };
      album: { "#text": string };
      url: string;
      "@attr"?: { nowplaying: string };
    }>;
  };
}

function getNowPlayingUrl(user: string): string {
  return `https://ws.audioscrobbler.com/2.0/?method=user.getrecenttracks&user=${user}&api_key=${apiKey}&limit=1&format=json`;
}

async function fetchNowPlaying(user: string): Promise<NowPlayingResponse> {
  const response = await fetch(getNowPlayingUrl(user));

  if (!response.ok) throw new Error(`Error fetching from Last.fm: ${response.statusText}`);

  return (await response.json()) as NowPlayingResponse;
}

const db = new BunSqliteKeyValue("./data/sfm.sqlite");

if (!process.env.SLACK_SIGNING_SECRET) throw new Error("SLACK_SIGNING_SECRET is not set");
if (!process.env.SLACK_APP_TOKEN) throw new Error("SLACK_APP_TOKEN is not set");
if (!process.env.SLACK_BOT_TOKEN) throw new Error("SLACK_BOT_TOKEN is not set");

const app = new App({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  appToken: process.env.SLACK_APP_TOKEN!,
  token: process.env.SLACK_BOT_TOKEN!,
  socketMode: true,
  //   logLevel: LogLevel.DEBUG,
});

app.command("/sfm", async ({ command, ack, say }) => {
  await ack();

  if (db.hGet("channels", command.channel_id)) {
    db.hDelete("channels", command.channel_id);
    await say(`:white_check_mark: Removed last.fm tracking for <#${command.channel_id}>`);
    return;
  }

  const username = command.text.trim();
  if (!username) {
    await say(`:x: Please provide a last.fm username. Usage: \`/sfm <lastfm_username>\``);
    return;
  }

  db.hSet("channels", command.channel_id, username);
  await say(`:white_check_mark: Set last.fm username to *${username}* for <#${command.channel_id}>`);
});

await app.start();

console.log("⚡️ Bolt app is running!");

setInterval(async () => {
  const channels = db.hGetFields("channels");
  if (!channels?.length) return;

  for (const channel of channels) {
    try {
      const username = (await db.hGet("channels", channel))!;

      const data = await fetchNowPlaying(username);
      const track = data.recenttracks?.track?.[0];
      if (track?.["@attr"]?.nowplaying !== "true") {
        // Not currently playing
        db.hDelete("lastTracks", channel);
        db.hDelete("threadMessage", channel);
        continue;
      }

      const lastTrackId = await db.hGet("lastTracks", channel);
      const currentTrackId = `${track.artist["#text"]} - ${track.name}`;
      if (lastTrackId === currentTrackId) continue;

      db.hSet("lastTracks", channel, currentTrackId);

      const threadMessageTs = db.hGet<string>("threadMessage", channel);

      let text = `:musical_note: <${track.url}|${track.name}> by *${track.artist["#text"]}*`;

      if (!threadMessageTs) {
        text = `*${username}* is now playing:\n` + text;
      }

      if (track.album["#text"]) {
        text += ` from _${track.album["#text"]}_`;
      }

      const message = await app.client.chat.postMessage({
        channel,
        thread_ts: threadMessageTs,
        text,
      });

      if (!threadMessageTs) {
        db.hSet("threadMessage", channel, message.ts);
      }
    } catch (error) {
      console.error(`Error processing channel ${channel}:`, error);
    }
  }
}, fetchInterval);
