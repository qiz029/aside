import WebSocket from "ws";
export interface LiveSideband {
  send(text: string): void;
  close(): void;
}
/** Node adapter only; Workers use the supervisor's already-authenticated socket. */
export async function attachLiveSideband(
  key: string,
  sessionId: string,
  receive: (event: Record<string, unknown>) => void,
  closed: () => void,
  connect = (url: string, options: WebSocket.ClientOptions) =>
    new WebSocket(url, options),
): Promise<LiveSideband> {
  const socket = connect(
    `wss://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/attach`,
    {
      headers: { Authorization: `Bearer ${key}` },
      handshakeTimeout: 5000,
    },
  );
  socket.on("message", (data) => {
    try {
      receive(JSON.parse(data.toString()));
    } catch {
      /* Non-JSON frames are not commands. */
    }
  });
  socket.on("close", closed);
  socket.on("error", closed);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("close", () =>
      reject(Error("Live sideband closed before connecting")),
    );
  });
  return { send: (text) => socket.send(text), close: () => socket.close() };
}
