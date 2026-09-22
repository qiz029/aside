import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("Android input restarts a reused recorder and suppresses samples revoked during read", () => {
  const dir = mkdtempSync(join(tmpdir(), "aside-input-"));
  try {
    mkdirSync(join(dir, "android/media"), { recursive: true });
    writeFileSync(
      join(dir, "android/media/AudioRecord.java"),
      `
package android.media;
import java.nio.ByteBuffer;
public class AudioRecord {
  public static final int RECORDSTATE_RECORDING=3;
  public int starts, state=1;
  public Runnable duringRead;
  public void startRecording(){ starts++; state=3; }
  public void stop(){ state=1; }
  public int getRecordingState(){ return state; }
  public int getSampleRate(){ return 48000; }
  public int getChannelCount(){ return 1; }
  public int read(ByteBuffer pcm,int bytes){
    for(int i=0;i<bytes;i++)pcm.put(i,(byte)127);
    if(duringRead!=null){ duringRead.run(); return -3; }
    return bytes;
  }
}`,
    );
    writeFileSync(
      join(dir, "android/media/AudioTrack.java"),
      `
package android.media;
import java.nio.ByteBuffer;
public class AudioTrack {
  public int getSampleRate(){return 48000;}
  public int getChannelCount(){return 1;}
  public int write(ByteBuffer pcm,int bytes,int mode){return bytes;}
}`,
    );
    writeFileSync(
      join(dir, "InputTest.java"),
      `
package com.aside.audio;
import android.media.AudioRecord;
import java.nio.ByteBuffer;
public class InputTest {
  static void check(boolean b){if(!b)throw new AssertionError();}
  public static void main(String[] args){
    AudioRecord source=new AudioRecord(); ByteBuffer pcm=ByteBuffer.allocate(16);
    AsideAudioPipeline.start(source);
    check(source.starts==0);
    check(AsideAudioPipeline.read(source,pcm,16)==16);
    for(int i=0;i<16;i++)check(pcm.get(i)==0);
    AsideAudioPipeline.enableInput(true);
    check(AsideAudioPipeline.read(source,pcm,16)==16);
    check(source.starts==1 && AsideAudioPipeline.inputLevel>0);
    AsideAudioPipeline.enableInput(false); check(source.state==1);
    AsideAudioPipeline.enableInput(true);
    AsideAudioPipeline.read(source,pcm,16); check(source.starts==2);
    source.duringRead=()->AsideAudioPipeline.enableInput(false);
    check(AsideAudioPipeline.read(source,pcm,16)==16);
    check(AsideAudioPipeline.inputLevel==0);
    for(int i=0;i<16;i++)check(pcm.get(i)==0);
    AsideAudioPipeline.enableInput(true);
    source.duringRead=()->{ AsideAudioPipeline.enableInput(false); AsideAudioPipeline.enableInput(true); };
    check(AsideAudioPipeline.read(source,pcm,16)==16);
    for(int i=0;i<16;i++)check(pcm.get(i)==0);
    AsideAudioPipeline.stop(source);
    check(AsideAudioPipeline.recorder==null);
  }
}`,
    );
    execFileSync("javac", [
      "-d",
      dir,
      join(dir, "android/media/AudioRecord.java"),
      join(dir, "android/media/AudioTrack.java"),
      resolve("mobile/native/android/AsidePcmQueue.java"),
      resolve("mobile/native/android/AsideAudioPipeline.java"),
      join(dir, "InputTest.java"),
    ]);
    execFileSync("java", ["-cp", dir, "com.aside.audio.InputTest"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
