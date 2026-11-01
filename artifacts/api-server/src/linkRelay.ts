import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Server } from "node:http";
import { logger } from "./lib/logger";

const LINK_PATH = "/api/link";
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const ROOM_IDLE_MS = 15 * 60_000;
const ROOM_MAX_AGE_MS = 2 * 60 * 60_000;
const MAX_ROOMS = 500;
const MAX_MESSAGE_BYTES = 4096;
const RATE_WINDOW_MS = 5_000;
const MAX_MESSAGES_PER_WINDOW = 1500;

type PlayerRole = "host" | "guest";

interface LinkClient {
  socket: Socket;
  buffer: Buffer;
  room: LinkRoom | null;
  role: PlayerRole | null;
  closed: boolean;
  remoteAddress: string;
  rateWindowStartedAt: number;
  messagesInWindow: number;
}

interface PendingTransfer {
  id: number;
  initiator: PlayerRole;
  data: number;
  createdAt: number;
  timeout: NodeJS.Timeout;
}

interface LinkRoom {
  code: string;
  romHash: string;
  protocol: number;
  createdAt: number;
  lastActiveAt: number;
  host: LinkClient;
  guest: LinkClient | null;
  pending: PendingTransfer | null;
}

interface ClientMessage {
  type?: unknown;
  code?: unknown;
  romHash?: unknown;
  protocol?: unknown;
  id?: unknown;
  data?: unknown;
}

const rooms = new Map<string, LinkRoom>();
const clientsByAddress = new Map<string, number>();

function json(client: LinkClient, payload: object): void {
  if (client.closed || client.socket.destroyed) return;
  const body = Buffer.from(JSON.stringify(payload));
  const header =
    body.length < 126
      ? Buffer.from([0x81, body.length])
      : Buffer.from([0x81, 126, body.length >>> 8, body.length & 0xff]);
  client.socket.write(Buffer.concat([header, body]));
}

function close(client: LinkClient, code = 1000, reason = ""): void {
  if (client.closed) return;
  const reasonBytes = Buffer.from(reason).subarray(0, 120);
  const payload = Buffer.allocUnsafe(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  client.socket.write(Buffer.concat([Buffer.from([0x88, payload.length]), payload]));
  client.socket.end();
}

function error(client: LinkClient, code: string, message: string): void {
  json(client, { type: "error", code, message });
}

function validRomHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function validTransferId(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0x7fffffff;
}

function validLinkWord(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff;
}

function makeRoomCode(): string {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = "";
    for (let i = 0; i < 6; i += 1) {
      code += ROOM_CODE_ALPHABET[randomInt(ROOM_CODE_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error("Unable to allocate a link room code");
}

function sameHash(left: string, right: string): boolean {
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function roomState(client: LinkClient, status: "waiting" | "connected"): void {
  const room = client.room;
  if (!room || !client.role) return;
  json(client, {
    type: "room",
    code: room.code,
    role: client.role,
    playerId: client.role === "host" ? 0 : 1,
    status,
  });
}

function createRoom(client: LinkClient, message: ClientMessage): void {
  if (client.room) {
    error(client, "already_in_room", "Leave the current room before creating another.");
    return;
  }
  if (rooms.size >= MAX_ROOMS) {
    error(client, "server_busy", "Link Play is at capacity. Try again shortly.");
    return;
  }
  if (message.protocol !== 1 || !validRomHash(message.romHash)) {
    error(client, "invalid_handshake", "A supported protocol and ROM identity are required.");
    return;
  }
  const code = makeRoomCode();
  const now = Date.now();
  const room: LinkRoom = {
    code,
    romHash: message.romHash,
    protocol: 1,
    createdAt: now,
    lastActiveAt: now,
    host: client,
    guest: null,
    pending: null,
  };
  rooms.set(code, room);
  client.room = room;
  client.role = "host";
  roomState(client, "waiting");
}

function joinRoom(client: LinkClient, message: ClientMessage): void {
  if (client.room) {
    error(client, "already_in_room", "Leave the current room before joining another.");
    return;
  }
  if (
    message.protocol !== 1 ||
    !validRomHash(message.romHash) ||
    typeof message.code !== "string"
  ) {
    error(client, "invalid_handshake", "A room code and ROM identity are required.");
    return;
  }
  const code = message.code.trim().toUpperCase();
  const room = rooms.get(code);
  if (!room) {
    error(client, "room_not_found", "That Link Play room does not exist or has expired.");
    return;
  }
  if (room.guest) {
    error(client, "room_full", "That Link Play room already has two players.");
    return;
  }
  if (!sameHash(room.romHash, message.romHash)) {
    error(client, "rom_mismatch", "Both players must use the exact same game and revision.");
    return;
  }
  room.guest = client;
  room.pending = null;
  room.lastActiveAt = Date.now();
  client.room = room;
  client.role = "guest";
  roomState(room.host, "connected");
  roomState(client, "connected");
}

function peerOf(client: LinkClient): LinkClient | null {
  const room = client.room;
  if (!room || !client.role) return null;
  return client.role === "host" ? room.guest : room.host;
}

function startTransfer(client: LinkClient, message: ClientMessage): void {
  const room = client.room;
  const peer = peerOf(client);
  if (!room || !client.role || !peer) {
    error(client, "peer_unavailable", "The other player is not connected.");
    return;
  }
  if (client.role !== "host") {
    error(client, "not_cable_master", "Only player 1 can start a cable transfer.");
    return;
  }
  if (!validTransferId(message.id) || !validLinkWord(message.data)) {
    error(client, "invalid_transfer", "The link transfer was malformed.");
    return;
  }
  if (room.pending) {
    error(client, "transfer_busy", "A link transfer is already in progress.");
    return;
  }
  room.lastActiveAt = Date.now();
  const pending: PendingTransfer = {
    id: message.id,
    initiator: client.role,
    data: message.data,
    createdAt: room.lastActiveAt,
    timeout: setTimeout(() => {
      if (room.pending !== pending) return;
      room.pending = null;
      json(room.host, { type: "serial-timeout" });
      if (room.guest) json(room.guest, { type: "serial-timeout" });
    }, 10_000),
  };
  pending.timeout.unref();
  room.pending = pending;
  json(peer, {
    type: "serial-start",
    id: message.id,
    initiator: client.role,
    data: message.data,
  });
}

function replyTransfer(client: LinkClient, message: ClientMessage): void {
  const room = client.room;
  const pending = room?.pending;
  if (!room || !client.role || !pending) {
    error(client, "no_transfer", "There is no link transfer awaiting a reply.");
    return;
  }
  if (
    client.role !== "guest" ||
    pending.initiator !== "host" ||
    message.id !== pending.id ||
    !validLinkWord(message.data)
  ) {
    error(client, "invalid_reply", "The link transfer reply did not match the pending transfer.");
    return;
  }
  const hostData = pending.data;
  const guestData = message.data;
  const completion = {
    type: "serial-complete",
    id: pending.id,
    words: [hostData, guestData, 0xffff, 0xffff],
  };
  clearTimeout(pending.timeout);
  room.pending = null;
  room.lastActiveAt = Date.now();
  json(room.host, completion);
  if (room.guest) json(room.guest, completion);
}

function leaveRoom(client: LinkClient): void {
  const room = client.room;
  const role = client.role;
  if (!room || !role) return;
  client.room = null;
  client.role = null;
  if (room.pending) clearTimeout(room.pending.timeout);
  room.pending = null;

  if (role === "host") {
    rooms.delete(room.code);
    if (room.guest) {
      const guest = room.guest;
      guest.room = null;
      guest.role = null;
      json(guest, { type: "room-ended", reason: "The room host left Link Play." });
    }
    return;
  }

  room.guest = null;
  room.lastActiveAt = Date.now();
  json(room.host, { type: "peer-left" });
  roomState(room.host, "waiting");
}

function onClientMessage(client: LinkClient, raw: string): void {
  const now = Date.now();
  if (now - client.rateWindowStartedAt >= RATE_WINDOW_MS) {
    client.rateWindowStartedAt = now;
    client.messagesInWindow = 0;
  }
  client.messagesInWindow += 1;
  if (client.messagesInWindow > MAX_MESSAGES_PER_WINDOW) {
    close(client, 1008, "Rate limit exceeded");
    return;
  }

  let message: ClientMessage;
  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    error(client, "invalid_json", "Messages must be valid JSON.");
    return;
  }
  switch (message.type) {
    case "create":
      createRoom(client, message);
      break;
    case "join":
      joinRoom(client, message);
      break;
    case "serial-start":
      startTransfer(client, message);
      break;
    case "serial-reply":
      replyTransfer(client, message);
      break;
    case "leave":
      leaveRoom(client);
      json(client, { type: "left" });
      break;
    case "ping":
      if (client.room) client.room.lastActiveAt = Date.now();
      json(client, { type: "pong" });
      break;
    default:
      error(client, "unknown_message", "Unsupported Link Play message.");
  }
}

function websocketFrame(opcode: number, payload: Buffer): Buffer {
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : Buffer.from([0x80 | opcode, 126, payload.length >>> 8, payload.length & 0xff]);
  return Buffer.concat([header, payload]);
}

function drainFrames(client: LinkClient): void {
  while (client.buffer.length >= 2 && !client.closed) {
    const first = client.buffer[0]!;
    const second = client.buffer[1]!;
    const final = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let payloadLength = second & 0x7f;
    let headerLength = 2;

    if (!final || !masked) {
      close(client, 1002, "Unsupported WebSocket frame");
      return;
    }
    if (payloadLength === 126) {
      if (client.buffer.length < 4) return;
      payloadLength = client.buffer.readUInt16BE(2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (client.buffer.length < 10) return;
      const largeLength = client.buffer.readBigUInt64BE(2);
      if (largeLength > BigInt(MAX_MESSAGE_BYTES)) {
        close(client, 1009, "Message too large");
        return;
      }
      payloadLength = Number(largeLength);
      headerLength = 10;
    }
    if (payloadLength > MAX_MESSAGE_BYTES) {
      close(client, 1009, "Message too large");
      return;
    }
    const frameLength = headerLength + 4 + payloadLength;
    if (client.buffer.length < frameLength) return;
    const mask = client.buffer.subarray(headerLength, headerLength + 4);
    const payload = Buffer.from(
      client.buffer.subarray(headerLength + 4, frameLength),
    );
    client.buffer = client.buffer.subarray(frameLength);
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] = payload[i]! ^ mask[i & 3]!;
    }

    if (opcode === 0x8) {
      client.socket.write(websocketFrame(0x8, payload.subarray(0, 125)));
      client.socket.end();
      return;
    }
    if (opcode === 0x9) {
      client.socket.write(websocketFrame(0xa, payload));
      continue;
    }
    if (opcode !== 0x1) {
      close(client, 1003, "Only text messages are supported");
      return;
    }
    onClientMessage(client, payload.toString("utf8"));
  }
}

function dispose(client: LinkClient): void {
  if (client.closed) return;
  client.closed = true;
  leaveRoom(client);
  const current = clientsByAddress.get(client.remoteAddress) ?? 1;
  if (current <= 1) clientsByAddress.delete(client.remoteAddress);
  else clientsByAddress.set(client.remoteAddress, current - 1);
}

function handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): void {
  const requestUrl = new URL(request.url ?? "/", "http://localhost");
  if (requestUrl.pathname !== LINK_PATH) {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return;
  }
  const key = request.headers["sec-websocket-key"];
  const upgrade = request.headers.upgrade;
  const version = request.headers["sec-websocket-version"];
  if (
    request.method !== "GET" ||
    typeof key !== "string" ||
    upgrade?.toLowerCase() !== "websocket" ||
    version !== "13"
  ) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    return;
  }
  const forwardedFor = request.headers["x-forwarded-for"];
  const forwardedAddresses = (
    Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor ?? ""
  )
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const remoteAddress =
    forwardedAddresses.at(-1) ||
    request.socket.remoteAddress ||
    "unknown";
  const connections = clientsByAddress.get(remoteAddress) ?? 0;
  if (connections >= 6) {
    socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
    return;
  }
  clientsByAddress.set(remoteAddress, connections + 1);

  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);

  const client: LinkClient = {
    socket,
    buffer: head,
    room: null,
    role: null,
    closed: false,
    remoteAddress,
    rateWindowStartedAt: Date.now(),
    messagesInWindow: 0,
  };
  socket.on("data", (chunk: Buffer) => {
    client.buffer = Buffer.concat([client.buffer, chunk]);
    drainFrames(client);
  });
  socket.on("close", () => dispose(client));
  socket.on("end", () => dispose(client));
  socket.on("error", () => dispose(client));
  if (head.length) drainFrames(client);
}

export function attachLinkRelay(server: Server): void {
  server.on("upgrade", handleUpgrade);
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      if (
        now - room.lastActiveAt > ROOM_IDLE_MS ||
        now - room.createdAt > ROOM_MAX_AGE_MS
      ) {
        if (room.pending) clearTimeout(room.pending.timeout);
        json(room.host, { type: "room-ended", reason: "The Link Play room expired." });
        if (room.guest) {
          json(room.guest, { type: "room-ended", reason: "The Link Play room expired." });
          room.guest.room = null;
          room.guest.role = null;
        }
        room.host.room = null;
        room.host.role = null;
        rooms.delete(room.code);
      }
    }
  }, 30_000);
  cleanupTimer.unref();
  logger.info({ path: LINK_PATH }, "Link Play relay attached");
}
