import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("native upload persists acknowledgements, retries transient failures and respects cancellation", () => {
  const dir = mkdtempSync(join(tmpdir(), "aside-upload-"));
  try {
    writeFileSync(
      join(dir, "UploadTest.java"),
      `
package com.aside.audio;
import java.io.*;
import java.util.*;
import static com.aside.audio.AsideUploadTransfer.*;
public class UploadTest {
  static void require(boolean value) { if (!value) throw new AssertionError(); }
  static class Store implements Journal {
    List<Part> saved = new ArrayList<>();
    boolean completed, processing;
    public List<Part> parts() { return saved; }
    public void acknowledge(Part p) { saved.add(p); }
    public void processing() { processing = true; }
    public void done() { completed = true; }
  }
  static class Network implements Transport {
    List<String> requests = new ArrayList<>();
    boolean cancelled, failComplete;
    int failPart, status, delays;
    public String part(int n, long offset, int length) throws IOException {
      requests.add(n + ":" + offset + ":" + length);
      if (n == failPart) { if (status == 0) throw new IOException("offline"); throw new HttpFailure(status); }
      return "etag-" + n;
    }
    public void complete(List<Part> parts) throws IOException {
      require(parts.size() == 3);
      if (failComplete) throw new IOException("completion response lost");
    }
    public void checkCancelled() throws IOException { if (cancelled) throw new InterruptedIOException(); }
    public void retryDelay(int attempt) throws IOException { delays++; checkCancelled(); }
  }
  public static void main(String[] args) throws Exception {
    Store store = new Store(); Network first = new Network(); first.failPart = 2;
    try { run(20, 8, store, first); throw new AssertionError(); } catch (IOException expected) {}
    require(store.saved.size() == 1 && !store.completed && first.delays == 2);
    Network retry = new Network(); retry.failComplete = true;
    try { run(20, 8, store, retry); throw new AssertionError(); } catch (IOException expected) {}
    require(retry.requests.equals(Arrays.asList("2:8:8", "3:16:4")));
    require(store.saved.size() == 3 && store.processing && !store.completed);
    Network restart = new Network(); run(20, 8, store, restart);
    require(restart.requests.isEmpty() && store.completed);
    for (int status : new int[]{401, 403, 404, 409}) {
      Network rejected = new Network(); rejected.failPart = 1; rejected.status = status;
      try { run(20, 8, new Store(), rejected); throw new AssertionError(); } catch (HttpFailure expected) {}
      require(rejected.delays == 0 && rejected.requests.size() == 1);
    }
    Network lostAck = new Network() {
      public String part(int n, long offset, int length) throws IOException {
        String etag = super.part(n, offset, length);
        if (requests.size() == 1) throw new IOException("ack lost");
        return etag;
      }
    };
    Store recovered = new Store(); run(20, 8, recovered, lostAck);
    require(lostAck.requests.equals(Arrays.asList("1:0:8", "1:0:8", "2:8:8", "3:16:4")));
    require(recovered.saved.size() == 3);
    Store cancelledStore = new Store();
    Network cancel = new Network() {
      public String part(int n, long offset, int length) throws IOException { cancelled = true; return super.part(n, offset, length); }
    };
    try { run(20, 8, cancelledStore, cancel); throw new AssertionError(); } catch (InterruptedIOException expected) {}
    require(cancelledStore.saved.isEmpty() && !cancelledStore.processing);
    Store invalid = new Store(); invalid.saved.add(new Part(2, "out-of-order"));
    Network unused = new Network();
    try { run(20, 8, invalid, unused); throw new AssertionError(); } catch (IOException expected) {}
    require(unused.requests.isEmpty());
    Store diskFull = new Store() { public void acknowledge(Part p) { throw new IllegalStateException("disk full"); } };
    Network disk = new Network();
    try { run(20, 8, diskFull, disk); throw new AssertionError(); } catch (IllegalStateException expected) {}
    require(disk.requests.size() == 1 && !diskFull.processing);
  }
}`,
    );
    execFileSync("javac", [
      "-d",
      dir,
      resolve("mobile/native/android/AsideUploadTransfer.java"),
      join(dir, "UploadTest.java"),
    ]);
    execFileSync("java", ["-cp", dir, "com.aside.audio.UploadTest"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
