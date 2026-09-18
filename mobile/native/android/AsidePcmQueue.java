package com.aside.audio;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/** Native playout FIFO. Kept equivalent to AsidePcmQueue.h and tested with the same PCM traces. */
public final class AsidePcmQueue {
  public static final int DISCARD = 0, HOLD = 1, PLAY = 2, OVERFLOW = 3;
  final short[] data;
  public final int rate;
  int head, size, audible, mode, overflows;
  long received, played, through, discarded, quiet;
  boolean started, active;
  public AsidePcmQueue(int rate, int seconds) {
    if (rate < 1 || rate > 192000 || seconds < 1 || seconds > 30)
      throw new IllegalArgumentException("Invalid PCM capacity");
    this.rate = rate; data = new short[rate * seconds];
  }
  private void clear() {
    discarded += size; head = size = audible = 0; started = active = false; quiet = 0;
  }
  public synchronized void command(int next) {
    if (mode == OVERFLOW) return;
    if (next == DISCARD) clear();
    if (next != HOLD || mode == DISCARD) mode = next;
  }
  public synchronized void process(ByteBuffer pcm, int bytes) {
    pcm.order(ByteOrder.nativeOrder());
    int count = bytes / 2;
    received += count;
    if (mode == DISCARD || mode == OVERFLOW) {
      discarded += count;
      for (int i = 0; i < count; i++) pcm.putShort(i * 2, (short)0);
      return;
    }
    for (int i = 0; i < count; i++) {
      short value = pcm.getShort(i * 2);
      if (Math.abs((int)value) > 3) started = true;
      if (mode == HOLD && !started && size >= rate / 5) {
        head = (head + 1) % data.length; size--; discarded++;
      }
      if (size == data.length) {
        clear(); mode = OVERFLOW; overflows++;
        for (int j = 0; j < count; j++) pcm.putShort(j * 2, (short)0);
        return;
      }
      data[(head + size++) % data.length] = value;
      if (Math.abs((int)value) > 32) audible++;
    }
    double energy = 0;
    int read = mode == PLAY ? Math.min(count, size) : 0;
    for (int i = 0; i < count; i++) {
      short value = 0;
      if (i < read) {
        value = data[head]; head = (head + 1) % data.length;
        if (Math.abs((int)value) > 32) audible--;
      }
      energy += (double)value * value;
      pcm.putShort(i * 2, value);
    }
    if (mode == PLAY) { size -= read; played += read; through = received - size; }
    boolean loud = count > 0 && energy / count > Math.pow(32768 * 0.008, 2);
    quiet = loud ? 0 : quiet + count;
    active = mode == PLAY && (loud || (active && quiet < rate * 0.9));
  }
  public synchronized boolean drained() {
    return mode == PLAY && played > 0 && !active && audible == 0 && quiet >= rate * 0.9;
  }
}
