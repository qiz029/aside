import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import type { AudioSessionCoordinator } from "../mobile/src/audio-session.js";

/** Run the actual mobile adapter and coordinator, replacing only the OS APIs. */
async function fixture(t: TestContext, platform = "ios", rejectRoute = false) {
  const events: string[] = [];
  const key = `asideAudioRoute_${crypto.randomUUID()}`;
  const globals = globalThis as unknown as Record<string, unknown>;
  globals[key] = { events };
  t.after(() => delete globals[key]);
  const ref = `globalThis[${JSON.stringify(key)}]`;
  const modules: Record<string, string> = {
    "expo-audio": `
      const events = ${ref}.events;
      export const AudioModule = {};
      export const createAudioPlayer = () => ({});
      export async function setIsAudioActiveAsync(active) { events.push('active:' + active); }
      export async function setAudioModeAsync(mode) {
        events.push(mode.allowsRecording ? 'expo:record' : 'expo:playback');
      }
    `,
    "react-native": `
      const events = ${ref}.events;
      export const Platform = { OS: ${JSON.stringify(platform)} };
      export const NativeModules = { AsideAudioSession: {
        async configureVoiceChat() {
          events.push('voice-chat');
          if (${rejectRoute}) throw Error('HFP route failed');
        },
        async setAnswerEnabled(enabled) { events.push('answer:' + enabled); },
        async setInputEnabled(enabled) { events.push('input:' + enabled); },
        async setVoiceFocusEnabled(enabled) { events.push('focus:' + enabled); },
      }};
    `,
  };
  const bundle = await build({
    entryPoints: ["mobile/src/audio.ts"],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    loader: { ".wav": "dataurl" },
    plugins: [
      {
        name: "native-audio-boundaries",
        setup(builder) {
          builder.onResolve(
            { filter: /^(expo-audio|react-native)$/ },
            ({ path }) => ({ path, namespace: "native-test" }),
          );
          builder.onLoad(
            { filter: /.*/, namespace: "native-test" },
            ({ path }) => ({ contents: modules[path], loader: "js" }),
          );
        },
      },
    ],
  });
  const { AudioCoordinator } = (await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
  )) as { AudioCoordinator: new () => AudioSessionCoordinator };
  const coordinator = new AudioCoordinator();
  coordinator.bindPodcast({
    pause() {
      events.push("podcast:pause");
    },
    resume() {
      events.push("podcast:resume");
    },
  });
  return { coordinator, events };
}

test("iOS enables duplex routing before capture and restores media defaults after conversation", async (t) => {
  const { coordinator: c, events } = await fixture(t);
  await c.playPodcast();
  events.length = 0;
  const owner = Symbol();
  await c.listen(owner);
  assert.deepEqual(events, [
    "podcast:pause",
    "answer:false",
    "input:false",
    "active:false",
    "expo:record",
    "voice-chat",
    "active:true",
    "input:true",
    "answer:true",
    "podcast:resume",
  ]);
  events.length = 0;
  await c.pausePodcast();
  await c.answer(owner);
  await c.playPodcast();
  assert.deepEqual([...events], [], "pause/answer/resume retains the duplex route");
  await c.finishQuestion(owner);
  assert.deepEqual(events, [
    "podcast:pause",
    "answer:false",
    "input:false",
    "active:false",
    "expo:playback",
    "active:true",
    "podcast:resume",
  ]);
  events.length = 0;
  await c.record(Symbol());
  assert.ok(events.includes("expo:record"));
  assert.ok(
    !events.includes("voice-chat"),
    "manual capture retains Expo defaults",
  );
});

test("a rejected duplex route never starts raw capture and permits a later media session", async (t) => {
  const { coordinator: c, events } = await fixture(t, "ios", true);
  await c.playPodcast();
  events.length = 0;
  await assert.rejects(c.listen(Symbol()), /HFP route failed/);
  assert.ok(!events.includes("input:true"));
  assert.ok(!events.includes("answer:true"));
  assert.equal(events.at(-1), "active:false");
  events.length = 0;
  await c.playPodcast();
  assert.ok(events.includes("expo:playback"));
  assert.equal(events.at(-1), "podcast:resume");
});

test("Android keeps its existing focus and input ownership without the iOS route API", async (t) => {
  const { coordinator: c, events } = await fixture(t, "android");
  await c.listen(Symbol());
  assert.ok(!events.includes("voice-chat"));
  assert.ok(events.includes("focus:true"));
  assert.ok(events.indexOf("focus:true") < events.indexOf("input:true"));
});
