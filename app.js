"use strict";

if (typeof window !== "undefined") {
const PROFILE_KEY = "friendzone.profile.v1";
const avatarColors = [
  ["#f1eaff", "#8063cd"], ["#e5f6f1", "#4a9f85"], ["#fff0e6", "#c57c4f"],
  ["#ffeaf0", "#c96889"], ["#eaf1ff", "#5d7dc1"], ["#fff7dc", "#b18b38"]
];
let profile = loadProfile();
let toastTimer;
let googleScriptPromise;
let googleClientId = "";
let loginRequired = false;
let roomRefreshTimer = null;
let roomRefreshInProgress = false;
let roomGeneration = 0;
let activeRoomId = null;
let activeRoomView = "board";
let rooms = [];
let roomNotes = [];
let roomMessages = [];
let photoVisibleToCampus = false;
let campusPeople = [];
let directoryRefreshTimer = null;
let directoryRefreshInProgress = false;
let pendingJoinRoomId = null;
let roomInvitees = [];

const $ = (selector) => document.querySelector(selector);
const studentList = $("#student-list");
const profileSetupDialog = $("#profile-setup-dialog");
const authDialog = $("#auth-dialog");
const floatingMenu = $("#floating-menu");

function loadProfile() {
  if (typeof window === "undefined") return null;
  try {
    const saved = window.localStorage.getItem(PROFILE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved);
    return parsed.provider === "demo" && typeof parsed.name === "string" && typeof parsed.email === "string"
      ? parsed
      : null;
  } catch (error) {
    console.error("Could not load FriendZone profile:", error);
    return null;
  }
}

function initials(name) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function colorFor(id) {
  return avatarColors[(Number(id) - 1) % avatarColors.length];
}

function addText(parent, tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function setPersonAvatar(avatar, person, index) {
  if (person.picture) {
    const image = document.createElement("img");
    image.src = person.picture;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    avatar.append(image);
  } else {
    avatar.textContent = initials(person.name);
    const [background, foreground] = colorFor(index + 1);
    avatar.style.backgroundColor = background;
    avatar.style.color = foreground;
  }
}

function createFriendButton(person) {
  const actions = document.createElement("div");
  actions.className = "person-actions";
  if (person.relationship === "incoming") {
    const accept = addText(actions, "button", "button button-primary friend-action", "Accept");
    accept.type = "button";
    accept.dataset.friendAction = "accept";
    accept.dataset.requestId = person.requestId;
    const decline = addText(actions, "button", "button button-quiet friend-action", "Decline");
    decline.type = "button";
    decline.dataset.friendAction = "decline";
    decline.dataset.requestId = person.requestId;
  } else {
    const label = person.relationship === "friends"
      ? "Friends"
      : person.relationship === "outgoing"
        ? "Request sent"
        : "Add friend";
    const button = addText(actions, "button", `button ${person.relationship === "none" ? "button-primary" : "button-quiet"} friend-action`, label);
    button.type = "button";
    button.disabled = person.relationship !== "none";
    button.dataset.friendAction = "send";
    button.dataset.userId = person.id;
  }
  return actions;
}

function renderStudents() {
  const query = $("#search-input").value.trim().toLocaleLowerCase();
  const department = $("#department-filter").value;
  const filtered = campusPeople.filter((person) =>
    (!department || person.department === department) &&
    (!query || `${person.name} ${person.department} ${person.subjects.join(" ")} ${person.skills.join(" ")}`.toLocaleLowerCase().includes(query))
  );
  studentList.replaceChildren();
  $("#student-empty").classList.toggle("hidden", filtered.length !== 0);
  studentList.classList.toggle("hidden", filtered.length === 0);

  filtered.forEach((person, index) => {
    const row = document.createElement("article");
    row.className = `student-row${person.relationship === "incoming" ? " friend-request-row" : ""}`;
    const avatar = addText(row, "div", "student-avatar", "");
    setPersonAvatar(avatar, person, index);
    const info = document.createElement("div");
    info.className = "student-info";
    addText(info, "strong", "", person.name);
    addText(info, "span", "", person.department);
    addText(info, "span", "person-tags", `Subjects: ${person.subjects.join(", ")}`);
    addText(info, "span", "person-tags", `Skills: ${person.skills.join(", ")}`);
    row.append(info);
    row.append(createFriendButton(person));
    studentList.append(row);
  });

  $("#people-count").textContent = String(campusPeople.length);
  const totalMembers = campusPeople.length + (profile?.provider === "google" && profile.profileCompleted ? 1 : 0);
  const departments = new Set(campusPeople.map((person) => person.department));
  if (profile?.provider === "google" && profile.profileCompleted) departments.add(profile.department);
  $("#student-stat").textContent = String(totalMembers);
  $("#nav-student-count").textContent = String(totalMembers);
  $("#department-stat").textContent = String(departments.size);
  $("#student-empty-title").textContent = $("#search-input").value || department
    ? "No campus people found"
    : "No other campus people yet";
  $("#student-empty-message").textContent = profile?.provider === "google"
    ? "Google members appear here after completing their campus profile."
    : "Sign in with Google and complete your profile to find campus collaborators.";
}

function renderDepartmentFilter() {
  const filter = $("#department-filter");
  const selected = filter.value;
  const departments = [...new Set(campusPeople.map((person) => person.department))].sort((a, b) => a.localeCompare(b));
  filter.replaceChildren(new Option("All departments", ""));
  departments.forEach((department) => filter.add(new Option(department, department)));
  if (departments.includes(selected)) filter.value = selected;
}

function render() {
  renderDepartmentFilter();
  renderStudents();
}

async function refreshCampusPeople() {
  if (profile?.provider !== "google" || !profile.profileCompleted || directoryRefreshInProgress) return;
  directoryRefreshInProgress = true;
  try {
    const response = await fetch("/api/directory", { credentials: "same-origin" });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Could not load campus people.");
    if (!Array.isArray(result.people)) throw new Error("The campus directory returned an invalid response.");
    campusPeople = result.people;
    renderDepartmentFilter();
    renderStudents();
  } catch (error) {
    console.error("Could not refresh campus people:", error);
    showToast(error.message);
  } finally {
    directoryRefreshInProgress = false;
  }
}

function startCampusDirectory() {
  if (directoryRefreshTimer) return;
  refreshCampusPeople();
  directoryRefreshTimer = window.setInterval(refreshCampusPeople, 12000);
}

function stopCampusDirectory() {
  if (directoryRefreshTimer) window.clearInterval(directoryRefreshTimer);
  directoryRefreshTimer = null;
  directoryRefreshInProgress = false;
  campusPeople = [];
  renderDepartmentFilter();
  renderStudents();
}

function showToast(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

function renderProfile() {
  const displayName = profile ? profile.name : "Guest";
  const avatarText = profile ? initials(profile.name) : "G";
  document.querySelectorAll("[data-user-name]").forEach((element) => {
    element.textContent = displayName;
  });
  document.querySelectorAll("[data-user-caption]").forEach((element) => {
    element.textContent = profile ? `${profile.provider === "google" ? "Google account" : "Demo profile"} · ${profile.email}` : "Sign in to your account";
  });
  document.querySelectorAll("[data-user-avatar]").forEach((element) => {
    element.replaceChildren();
    if (profile?.provider === "google" && profile.picture) {
      const image = document.createElement("img");
      image.src = profile.picture;
      image.alt = "";
      image.referrerPolicy = "no-referrer";
      element.append(image);
    } else {
      element.textContent = avatarText;
    }
    element.setAttribute("aria-label", profile ? `Signed in as ${displayName}` : "Guest profile");
  });
}

function setDemoProfile(nextProfile) {
  if (typeof window === "undefined") {
    console.error("Could not save FriendZone profile: browser storage is unavailable.");
    return false;
  }
  try {
    window.localStorage.setItem(PROFILE_KEY, JSON.stringify(nextProfile));
  } catch (error) {
    console.error("Could not save FriendZone profile:", error);
    showToast("Your browser could not save the profile.");
    return false;
  }
  profile = nextProfile;
  photoVisibleToCampus = false;
  profile.profileCompleted = false;
  renderProfile();
  updateAccessTier();
  finishLoginGate();
  authDialog.close();
  showToast(`Welcome${profile.name ? `, ${profile.name.split(" ")[0]}` : ""}!`);
  return true;
}

function setGoogleProfile(nextProfile) {
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(PROFILE_KEY);
    } catch (error) {
      console.error("Could not clear the old local demo profile:", error);
    }
  }
  profile = nextProfile;
  photoVisibleToCampus = Boolean(nextProfile.photoVisibleToCampus);
  renderProfile();
  updateAccessTier();
  finishLoginGate();
  authDialog.close();
  if (profile.profileCompleted) {
    showToast(`Welcome, ${profile.name.split(" ")[0]}!`);
  } else {
    openProfileSetup();
  }
}

function openProfileSetup(editing = false) {
  document.body.classList.toggle("profile-setup-required", !editing);
  $("#profile-setup-title").textContent = editing ? "Edit your campus profile" : "Complete your profile";
  $("#profile-setup-submit").textContent = editing ? "Save profile" : "Save profile and continue →";
  $("#cancel-profile-setup").classList.toggle("hidden", !editing);
  $("#profile-department").value = editing ? profile.department : "";
  $("#profile-subjects").value = editing ? profile.subjects.join(", ") : "";
  $("#profile-skills").value = editing ? profile.skills.join(", ") : "";
  if (!profileSetupDialog.open) profileSetupDialog.showModal();
  $("#profile-department").focus();
}

function openLoginGate() {
  loginRequired = true;
  document.body.classList.remove("auth-pending");
  document.body.classList.add("login-required");
  authDialog.classList.add("auth-gate");
  $(".auth-close").classList.add("hidden");
  openAuthDialog();
  $("#auth-title").textContent = "Sign in to continue";
  $("#auth-intro").textContent = "Sign in to enter your campus community.";
}

function finishLoginGate() {
  if (!loginRequired) return;
  loginRequired = false;
  document.body.classList.remove("login-required");
  authDialog.classList.remove("auth-gate");
  $(".auth-close").classList.remove("hidden");
}

function updateAccessTier() {
  const isGoogleUser = profile?.provider === "google" && profile.profileCompleted === true;
  document.body.classList.toggle("demo-access", profile?.provider === "demo");
  document.body.classList.toggle("google-access", isGoogleUser);
  $("#rooms-nav-item").classList.toggle("hidden", !isGoogleUser);
  $("#rooms-section").classList.toggle("hidden", !isGoogleUser);
  if (isGoogleUser) {
    startRooms();
    startCampusDirectory();
  } else {
    stopRooms();
    stopCampusDirectory();
  }
}

async function loadServerProfile() {
  try {
    const response = await fetch("/api/auth/me", { credentials: "same-origin" });
    if (response.status === 401) return;
    if (!response.ok) throw new Error(`Profile request failed with status ${response.status}.`);
    const result = await response.json();
    if (!result.user || typeof result.user.name !== "string" || typeof result.user.email !== "string") {
      throw new Error("The sign-in API returned an invalid profile.");
    }
    profile = {
      ...result.user,
      ...result.campusProfile,
      chatId: result.chatId,
      profileCompleted: result.profileCompleted === true,
      provider: "google"
    };
    photoVisibleToCampus = result.photoVisibleToCampus === true;
    renderProfile();
    updateAccessTier();
    if (profile.profileCompleted) {
      document.body.classList.remove("auth-pending", "profile-setup-required");
    } else {
      document.body.classList.remove("auth-pending");
      finishLoginGate();
      authDialog.close();
      openProfileSetup();
    }
  } catch (error) {
    console.warn("FriendZone sign-in API is unavailable:", error.message);
  }
}

function renderRoomMessages() {
  const transcript = $("#room-messages");
  transcript.replaceChildren();
  roomMessages.forEach((message) => {
    const article = document.createElement("article");
    article.className = `chat-message${message.senderId === profile?.chatId ? " own-message" : ""}`;
    const meta = document.createElement("div");
    meta.className = "chat-message-meta";
    const sender = document.createElement("span");
    sender.textContent = message.senderId === profile?.chatId ? "You" : message.senderName;
    const time = document.createElement("time");
    time.dateTime = message.sentAt;
    time.textContent = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(message.sentAt));
    meta.append(sender, time);
    const text = document.createElement("p");
    text.className = "chat-message-text";
    text.textContent = message.text;
    article.append(meta, text);
    transcript.append(article);
  });
  $("#room-chat-empty").classList.toggle("hidden", roomMessages.length > 0);
  transcript.scrollTop = transcript.scrollHeight;
}

function renderBoard() {
  const board = $("#board-notes");
  board.replaceChildren();
  roomNotes.forEach((note) => {
    const card = document.createElement("article");
    card.className = `board-note note-${note.color}`;
    const author = addText(card, "p", "board-note-author", note.authorName);
    author.title = new Date(note.createdAt).toLocaleString();
    addText(card, "p", "board-note-text", note.text);
    board.append(card);
  });
  $("#board-empty").classList.toggle("hidden", roomNotes.length > 0);
}

function renderRooms() {
  const roomList = $("#room-list");
  roomList.replaceChildren();
  rooms.forEach((room) => {
    const card = document.createElement("article");
    card.className = `room-card${room.id === activeRoomId ? " selected" : ""}`;
    const detail = document.createElement("div");
    detail.className = "room-card-detail";
    addText(detail, "strong", "room-card-name", room.name);
    addText(detail, "span", "room-card-description", room.description || "A shared room for campus ideas.");
    const securityStatus = room.id === "campus-commons"
      ? " · open to all"
      : room.passwordNeedsSetup
        ? " · host must set a password"
        : " · password protected";
    addText(detail, "span", "room-card-members", `${room.memberCount} ${room.memberCount === 1 ? "member" : "members"}${securityStatus}`);
    const action = document.createElement("button");
    action.type = "button";
    action.className = room.joined ? "button button-soft room-action" : "button button-quiet room-action";
    action.textContent = room.joined
      ? (room.id === activeRoomId ? "Open" : "Enter room")
      : room.passwordProtected || room.passwordNeedsSetup ? "Enter password" : "Join room";
    action.addEventListener("click", () => {
      if (room.joined) {
        openRoom(room.id);
      } else if (room.passwordProtected || room.passwordNeedsSetup) {
        pendingJoinRoomId = room.id;
        $("#join-room-title").textContent = `Join ${room.name}`;
        $("#join-room-description").textContent = "Enter the password provided by the room host.";
        $("#join-room-dialog").showModal();
        $("#join-room-password").focus();
      } else {
        joinRoom(room.id, "");
      }
    });
    card.append(detail, action);
    roomList.append(card);
  });
  $("#room-empty").classList.toggle("hidden", rooms.length > 0);
  $("#rooms-stat").textContent = String(rooms.length);
}

function renderActiveRoom() {
  const room = rooms.find((candidate) => candidate.id === activeRoomId && candidate.joined);
  const panel = $("#active-room");
  panel.classList.toggle("hidden", !room);
  if (!room) return;
  $("#active-room-title").textContent = room.name;
  $("#active-room-description").textContent = room.description || "A shared space for campus ideas.";
  $("#active-room-members").textContent = `${room.memberCount} ${room.memberCount === 1 ? "member" : "members"}`;
  $("#leave-room-button").classList.toggle("hidden", room.id === "campus-commons" || room.isHost);
  $("#invite-room-friends-button").classList.toggle("hidden", !room.isHost || room.id === "campus-commons");
  const passwordButton = $("#set-room-password-button");
  passwordButton.classList.toggle("hidden", !room.isHost || room.id === "campus-commons");
  passwordButton.textContent = room.passwordNeedsSetup ? "Set password" : "Change password";
  const boardSelected = activeRoomView === "board";
  $("#board-tab").classList.toggle("active", boardSelected);
  $("#board-tab").setAttribute("aria-pressed", String(boardSelected));
  $("#room-chat-tab").classList.toggle("active", !boardSelected);
  $("#room-chat-tab").setAttribute("aria-pressed", String(!boardSelected));
  $("#room-board").classList.toggle("hidden", !boardSelected);
  $("#room-chat").classList.toggle("hidden", boardSelected);
}

async function refreshRooms() {
  if (profile?.provider !== "google" || roomRefreshInProgress) return;
  roomRefreshInProgress = true;
  const generation = roomGeneration;
  try {
    const response = await fetch("/api/rooms", { credentials: "same-origin" });
    const result = await response.json();
    if (generation !== roomGeneration || profile?.provider !== "google") return;
    if (!response.ok) throw new Error(result.error || "Could not load project rooms.");
    if (!Array.isArray(result.rooms)) throw new Error("The room API returned an invalid room list.");
    rooms = result.rooms;
    if (!rooms.some((room) => room.id === activeRoomId && room.joined)) {
      activeRoomId = rooms.find((room) => room.id === "campus-commons" && room.joined)?.id ||
        rooms.find((room) => room.joined)?.id || null;
      roomMessages = [];
      roomNotes = [];
    }
    renderRooms();
    renderActiveRoom();
    const room = rooms.find((candidate) => candidate.id === activeRoomId && candidate.joined);
    if (!room) {
      $("#room-status").textContent = "Join a room to see its shared board and group chat.";
      return;
    }

    const encodedRoomId = encodeURIComponent(room.id);
    const [boardResponse, messagesResponse] = await Promise.all([
      fetch(`/api/rooms/${encodedRoomId}/board`, { credentials: "same-origin" }),
      fetch(`/api/rooms/${encodedRoomId}/messages?after=${roomMessages.length ? roomMessages[roomMessages.length - 1].id : 0}`, { credentials: "same-origin" })
    ]);
    const [boardResult, messagesResult] = await Promise.all([boardResponse.json(), messagesResponse.json()]);
    if (generation !== roomGeneration || profile?.provider !== "google") return;
    if (!boardResponse.ok) throw new Error(boardResult.error || "Could not load the shared idea board.");
    if (!messagesResponse.ok) throw new Error(messagesResult.error || "Could not load the room chat.");
    if (!Array.isArray(boardResult.notes) || !Array.isArray(messagesResult.messages)) {
      throw new Error("The room API returned invalid collaboration data.");
    }
    roomNotes = boardResult.notes;
    const knownIds = new Set(roomMessages.map((message) => message.id));
    roomMessages.push(...messagesResult.messages.filter((message) => !knownIds.has(message.id)));
    roomMessages.sort((first, second) => first.id - second.id);
    renderBoard();
    renderRoomMessages();
    $("#room-status").textContent = "Board and chat sync automatically with room members.";
  } catch (error) {
    if (generation !== roomGeneration || profile?.provider !== "google") return;
    console.error("Could not refresh FriendZone rooms:", error);
    $("#room-status").textContent = error.message.includes("Failed to fetch")
      ? "The room server is unavailable. Check that FriendZone is running."
      : error.message;
  } finally {
    if (generation === roomGeneration) roomRefreshInProgress = false;
  }
}

function startRooms() {
  if (roomRefreshTimer) return;
  refreshRooms();
  roomRefreshTimer = window.setInterval(refreshRooms, 5000);
}

function stopRooms() {
  roomGeneration++;
  if (roomRefreshTimer) window.clearInterval(roomRefreshTimer);
  roomRefreshTimer = null;
  roomRefreshInProgress = false;
  rooms = [];
  roomNotes = [];
  roomMessages = [];
  activeRoomId = null;
  renderRooms();
  renderActiveRoom();
}

async function roomRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: options.body
      ? { "Content-Type": "application/json", ...options.headers }
      : options.headers
  });
  const result = response.status === 204 ? {} : await response.json();
  if (!response.ok) throw new Error(result.error || "The room request could not be completed.");
  return result;
}

async function joinRoom(roomId, password) {
  try {
    const result = await roomRequest(`/api/rooms/${encodeURIComponent(roomId)}/join`, {
      method: "POST",
      body: JSON.stringify({ password })
    });
    activeRoomId = result.room.id;
    roomMessages = [];
    roomNotes = [];
    $("#join-room-dialog").close();
    $("#join-room-form").reset();
    await refreshRooms();
  } catch (error) {
    console.error("Could not join FriendZone room:", error);
    $("#join-room-description").textContent = error.message;
  }
}

async function openRoomInviteDialog() {
  if (!activeRoomId) return;
  const select = $("#invite-friend-select");
  const submit = $("#invite-friend-submit");
  select.replaceChildren(new Option("Loading friends…", ""));
  submit.disabled = true;
  $("#invite-friends-empty").classList.add("hidden");
  try {
    const result = await roomRequest(`/api/rooms/${encodeURIComponent(activeRoomId)}/invitees`);
    roomInvitees = result.invitees;
    select.replaceChildren(new Option("Choose a friend", ""));
    roomInvitees.forEach((friend) => select.add(new Option(friend.name, friend.id)));
    const hasInvitees = roomInvitees.length > 0;
    select.disabled = !hasInvitees;
    submit.disabled = !hasInvitees;
    $("#invite-friends-empty").classList.toggle("hidden", hasInvitees);
    $("#invite-friends-dialog").showModal();
  } catch (error) {
    console.error("Could not load room invitees:", error);
    showToast(error.message);
  }
}

async function openRoom(roomId) {
  if (activeRoomId === roomId) return;
  activeRoomId = roomId;
  roomMessages = [];
  roomNotes = [];
  renderRooms();
  renderActiveRoom();
  await refreshRooms();
}

async function openProfileSettings() {
  if (profile?.provider !== "google") return;
  try {
    const result = await roomRequest("/api/profile/privacy");
    photoVisibleToCampus = result.photoVisibleToCampus === true;
    $("#photo-visibility-toggle").checked = photoVisibleToCampus;
    $("#photo-visibility-toggle").disabled = !profile.picture;
    $("#profile-settings-dialog").showModal();
  } catch (error) {
    console.error("Could not load profile photo privacy settings:", error);
    showToast(error.message);
  }
}

function closeMenu() {
  floatingMenu.classList.add("hidden");
  if (activeMenuAnchor) activeMenuAnchor.setAttribute("aria-expanded", "false");
  activeMenuAnchor = null;
}

function appendMenuAction(label, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "menu-action";
  button.setAttribute("role", "menuitem");
  button.dataset.menuAction = action;
  button.textContent = label;
  floatingMenu.append(button);
}

function positionMenu() {
  if (!activeMenuAnchor || floatingMenu.classList.contains("hidden")) return;
  const rect = activeMenuAnchor.getBoundingClientRect();
  const width = Math.min(270, window.innerWidth - 24);
  floatingMenu.style.width = `${width}px`;
  floatingMenu.style.top = `${Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - floatingMenu.offsetHeight - 12))}px`;
  floatingMenu.style.left = `${Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12))}px`;
}

let activeMenuAnchor = null;
function openMenu(anchor, kind) {
  if (!floatingMenu.classList.contains("hidden") && activeMenuAnchor === anchor) {
    closeMenu();
    return;
  }
  closeMenu();
  activeMenuAnchor = anchor;
  anchor.setAttribute("aria-expanded", "true");
  floatingMenu.replaceChildren();

  if (kind === "profile") {
    addText(floatingMenu, "p", "menu-title", profile ? profile.name : "Welcome to FriendZone");
    if (profile) {
      addText(floatingMenu, "p", "menu-caption", profile.email);
      appendMenuAction(profile.provider === "demo" ? "Edit demo profile" : "Google account information", profile.provider === "demo" ? "edit-profile" : "account");
      if (profile.provider === "google") {
        appendMenuAction("Edit campus profile", "edit-campus-profile");
        appendMenuAction("Profile photo privacy", "photo-privacy");
      }
      appendMenuAction("Sign out", "sign-out");
    } else {
      addText(floatingMenu, "p", "menu-caption", "Sign in to personalize your community.");
      appendMenuAction("Sign in / create account", "sign-in");
    }
  } else if (kind === "campus") {
    addText(floatingMenu, "p", "menu-title", "Campus Connect");
    addText(floatingMenu, "p", "menu-caption", `${campusPeople.length} campus people · ${rooms.length} project rooms`);
    appendMenuAction("Copy page link", "copy-link");
  } else {
    addText(floatingMenu, "p", "menu-title", "Your project rooms");
    addText(floatingMenu, "p", "menu-caption", "Room boards and group conversations sync with members.");
    appendMenuAction("Explore project rooms", "view-rooms");
  }

  floatingMenu.classList.remove("hidden");
  positionMenu();
}

function openAuthDialog(editing = false) {
  closeMenu();
  authDialog.showModal();
  $("#auth-title").textContent = editing ? "Edit your profile" : "Welcome to FriendZone";
  $("#auth-intro").textContent = editing
    ? "Update the demo profile saved on this device."
    : "Sign in to make your campus connections feel like yours.";
  $("#demo-form-label").textContent = editing ? "Your demo profile" : "Preview with a demo profile";
  $("#demo-submit-label").textContent = editing ? "Save profile" : "Continue as demo";
  $("#demo-name").value = editing && profile ? profile.name : "";
  $("#demo-email").value = editing && profile ? profile.email : "";
  $(".auth-divider").classList.toggle("hidden", editing);
  $(".auth-disclaimer").classList.toggle("hidden", editing);
  $("#demo-quick-login").classList.toggle("hidden", editing);
  $("#auth-notice").classList.toggle("hidden", editing);
  $("#oauth-setup-link").classList.add("hidden");
  $("#auth-notice").textContent = "Checking Google sign-in setup…";
  $("#google-signin").classList.toggle("hidden", editing);
  $("#google-signin-button").replaceChildren();
  $("#google-signin-button").classList.toggle("hidden", editing);
  if (!editing) setupGoogleSignIn();
}

async function handleGoogleCredential(response) {
  try {
    const result = await fetch("/api/auth/google", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential })
    });
    const payload = await result.json();
    if (!result.ok) throw new Error(payload.error || "Google sign-in could not be verified.");
    setGoogleProfile({
      ...payload.user,
      chatId: payload.chatId,
      photoVisibleToCampus: payload.photoVisibleToCampus,
      profileCompleted: payload.profileCompleted === true,
      ...payload.campusProfile,
      provider: "google"
    });
  } catch (error) {
    console.error("Google sign-in could not be completed:", error);
    $("#auth-notice").textContent = error.message.includes("Failed to fetch")
      ? "The sign-in API is not running. Start FriendZone with npm start, then open its localhost address."
      : error.message;
  }
}

function loadGoogleIdentity() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!googleScriptPromise) {
    googleScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://accounts.google.com/gsi/client";
      script.async = true;
      script.defer = true;
      script.onload = () => window.google?.accounts?.id
        ? resolve()
        : reject(new Error("Google Identity Services did not load."));
      script.onerror = () => reject(new Error("Google Identity Services could not be reached."));
      document.head.append(script);
    });
  }
  return googleScriptPromise;
}

async function setupGoogleSignIn() {
  const notice = $("#auth-notice");
  try {
    const configResponse = await fetch("/api/config", { credentials: "same-origin" });
    if (!configResponse.ok) throw new Error("The FriendZone API could not load its configuration.");
    const config = await configResponse.json();
    if (!config.googleSignInEnabled || typeof config.googleClientId !== "string") {
      notice.textContent = "Google sign-in is optional. Your app is ready to explore with a free local demo profile.";
      $("#google-signin").classList.add("hidden");
      $("#oauth-setup-link").classList.remove("hidden");
      return;
    }
    googleClientId = config.googleClientId;
    notice.textContent = "Connecting securely to Google…";
    await loadGoogleIdentity();
    window.google.accounts.id.initialize({
      client_id: googleClientId,
      callback: handleGoogleCredential,
      auto_select: false,
      cancel_on_tap_outside: true
    });
    $("#google-signin-button").classList.remove("hidden");
    $("#oauth-setup-link").classList.add("hidden");
    window.google.accounts.id.renderButton($("#google-signin-button"), {
      type: "standard",
      theme: "outline",
      size: "large",
      text: "continue_with",
      shape: "rectangular",
      width: Math.min(350, Math.max(240, $("#auth-dialog").clientWidth - 48))
    });
    $("#google-signin").classList.add("hidden");
    notice.textContent = "Google will handle your password. FriendZone only receives your basic profile.";
  } catch (error) {
    console.error("Could not initialize Google sign-in:", error);
    $("#google-signin").classList.add("hidden");
    $("#oauth-setup-link").classList.remove("hidden");
    notice.textContent = error.message.includes("Failed to fetch")
      ? "The FriendZone API is not running. Start it with npm start and open http://localhost:8000."
      : "Google sign-in could not load. Check your connection and OAuth setup, or use the demo profile.";
  }
}

document.querySelectorAll("[data-scroll]").forEach((button) => {
  button.addEventListener("click", () => {
    const target = document.getElementById(button.dataset.scroll);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.scroll === button.dataset.scroll));
  });
});

$("#campus-button").addEventListener("click", (event) => openMenu(event.currentTarget, "campus"));
$("#notifications-button").addEventListener("click", (event) => openMenu(event.currentTarget, "notifications"));
$("#create-room-button").addEventListener("click", () => $("#room-dialog").showModal());
$("#room-dialog-close").addEventListener("click", () => $("#room-dialog").close());
$("#cancel-room-dialog").addEventListener("click", () => $("#room-dialog").close());
$("#room-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const fields = new FormData(form);
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await roomRequest("/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        name: String(fields.get("name")).trim(),
        description: String(fields.get("description")).trim(),
        password: String(fields.get("password"))
      })
    });

    $("#join-room-close").addEventListener("click", () => $("#join-room-dialog").close());
    $("#cancel-join-room").addEventListener("click", () => $("#join-room-dialog").close());
    $("#join-room-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!pendingJoinRoomId) return;
      const roomId = pendingJoinRoomId;
      const password = $("#join-room-password").value;
      const submit = event.currentTarget.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        await joinRoom(roomId, password);
        if (!$("#join-room-dialog").open) {
          pendingJoinRoomId = null;
        }
      } finally {
        submit.disabled = false;
      }
    });

    $("#invite-room-friends-button").addEventListener("click", openRoomInviteDialog);
    $("#invite-friends-close").addEventListener("click", () => $("#invite-friends-dialog").close());
    $("#cancel-invite-friends").addEventListener("click", () => $("#invite-friends-dialog").close());
    $("#invite-friends-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (!activeRoomId) return;
      const submit = $("#invite-friend-submit");
      submit.disabled = true;
      try {
        await roomRequest(`/api/rooms/${encodeURIComponent(activeRoomId)}/invites`, {
          method: "POST",
          body: JSON.stringify({ userId: $("#invite-friend-select").value })
        });
        $("#invite-friends-dialog").close();
        await refreshRooms();
        showToast("Your friend has joined the room.");
      } catch (error) {
        console.error("Could not invite a friend to the room:", error);
        showToast(error.message);
      } finally {
        submit.disabled = false;
      }
    });
    rooms = [result.room, ...rooms.filter((room) => room.id !== result.room.id)];
    activeRoomId = result.room.id;
    roomMessages = [];
    roomNotes = [];
    renderRooms();
    renderActiveRoom();
    $("#room-dialog").close();
    form.reset();
    await refreshRooms();
  } catch (error) {
    console.error("Could not create FriendZone study room:", error);
    showToast(error.message);
  } finally {
    submit.disabled = false;
  }
});
$("#set-room-password-button").addEventListener("click", () => $("#set-room-password-dialog").showModal());
$("#set-room-password-close").addEventListener("click", () => $("#set-room-password-dialog").close());
$("#cancel-set-room-password").addEventListener("click", () => $("#set-room-password-dialog").close());
$("#set-room-password-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeRoomId) return;
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    await roomRequest(`/api/rooms/${encodeURIComponent(activeRoomId)}/password`, {
      method: "POST",
      body: JSON.stringify({ password: $("#set-room-password-input").value })
    });
    $("#set-room-password-dialog").close();
    form.reset();
    await refreshRooms();
    showToast("Room password saved.");
  } catch (error) {
    console.error("Could not save room password:", error);
    showToast(error.message);
  } finally {
    submit.disabled = false;
  }
});

$("#leave-room-button").addEventListener("click", async () => {
  if (!activeRoomId || activeRoomId === "campus-commons") return;
  try {
    await roomRequest(`/api/rooms/${encodeURIComponent(activeRoomId)}/leave`, {
      method: "POST",
      body: "{}"
    });
    rooms = rooms.map((room) => room.id === activeRoomId ? { ...room, joined: false } : room);
    activeRoomId = "campus-commons";
    roomMessages = [];
    roomNotes = [];
    renderRooms();
    renderActiveRoom();
    await refreshRooms();
  } catch (error) {
    console.error("Could not leave FriendZone study room:", error);
    showToast(error.message);
  }
});

$("#board-tab").addEventListener("click", () => {
  activeRoomView = "board";
  renderActiveRoom();
});
$("#room-chat-tab").addEventListener("click", () => {
  activeRoomView = "chat";
  renderActiveRoom();
});
$("#board-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeRoomId) return;
  const form = event.currentTarget;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await roomRequest(`/api/rooms/${encodeURIComponent(activeRoomId)}/board`, {
      method: "POST",
      body: JSON.stringify({
        text: $("#board-note-input").value,
        color: $("#board-note-color").value
      })
    });
    roomNotes.push(result.note);
    renderBoard();
    form.reset();
    $("#board-note-input").focus();
    $("#room-status").textContent = "Idea shared with the room.";
  } catch (error) {
    console.error("Could not add an idea to the shared board:", error);
    $("#room-status").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$("#room-chat-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!activeRoomId) return;
  const form = event.currentTarget;
  const input = $("#room-chat-input");
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await roomRequest(`/api/rooms/${encodeURIComponent(activeRoomId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ text: input.value })
    });
    roomMessages.push(result.message);
    roomMessages.sort((first, second) => first.id - second.id);
    form.reset();
    renderRoomMessages();
    input.focus();
    $("#room-status").textContent = "Message sent to the room.";
  } catch (error) {
    console.error("Could not send a FriendZone room message:", error);
    $("#room-status").textContent = error.message;
  } finally {
    submit.disabled = false;
  }
});

$("#profile-setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = $("#profile-setup-submit");
  submit.disabled = true;
  const splitList = (value) => [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  try {
    const result = await roomRequest("/api/profile", {
      method: "POST",
      body: JSON.stringify({
        department: $("#profile-department").value.trim(),
        subjects: splitList($("#profile-subjects").value),
        skills: splitList($("#profile-skills").value)
      })
    });
    profile = { ...profile, ...result.campusProfile, profileCompleted: true, provider: "google" };
    profileSetupDialog.close();
    document.body.classList.remove("profile-setup-required");
    renderProfile();
    updateAccessTier();
    showToast("Your campus profile is ready.");
  } catch (error) {
    console.error("Could not save campus profile:", error);
    showToast(error.message);
  } finally {
    submit.disabled = false;
  }
});
$("#cancel-profile-setup").addEventListener("click", () => {
  if (profile?.profileCompleted) profileSetupDialog.close();
});
profileSetupDialog.addEventListener("cancel", (event) => {
  if (!profile?.profileCompleted) event.preventDefault();
});

studentList.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-friend-action]");
  if (!button || button.disabled) return;
  button.disabled = true;
  try {
    if (button.dataset.friendAction === "send") {
      await roomRequest("/api/friend-requests", {
        method: "POST",
        body: JSON.stringify({ recipientId: button.dataset.userId })
      });
      showToast("Friend request sent.");
    } else {
      await roomRequest(`/api/friend-requests/${encodeURIComponent(button.dataset.requestId)}/respond`, {
        method: "POST",
        body: JSON.stringify({ action: button.dataset.friendAction })
      });
      showToast(button.dataset.friendAction === "accept" ? "Friend request accepted." : "Friend request declined.");
    }
    await refreshCampusPeople();
  } catch (error) {
    console.error("Could not update friend request:", error);
    showToast(error.message);
    button.disabled = false;
  }
});

$("#profile-settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const result = await roomRequest("/api/profile/privacy", {
      method: "POST",
      body: JSON.stringify({ photoVisibleToCampus: $("#photo-visibility-toggle").checked })
    });
    photoVisibleToCampus = result.photoVisibleToCampus;
    $("#profile-settings-dialog").close();
    showToast(photoVisibleToCampus ? "Your profile photo is visible to campus members." : "Your profile photo is private.");
  } catch (error) {
    console.error("Could not save profile photo privacy settings:", error);
    showToast(error.message);
  } finally {
    submit.disabled = false;
  }
});
$("#profile-settings-close").addEventListener("click", () => $("#profile-settings-dialog").close());
$("#cancel-profile-settings").addEventListener("click", () => $("#profile-settings-dialog").close());
document.querySelectorAll('[data-action="profile"]').forEach((button) => {
  button.addEventListener("click", (event) => openMenu(event.currentTarget, "profile"));
});
$("#floating-menu").addEventListener("click", async (event) => {
  const action = event.target.closest("[data-menu-action]")?.dataset.menuAction;
  if (!action) return;
  closeMenu();
  if (action === "sign-in") {
    openAuthDialog();
  } else if (action === "sign-out") {
    try {
      if (profile?.provider === "google") {
        const response = await fetch("/api/auth/logout", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: "{}"
        });
        if (!response.ok) throw new Error(`Sign-out failed with status ${response.status}.`);
      } else {
        if (typeof window !== "undefined") {
          window.localStorage.removeItem(PROFILE_KEY);
        }
      }
      profile = null;
      photoVisibleToCampus = false;
      document.body.classList.remove("profile-setup-required");
      render();
      renderProfile();
      updateAccessTier();
      openLoginGate();
    } catch (error) {
      console.error("Could not sign out of FriendZone:", error);
      showToast(error.message.includes("Failed to fetch")
        ? "The FriendZone API is not running; sign-out could not be completed."
        : "Could not sign out of FriendZone.");
    }
  } else if (action === "account") {
    showToast("Your name and email come from your Google account.");
  } else if (action === "photo-privacy") {
    openProfileSettings();
  } else if (action === "edit-campus-profile") {
    openProfileSetup(true);
  } else if (action === "edit-profile") {
    openAuthDialog(true);
  } else if (action === "copy-link") {
    try {
      await navigator.clipboard.writeText(window.location.href);
      showToast("Campus page link copied.");
    } catch (error) {
      console.error("Could not copy the campus link:", error);
      showToast("Copy the page address from your browser to share it.");
    }
  } else if (action === "view-rooms") {
    $("#rooms-section").scrollIntoView({ behavior: "smooth", block: "start" });
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.scroll === "rooms-section"));
  }
});
$("#google-signin").addEventListener("click", () => setupGoogleSignIn());
$(".auth-close").addEventListener("click", () => authDialog.close());
authDialog.addEventListener("click", (event) => {
  if (event.target === authDialog && !loginRequired) authDialog.close();
});
authDialog.addEventListener("cancel", (event) => {
  if (loginRequired) event.preventDefault();
});
$("#demo-signin-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const fields = new FormData(event.currentTarget);
  const name = String(fields.get("name")).trim().replace(/\s+/g, " ");
  const email = String(fields.get("email")).trim();
  if (name && email) setDemoProfile({ name, email, provider: "demo" });
});
$("#demo-quick-login").addEventListener("click", () => {
  $("#demo-name").value = "FriendZone Guest";
  $("#demo-email").value = "guest@friendzone.local";
  setDemoProfile({
    name: "FriendZone Guest",
    email: "guest@friendzone.local",
    provider: "demo"
  });
});
document.addEventListener("click", (event) => {
  if (!floatingMenu.classList.contains("hidden") &&
      !floatingMenu.contains(event.target) &&
      !event.target.closest("#campus-button, #notifications-button, [data-action='profile']")) {
    closeMenu();
  }
});
window.addEventListener("resize", positionMenu);
window.addEventListener("scroll", positionMenu, true);

$("#search-input").addEventListener("input", renderStudents);
$("#department-filter").addEventListener("change", renderStudents);
document.querySelector('[data-scroll="students-section"].text-button').addEventListener("click", () => {
  $("#search-input").value = "";
  $("#department-filter").value = "";
  renderStudents();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !floatingMenu.classList.contains("hidden")) {
    closeMenu();
    return;
  }
  if (event.key === "/" && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    $("#search-input").focus();
  }
});

$("#today-label").textContent = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(new Date());
renderProfile();
render();
loadServerProfile().then(() => {
  if (profile?.provider === "google") {
    document.body.classList.remove("auth-pending");
  } else {
    openLoginGate();
  }
});
}
