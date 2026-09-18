package com.aside.audio;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import com.facebook.react.modules.core.DeviceEventManagerModule;
import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.*;
import com.facebook.react.uimanager.ViewManager;
import java.util.Collections;
import java.util.List;

public final class AsideAudioPackage implements ReactPackage {
  @Override public List<NativeModule> createNativeModules(ReactApplicationContext context) {
    return Collections.singletonList(new Session(context));
  }
  @Override public List<ViewManager> createViewManagers(ReactApplicationContext context) {
    return Collections.emptyList();
  }
  static final class Session extends ReactContextBaseJavaModule implements LifecycleEventListener {
    private final AudioManager manager;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AudioFocusRequest focus;
    private boolean focusHeld;
    private final BroadcastReceiver noisy = new BroadcastReceiver() {
      @Override public void onReceive(Context context, Intent intent) { interrupt(); }
    };
    Session(ReactApplicationContext context) {
      super(context);
      manager = (AudioManager)context.getSystemService(Context.AUDIO_SERVICE);
      focus = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
          .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
        .setWillPauseWhenDucked(true)
        .setOnAudioFocusChangeListener(change -> { if (change < 0) interrupt(); }, main).build();
      IntentFilter filter = new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY);
      if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(noisy, filter, Context.RECEIVER_NOT_EXPORTED);
      else context.registerReceiver(noisy, filter);
      context.addLifecycleEventListener(this);
    }
    private void release() {
      AsideAudioPipeline.enableInput(false);
      AsideAudioPipeline.outputEnabled = false;
      AsideAudioPipeline.queue.command(AsidePcmQueue.DISCARD);
      if (focusHeld) { focusHeld = false; manager.abandonAudioFocusRequest(focus); }
    }
    private void interrupt() {
      if (!focusHeld) return;
      release();
      ReactApplicationContext context = getReactApplicationContext();
      if (context.hasActiveReactInstance()) context
        .getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter.class)
        .emit("AsideAnswerInterrupted", null);
    }
    @Override public void invalidate() {
      main.post(() -> {
        release();
        getReactApplicationContext().unregisterReceiver(noisy);
        getReactApplicationContext().removeLifecycleEventListener(this);
      });
      super.invalidate();
    }
    @Override public String getName() { return "AsideAudioSession"; }
    @ReactMethod public void setAnswerEnabled(boolean enabled, Promise result) {
      AsideAudioPipeline.outputEnabled = enabled;
      result.resolve(null);
    }
    @ReactMethod public void setVoiceFocusEnabled(boolean enabled, Promise result) {
      main.post(() -> {
        if (enabled && !focusHeld) {
          if (manager.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            result.reject("audio_focus", "Audio is in use. Try again after the call or other audio ends."); return;
          }
          focusHeld = true;
        }
        if (!enabled && focusHeld) { focusHeld = false; manager.abandonAudioFocusRequest(focus); }
        result.resolve(null);
      });
    }
    @ReactMethod public void setInputEnabled(boolean enabled, Promise result) {
      AsideAudioPipeline.enableInput(enabled); result.resolve(null);
    }
    @ReactMethod public void resetOutput(double generation, Promise result) {
      AsideAudioPipeline.reset((long)generation); result.resolve(null);
    }
    @ReactMethod public void outputCommand(double generation, double epoch, int mode, Promise result) {
      AsideAudioPipeline.command((long)generation, (long)epoch, mode); result.resolve(null);
    }
    @ReactMethod public void audioStatus(Promise result) {
      AsidePcmQueue q = AsideAudioPipeline.queue;
      WritableMap status = Arguments.createMap();
      synchronized (q) {
        status.putInt("mode", q.mode); status.putBoolean("active", q.active);
        status.putBoolean("drained", q.drained()); status.putInt("overflows", q.overflows);
        status.putDouble("receivedFrames", q.received); status.putDouble("playedThroughFrame", q.through);
        status.putDouble("bufferedMs", (double)q.size * 1000 / q.rate);
      }
      status.putDouble("generation", AsideAudioPipeline.generation);
      status.putDouble("inputLevel", AsideAudioPipeline.inputLevel);
      result.resolve(status);
    }
    @Override public void onHostPause() {
      release();
    }
    @Override public void onHostDestroy() { onHostPause(); }
    @Override public void onHostResume() {}
    @ReactMethod public void addListener(String name) {}
    @ReactMethod public void removeListeners(double count) {}
  }
}
