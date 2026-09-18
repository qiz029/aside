import { fetchWebSocketUpgrade } from "./websocket-upgrade.js";
import type { ResponsesEvents, ResponsesSocket } from "./response-preload.js";

export async function connectResponsesWorker(
  key: string,
  events: ResponsesEvents,
  upgrade = fetchWebSocketUpgrade,
): Promise<ResponsesSocket> {
  const response = await upgrade("https://api.openai.com/v1/responses", {
    Upgrade: "websocket",
    Authorization: `Bearer ${key}`,
  });
  const socket = (
    response as Response & { webSocket?: WebSocket & { accept(): void } }
  ).webSocket;
  if (!socket) throw Error("Responses WebSocket upgrade unavailable");
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") events.message(event.data);
  });
  socket.addEventListener("close", events.closed);
  socket.addEventListener("error", events.closed);
  socket.accept();
  return { send: (text) => socket.send(text), close: () => socket.close() };
}
