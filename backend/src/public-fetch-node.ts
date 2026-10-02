import { lookup } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent } from "undici";
import { privateAddress, publicFetch } from "./public-fetch.js";

// Validate the address passed to the actual socket, not only a DNS preflight.
// This also prevents a publisher's hostname rebinding between the two lookups.
export const publicLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, []);
    if (
      !addresses.length ||
      addresses.some(({ address }) => privateAddress(address))
    )
      return callback(Error("Podcast host is not public"), []);
    callback(
      null,
      options.all ? addresses : addresses[0].address,
      addresses[0].family,
    );
  });
};
const dispatcher = new Agent({
  connect: { lookup: publicLookup },
  maxOrigins: 100,
});
const transport: typeof fetch = (input, init) => {
  const options = { ...init, dispatcher };
  return fetch(input, options);
};
export const nodePublicFetch: typeof publicFetch = (
  value,
  init = {},
  _transport,
  timeoutMs,
) => publicFetch(value, init, transport, timeoutMs);
