"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = __dirname;
const sessionCookieName = "friendzone_session";
const sessionLifetimeSeconds = 7 * 24 * 60 * 60;
const googleCertificatesUrl = "https://www.googleapis.com/oauth2/v3/certs";
let googleKeysCache = null;
let googleKeysExpiry = 0;
let googleKeysRequest = null;

function loadEnvironmentFile() {
  const envPath = path.join(root, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || match[1] in process.env) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    process.env[match[1]] = value;
  }
}

loadEnvironmentFile();
const port = Number(process.env.PORT || 8000);
const clientId = process.env.GOOGLE_CLIENT_ID || "";
const sessionSecret = process.env.SESSION_SECRET || "";
const chatFilePath = process.env.FRIENDZONE_CHAT_FILE || path.join(root, ".friendzone-chat.json");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port number.");
}
if (sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET is required and must be at least 32 characters. Set it in .env.");
}

function loadChatStore() {
  try {
    const store = JSON.parse(fs.readFileSync(chatFilePath, "utf8"));
    if (!store || !Array.isArray(store.users) || !Array.isArray(store.messages)) {
      throw new Error("Chat data file has an invalid format.");
    }
    store.rooms = Array.isArray(store.rooms) ? store.rooms : [];
    store.boardNotes = Array.isArray(store.boardNotes) ? store.boardNotes : [];
    store.friendRequests = Array.isArray(store.friendRequests) ? store.friendRequests : [];
    for (const user of store.users) {
      user.pictureVisibleToCampus = user.pictureVisibleToCampus === true;
      user.profileCompleted = user.profileCompleted === true;
      user.department = typeof user.department === "string" ? user.department : "";
      user.subjects = Array.isArray(user.subjects) ? user.subjects : [];
      user.skills = Array.isArray(user.skills) ? user.skills : [];
    }
    for (const room of store.rooms) {
      room.memberSubs = Array.isArray(room.memberSubs) ? room.memberSubs : [];
    }
    if (!store.rooms.some((room) => room.id === "campus-commons")) {
      store.rooms.unshift({
        id: "campus-commons",
        name: "Campus Commons",
        description: "An open room to share ideas with your campus.",
        ownerSub: null,
        createdAt: Date.now(),
        memberSubs: store.users.map((user) => user.sub)
      });
    }
    return store;
  } catch (error) {
    if (error.code === "ENOENT") {
      return {
        users: [],
        messages: [],
        friendRequests: [],
        rooms: [{
          id: "campus-commons",
          name: "Campus Commons",
          description: "An open room to share ideas with your campus.",
          ownerSub: null,
          createdAt: Date.now(),
          memberSubs: []
        }],
        boardNotes: []
      };
    }
    throw new Error(`Could not load FriendZone chat data: ${error.message}`);
  }
}

let chatStore = loadChatStore();

function saveChatStore() {
  const temporaryPath = `${chatFilePath}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(chatStore), { mode: 0o600 });
    fs.renameSync(temporaryPath, chatFilePath);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") console.error("Could not clean up temporary chat data:", cleanupError);
    }
    throw new Error(`Could not save FriendZone chat data: ${error.message}`);
  }
}

function jsonResponse(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers
  });
  response.end(body === null ? "" : JSON.stringify(body));
}

function expectedOrigin(request) {
  if (process.env.APP_ORIGIN) return process.env.APP_ORIGIN.replace(/\/$/, "");
  const scheme = request.socket.encrypted ? "https" : "http";
  return `${scheme}://${request.headers.host}`;
}

function hasAllowedOrigin(request) {
  return typeof request.headers.origin === "string" && request.headers.origin === expectedOrigin(request);
}

async function readJsonBody(request) {
  if (!String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
    const error = new Error("Content-Type must be application/json.");
    error.status = 415;
    throw error;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must contain valid JSON.");
    error.status = 400;
    throw error;
  }
}

function decodeJwtPart(encoded) {
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
}

async function getGooglePublicKeys(forceRefresh = false) {
  if (!forceRefresh && googleKeysCache && Date.now() < googleKeysExpiry) return googleKeysCache;
  if (googleKeysRequest) return googleKeysRequest;
  googleKeysRequest = (async () => {
    const result = await fetch(googleCertificatesUrl, { signal: AbortSignal.timeout(8000) });
    if (!result.ok) throw new Error(`Google public-key request failed with status ${result.status}.`);
    const document = await result.json();
    if (!Array.isArray(document.keys)) throw new Error("Google returned an invalid signing-key document.");
    const cacheHeader = result.headers.get("cache-control") || "";
    const maxAge = Number(cacheHeader.match(/max-age=(\d+)/i)?.[1] || 300);
    googleKeysCache = document.keys;
    googleKeysExpiry = Date.now() + Math.max(60, Math.min(maxAge, 86400)) * 1000;
    return googleKeysCache;
  })();
  try {
    return await googleKeysRequest;
  } finally {
    googleKeysRequest = null;
  }
}

async function verifyGoogleIdToken(token) {
  if (typeof token !== "string" || token.length < 20 || token.length > 10000) {
    throw new Error("A valid Google ID credential is required.");
  }
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Google returned an invalid ID token.");
  const header = decodeJwtPart(parts[0]);
  const claims = decodeJwtPart(parts[1]);
  if (header.alg !== "RS256" || typeof header.kid !== "string") {
    throw new Error("Google ID token uses an unsupported signature.");
  }

  let keys = await getGooglePublicKeys();
  let jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA" && key.use === "sig");
  if (!jwk) {
    keys = await getGooglePublicKeys(true);
    jwk = keys.find((key) => key.kid === header.kid && key.kty === "RSA" && key.use === "sig");
  }
  if (!jwk) throw new Error("Google ID token signing key was not found.");
  const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const signingInput = Buffer.from(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(parts[2], "base64url");
  if (!crypto.verify("RSA-SHA256", signingInput, publicKey, signature)) {
    throw new Error("Google ID token signature is invalid.");
  }

  const now = Math.floor(Date.now() / 1000);
  const validIssuer = claims.iss === "https://accounts.google.com" || claims.iss === "accounts.google.com";
  const validAudience = claims.aud === clientId ||
    (Array.isArray(claims.aud) && claims.aud.includes(clientId) && claims.azp === clientId);
  if (!validIssuer || !validAudience || typeof claims.sub !== "string" ||
      !Number.isInteger(claims.exp) || claims.exp <= now ||
      !Number.isInteger(claims.iat) || claims.iat > now + 60 ||
      typeof claims.email !== "string" || claims.email_verified !== true ||
      typeof claims.name !== "string") {
    throw new Error("Google ID token claims are invalid or expired.");
  }
  return {
    sub: claims.sub,
    name: claims.name,
    email: claims.email,
    picture: typeof claims.picture === "string" ? claims.picture : null
  };
}

function signSession(user) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    ...user,
    iat: now,
    exp: now + sessionLifetimeSeconds
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", sessionSecret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifySession(token) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [encodedPayload, providedSignature] = parts;
  const expectedSignature = crypto.createHmac("sha256", sessionSecret).update(encodedPayload).digest();
  const actualSignature = Buffer.from(providedSignature, "base64url");
  if (actualSignature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(actualSignature, expectedSignature)) {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    if (!payload || typeof payload.sub !== "string" || typeof payload.email !== "string" ||
        typeof payload.name !== "string" || !Number.isInteger(payload.exp) ||
        payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function readSession(request) {
  const cookieHeader = request.headers.cookie || "";
  const cookie = cookieHeader.split(";").map((part) => part.trim())
    .find((part) => part.startsWith(`${sessionCookieName}=`));
  return cookie ? verifySession(cookie.slice(sessionCookieName.length + 1)) : null;
}

function sessionCookie(value, maxAge) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${sessionCookieName}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function publicUser(user) {
  return {
    id: user.sub,
    name: user.name,
    email: user.email,
    picture: user.picture || null,
    provider: "google"
  };
}

function chatUser(user) {
  return {
    id: user.id,
    name: user.name,
    picture: user.pictureVisibleToCampus ? user.picture : null,
    online: Date.now() - user.lastSeenAt < 45_000
  };
}

function campusProfile(user, viewerSub = null) {
  return {
    id: user.id,
    name: user.name,
    picture: user.sub === viewerSub || user.pictureVisibleToCampus ? user.picture : null,
    department: user.department,
    subjects: user.subjects,
    skills: user.skills,
    online: Date.now() - user.lastSeenAt < 45_000
  };
}

function acceptedFriends(firstSub, secondSub) {
  return chatStore.friendRequests.some((request) =>
    request.status === "accepted" &&
    ((request.senderSub === firstSub && request.recipientSub === secondSub) ||
      (request.senderSub === secondSub && request.recipientSub === firstSub))
  );
}

function relationshipStatus(viewerSub, otherSub) {
  if (acceptedFriends(viewerSub, otherSub)) return "friends";
  const relationship = chatStore.friendRequests.filter((request) =>
    (request.senderSub === viewerSub && request.recipientSub === otherSub) ||
    (request.senderSub === otherSub && request.recipientSub === viewerSub)
  ).filter((request) => request.status === "pending")
    .sort((first, second) => second.createdAt - first.createdAt)[0];
  if (!relationship) return "none";
  return relationship.senderSub === viewerSub ? "outgoing" : "incoming";
}

function completeProfileRequired(user, response) {
  if (user.profileCompleted) return true;
  jsonResponse(response, 409, { error: "Complete your campus profile before using this feature." });
  return false;
}

function respondFriendRequest(pathname, response, user, body) {
  const match = pathname.match(/^\/api\/friend-requests\/([a-z0-9-]+)\/respond$/i);
  if (!match) return false;
  const friendshipRequest = chatStore.friendRequests.find((candidate) => candidate.id === match[1]);
  if (!friendshipRequest) {
    jsonResponse(response, 404, { error: "That friend request was not found." });
    return true;
  }
  if (friendshipRequest.recipientSub !== user.sub || friendshipRequest.status !== "pending") {
    jsonResponse(response, 403, { error: "Only the recipient can respond to a pending friend request." });
    return true;
  }
  if (body?.action !== "accept" && body?.action !== "decline") {
    jsonResponse(response, 400, { error: "Choose whether to accept or decline this request." });
    return true;
  }
  friendshipRequest.status = body.action === "accept" ? "accepted" : "declined";
  friendshipRequest.respondedAt = new Date().toISOString();
  saveChatStore();
  jsonResponse(response, 200, { status: friendshipRequest.status });
  return true;
}

function upsertChatUser(session) {
  const now = Date.now();
  let user = chatStore.users.find((candidate) => candidate.sub === session.sub);
  if (!user) {
    user = {
      id: crypto.randomUUID(),
      sub: session.sub,
      name: session.name,
      picture: session.picture || null,
      pictureVisibleToCampus: false,
      profileCompleted: false,
      department: "",
      subjects: [],
      skills: [],
      createdAt: now,
      lastSeenAt: now
    };
    chatStore.users.push(user);
    chatStore.rooms.find((room) => room.id === "campus-commons")?.memberSubs.push(user.sub);
    saveChatStore();
  } else {
    let changed = false;
    if (now - user.lastSeenAt >= 15_000) {
      user.name = session.name;
      user.picture = session.picture || null;
      user.lastSeenAt = now;
      changed = true;
    }
    if (user.pictureVisibleToCampus !== true) {
      user.pictureVisibleToCampus = false;
    }
    user.profileCompleted = user.profileCompleted === true;
    user.department = typeof user.department === "string" ? user.department : "";
    user.subjects = Array.isArray(user.subjects) ? user.subjects : [];
    user.skills = Array.isArray(user.skills) ? user.skills : [];
    const commons = chatStore.rooms.find((room) => room.id === "campus-commons");
    if (commons && !commons.memberSubs.includes(user.sub)) {
      commons.memberSubs.push(user.sub);
      changed = true;
    }
    if (changed) saveChatStore();
  }
  return user;
}

function publicChatMessage(message) {
  const sender = chatStore.users.find((user) => user.sub === message.senderSub);
  return {
    id: message.id,
    senderId: sender ? sender.id : null,
    senderName: sender ? sender.name : "Former user",
    senderPicture: sender?.pictureVisibleToCampus ? sender.picture : null,
    text: message.text,
    sentAt: message.sentAt
  };
}

function requireChatUser(request, response) {
  const session = readSession(request);
  if (!session) {
    jsonResponse(response, 401, { error: "Google sign-in is required to use chat." });
    return null;
  }
  return upsertChatUser(session);
}

function handleChatApi(request, response, url) {
  const user = requireChatUser(request, response);
  if (!user || !completeProfileRequired(user, response)) return;

  if (request.method === "GET" && url.pathname === "/api/chat/users") {
    jsonResponse(response, 200, {
      users: chatStore.users.filter((candidate) => candidate.sub !== user.sub && candidate.profileCompleted).map(chatUser)
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/chat/messages") {
    const room = url.searchParams.get("room");
    const peerId = url.searchParams.get("peer");
    const afterValue = url.searchParams.get("after") || "0";
    const after = Number(afterValue);
    if (!Number.isSafeInteger(after) || after < 0 || (room !== "campus" && peerId === null) ||
        (room === "campus" && peerId !== null) || (room !== "campus" && room !== null)) {
      jsonResponse(response, 400, { error: "Choose a valid chat and message cursor." });
      return;
    }

    let messages;
    if (room === "campus") {
      messages = chatStore.messages.filter((message) => message.recipientSub === null);
    } else {
      const peer = chatStore.users.find((candidate) => candidate.id === peerId);
      if (!peer || peer.sub === user.sub) {
        jsonResponse(response, 404, { error: "That chat participant was not found." });
        return;
      }
      if (!acceptedFriends(user.sub, peer.sub)) {
        jsonResponse(response, 403, { error: "Accept a friend request before opening a private chat." });
        return;
      }
      messages = chatStore.messages.filter((message) =>
        (message.senderSub === user.sub && message.recipientSub === peer.sub) ||
        (message.senderSub === peer.sub && message.recipientSub === user.sub)
      );
    }

    const unread = messages.filter((message) => message.id > after);
    const page = after === 0 ? unread.slice(-100) : unread.slice(0, 100);
    jsonResponse(response, 200, { messages: page.map(publicChatMessage) });
    return;
  }

  jsonResponse(response, 404, { error: "Chat endpoint not found." });
}

function roomSummary(room) {
  return {
    id: room.id,
    name: room.name,
    description: room.description,
    memberCount: room.memberSubs.length,
    joined: room.memberSubs.includes(room.currentMemberSub),
    isHost: room.ownerSub === room.currentMemberSub,
    passwordProtected: Boolean(room.passwordHash),
    passwordNeedsSetup: room.id !== "campus-commons" && !room.passwordHash,
    createdAt: room.createdAt
  };
}

function isValidRoomPassword(room, password) {
  if (!room.passwordHash || typeof password !== "string") return false;
  const expected = Buffer.from(room.passwordHash, "base64url");
  const actual = crypto.scryptSync(password, Buffer.from(room.passwordSalt, "base64url"), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function requireRoomMember(roomId, user, response) {
  const room = chatStore.rooms.find((candidate) => candidate.id === roomId);
  if (!room) {
    jsonResponse(response, 404, { error: "That study room was not found." });
    return null;
  }
  if (!room.memberSubs.includes(user.sub)) {
    jsonResponse(response, 403, { error: "Join this study room before viewing its board or chat." });
    return null;
  }
  return room;
}

function handleRoomApi(request, response, url, body = null) {
  const user = requireChatUser(request, response);
  if (!user || !completeProfileRequired(user, response)) return;

  if (url.pathname === "/api/rooms" && request.method === "GET") {
    jsonResponse(response, 200, {
      rooms: chatStore.rooms.map((room) => roomSummary({ ...room, currentMemberSub: user.sub }))
    });
    return;
  }

  if (url.pathname === "/api/rooms" && request.method === "POST") {
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    const description = typeof body?.description === "string" ? body.description.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!name || name.length > 60 || description.length > 240 || password.length < 8 || password.length > 128) {
      jsonResponse(response, 400, { error: "Enter a room name, an optional description, and a password of 8–128 characters." });
      return;
    }
    if (chatStore.rooms.length >= 100) {
      jsonResponse(response, 409, { error: "This demo has reached its study room limit." });
      return;
    }
    const room = {
      id: crypto.randomUUID(),
      name,
      description,
      passwordSalt: crypto.randomBytes(16).toString("base64url"),
      ownerSub: user.sub,
      createdAt: Date.now(),
      memberSubs: [user.sub]
    };
    room.passwordHash = crypto.scryptSync(password, Buffer.from(room.passwordSalt, "base64url"), 64).toString("base64url");
    chatStore.rooms.push(room);
    saveChatStore();
    jsonResponse(response, 201, { room: roomSummary({ ...room, currentMemberSub: user.sub }) });
    return;
  }

  const joinMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/join$/i);
  if (joinMatch && request.method === "POST") {
    const room = chatStore.rooms.find((candidate) => candidate.id === joinMatch[1]);
    if (!room) {
      jsonResponse(response, 404, { error: "That study room was not found." });
      return;
    }
    if (!room.memberSubs.includes(user.sub) &&
        (room.id !== "campus-commons" && (!room.passwordHash || !isValidRoomPassword(room, body?.password)))) {
      jsonResponse(response, 403, { error: "That room password is not correct." });
      return;
    }
    if (!room.memberSubs.includes(user.sub)) {
      room.memberSubs.push(user.sub);
      saveChatStore();
    }
    jsonResponse(response, 200, { room: roomSummary({ ...room, currentMemberSub: user.sub }) });
    return;
  }

  const leaveMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/leave$/i);
  if (leaveMatch && request.method === "POST") {
    const room = chatStore.rooms.find((candidate) => candidate.id === leaveMatch[1]);
    if (!room) {
      jsonResponse(response, 404, { error: "That study room was not found." });
      return;
    }
    if (room.ownerSub === user.sub) {
      jsonResponse(response, 409, { error: "The room host cannot leave their room." });
      return;
    }
    room.memberSubs = room.memberSubs.filter((sub) => sub !== user.sub);
    saveChatStore();
    jsonResponse(response, 200, { room: roomSummary({ ...room, currentMemberSub: user.sub }) });
    return;
  }

  const passwordMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/password$/i);
  if (passwordMatch && request.method === "POST") {
    const room = chatStore.rooms.find((candidate) => candidate.id === passwordMatch[1]);
    if (!room) {
      jsonResponse(response, 404, { error: "That study room was not found." });
      return;
    }
    if (room.ownerSub !== user.sub || room.id === "campus-commons") {
      jsonResponse(response, 403, { error: "Only the host can set this room password." });
      return;
    }
    const password = typeof body?.password === "string" ? body.password : "";
    if (password.length < 8 || password.length > 128) {
      jsonResponse(response, 400, { error: "Room passwords must contain 8–128 characters." });
      return;
    }
    room.passwordSalt = crypto.randomBytes(16).toString("base64url");
    room.passwordHash = crypto.scryptSync(password, Buffer.from(room.passwordSalt, "base64url"), 64).toString("base64url");
    saveChatStore();
    jsonResponse(response, 200, { passwordProtected: true });
    return;
  }

  const inviteesMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/invitees$/i);
  if (inviteesMatch && request.method === "GET") {
    const room = chatStore.rooms.find((candidate) => candidate.id === inviteesMatch[1]);
    if (!room) {
      jsonResponse(response, 404, { error: "That study room was not found." });
      return;
    }
    if (room.ownerSub !== user.sub) {
      jsonResponse(response, 403, { error: "Only the room host can invite friends." });
      return;
    }
    const invitees = chatStore.users.filter((candidate) =>
      candidate.profileCompleted &&
      !room.memberSubs.includes(candidate.sub) &&
      acceptedFriends(user.sub, candidate.sub)
    ).map((candidate) => campusProfile(candidate));
    jsonResponse(response, 200, { invitees });
    return;
  }

  const inviteMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/invites$/i);
  if (inviteMatch && request.method === "POST") {
    const room = chatStore.rooms.find((candidate) => candidate.id === inviteMatch[1]);
    if (!room) {
      jsonResponse(response, 404, { error: "That study room was not found." });
      return;
    }
    if (room.ownerSub !== user.sub) {
      jsonResponse(response, 403, { error: "Only the room host can invite friends." });
      return;
    }
    const invitee = typeof body?.userId === "string"
      ? chatStore.users.find((candidate) => candidate.id === body.userId)
      : null;
    if (!invitee || !invitee.profileCompleted || !acceptedFriends(user.sub, invitee.sub)) {
      jsonResponse(response, 403, { error: "Only an accepted friend can be invited to this room." });
      return;
    }
    if (!room.memberSubs.includes(invitee.sub)) {
      room.memberSubs.push(invitee.sub);
      saveChatStore();
    }
    jsonResponse(response, 200, {
      member: campusProfile(invitee),
      memberCount: room.memberSubs.length
    });
    return;
  }

  const boardMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/board$/i);
  if (boardMatch && request.method === "GET") {
    const room = requireRoomMember(boardMatch[1], user, response);
    if (!room) return;
    jsonResponse(response, 200, {
      notes: chatStore.boardNotes.filter((note) => note.roomId === room.id).slice(-200)
        .map((note) => ({
          id: note.id,
          text: note.text,
          authorName: note.authorName,
          color: note.color,
          createdAt: note.createdAt
        }))
    });
    return;
  }

  if (boardMatch && request.method === "POST") {
    const room = requireRoomMember(boardMatch[1], user, response);
    if (!room) return;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const colors = ["lavender", "mint", "peach"];
    if (!text || text.length > 500 || !colors.includes(body.color)) {
      jsonResponse(response, 400, { error: "Board notes need 1–500 characters and a valid color." });
      return;
    }
    if (chatStore.boardNotes.filter((note) => note.roomId === room.id).length >= 200) {
      jsonResponse(response, 409, { error: "This room's idea board is full." });
      return;
    }
    const note = {
      id: chatStore.boardNotes.length ? chatStore.boardNotes[chatStore.boardNotes.length - 1].id + 1 : 1,
      roomId: room.id,
      authorSub: user.sub,
      authorName: user.name,
      text,
      color: body.color,
      createdAt: new Date().toISOString()
    };
    chatStore.boardNotes.push(note);
    saveChatStore();
    jsonResponse(response, 201, {
      note: {
        id: note.id,
        text: note.text,
        authorName: note.authorName,
        color: note.color,
        createdAt: note.createdAt
      }
    });
    return;
  }

  const messageMatch = url.pathname.match(/^\/api\/rooms\/([a-z0-9-]+)\/messages$/i);
  if (messageMatch && request.method === "GET") {
    const room = requireRoomMember(messageMatch[1], user, response);
    if (!room) return;
    const after = Number(url.searchParams.get("after") || "0");
    if (!Number.isSafeInteger(after) || after < 0) {
      jsonResponse(response, 400, { error: "Choose a valid message cursor." });
      return;
    }
    const messages = chatStore.messages.filter((message) => message.roomId === room.id && message.id > after);
    jsonResponse(response, 200, { messages: messages.slice(after === 0 ? -100 : 0, after === 0 ? undefined : 100).map(publicChatMessage) });
    return;
  }

  if (messageMatch && request.method === "POST") {
    const room = requireRoomMember(messageMatch[1], user, response);
    if (!room) return;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 2000) {
      jsonResponse(response, 400, { error: "Messages must contain between 1 and 2000 characters." });
      return;
    }
    if (chatStore.messages.filter((message) => message.roomId === room.id).length >= 100_000) {
      jsonResponse(response, 409, { error: "This room's chat has reached its demo storage limit." });
      return;
    }
    const message = {
      id: chatStore.messages.length ? chatStore.messages[chatStore.messages.length - 1].id + 1 : 1,
      roomId: room.id,
      senderSub: user.sub,
      recipientSub: null,
      text,
      sentAt: new Date().toISOString()
    };
    chatStore.messages.push(message);
    saveChatStore();
    jsonResponse(response, 201, { message: publicChatMessage(message) });
    return;
  }

  jsonResponse(response, 404, { error: "Study room endpoint not found." });
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/config") {
    jsonResponse(response, 200, {
      googleSignInEnabled: Boolean(clientId),
      googleClientId: clientId || null
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/auth/me") {
    const session = readSession(request);
    if (!session) {
      jsonResponse(response, 401, { error: "You are not signed in." }, {
        "Set-Cookie": sessionCookie("", 0)
      });
      return;
    }
    const chatProfile = upsertChatUser(session);
    jsonResponse(response, 200, {
      user: publicUser(session),
      chatId: chatProfile.id,
      photoVisibleToCampus: chatProfile.pictureVisibleToCampus,
      profileCompleted: chatProfile.profileCompleted,
      campusProfile: campusProfile(chatProfile, chatProfile.sub)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/google") {
    if (!hasAllowedOrigin(request)) {
      jsonResponse(response, 403, { error: "This request origin is not allowed." });
      return;
    }
    if (!clientId) {
      jsonResponse(response, 503, { error: "Google sign-in is not configured on this server." });
      return;
    }
    const body = await readJsonBody(request);
    let user;
    try {
      user = await verifyGoogleIdToken(body.credential);
    } catch (error) {
      console.error("Google ID token verification failed:", error.message);
      const status = error.message.includes("Google public-key request failed") ||
        error.name === "TimeoutError" || error.name === "TypeError" ? 502 : 401;
      jsonResponse(response, status, {
        error: status === 502
          ? "Google sign-in verification is temporarily unavailable. Please retry."
          : "Google sign-in could not be verified. Please try again."
      });
      return;
    }
    const chatProfile = upsertChatUser(user);
    jsonResponse(response, 200, {
      user: publicUser(user),
      chatId: chatProfile.id,
      photoVisibleToCampus: chatProfile.pictureVisibleToCampus,
      profileCompleted: chatProfile.profileCompleted,
      campusProfile: campusProfile(chatProfile, chatProfile.sub)
    }, {
      "Set-Cookie": sessionCookie(signSession(user), sessionLifetimeSeconds)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    if (!hasAllowedOrigin(request)) {
      jsonResponse(response, 403, { error: "This request origin is not allowed." });
      return;
    }
    await readJsonBody(request);
    response.writeHead(204, {
      "Cache-Control": "no-store",
      "Set-Cookie": sessionCookie("", 0)
    });
    response.end();
    return;
  }

  if (url.pathname === "/api/profile" && request.method === "POST") {
    if (!hasAllowedOrigin(request)) {
      jsonResponse(response, 403, { error: "This request origin is not allowed." });
      return;
    }
    const user = requireChatUser(request, response);
    if (!user) return;
    const body = await readJsonBody(request);
    const department = typeof body?.department === "string" ? body.department.trim() : "";
    const parseList = (value) => Array.isArray(value)
      ? [...new Set(value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
      : null;
    const subjects = parseList(body?.subjects);
    const skills = parseList(body?.skills);
    if (!department || department.length > 80 ||
        !subjects || subjects.length < 1 || subjects.length > 12 ||
        subjects.some((subject) => subject.length > 60) ||
        !skills || skills.length < 1 || skills.length > 20 ||
        skills.some((skill) => skill.length > 60)) {
      jsonResponse(response, 400, { error: "Add a department, 1–12 subjects, and 1–20 skills. Each item has a 60-character limit." });
      return;
    }
    user.department = department;
    user.subjects = subjects;
    user.skills = skills;
    user.profileCompleted = true;
    saveChatStore();
    jsonResponse(response, 200, {
      profileCompleted: true,
      campusProfile: campusProfile(user, user.sub)
    });
    return;
  }

  if (url.pathname === "/api/directory" && request.method === "GET") {
    const user = requireChatUser(request, response);
    if (!user || !completeProfileRequired(user, response)) return;
    const people = chatStore.users.filter((candidate) =>
      candidate.sub !== user.sub && candidate.profileCompleted
    ).map((candidate) => ({
      ...campusProfile(candidate),
      relationship: relationshipStatus(user.sub, candidate.sub),
      requestId: chatStore.friendRequests.find((friendRequest) =>
        friendRequest.status === "pending" &&
        friendRequest.senderSub === candidate.sub &&
        friendRequest.recipientSub === user.sub
      )?.id || null
    })).sort((first, second) => first.name.localeCompare(second.name));
    jsonResponse(response, 200, { people });
    return;
  }

  if (url.pathname === "/api/friend-requests" && request.method === "POST") {
    if (!hasAllowedOrigin(request)) {
      jsonResponse(response, 403, { error: "This request origin is not allowed." });
      return;
    }
    const user = requireChatUser(request, response);
    if (!user || !completeProfileRequired(user, response)) return;
    const body = await readJsonBody(request);
    const recipient = typeof body?.recipientId === "string"
      ? chatStore.users.find((candidate) => candidate.id === body.recipientId)
      : null;
    if (!recipient || recipient.sub === user.sub || !recipient.profileCompleted) {
      jsonResponse(response, 404, { error: "Choose a valid campus member." });
      return;
    }
    if (acceptedFriends(user.sub, recipient.sub)) {
      jsonResponse(response, 409, { error: "You are already friends." });
      return;
    }
    if (chatStore.friendRequests.some((candidate) =>
      candidate.status === "pending" &&
      ((candidate.senderSub === user.sub && candidate.recipientSub === recipient.sub) ||
        (candidate.senderSub === recipient.sub && candidate.recipientSub === user.sub))
    )) {
      jsonResponse(response, 409, { error: "A friend request between you is already pending." });
      return;
    }
    const friendRequest = {
      id: crypto.randomUUID(),
      senderSub: user.sub,
      recipientSub: recipient.sub,
      status: "pending",
      createdAt: Date.now()
    };
    chatStore.friendRequests.push(friendRequest);
    saveChatStore();
    jsonResponse(response, 201, { status: friendRequest.status });
    return;
  }

  if (url.pathname.startsWith("/api/friend-requests/") && request.method === "POST") {
    if (!hasAllowedOrigin(request)) {
      jsonResponse(response, 403, { error: "This request origin is not allowed." });
      return;
    }
    const user = requireChatUser(request, response);
    if (!user || !completeProfileRequired(user, response)) return;
    const body = await readJsonBody(request);
    if (respondFriendRequest(url.pathname, response, user, body)) return;
  }

  if (url.pathname.startsWith("/api/chat/")) {
    if (request.method === "POST" && !hasAllowedOrigin(request)) {
      jsonResponse(response, 403, { error: "This request origin is not allowed." });
      return;
    }
    if (request.method === "GET") {
      handleChatApi(request, response, url);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/chat/messages") {
      const user = requireChatUser(request, response);
      if (!user || !completeProfileRequired(user, response)) return;
      const body = await readJsonBody(request);
      if (!body || typeof body.text !== "string") {
        jsonResponse(response, 400, { error: "A message is required." });
        return;
      }
      const text = body.text.trim();
      if (!text || text.length > 2000) {
        jsonResponse(response, 400, { error: "Messages must contain between 1 and 2000 characters." });
        return;
      }

      let recipientSub = null;
      if (body.recipientId !== undefined && body.recipientId !== null) {
        if (typeof body.recipientId !== "string") {
          jsonResponse(response, 400, { error: "Choose a valid chat participant." });
          return;
        }
        const recipient = chatStore.users.find((candidate) => candidate.id === body.recipientId);
        if (!recipient || recipient.sub === user.sub) {
          jsonResponse(response, 404, { error: "That chat participant was not found." });
          return;
        }
        if (!acceptedFriends(user.sub, recipient.sub)) {
          jsonResponse(response, 403, { error: "Send and accept a friend request before starting a private chat." });
          return;
        }
        recipientSub = recipient.sub;
      }

      const message = {
        id: chatStore.messages.length ? chatStore.messages[chatStore.messages.length - 1].id + 1 : 1,
        senderSub: user.sub,
        recipientSub,
        text,
        sentAt: new Date().toISOString()
      };
      chatStore.messages.push(message);
      saveChatStore();
      jsonResponse(response, 201, { message: publicChatMessage(message) });
      return;
    }
  }

  if (url.pathname === "/api/profile/privacy" && (request.method === "GET" || request.method === "POST")) {
    if (request.method === "POST" && !hasAllowedOrigin(request)) {
      jsonResponse(response, 403, { error: "This request origin is not allowed." });
      return;
    }
    const user = requireChatUser(request, response);
    if (!user) return;
    if (request.method === "GET") {
      jsonResponse(response, 200, { photoVisibleToCampus: user.pictureVisibleToCampus });
      return;
    }
    const body = await readJsonBody(request);
    if (typeof body?.photoVisibleToCampus !== "boolean") {
      jsonResponse(response, 400, { error: "Choose whether your Google profile photo is visible to campus members." });
      return;
    }
    user.pictureVisibleToCampus = body.photoVisibleToCampus;
    saveChatStore();
    jsonResponse(response, 200, { photoVisibleToCampus: user.pictureVisibleToCampus });
    return;
  }

  if (url.pathname.startsWith("/api/rooms")) {
    if (request.method === "POST" && !hasAllowedOrigin(request)) {
      jsonResponse(response, 403, { error: "This request origin is not allowed." });
      return;
    }
    const body = request.method === "POST" ? await readJsonBody(request) : null;
    handleRoomApi(request, response, url, body);
    return;
  }

  jsonResponse(response, 404, { error: "API endpoint not found." });
}

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

function serveStatic(request, response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    jsonResponse(response, 400, { error: "Invalid URL path." });
    return;
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.slice(1);
  const filePath = path.resolve(root, relativePath);
  const pathParts = relativePath.split(/[\\/]+/);
  if (pathParts.some((part) => part.startsWith(".") || part === "node_modules")) {
    jsonResponse(response, 404, { error: "File not found." });
    return;
  }
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    jsonResponse(response, 403, { error: "Path is not allowed." });
    return;
  }
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      jsonResponse(response, 404, { error: "File not found." });
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer(async (request, response) => {
  let url;
  try {
    url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
    } else if (request.method === "GET" || request.method === "HEAD") {
      serveStatic(request, response, url.pathname);
    } else {
      jsonResponse(response, 405, { error: "Method not allowed." }, { Allow: "GET, HEAD" });
    }
  } catch (error) {
    console.error("FriendZone request failed:", error);
    if (!response.headersSent) {
      jsonResponse(response, error.status || 500, {
        error: error.status ? error.message : "The server could not complete the request."
      });
    } else {
      response.destroy(error);
    }
  }
});

if (require.main === module) {
  server.listen(port, () => {
    console.log(`FriendZone is running at http://localhost:${port}`);
    if (!clientId) console.warn("Google sign-in is disabled. Set GOOGLE_CLIENT_ID in .env to enable it.");
  });
}

module.exports = { server, verifyGoogleIdToken };
