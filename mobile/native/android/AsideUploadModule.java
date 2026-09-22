package com.aside.audio;

import android.content.Intent;
import android.os.Build;
import com.facebook.react.bridge.*;

/** React only starts/observes the service; it never owns the transfer loop. */
public final class AsideUploadModule extends ReactContextBaseJavaModule {
  AsideUploadModule(ReactApplicationContext context) { super(context); }
  @Override public String getName() { return "AsideUpload"; }
  @ReactMethod public void start(String id, String base, String token, String uri,
      double size, double partSize, String parts, Promise promise) {
    try {
      if (!AsideUploadService.prepare(getReactApplicationContext(), id, base, uri, (long)size, (int)partSize, parts)) {
        promise.resolve(null); return;
      }
      Intent intent = new Intent(getReactApplicationContext(), AsideUploadService.class)
        .putExtra("id", id).putExtra("token", token);
      if (Build.VERSION.SDK_INT >= 26) getReactApplicationContext().startForegroundService(intent);
      else getReactApplicationContext().startService(intent);
      promise.resolve(null);
    } catch (Exception error) {
      AsideUploadService.failedStart(getReactApplicationContext(), id);
      promise.reject("upload_start", "Unable to start upload. Keep Aside open and retry.", error);
    }
  }
  @ReactMethod public void status(String id, Promise promise) {
    try { promise.resolve(AsideUploadService.status(getReactApplicationContext(), id)); }
    catch (Exception error) { promise.reject("upload_status", "Unable to read upload progress", error); }
  }
  @ReactMethod public void cancel(String id, Promise promise) {
    try { AsideUploadService.discard(getReactApplicationContext(), id); promise.resolve(null); }
    catch (Exception error) { promise.reject("upload_cancel", "Unable to cancel upload", error); }
  }
}
