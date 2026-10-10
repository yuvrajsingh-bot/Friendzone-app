"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, test } = require("node:test");

const googleClientId = "friendzone-test-client.apps.googleusercontent.com";
process.env.GOOGLE_CLIENT_ID = googleClientId;
process.env.SESSION_SECRET = "friendzone-test-session-secret-which-is-long-enough";
const chatFilePath = path.join(__dirname, `.friendzone-chat-test-${process.pid}.json`);
process.env.FRIENDZONE_CHAT_FILE = chatFilePath;

const { server, verifyGoogleIdToken } = require("./server");
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const signingKid = "friendzone-test-key";
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: signingKid, use: "sig", alg: "RS256" };
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
  if (String(url) === "https://www.googleapis.com/oauth2/v3/certs") {
    return new Response(JSON.stringify({ keys: [publicJwk] }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=300" }
    });
  }
  return originalFetch(url, options);
};

let serverOrigin;

function makeGoogleToken(overrides = {}, signingKey = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: signingKid, typ: "JWT" })).toString("base64url");
  const claims = {
    iss: "https://accounts.google.com",
    aud: googleClientId,
    sub: "google-user-123",
    email: "student@example.edu",
    email_verified: true,
    name: "Test Student",
    exp: now + 3600,
    iat: now,
    ...overrides
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), signingKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  serverOrigin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  global.fetch = originalFetch;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  try {
    fs.unlinkSync(chatFilePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
});

async function signIn({ sub, email, name, picture }) {
  const response = await originalFetch(`${serverOrigin}/api/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: serverOrigin },
    body: JSON.stringify({ credential: makeGoogleToken({ sub, email, name, picture }) })
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const result = await response.json();
  const profileResponse = await roomRequest("/api/profile", cookie, "POST", {
    department: "Computer Science",
    subjects: ["Algorithms", "Web Development"],
    skills: ["JavaScript", "Research"]
  });
  assert.equal(profileResponse.status, 200);
  return { cookie, result };
}

async function getChat(pathname, cookie) {
  return originalFetch(`${serverOrigin}${pathname}`, {
    headers: cookie ? { Cookie: cookie } : {}
  });
}

async function sendChatMessage(cookie, body) {
  return originalFetch(`${serverOrigin}/api/chat/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: serverOrigin,
      Cookie: cookie
    },
    body: JSON.stringify(body)
  });
}

async function roomRequest(pathname, cookie, method = "GET", body) {
  return originalFetch(`${serverOrigin}${pathname}`, {
    method,
    headers: {
      ...(method === "POST" ? { "Content-Type": "application/json", Origin: serverOrigin } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

test("verifies Google ID-token signature and account claims", async () => {
  const user = await verifyGoogleIdToken(makeGoogleToken());
  assert.deepEqual(user, {
    sub: "google-user-123",
    name: "Test Student",
    email: "student@example.edu",
    picture: null
  });
});

test("rejects tokens with an invalid signature or audience", async () => {
  const otherKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  await assert.rejects(verifyGoogleIdToken(makeGoogleToken({}, otherKey)), /signature is invalid/);
  await assert.rejects(verifyGoogleIdToken(makeGoogleToken({ aud: "another-client.apps.googleusercontent.com" })), /claims are invalid/);
});

test("Google login API creates an HttpOnly session that can be read and cleared", async () => {
  const response = await originalFetch(`${serverOrigin}/api/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: serverOrigin },
    body: JSON.stringify({ credential: makeGoogleToken() })
  });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);

  const cookiePair = cookie.split(";")[0];
  const profileResponse = await originalFetch(`${serverOrigin}/api/auth/me`, {
    headers: { Cookie: cookiePair }
  });
  assert.equal(profileResponse.status, 200);
  const signedIn = await profileResponse.json();
  assert.equal(signedIn.user.email, "student@example.edu");
  assert.equal(signedIn.profileCompleted, false);
  const setupRequired = await roomRequest("/api/rooms", cookiePair);
  assert.equal(setupRequired.status, 409);
  const directorySetupRequired = await roomRequest("/api/directory", cookiePair);
  assert.equal(directorySetupRequired.status, 409);
  const invalidProfile = await roomRequest("/api/profile", cookiePair, "POST", {
    department: "",
    subjects: [],
    skills: []
  });
  assert.equal(invalidProfile.status, 400);
  const savedProfile = await roomRequest("/api/profile", cookiePair, "POST", {
    department: "Computer Science",
    subjects: ["Data Structures"],
    skills: ["Problem solving"]
  });
  assert.equal(savedProfile.status, 200);
  const completedProfile = await savedProfile.json();
  assert.equal(completedProfile.profileCompleted, true);
  assert.deepEqual(completedProfile.campusProfile.subjects, ["Data Structures"]);

  const logoutResponse = await originalFetch(`${serverOrigin}/api/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: serverOrigin },
    body: "{}"
  });
  assert.equal(logoutResponse.status, 204);
  assert.match(logoutResponse.headers.get("set-cookie"), /Max-Age=0/);

  const unauthenticatedResponse = await originalFetch(`${serverOrigin}/api/auth/me`);
  assert.equal(unauthenticatedResponse.status, 401);
});

test("rejects a cross-origin sign-in request", async () => {
  const response = await originalFetch(`${serverOrigin}/api/auth/google`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
    body: JSON.stringify({ credential: makeGoogleToken() })
  });
  assert.equal(response.status, 403);
});

test("chat requires a Google session and keeps email addresses out of the member directory", async () => {
  const unauthenticated = await getChat("/api/chat/users");
  assert.equal(unauthenticated.status, 401);

  const alice = await signIn({ sub: "chat-alice", email: "alice@example.edu", name: "Alice" });
  const bob = await signIn({ sub: "chat-bob", email: "bob@example.edu", name: "Bob" });
  const response = await getChat("/api/chat/users", alice.cookie);
  assert.equal(response.status, 200);
  const { users } = await response.json();
  const bobProfile = users.find((user) => user.id === bob.result.chatId);
  assert.equal(bobProfile.name, "Bob");
  assert.equal(users.some((user) => "email" in user), false);
  const directory = await getChat("/api/directory", alice.cookie);
  const bobCampusProfile = (await directory.json()).people.find((person) => person.id === bob.result.chatId);
  assert.equal(bobCampusProfile.department, "Computer Science");
  assert.deepEqual(bobCampusProfile.subjects, ["Algorithms", "Web Development"]);
  assert.deepEqual(bobCampusProfile.skills, ["JavaScript", "Research"]);
  assert.equal("email" in bobCampusProfile, false);
});

test("campus chat is shared while private messages require accepted friendship", async () => {
  const alice = await signIn({ sub: "chat-alice", email: "alice@example.edu", name: "Alice" });
  const bob = await signIn({ sub: "chat-bob", email: "bob@example.edu", name: "Bob" });
  const charlie = await signIn({ sub: "chat-charlie", email: "charlie@example.edu", name: "Charlie" });

  const campusPost = await sendChatMessage(alice.cookie, { text: "Hello campus" });
  assert.equal(campusPost.status, 201);
  const campusMessages = await getChat("/api/chat/messages?room=campus", bob.cookie);
  assert.equal(campusMessages.status, 200);
  assert.equal((await campusMessages.json()).messages[0].text, "Hello campus");

  const blockedPrivatePost = await sendChatMessage(alice.cookie, {
    text: "Hello Bob",
    recipientId: bob.result.chatId
  });
  assert.equal(blockedPrivatePost.status, 403);

  const requestPost = await roomRequest("/api/friend-requests", alice.cookie, "POST", {
    recipientId: bob.result.chatId
  });
  assert.equal(requestPost.status, 201);
  const bobDirectory = await getChat("/api/directory", bob.cookie);
  const incoming = (await bobDirectory.json()).people.find((person) => person.id === alice.result.chatId);
  assert.equal(incoming.relationship, "incoming");
  const duplicateRequest = await roomRequest("/api/friend-requests", alice.cookie, "POST", {
    recipientId: bob.result.chatId
  });
  assert.equal(duplicateRequest.status, 409);
  const unauthorizedResponse = await roomRequest(`/api/friend-requests/${incoming.requestId}/respond`, charlie.cookie, "POST", {
    action: "accept"
  });
  assert.equal(unauthorizedResponse.status, 403);
  const accepted = await roomRequest(`/api/friend-requests/${incoming.requestId}/respond`, bob.cookie, "POST", {
    action: "accept"
  });
  assert.equal(accepted.status, 200);
  const newRequest = await roomRequest("/api/friend-requests", bob.cookie, "POST", {
    recipientId: charlie.result.chatId
  });
  assert.equal(newRequest.status, 201);
  const charlieDirectory = await getChat("/api/directory", charlie.cookie);
  const charlieIncoming = (await charlieDirectory.json()).people.find((person) => person.id === bob.result.chatId);
  const declined = await roomRequest(`/api/friend-requests/${charlieIncoming.requestId}/respond`, charlie.cookie, "POST", {
    action: "decline"
  });
  assert.equal(declined.status, 200);
  const declinedDirectMessage = await sendChatMessage(bob.cookie, {
    text: "You declined this request",
    recipientId: charlie.result.chatId
  });
  assert.equal(declinedDirectMessage.status, 403);

  const privatePost = await sendChatMessage(alice.cookie, {
    text: "Hello Bob",
    recipientId: bob.result.chatId
  });
  assert.equal(privatePost.status, 201);
  const aliceHistory = await getChat(`/api/chat/messages?peer=${bob.result.chatId}`, alice.cookie);
  assert.equal((await aliceHistory.json()).messages[0].text, "Hello Bob");
  const bobHistory = await getChat(`/api/chat/messages?peer=${alice.result.chatId}`, bob.cookie);
  assert.equal((await bobHistory.json()).messages[0].text, "Hello Bob");
  const charlieHistory = await getChat(`/api/chat/messages?peer=${alice.result.chatId}`, charlie.cookie);
  assert.equal(charlieHistory.status, 403);
});

test("chat validates message length and blocks cross-origin sends", async () => {
  const alice = await signIn({ sub: "chat-alice", email: "alice@example.edu", name: "Alice" });
  const tooLong = await sendChatMessage(alice.cookie, { text: "x".repeat(2001) });
  assert.equal(tooLong.status, 400);

  const crossOrigin = await originalFetch(`${serverOrigin}/api/chat/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://attacker.example",
      Cookie: alice.cookie
    },
    body: JSON.stringify({ text: "Not allowed" })
  });
  assert.equal(crossOrigin.status, 403);
});

test("study rooms share idea notes and group chat only with joined Google members", async () => {
  const alice = await signIn({ sub: "room-alice", email: "room-alice@example.edu", name: "Room Alice" });
  const bob = await signIn({ sub: "room-bob", email: "room-bob@example.edu", name: "Room Bob" });
  const outsider = await signIn({ sub: "room-outsider", email: "outsider@example.edu", name: "Outsider" });

  const create = await roomRequest("/api/rooms", alice.cookie, "POST", {
    name: "Design Lab",
    description: "A space for interface ideas.",
    password: "design-lab-secret"
  });
  assert.equal(create.status, 201);
  const { room } = await create.json();
  assert.equal(room.passwordProtected, true);
  assert.equal("passwordHash" in room, false);
  assert.equal("passwordSalt" in room, false);

  const outsiderBoard = await roomRequest(`/api/rooms/${room.id}/board`, outsider.cookie);
  assert.equal(outsiderBoard.status, 403);

  const list = await roomRequest("/api/rooms", bob.cookie);
  const roomSummary = (await list.json()).rooms.find((candidate) => candidate.id === room.id);
  assert.equal(roomSummary.joined, false);
  const wrongPassword = await roomRequest(`/api/rooms/${room.id}/join`, bob.cookie, "POST", {
    password: "incorrect-password"
  });
  assert.equal(wrongPassword.status, 403);
  const hostChange = await roomRequest(`/api/rooms/${room.id}/password`, alice.cookie, "POST", {
    password: "replacement-room-password"
  });
  assert.equal(hostChange.status, 200);
  const nonHostPasswordChange = await roomRequest(`/api/rooms/${room.id}/password`, bob.cookie, "POST", {
    password: "unapproved-password"
  });
  assert.equal(nonHostPasswordChange.status, 403);
  const oldPassword = await roomRequest(`/api/rooms/${room.id}/join`, bob.cookie, "POST", {
    password: "design-lab-secret"
  });
  assert.equal(oldPassword.status, 403);
  const join = await roomRequest(`/api/rooms/${room.id}/join`, bob.cookie, "POST", {
    password: "replacement-room-password"
  });
  assert.equal(join.status, 200);

  const notePost = await roomRequest(`/api/rooms/${room.id}/board`, alice.cookie, "POST", {
    text: "Start with a shared sketch.",
    color: "mint"
  });
  assert.equal(notePost.status, 201);
  assert.equal("authorSub" in (await notePost.json()).note, false);
  const board = await roomRequest(`/api/rooms/${room.id}/board`, bob.cookie);
  assert.equal((await board.json()).notes[0].text, "Start with a shared sketch.");

  const messagePost = await roomRequest(`/api/rooms/${room.id}/messages`, alice.cookie, "POST", {
    text: "Welcome to the design room."
  });
  assert.equal(messagePost.status, 201);
  const messages = await roomRequest(`/api/rooms/${room.id}/messages`, bob.cookie);
  assert.equal((await messages.json()).messages[0].text, "Welcome to the design room.");

  const outsiderMessages = await roomRequest(`/api/rooms/${room.id}/messages`, outsider.cookie);
  assert.equal(outsiderMessages.status, 403);

  const missingPassword = await roomRequest("/api/rooms", alice.cookie, "POST", {
    name: "No Password",
    description: ""
  });
  assert.equal(missingPassword.status, 400);
});

test("accepted friends can be directly invited into a password-protected room", async () => {
  const alice = await signIn({ sub: "invite-alice", email: "invite-alice@example.edu", name: "Invite Alice" });
  const bob = await signIn({ sub: "invite-bob", email: "invite-bob@example.edu", name: "Invite Bob" });
  const stranger = await signIn({ sub: "invite-stranger", email: "invite-stranger@example.edu", name: "Stranger" });

  const friendship = await roomRequest("/api/friend-requests", alice.cookie, "POST", {
    recipientId: bob.result.chatId
  });
  assert.equal(friendship.status, 201);
  const bobDirectory = await getChat("/api/directory", bob.cookie);
  const incoming = (await bobDirectory.json()).people.find((person) => person.id === alice.result.chatId);
  await roomRequest(`/api/friend-requests/${incoming.requestId}/respond`, bob.cookie, "POST", { action: "accept" });

  const create = await roomRequest("/api/rooms", alice.cookie, "POST", {
    name: "Private Design Room",
    description: "Invite-only collaboration.",
    password: "room-password-123"
  });
  const { room } = await create.json();

  const invitees = await roomRequest(`/api/rooms/${room.id}/invitees`, alice.cookie);
  assert.deepEqual((await invitees.json()).invitees.map((person) => person.id), [bob.result.chatId]);
  const nonHostInvite = await roomRequest(`/api/rooms/${room.id}/invites`, bob.cookie, "POST", {
    userId: stranger.result.chatId
  });
  assert.equal(nonHostInvite.status, 403);
  const hostInvitesNonfriend = await roomRequest(`/api/rooms/${room.id}/invites`, alice.cookie, "POST", {
    userId: stranger.result.chatId
  });
  assert.equal(hostInvitesNonfriend.status, 403);

  const invite = await roomRequest(`/api/rooms/${room.id}/invites`, alice.cookie, "POST", {
    userId: bob.result.chatId
  });
  assert.equal(invite.status, 200);
  const bobRooms = await roomRequest("/api/rooms", bob.cookie);
  assert.equal((await bobRooms.json()).rooms.find((candidate) => candidate.id === room.id).joined, true);
  const board = await roomRequest(`/api/rooms/${room.id}/board`, bob.cookie);
  assert.equal(board.status, 200);
});

test("Google profile photos are private until the owner enables campus visibility", async () => {
  const picture = "https://lh3.googleusercontent.com/test-profile-photo";
  const alice = await signIn({
    sub: "photo-alice",
    email: "photo-alice@example.edu",
    name: "Photo Alice",
    picture
  });
  const bob = await signIn({ sub: "photo-bob", email: "photo-bob@example.edu", name: "Photo Bob" });

  const initialSettings = await roomRequest("/api/profile/privacy", alice.cookie);
  assert.equal((await initialSettings.json()).photoVisibleToCampus, false);
  const hiddenPhotoDirectory = await getChat("/api/chat/users", bob.cookie);
  const hiddenPhotoProfile = (await hiddenPhotoDirectory.json()).users.find((user) => user.id === alice.result.chatId);
  assert.equal(hiddenPhotoProfile.picture, null);

  const update = await roomRequest("/api/profile/privacy", alice.cookie, "POST", {
    photoVisibleToCampus: true
  });
  assert.equal((await update.json()).photoVisibleToCampus, true);
  const visiblePhotoDirectory = await getChat("/api/chat/users", bob.cookie);
  const visiblePhotoProfile = (await visiblePhotoDirectory.json()).users.find((user) => user.id === alice.result.chatId);
  assert.equal(visiblePhotoProfile.picture, picture);

  const invalidUpdate = await roomRequest("/api/profile/privacy", alice.cookie, "POST", {
    photoVisibleToCampus: "yes"
  });
  assert.equal(invalidUpdate.status, 400);
  const nullUpdate = await roomRequest("/api/profile/privacy", alice.cookie, "POST", null);
  assert.equal(nullUpdate.status, 400);
});
