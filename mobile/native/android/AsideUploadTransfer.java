package com.aside.audio;

import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/** Transfer policy, independent of Android and the React lifecycle. */
public final class AsideUploadTransfer {
  public static final class Part {
    public final int number;
    public final String etag;
    public Part(int number, String etag) { this.number = number; this.etag = etag; }
  }
  public interface Transport {
    String part(int number, long offset, int length) throws IOException;
    void complete(List<Part> parts) throws IOException;
    void checkCancelled() throws IOException;
    void retryDelay(int attempt) throws IOException;
  }
  public interface Journal {
    List<Part> parts();
    void acknowledge(Part part) throws IOException;
    void processing() throws IOException;
    void done() throws IOException;
  }
  public static final class HttpFailure extends IOException {
    public final int status;
    public HttpFailure(int status) { super("Upload HTTP " + status); this.status = status; }
  }
  private interface Request<T> { T run() throws IOException; }
  private static <T> T retry(Transport transport, Request<T> request) throws IOException {
    for (int attempt = 0; ; attempt++) {
      transport.checkCancelled();
      try { return request.run(); }
      catch (IOException error) {
        transport.checkCancelled();
        if (attempt >= 2 || (error instanceof HttpFailure &&
            ((HttpFailure)error).status != 408 && ((HttpFailure)error).status != 429 &&
            ((HttpFailure)error).status < 500)) throw error;
        transport.retryDelay(attempt);
      }
    }
  }
  public static void run(long size, int partSize, Journal journal, Transport transport) throws IOException {
    if (size <= 0 || partSize <= 0) throw new IOException("Invalid upload size");
    List<Part> parts = new ArrayList<>(journal.parts());
    for (int i = 0; i < parts.size(); i++) {
      if (parts.get(i).number != i + 1 || parts.get(i).etag.isEmpty() || (long)i * partSize >= size)
        throw new IOException("Invalid upload journal");
    }
    for (int n = parts.size() + 1; (long)(n - 1) * partSize < size; n++) {
      final int number = n;
      final long offset = (long)(n - 1) * partSize;
      final int length = (int)Math.min(partSize, size - offset);
      String etag = retry(transport, () -> transport.part(number, offset, length));
      transport.checkCancelled();
      if (etag == null || etag.isEmpty()) throw new IOException("Missing part acknowledgement");
      Part part = new Part(n, etag);
      // Persist before advancing. A crash may resend this part, never skip it.
      journal.acknowledge(part);
      parts.add(part);
    }
    transport.checkCancelled();
    journal.processing();
    retry(transport, () -> { transport.complete(parts); return null; });
    transport.checkCancelled();
    journal.done();
  }
}
