import { type Page } from "@playwright/test";
import type { Episode } from "@aside/engine/core";

// A local silent WAV exercises the real media element without model or backend calls.
const wav = Buffer.alloc(44 + 8000 * 2 * 60);
wav.write("RIFF", 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write("data", 36);
wav.writeUInt32LE(wav.length - 44, 40);
export const episodes: Episode[] = ["a", "b"].map((id) => ({
  id: `remote-${id}`,
  title: `Remote sample ${id}`,
  durationMs: 60000,
  createdAt: "2026-09-14",
  status: "ready",
  stage: "ready",
  progress: 1,
  analysis: {
    version: "1",
    source: "demo",
    summary: "Remote control sample",
    hostStyle: "",
    speakers: [],
    voice: "feminine",
    voiceReason: "test",
    passages: [
      {
        id: "first",
        startMs: 0,
        endMs: 20000,
        text: "First passage",
        speaker: "host",
      },
      {
        id: "second",
        startMs: 20000,
        endMs: 40000,
        text: "Second passage",
        speaker: "host",
      },
    ],
    anchors: [
      {
        id: "first",
        startMs: 0,
        endMs: 20000,
        text: "First passage",
        confidence: 1,
      },
      {
        id: "second",
        startMs: 20000,
        endMs: 40000,
        text: "Second passage",
        confidence: 1,
      },
    ],
  },
}));

export async function mockPlayer(page: Page) {
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if(path === "/api/podcasts/subscriptions") return route.fulfill({json:{subscriptions:[],episodes:[]}});
    if (path === "/api/health")
      return route.fulfill({
        json: {
          liveConfigured: false,
          uploadsEnabled: false,
          microphone: { threshold: 0.025, minSpeechMs: 120, silenceMs: 650 },
          voiceLifecycle: { preRollMs: 750, graceMs: 5000, idleCloseMs: 60000 },
        },
      });
    if (path === "/api/auth/session")
      return route.fulfill({ json: { user: null } });
    if (path === "/api/episodes") return route.fulfill({ json: episodes });
    if (path.endsWith("/checkpoint")) {
      if (route.request().method() === "PUT") {
        const checkpoint = route.request().postDataJSON();
        return route.fulfill({
          json: { ...checkpoint, version: (checkpoint.version ?? 0) + 1 },
        });
      }
      return route.fulfill({ json: null });
    }
    if (path.endsWith("/audio")) {
      const range = /bytes=(\d+)-(\d*)/.exec(
        route.request().headers().range ?? "",
      );
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2]
        ? Math.min(Number(range[2]), wav.length - 1)
        : wav.length - 1;
      return route.fulfill({
        status: range ? 206 : 200,
        contentType: "audio/wav",
        headers: {
          "Accept-Ranges": "bytes",
          ...(range
            ? { "Content-Range": `bytes ${start}-${end}/${wav.length}` }
            : {}),
        },
        body: wav.subarray(start, end + 1),
      });
    }
    const episode = episodes.find((e) => path === `/api/episodes/${e.id}`);
    if (episode) return route.fulfill({ json: episode });
    // Block all unanticipated endpoints, including paid ones.
    return route.fulfill({
      status: 404,
      json: { error: "Not available in player test" },
    });
  });
}
