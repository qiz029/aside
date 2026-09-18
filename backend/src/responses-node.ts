import WebSocket from "ws";
import type { ResponsesEvents, ResponsesSocket } from "./response-preload.js";

/** Auth stays on the backend. Each voice session owns one Responses socket. */
export async function connectResponsesNode(
  key: string,
  events: ResponsesEvents,
  connect = (url: string, options: WebSocket.ClientOptions) =>
    new WebSocket(url, options),
): Promise<ResponsesSocket> {
  const socket = connect("wss://api.openai.com/v1/responses", {
    headers: { Authorization: `Bearer ${key}` },
    handshakeTimeout: 5000,
  });
  socket.on("message", (data) => events.message(data.toString()));
  socket.on("close", events.closed);
  socket.on("error", events.closed);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
    socket.once("close", () =>
      reject(Error("Responses connection closed before opening")),
    );
  });
  return { send: (text) => socket.send(text), close: () => socket.close() };
}
