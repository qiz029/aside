package com.aside.audio;

import android.media.AudioRecord;
import android.media.AudioTrack;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.concurrent.locks.LockSupport;

/** Hooks run on WebRTC's native audio threads, before hardware write / media send. */
public final class AsideAudioPipeline {
  static volatile AsidePcmQueue queue = new AsidePcmQueue(48000, 30);
  static volatile boolean inputEnabled, outputEnabled;
  static volatile double inputLevel;
  static volatile AudioRecord recorder;
  static volatile long generation;
  static int requestedMode;
  static long epoch;

  public static synchronized void reset(long nextGeneration) {
    if (nextGeneration < generation) return;
    generation = nextGeneration; epoch = 0; requestedMode = 0;
    queue = new AsidePcmQueue(48000, 30); inputLevel = 0;
  }
  public static synchronized void command(long owner, long nextEpoch, int mode) {
    if (owner != generation || nextEpoch < epoch) return;
    epoch = nextEpoch; requestedMode = mode; queue.command(mode);
  }
  public static int write(AudioTrack track, ByteBuffer pcm, int bytes, int writeMode) {
    int rate = track.getSampleRate() * track.getChannelCount();
    synchronized (AsideAudioPipeline.class) {
      if (queue.rate != rate) {
        queue = new AsidePcmQueue(rate, 30); queue.command(requestedMode);
      }
    }
    if (outputEnabled) queue.process(pcm, bytes);
    else for (int i = 0; i < bytes; i++) pcm.put(i, (byte)0);
    return track.write(pcm, bytes, writeMode);
  }
  public static void start(AudioRecord source) {
    recorder = source;
    if (inputEnabled) source.startRecording();
  }
  public static int state(AudioRecord source) {
    return inputEnabled ? source.getRecordingState() : AudioRecord.RECORDSTATE_RECORDING;
  }
  public static void stop(AudioRecord source) {
    if (source.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING) source.stop();
    if (recorder == source) recorder = null;
  }
  public static void enableInput(boolean enabled) {
    inputEnabled = enabled;
    inputLevel = 0;
    // Native lifecycle closes capture immediately, even when JS is suspended.
    AudioRecord source = recorder;
    if (!enabled && source != null && source.getRecordingState() == AudioRecord.RECORDSTATE_RECORDING)
      source.stop();
  }
  public static int read(AudioRecord source, ByteBuffer pcm, int bytes) {
    if (!inputEnabled) {
      inputLevel = 0;
      for (int i = 0; i < bytes; i++) pcm.put(i, (byte)0);
      // A real RTP clock for manual answers, without starting the hardware microphone.
      long nanos = (long)bytes * 1_000_000_000L / (2L * source.getSampleRate() * source.getChannelCount());
      LockSupport.parkNanos(nanos);
      return bytes;
    }
    int count = source.read(pcm, bytes);
    double energy = 0;
    pcm.order(ByteOrder.nativeOrder());
    for (int i = 0; i + 1 < count; i += 2) {
      double sample = pcm.getShort(i) / 32768.0; energy += sample * sample;
    }
    inputLevel = count > 0 ? Math.sqrt(energy / (count / 2)) : 0;
    // Capture may have been revoked while the blocking AudioRecord.read ran.
    if (!inputEnabled) for (int i = 0; i < Math.max(0, count); i++) pcm.put(i, (byte)0);
    return count;
  }
}
