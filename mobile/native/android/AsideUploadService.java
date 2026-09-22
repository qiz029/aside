package com.aside.audio;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.*;
import android.util.AtomicFile;
import com.facebook.react.bridge.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import org.json.*;
import okhttp3.*;
import okio.BufferedSink;

/** User-started dataSync service. Journals contain no credential and live in no-backup storage. */
public final class AsideUploadService extends Service {
  private static final Object LOCK = new Object();
  private static final String CHANNEL = "aside-uploads";
  private static final int NOTIFICATION = 7341;
  private static Job active;
  private static final ExecutorService worker = Executors.newSingleThreadExecutor();
  private static final OkHttpClient client = new OkHttpClient.Builder()
    .connectTimeout(20, TimeUnit.SECONDS).readTimeout(60, TimeUnit.SECONDS)
    .writeTimeout(60, TimeUnit.SECONDS).callTimeout(120, TimeUnit.SECONDS)
    .followRedirects(false).followSslRedirects(false).build();
  private PowerManager.WakeLock wakeLock;
  private Job owned;
  private final Handler main = new Handler(Looper.getMainLooper());

  private static final class Job {
    final String id, base, uri;
    final long size;
    final int partSize;
    final List<AsideUploadTransfer.Part> parts = new ArrayList<>();
    String state = "paused";
    volatile boolean stopped;
    volatile Call call;
    boolean running;
    Job(String id, String base, String uri, long size, int partSize) {
      this.id = id; this.base = base; this.uri = uri; this.size = size; this.partSize = partSize;
    }
  }
  private static File journal(Context context, String id) {
    UUID.fromString(id);
    return new File(context.getNoBackupFilesDir(), "aside-upload-" + id + ".json");
  }
  private static JSONArray partsJson(List<AsideUploadTransfer.Part> parts) throws JSONException {
    JSONArray result = new JSONArray();
    for (AsideUploadTransfer.Part part : parts)
      result.put(new JSONObject().put("partNumber", part.number).put("etag", part.etag));
    return result;
  }
  private static void readParts(Job job, JSONArray parts) throws JSONException {
    for (int i = 0; i < parts.length(); i++) {
      JSONObject part = parts.getJSONObject(i);
      job.parts.add(new AsideUploadTransfer.Part(part.getInt("partNumber"), part.getString("etag")));
    }
  }
  private static Job read(Context context, String id) throws Exception {
    File file = journal(context, id);
    if (!file.exists()) return null;
    try (InputStream input = new AtomicFile(file).openRead()) {
      JSONObject value = new JSONObject(new String(readBytes(input), StandardCharsets.UTF_8));
      Job job = new Job(id, value.getString("base"), value.getString("uri"), value.getLong("size"), value.getInt("partSize"));
      job.state = value.getString("state");
      // The OS may have killed the old process. Only a new user action resumes it.
      if (job.state.equals("uploading") || job.state.equals("processing")) job.state = "paused";
      readParts(job, value.getJSONArray("parts"));
      return job;
    }
  }
  private static void save(Context context, Job job) throws IOException {
    AtomicFile file = new AtomicFile(journal(context, job.id));
    FileOutputStream output = null;
    try {
      JSONObject value = new JSONObject().put("base", job.base).put("uri", job.uri)
        .put("size", job.size).put("partSize", job.partSize).put("state", job.state)
        .put("parts", partsJson(job.parts));
      output = file.startWrite();
      output.write(value.toString().getBytes(StandardCharsets.UTF_8));
      file.finishWrite(output);
    } catch (Exception error) {
      if (output != null) file.failWrite(output);
      throw new IOException("Unable to save upload progress", error);
    }
  }
  static boolean prepare(Context context, String id, String base, String uri, long size, int partSize, String parts) throws Exception {
    synchronized (LOCK) {
      journal(context, id);
      Uri origin = Uri.parse(base);
      if (!("https".equals(origin.getScheme()) || "http".equals(origin.getScheme())) ||
          origin.getHost() == null || origin.getUserInfo() != null || origin.getQuery() != null ||
          origin.getFragment() != null || !(origin.getPath().isEmpty() || origin.getPath().equals("/")) ||
          size <= 0 || size > 1024L * 1024 * 1024 || partSize <= 0 || partSize > 64 * 1024 * 1024)
        throw new IOException("Invalid upload request");
      if (!"file".equals(Uri.parse(uri).getScheme())) throw new IOException("Upload requires a local file");
      File source = new File(Uri.parse(uri).getPath()).getCanonicalFile();
      String root = new File(context.getApplicationInfo().dataDir).getCanonicalPath() + File.separator;
      if (!source.getPath().startsWith(root) || !source.isFile() || source.length() != size)
        throw new IOException("Upload file is unavailable");
      if (active != null && !active.stopped &&
          (active.state.equals("uploading") || active.state.equals("processing"))) {
        if (!active.id.equals(id)) throw new IOException("Another upload is running");
        return false;
      }
      Job job = read(context, id);
      if (job == null) { job = new Job(id, base, uri, size, partSize); readParts(job, new JSONArray(parts)); }
      if (!job.base.equals(base) || !job.uri.equals(uri) || job.size != size || job.partSize != partSize)
        throw new IOException("Upload does not match its saved progress");
      if (job.state.equals("cancelled") || job.state.equals("done")) return false;
      job.state = "uploading";
      save(context, job);
      active = job;
      return true;
    }
  }
  static void failedStart(Context context, String id) {
    synchronized (LOCK) {
      if (active == null || !active.id.equals(id) || active.running) return;
      stopJob(active); active.state = "paused";
      try { save(context, active); } catch (Exception ignored) {}
    }
  }
  static WritableMap status(Context context, String id) throws Exception {
    synchronized (LOCK) {
      Job job = active != null && active.id.equals(id) ? active : read(context, id);
      WritableMap result = Arguments.createMap();
      result.putString("state", job == null ? "missing" : job.state);
      result.putDouble("progress", job == null ? 0 : Math.min(1, (double)job.parts.size() * job.partSize / job.size));
      return result;
    }
  }
  static void discard(Context context, String id) {
    synchronized (LOCK) {
      if (active != null && active.id.equals(id)) {
        stopJob(active); active.state = "cancelled"; active = null;
      }
      new AtomicFile(journal(context, id)).delete();
    }
  }
  private static void stopJob(Job job) {
    job.stopped = true;
    if (job.call != null) job.call.cancel();
  }
  @Override public IBinder onBind(Intent intent) { return null; }
  @Override public void onCreate() {
    super.onCreate();
    if (Build.VERSION.SDK_INT >= 26) getSystemService(NotificationManager.class).createNotificationChannel(
      new NotificationChannel(CHANNEL, "Audio uploads", NotificationManager.IMPORTANCE_LOW));
  }
  @Override public int onStartCommand(Intent intent, int flags, int startId) {
    try { return startCommand(intent, startId); }
    catch (RuntimeException error) {
      // A foreground-service quota/permission rejection must pause, not crash the app.
      synchronized (LOCK) {
        if (owned != null) {
          stopJob(owned); owned.state = "paused";
          try { save(this, owned); } catch (IOException ignored) {}
        }
      }
      stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(startId);
      return START_NOT_STICKY;
    }
  }
  private int startCommand(Intent intent, int startId) {
    synchronized (LOCK) {
      String id = intent == null ? null : intent.getStringExtra("id");
      if ("cancel".equals(intent == null ? null : intent.getAction())) {
        if (owned == null || !owned.id.equals(id)) return START_NOT_STICKY;
        if (owned != null) {
          stopJob(owned); owned.state = "cancelled";
          try { save(this, owned); } catch (IOException ignored) {}
        }
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
        return START_NOT_STICKY;
      }
      if (active == null || !active.id.equals(id) || active.stopped) {
        // Even a completion/start race must fulfill startForegroundService's contract.
        startNotice("Upload finished", 100, false);
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf(startId);
        return START_NOT_STICKY;
      }
      owned = active;
      startNotice("Uploading audio", progress(owned), true);
      if (!owned.running) {
        owned.running = true;
        PowerManager power = getSystemService(PowerManager.class);
        if (wakeLock == null) wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Aside:upload");
        if (!wakeLock.isHeld()) wakeLock.acquire(TimeUnit.HOURS.toMillis(6));
        Job job = owned;
        String token = intent.getStringExtra("token");
        worker.execute(() -> transfer(job, token));
      }
      return START_NOT_STICKY;
    }
  }
  private int progress(Job job) { return (int)Math.min(100, (long)job.parts.size() * job.partSize * 100 / job.size); }
  private Notification notice(String text, int progress, boolean ongoing) {
    Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
    PendingIntent open = PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    Notification.Builder builder = Build.VERSION.SDK_INT >= 26
      ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
    builder.setSmallIcon(android.R.drawable.stat_sys_upload).setContentTitle("Aside")
      .setContentText(text).setContentIntent(open).setOnlyAlertOnce(true).setOngoing(ongoing);
    if (ongoing && owned != null) {
      Intent cancel = new Intent(this, AsideUploadService.class).setAction("cancel").putExtra("id", owned.id);
      PendingIntent action = PendingIntent.getService(this, 1, cancel, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
      builder.setProgress(100, progress, progress >= 100)
        .addAction(new Notification.Action.Builder(null, "Cancel", action).build());
    } else builder.setAutoCancel(true);
    return builder.build();
  }
  private void startNotice(String text, int progress, boolean ongoing) {
    Notification notification = notice(text, progress, ongoing);
    if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
    else startForeground(NOTIFICATION, notification);
  }
  private void check(Job job) throws IOException {
    if (job.stopped) throw new InterruptedIOException("Upload stopped");
  }
  private JSONObject request(Job job, String token, String suffix, String method, RequestBody body) throws IOException {
    check(job);
    Request request = new Request.Builder().url(job.base + "/api/uploads/" + job.id + suffix)
      .header("Authorization", "Bearer " + token).method(method, body).build();
    Call call = client.newCall(request);
    synchronized (LOCK) { check(job); job.call = call; }
    try (Response response = call.execute()) {
      if (!response.isSuccessful()) throw new AsideUploadTransfer.HttpFailure(response.code());
      if (response.body() == null) throw new IOException("Missing upload response");
      try { return new JSONObject(new String(readBytes(response.body().byteStream()), StandardCharsets.UTF_8)); }
      catch (JSONException error) { throw new IOException("Invalid upload response", error); }
    } finally { job.call = null; }
  }
  private static byte[] readBytes(InputStream input) throws IOException {
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    byte[] bytes = new byte[8192];
    for (int count; (count = input.read(bytes)) != -1;) {
      if (output.size() + count > 256 * 1024) throw new IOException("Upload response too large");
      output.write(bytes, 0, count);
    }
    return output.toByteArray();
  }
  private void transfer(Job job, String token) {
    try {
      if (token == null || token.isEmpty()) throw new IOException("Sign in again to upload");
      AsideUploadTransfer.run(job.size, job.partSize, new AsideUploadTransfer.Journal() {
        public List<AsideUploadTransfer.Part> parts() { return job.parts; }
        public void acknowledge(AsideUploadTransfer.Part part) throws IOException {
          synchronized (LOCK) { check(job); job.parts.add(part); save(AsideUploadService.this, job); }
          updateNotice(job);
        }
        public void processing() throws IOException { update("processing"); }
        public void done() throws IOException { update("done"); }
        private void update(String state) throws IOException {
          synchronized (LOCK) { check(job); job.state = state; save(AsideUploadService.this, job); }
          updateNotice(job);
        }
      }, new AsideUploadTransfer.Transport() {
        public void checkCancelled() throws IOException { check(job); }
        public void retryDelay(int attempt) throws IOException {
          // Bounded retry, interruptible by cancellation or system timeout.
          for (int i = 0; i < (10 << attempt); i++) {
            check(job);
            try { Thread.sleep(100); } catch (InterruptedException error) { throw new InterruptedIOException(); }
          }
        }
        public String part(int number, long offset, int length) throws IOException {
          RequestBody body = new RequestBody() {
            public MediaType contentType() { return MediaType.parse("application/octet-stream"); }
            public long contentLength() { return length; }
            public void writeTo(BufferedSink sink) throws IOException {
              try (RandomAccessFile file = new RandomAccessFile(new File(Uri.parse(job.uri).getPath()), "r")) {
                file.seek(offset);
                byte[] buffer = new byte[64 * 1024];
                int remaining = length;
                while (remaining > 0) {
                  check(job);
                  int count = file.read(buffer, 0, Math.min(remaining, buffer.length));
                  if (count < 0) throw new EOFException("Upload file changed");
                  sink.write(buffer, 0, count); remaining -= count;
                }
              }
            }
          };
          return request(job, token, "/part?number=" + number, "PUT", body).optString("etag", "");
        }
        public void complete(List<AsideUploadTransfer.Part> parts) throws IOException {
          try {
            String json = new JSONObject().put("parts", partsJson(parts)).toString();
            request(job, token, "/complete", "POST", RequestBody.create(MediaType.parse("application/json"), json));
          } catch (JSONException error) { throw new IOException(error); }
        }
      });
    } catch (Exception error) {
      synchronized (LOCK) {
        if (!job.stopped) {
          job.state = "paused";
          try { save(this, job); } catch (IOException ignored) {}
        }
      }
    } finally {
      main.post(() -> finish(job));
    }
  }
  private void updateNotice(Job job) {
    main.post(() -> {
      synchronized (LOCK) {
        if (owned != job || job.stopped) return;
        getSystemService(NotificationManager.class).notify(NOTIFICATION,
          notice(job.state.equals("processing") ? "Preparing audio" : "Uploading audio", progress(job), true));
      }
    });
  }
  private void finish(Job job) {
    synchronized (LOCK) {
      if (owned != job) return;
      stopJob(job);
      // A new start may be queued on the main thread after cancellation.
      if (active != null && active != job && !active.stopped) return;
      stopForeground(STOP_FOREGROUND_REMOVE);
      if (!job.state.equals("cancelled") && (job.state.equals("done") || job.state.equals("paused"))) {
        getSystemService(NotificationManager.class).notify(NOTIFICATION,
          notice(job.state.equals("done") ? "Upload complete" : "Upload paused · open Aside to retry", progress(job), false));
      }
      stopSelf();
    }
  }
  @Override public void onTimeout(int startId, int fgsType) {
    synchronized (LOCK) {
      if (owned != null) {
        stopJob(owned); owned.state = "paused";
        try { save(this, owned); } catch (IOException ignored) {}
      }
      stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
    }
  }
  @Override public void onDestroy() {
    synchronized (LOCK) {
      if (owned != null) {
        stopJob(owned);
        if (owned.state.equals("uploading") || owned.state.equals("processing")) {
          owned.state = "paused";
          try { save(this, owned); } catch (IOException ignored) {}
        }
      }
      if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }
    super.onDestroy();
  }
}
