(function() {
(async () => {
  const CHAT_BASE = "https://dolegpt2.anonymousguy.workers.dev";
  const ACCOUNT_BASE = "https://account-worker.anonymousguy.workers.dev";
  const IMAGE_UPLOAD_WORKER = "https://dole-imagesupport.anonymousguy.workers.dev";

  // Persistent current room (localStorage). Fallback to "friends".
  let currentRoom = (function() {
    try { return localStorage.getItem("dole_chat_room") || "friends"; } catch (e) { return "friends"; }
  })();

  const ROOMS_LIST_KEY = "dole_chat_rooms";

  // In-memory caches
  let sessionImgBBKey = null;
  let sessionRoomPasswords = {}; // session-only room passwords: { room: password }
  let userRoomPasswords = {};    // saved on account (fetched on login): { room: password|null }
  let claimedChatsMap = {};      // { chat_name: { claimed_by, created_at, claimed_at } }
  let roomProofs = {};          // { room: { proof, expires } }

  let createdEls = [];

  // --- DRAG FUNCTION (mobile-friendly with threshold) ---
  function makeDraggable(el, options = {}) {
    const header = el.querySelector(":scope > div") || el;
    header.style.cursor = "grab";
    header.style.userSelect = "none";

    let dragging = false,
      moved = false,
      offsetX = 0,
      offsetY = 0,
      startX = 0,
      startY = 0;

    const origBg = header.style.background;
    const origTouchAction = el.style.touchAction || "";

    const threshold = options.threshold || 6;

    function shouldIgnoreStart(target) {
      return !!target.closest("button, input, textarea, [contenteditable], #chatMessages");
    }

    function start(e) {
      const isTouch = e.type && e.type.startsWith && e.type.startsWith("touch");
      const clientX = isTouch ? (e.touches && e.touches[0] && e.touches[0].clientX) : e.clientX;
      const clientY = isTouch ? (e.touches && e.touches[0] && e.touches[0].clientY) : e.clientY;

      if (shouldIgnoreStart(e.target)) return;

      dragging = false;
      moved = false;
      startX = clientX;
      startY = clientY;

      offsetX = clientX - el.getBoundingClientRect().left;
      offsetY = clientY - el.getBoundingClientRect().top;

      document.addEventListener("mousemove", move);
      document.addEventListener("mouseup", end);
      document.addEventListener("touchmove", move, { passive: false });
      document.addEventListener("touchend", end);
      document.addEventListener("pointermove", move);
      document.addEventListener("pointerup", end);

      if (e.preventDefault) e.preventDefault();
    }

    function move(e) {
      const isTouch = e.type && e.type.startsWith && e.type.startsWith("touch");
      const clientX = isTouch ? (e.touches && e.touches[0] && e.touches[0].clientX) : e.clientX;
      const clientY = isTouch ? (e.touches && e.touches[0] && e.touches[0].clientY) : e.clientY;

      const dx = clientX - startX;
      const dy = clientY - startY;

      if (!dragging) {
        if (Math.hypot(dx, dy) < threshold) return;
        dragging = true;
        header.style.cursor = "grabbing";
        header.style.background = "rgba(0,0,0,0.18)";
        el.style.userSelect = "none";
        el.style.touchAction = "none";
      }

      const left = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, clientX - offsetX));
      const top = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, clientY - offsetY));

      el.style.left = left + "px";
      el.style.top = top + "px";

      if (isTouch && e.preventDefault) e.preventDefault();
      moved = true;
    }

    function end() {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", end);
      document.removeEventListener("touchmove", move);
      document.removeEventListener("touchend", end);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", end);

      if (!dragging && !moved) el.click();

      dragging = false;
      header.style.cursor = "grab";
      header.style.background = origBg || "";
      el.style.userSelect = "";
      el.style.touchAction = origTouchAction;
    }

    header.addEventListener("pointerdown", start);
    header.addEventListener("mousedown", start);
    header.addEventListener("touchstart", start, { passive: false });
  }

  // --- Element registration for cleanup & draggable ---
  function registerEl(el) {
    try { el.dataset.bookmarklet = "true"; } catch (e) {}
    createdEls.push(el);
    makeDraggable(el);
  }
  function removeEl(el) {
    if (!el) return;
    el.remove();
    createdEls = createdEls.filter(e => e !== el);
  }

  // --- helpers: rooms list in localStorage ---
  function loadRoomsList() {
    try {
      const raw = localStorage.getItem(ROOMS_LIST_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.filter(r => typeof r === "string" && r.trim().length > 0).map(r => r.trim());
      return [];
    } catch (e) { return []; }
  }
  function saveRoomsList(arr) {
    try {
      const dedup = Array.from(new Set((arr || []).map(r => String(r).trim()))).filter(r => r.length > 0);
      localStorage.setItem(ROOMS_LIST_KEY, JSON.stringify(dedup));
      return true;
    } catch (e) { return false; }
  }
  function addRoomToList(room) {
    if (!room || !room.trim()) return false;
    const list = loadRoomsList();
    if (!list.includes(room)) {
      list.unshift(room);
      if (list.length > 50) list.length = 50;
      saveRoomsList(list);
    }
    return true;
  }
  function removeRoomFromList(room) {
    const list = loadRoomsList().filter(r => r !== room);
    saveRoomsList(list);
    return true;
  }

  // --- timestamp & message helpers ---
  function parseMessageTimestamp(m) {
    const candidates = [m.ts, m.timestamp, m.created_at, m.createdAt, m.time, m.date, m.when];
    let raw;
    for (const c of candidates) { if (c !== undefined && c !== null) { raw = c; break; } }
    if (raw === undefined) return null;
    if (typeof raw === "number") {
      if (raw > 1e12) return new Date(raw);
      if (raw > 1e9) return new Date(raw * 1000);
      return new Date(raw);
    }
    if (typeof raw === "string") {
      const n = Number(raw);
      if (!Number.isNaN(n)) {
        if (n > 1e12) return new Date(n);
        if (n > 1e9) return new Date(n * 1000);
      }
      const parsed = Date.parse(raw);
      if (!Number.isNaN(parsed)) return new Date(parsed);
    }
    return null;
  }
  function timeAgoShort(date) {
    if (!date) return "";
    const now = Date.now();
    const diff = Math.floor((now - date.getTime()) / 1000);
    if (diff < 5) return "now";
    if (diff < 60) return `${diff}s ago`;
    const mins = Math.floor(diff / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    return date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }
  function refreshTimestampsIn(container) {
    if (!container) return;
    const nodes = container.querySelectorAll && container.querySelectorAll("[data-ts]");
    if (!nodes || nodes.length === 0) return;
    for (const el of nodes) {
      const ms = Number(el.dataset.ts);
      if (!Number.isFinite(ms) || ms <= 0) { el.textContent = ""; el.title = ""; continue; }
      const d = new Date(ms);
      el.textContent = timeAgoShort(d);
      el.title = d.toLocaleString();
    }
  }

  // --- image detection ---
  const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|svg)(\?.*)?$/i;
  function isImageUrl(text) {
    if (typeof text !== "string") return false;
    const t = text.trim();
    try {
      const u = new URL(t);
      if (!["http:", "https:"].includes(u.protocol)) return false;
      return IMG_EXT_RE.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  // --- fetch with timeout ---
  function fetchWithTimeout(url, opts = {}, timeout = 8000) {
    const controller = new AbortController();
    const signal = controller.signal;
    const o = Object.assign({}, opts, { signal });
    const timer = setTimeout(() => controller.abort(), timeout);
    return fetch(url, o).finally(() => clearTimeout(timer));
  }

  // ------- New: account / claimed chats helpers used by client -------
  async function fetchUserRoomPasswords(token) {
    if (!token) return {};
    try {
      const res = await fetchWithTimeout(`${ACCOUNT_BASE}/user/room-passwords`, { method: "GET", headers: { Authorization: token } }, 8000);
      if (!res.ok) return {};
      const j = await res.json().catch(() => null);
      if (!j || !j.success || !j.passwords) return {};
      return j.passwords || {};
    } catch (e) {
      console.debug("fetchUserRoomPasswords error:", e);
      return {};
    }
  }
  async function fetchClaimedChats() {
    try {
      const res = await fetchWithTimeout(`${ACCOUNT_BASE}/claimed-chats`, { method: "GET" }, 8000);
      if (!res.ok) return {};
      const j = await res.json().catch(() => null);
      if (!j || !j.success || !Array.isArray(j.claimed)) return {};
      const map = {};
      for (const it of j.claimed) {
        map[it.chat_name] = { claimed_by: it.claimed_by || null, created_at: it.created_at || null, claimed_at: it.claimed_at || null };
      }
      return map;
    } catch (e) {
      console.debug("fetchClaimedChats error:", e);
      return {};
    }
  }

  async function postSaveRoomPassword(token, room, password) {
    try {
      const res = await fetchWithTimeout(`${ACCOUNT_BASE}/user/room-passwords`, {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({ room, password })
      }, 8000);
      const j = await res.json().catch(() => null);
      return !!(j && j.success);
    } catch (e) {
      console.debug("postSaveRoomPassword error:", e);
      return false;
    }
  }

  async function postDeleteRoomPassword(token, room) {
    try {
      const res = await fetchWithTimeout(`${ACCOUNT_BASE}/user/room-passwords`, {
        method: "DELETE",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({ room })
      }, 8000);
      const j = await res.json().catch(() => null);
      return !!(j && j.success);
    } catch (e) {
      console.debug("postDeleteRoomPassword error:", e);
      return false;
    }
  }

  async function postClaimChat(token, chat_name, password) {
    try {
      const res = await fetchWithTimeout(`${ACCOUNT_BASE}/user/claim-chat`, {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({ chat_name, password })
      }, 8000);
      const j = await res.json().catch(() => null);
      return j || { success: false };
    } catch (e) {
      console.debug("postClaimChat error:", e);
      return { success: false, error: "network" };
    }
  }

  async function postUnclaimChat(token, chat_name, adminKey) {
    try {
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = token;
      if (adminKey) headers["x-admin-key"] = adminKey;
      const res = await fetchWithTimeout(`${ACCOUNT_BASE}/user/unclaim-chat`, {
        method: "POST",
        headers,
        body: JSON.stringify({ chat_name })
      }, 8000);
      const j = await res.json().catch(() => null);
      return j || { success: false };
    } catch (e) {
      console.debug("postUnclaimChat error:", e);
      return { success: false, error: "network" };
    }
  }

  async function postUpdateClaimPassword(token, chat_name, password, adminKey) {
    try {
      const headers = { "Content-Type": "application/json" };
      if (token) headers.Authorization = token;
      if (adminKey) headers["x-admin-key"] = adminKey;
      const res = await fetchWithTimeout(`${ACCOUNT_BASE}/user/update-claim-password`, {
        method: "POST",
        headers,
        body: JSON.stringify({ chat_name, password })
      }, 8000);
      const j = await res.json().catch(() => null);
      return j || { success: false };
    } catch (e) {
      console.debug("postUpdateClaimPassword error:", e);
      return { success: false, error: "network" };
    }
  }

  // NEW: Request a short-lived proof from account worker for this room
  async function fetchRoomProof(token, room) {
    try {
      const cached = roomProofs[room];
      const now = Date.now();
      if (cached && cached.proof && cached.expires && now < (cached.expires - 500)) {
        return cached.proof;
      }
      const res = await fetchWithTimeout(`${ACCOUNT_BASE}/user/room-proof`, {
        method: "POST",
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify({ room })
      }, 8000);
      const j = await res.json().catch(() => null);
      if (!j || !j.success || !j.proof || !j.expires) {
        return null;
      }
      roomProofs[room] = { proof: j.proof, expires: j.expires };
      return j.proof;
    } catch (e) {
      console.debug("fetchRoomProof error:", e);
      return null;
    }
  }

  // ---------- Message rendering ----------
  function appendMessageToContainer(container, m, i) {
    const d = document.createElement("div");
    d.style.background = i % 2 === 0 ? "#40444b" : "#36393f";
    d.style.padding = "6px 8px";
    d.style.borderRadius = "8px";
    d.style.wordBreak = "break-word";
    d.style.fontSize = "15px";
    d.style.display = "flex";
    d.style.justifyContent = "space-between";
    d.style.alignItems = "flex-start";
    d.style.gap = "8px";

    const left = document.createElement("div");
    left.style.flex = "1 1 auto";
    left.style.minWidth = "0";

    const strong = document.createElement("strong");
    strong.textContent = String(m.username || "unknown");
    left.appendChild(strong);

    const text = String(m.text || "");
    const trimmed = text.trim();

    if (trimmed && isImageUrl(trimmed) && trimmed === text) {
      const wrapper = document.createElement("div");
      wrapper.style.display = "inline-flex";
      wrapper.style.alignItems = "center";
      wrapper.style.gap = "8px";

      const imgButton = document.createElement("button");
      imgButton.type = "button";
      imgButton.style.display = "inline-flex";
      imgButton.style.alignItems = "center";
      imgButton.style.justifyContent = "center";
      imgButton.style.padding = "6px 8px";
      imgButton.style.borderRadius = "8px";
      imgButton.style.border = "none";
      imgButton.style.background = "#5865f2";
      imgButton.style.color = "#fff";
      imgButton.style.cursor = "pointer";
      imgButton.style.fontSize = "16px";
      imgButton.title = "Show image";
      imgButton.textContent = "🖼️";
      imgButton.dataset.url = trimmed;

      let expanded = false;
      let imgEl = null;

      function expand() {
        if (expanded) return;
        expanded = true;
        imgEl = document.createElement("img");
        imgEl.src = trimmed;
        imgEl.alt = "Image";
        imgEl.loading = "lazy";
        imgEl.style.maxWidth = "100%";
        imgEl.style.maxHeight = "360px";
        imgEl.style.borderRadius = "8px";
        imgEl.style.display = "block";
        imgEl.style.cursor = "pointer";
        imgEl.style.boxShadow = "0 6px 18px rgba(0,0,0,0.4)";
        imgEl.referrerPolicy = "no-referrer";
        imgEl.addEventListener("error", () => {
          if (imgEl && imgEl.parentNode) imgEl.replaceWith(imgButton);
          expanded = false;
          imgEl = null;
        });
        imgEl.addEventListener("click", collapse);
        imgButton.replaceWith(imgEl);
      }
      function collapse() {
        if (!expanded) return;
        expanded = false;
        if (imgEl && imgEl.parentNode) imgEl.replaceWith(imgButton);
        imgEl = null;
      }
      imgButton.addEventListener("click", expand);
      wrapper.appendChild(document.createTextNode(": "));
      wrapper.appendChild(imgButton);
      left.appendChild(wrapper);
    } else {
      left.appendChild(document.createTextNode(": " + text));
    }

    const tsDate = parseMessageTimestamp(m);
    const timeEl = document.createElement("div");
    timeEl.style.marginLeft = "8px";
    timeEl.style.opacity = "0.75";
    timeEl.style.fontSize = "12px";
    timeEl.style.whiteSpace = "nowrap";
    timeEl.style.flex = "0 0 auto";
    if (tsDate) {
      timeEl.dataset.ts = String(tsDate.getTime());
      timeEl.textContent = timeAgoShort(tsDate);
      timeEl.title = tsDate.toLocaleString();
    } else {
      timeEl.textContent = "";
      timeEl.title = "";
    }

    d.appendChild(left);
    d.appendChild(timeEl);
    container.appendChild(d);
  }

  // --- LOGIN UI (unchanged) ---
  const loginBox = document.createElement("div");
  Object.assign(loginBox.style, {
    position: "fixed",
    top: "20px",
    right: "20px",
    width: "min(95vw, 320px)",
    background: "#2c2f33",
    color: "#fff",
    zIndex: 999999,
    borderRadius: "12px",
    display: "flex",
    flexDirection: "column",
    overflow: "hidden",
    fontFamily: "Arial, sans-serif",
    boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
    maxHeight: "90vh",
  });

  loginBox.innerHTML = `
    <div style="padding:12px; background:#23272a; font-weight:bold; text-align:center; position:relative; font-size:16px;">
      Login / Create Account
      <button id="closeLogin" style="position:absolute; right:10px; top:8px; background:red; color:white; border:none; padding:8px 12px; border-radius:8px; cursor:pointer; font-size:15px;">X</button>
    </div>
    <div style="padding:10px; display:flex; flex-direction:column; gap:8px; background:#2c2f33;">
      <input id="loginUser" placeholder="Username" style="padding:12px; border-radius:10px; border:none; outline:none; font-size:16px;">
      <input id="loginPass" type="password" placeholder="Password" style="padding:12px; border-radius:10px; border:none; outline:none; font-size:16px;">
      <div style="display:flex; gap:8px;">
        <button id="loginBtn" style="flex:1; padding:10px; border-radius:10px; border:none; background:#7289da; color:white; cursor:pointer; font-size:16px;">Login</button>
        <button id="createBtn" style="flex:1; padding:10px; border-radius:10px; border:none; background:#43b581; color:white; cursor:pointer; font-size:16px;">Create</button>
      </div>
      <div id="loginMsg" style="color:#ff5555; font-size:14px; min-height:18px;"></div>
    </div>
  `;

  document.body.appendChild(loginBox);
  registerEl(loginBox);
  document.getElementById("closeLogin").onclick = () => removeEl(loginBox);

  const showMsg = (msg) => {
    const el = document.getElementById("loginMsg");
    if (el) el.textContent = msg;
  };

  // --- AUTH (unchanged) ---
  async function login() {
    const username = document.getElementById("loginUser").value.trim(),
      password = document.getElementById("loginPass").value.trim();
    if (!username || !password) return showMsg("Fill both fields");
    try {
      const res = await fetch(`${ACCOUNT_BASE}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!data.success) return showMsg("Login failed: " + data.error);
      showMsg("Login successful!");
      removeEl(loginBox);

      initChat(data.token, username);
    } catch (e) {
      showMsg("Error: " + e);
    }
  }
  async function createAccount() {
    const username = document.getElementById("loginUser").value.trim(),
      password = document.getElementById("loginPass").value.trim();
    if (!username || !password) return showMsg("Fill both fields");
    try {
      const res = await fetch(`${ACCOUNT_BASE}/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!data.success) return showMsg("Request failed: " + data.error);
      showMsg("Request submitted! Wait for approval.");
    } catch (e) {
      showMsg("Error: " + e);
    }
  }
  document.getElementById("loginBtn").onclick = login;
  document.getElementById("createBtn").onclick = createAccount;

  // --- Main: initChat with claiming/password/proof UX additions ---
  async function initChat(token, username) {
    // Preload account-saved passwords and claimed-chats
    userRoomPasswords = await fetchUserRoomPasswords(token);
    claimedChatsMap = await fetchClaimedChats();

    // Build main box
    const box = document.createElement("div");
    Object.assign(box.style, {
      position: "fixed",
      top: "20px",
      right: "20px",
      width: "min(95vw, 360px)",
      height: "min(80vh, 600px)",
      background: "#2c2f33",
      color: "#ffffff",
      zIndex: 999999,
      borderRadius: "12px",
      display: "flex",
      flexDirection: "column",
      overflow: "hidden",
      fontFamily: "Arial, sans-serif",
      boxShadow: "0 8px 20px rgba(0,0,0,0.4)",
    });

    box.innerHTML = `
      <div style="padding:12px; background:#23272a; font-weight:bold; text-align:center; position:relative; font-size:16px;">
        <button id="minifyChat" title="Minify" style="position:absolute; left:10px; top:8px; background:#999; color:white; border:none; padding:8px 12px; border-radius:8px; cursor:pointer; font-size:15px;">_</button>
        Friends Chat (<span id="book_username"></span>)
        <button id="closeChat" style="position:absolute; right:10px; top:8px; background:red; color:white; border:none; padding:8px 12px; border-radius:8px; cursor:pointer; font-size:15px;">X</button>

        <!-- Room button opens overlay -->
        <div style="margin-top:8px; display:flex; gap:8px; justify-content:center; align-items:center;">
          <button id="openRoomsBtn" style="padding:6px 10px; border-radius:8px; border:none; background:#43b581; color:white; cursor:pointer; font-size:13px;">Room</button>
          <div id="currentRoomDisplay" style="font-size:13px; opacity:0.9; color:#ddd;">room: ${currentRoom}</div>
        </div>
      </div>
      <div id="chatMessages" style="flex:1; padding:10px; overflow-y:auto; background:#2c2f33; display:flex; flex-direction: column; gap:8px; -webkit-overflow-scrolling:touch; overscroll-behavior:contain; touch-action:auto; position:relative;"></div>
      <div id="imageInputRow" style="display:none; padding:8px 10px; background:#242528; gap:8px; align-items:center;">
        <input id="imageUrlInput" placeholder="Paste image URL (png/jpg/gif/webp...)" style="flex:1; padding:8px; border-radius:8px; border:none; outline:none; font-size:14px;">
        <button id="imageUrlSend" style="padding:8px 10px; border-radius:8px; border:none; background:#43b581; color:white; cursor:pointer; font-size:14px;">Send</button>
        <button id="imageUploadBtn" style="padding:8px 10px; border-radius:8px; border:none; background:#5865f2; color:white; cursor:pointer; font-size:14px;">Upload</button>
        <button id="imageUrlCancel" style="padding:8px 10px; border-radius:8px; border:none; background:#999; color:white; cursor:pointer; font-size:14px;">Cancel</button>
      </div>
      <div style="padding:10px; background:#23272a; display:flex; gap:8px; align-items:center;">
        <button id="imageBtn" title="Add image" style="padding:8px 10px; border-radius:8px; border:none; background:#5865f2; color:white; cursor:pointer; font-size:16px;">🖼️</button>
        <input id="chatInput" style="flex:1; padding:12px; border-radius:10px; border:none; outline:none; font-size:16px;" placeholder="Type a message...">
        <button id="chatSend" style="padding:10px 14px; border-radius:10px; border:none; background:#7289da; color:white; cursor:pointer; font-size:16px;">Send</button>
      </div>
    `;

    document.body.appendChild(box);
    registerEl(box);

    // Hidden file input for uploads
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/*";
    fileInput.style.display = "none";
    box.appendChild(fileInput);

    const usernameSpan = box.querySelector('#book_username');
    if (usernameSpan) usernameSpan.textContent = username;

    // UI elements
    const msgBox = box.querySelector("#chatMessages");
    const chatInputEl = box.querySelector("#chatInput");
    const minifyBtn = box.querySelector("#minifyChat");
    const closeBtn = box.querySelector("#closeChat");
    const imageBtn = box.querySelector("#imageBtn");
    const imageInputRow = box.querySelector("#imageInputRow");
    const imageUrlInput = box.querySelector("#imageUrlInput");
    const imageUrlSend = box.querySelector("#imageUrlSend");
    const imageUploadBtn = box.querySelector("#imageUploadBtn");
    const imageUrlCancel = box.querySelector("#imageUrlCancel");
    const openRoomsBtn = box.querySelector("#openRoomsBtn");
    const currentRoomDisplay = box.querySelector("#currentRoomDisplay");

    // New: rooms overlay + password modal elements
    const overlay = document.createElement("div");
    overlay.id = "roomOverlay";
    Object.assign(overlay.style, {
      position: "absolute",
      left: "0",
      top: "0",
      right: "0",
      bottom: "0",
      background: "rgba(0,0,0,0.55)",
      zIndex: 20,
      display: "none",
      alignItems: "center",
      justifyContent: "center",
      padding: "12px",
    });

    const modal = document.createElement("div");
    Object.assign(modal.style, {
      width: "100%",
      maxWidth: "360px",
      maxHeight: "80%",
      background: "#1e2124",
      borderRadius: "12px",
      padding: "12px",
      boxShadow: "0 8px 30px rgba(0,0,0,0.6)",
      overflow: "auto",
      color: "#fff",
      display: "flex",
      flexDirection: "column",
      gap: "8px",
    });

    modal.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between;">
        <strong style="font-size:16px;">Your Rooms</strong>
        <button id="closeRoomsOverlay" style="background:#999; border:none; padding:6px 8px; border-radius:8px; cursor:pointer;">Close</button>
      </div>
      <div id="roomsList" style="display:flex; flex-direction:column; gap:6px;"></div>
      <div style="display:flex; gap:8px; margin-top:8px;">
        <input id="newRoomNameInput" placeholder="New room name" style="flex:1; padding:8px; border-radius:8px; border:none; outline:none; font-size:14px;">
        <button id="addRoomBtn" style="padding:8px 10px; border-radius:8px; border:none; background:#43b581; color:white; cursor:pointer;">Add</button>
        <button id="addAndSwitchBtn" style="padding:8px 10px; border-radius:8px; border:none; background:#5865f2; color:white; cursor:pointer;">Add+Switch</button>
      </div>
      <div style="font-size:12px; opacity:0.8; margin-top:6px;">Tip: you can claim a chat (max 3). Claimed chats appear in your library and you control their password.</div>
    `;
    overlay.appendChild(modal);
    box.appendChild(overlay);

    const roomsListEl = modal.querySelector("#roomsList");
    const closeRoomsOverlayBtn = modal.querySelector("#closeRoomsOverlay");
    const newRoomNameInput = modal.querySelector("#newRoomNameInput");
    const addRoomBtn = modal.querySelector("#addRoomBtn");
    const addAndSwitchBtn = modal.querySelector("#addAndSwitchBtn");

    // Password modal (reusable)
    const passwordModal = document.createElement("div");
    Object.assign(passwordModal.style, {
      background: "#23272a",
      padding: "12px",
      borderRadius: "10px",
      display: "none",
      flexDirection: "column",
      gap: "8px",
      color: "#fff",
    });
    passwordModal.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <strong id="pwdModalTitle">Enter password</strong>
        <button id="pwdModalClose" style="background:#999; border:none; padding:6px 8px; border-radius:8px; cursor:pointer;">X</button>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px;">
        <input id="pwdInput" type="password" placeholder="Password" style="padding:8px; border-radius:8px; border:none; outline:none; font-size:14px;">
        <label style="font-size:13px; display:flex; gap:8px; align-items:center;"><input id="pwdRemember" type="checkbox"> Save to account</label>
        <div style="display:flex; gap:8px;">
          <button id="pwdSubmit" style="flex:1; padding:8px; border-radius:8px; border:none; background:#43b581; color:white; cursor:pointer;">Submit</button>
          <button id="pwdCancel" style="flex:1; padding:8px; border-radius:8px; border:none; background:#999; color:white; cursor:pointer;">Cancel</button>
        </div>
      </div>
    `;
    modal.appendChild(passwordModal);

    function showPasswordModal(title) {
      passwordModal.style.display = "flex";
      modal.querySelector("#pwdModalTitle").textContent = title || "Enter password";
      modal.querySelector("#pwdInput").value = "";
      modal.querySelector("#pwdRemember").checked = true;
      modal.querySelector("#pwdInput").focus();
    }
    function hidePasswordModal() {
      passwordModal.style.display = "none";
    }

    function promptPasswordForRoom(room, purpose = "access") {
      return new Promise((resolve) => {
        showPasswordModal(purpose === "claim" ? `Set password to claim "${room}"` : (purpose === "update-claim" ? `New password for "${room}"` : `Password for "${room}"`));
        const submit = () => {
          const pwd = modal.querySelector("#pwdInput").value;
          const remember = !!modal.querySelector("#pwdRemember").checked;
          hidePasswordModal();
          resolve({ password: pwd, remember });
        };
        const cancel = () => {
          hidePasswordModal();
          resolve(null);
        };
        const closeBtn = modal.querySelector("#pwdModalClose");
        const submitBtn = modal.querySelector("#pwdSubmit");
        const cancelBtn = modal.querySelector("#pwdCancel");

        function cleanup() {
          submitBtn.removeEventListener("click", submit);
          cancelBtn.removeEventListener("click", cancel);
          closeBtn.removeEventListener("click", cancel);
        }
        submitBtn.addEventListener("click", () => { cleanup(); submit(); });
        cancelBtn.addEventListener("click", () => { cleanup(); cancel(); });
        closeBtn.addEventListener("click", () => { cleanup(); cancel(); });
      });
    }

    // Rooms list rendering uses caches: userRoomPasswords & claimedChatsMap
    function renderRoomsList() {
      roomsListEl.innerHTML = "";
      const rooms = loadRoomsList();
      if (!rooms || rooms.length === 0) {
        const p = document.createElement("div");
        p.style.opacity = "0.85";
        p.style.fontSize = "13px";
        p.textContent = "No rooms yet. Add one below.";
        roomsListEl.appendChild(p);
        return;
      }
      for (const r of rooms) {
        const row = document.createElement("div");
        Object.assign(row.style, { display: "flex", gap: "8px", alignItems: "center", justifyContent: "space-between" });

        const left = document.createElement("div");
        left.style.display = "flex";
        left.style.gap = "8px";
        left.style.alignItems = "center";

        // Lock icon if we have a password for this room (either session or account)
        const hasPwd = (sessionRoomPasswords[r] && sessionRoomPasswords[r].length) || (userRoomPasswords[r] && userRoomPasswords[r].length);
        const lock = document.createElement("div");
        lock.textContent = hasPwd ? "🔒" : "🔓";
        lock.title = hasPwd ? "Has saved password" : "No saved password";
        left.appendChild(lock);

        // name / switch button
        const btn = document.createElement("button");
        btn.textContent = r;
        btn.title = `Switch to ${r}`;
        Object.assign(btn.style, { padding: "8px 10px", borderRadius: "8px", border: "none", background: r === currentRoom ? "#2c8f6e" : "#2b2f33", color: "#fff", cursor: "pointer", fontSize: "14px" });
        btn.onclick = async () => {
          await switchRoom(r);
          hideRoomsOverlay();
        };
        left.appendChild(btn);

        row.appendChild(left);

        // actions: claim/manage/remove
        const actions = document.createElement("div");
        actions.style.display = "flex";
        actions.style.gap = "6px";
        actions.style.alignItems = "center";

        const claimedInfo = claimedChatsMap[r];
        if (!claimedInfo || !claimedInfo.claimed_by) {
          // not claimed: show "Claim" button
          const claimBtn = document.createElement("button");
          claimBtn.textContent = "Claim";
          Object.assign(claimBtn.style, { padding: "6px 8px", borderRadius: "8px", border: "none", background: "#2b7a45", color: "#fff", cursor: "pointer", fontSize: "12px" });
          claimBtn.onclick = async () => {
            const ans = await promptPasswordForRoom(r, "claim");
            if (!ans || !ans.password) return alert("Claim canceled (no password)");
            // attempt claim
            const res = await postClaimChat(token, r, ans.password);
            if (!res || !res.success) {
              alert("Claim failed: " + (res && res.error ? res.error : "unknown"));
              return;
            }
            // refresh caches and attempt to mint a proof
            userRoomPasswords = await fetchUserRoomPasswords(token);
            claimedChatsMap = await fetchClaimedChats();
            renderRoomsList();
            // try to get a proof so user can immediately use the room
            const proof = await fetchRoomProof(token, r);
            if (proof) alert(`Chat "${r}" claimed successfully and proof minted.`); else alert(`Chat "${r}" claimed. Proof minting failed; try switching into the room to trigger proof generation.`);
          };
          actions.appendChild(claimBtn);
        } else {
          // claimed by someone
          const owner = claimedInfo.claimed_by;
          if (owner === username) {
            // manage: change password, unclaim
            const manageBtn = document.createElement("button");
            manageBtn.textContent = "Manage";
            Object.assign(manageBtn.style, { padding: "6px 8px", borderRadius: "8px", border: "none", background: "#5865f2", color: "#fff", cursor: "pointer", fontSize: "12px" });
            manageBtn.onclick = () => {
              const menu = document.createElement("div");
              Object.assign(menu.style, { position: "absolute", background: "#111", padding: "8px", borderRadius: "8px", right: "20px", zIndex: 99999, display: "flex", gap: "6px" });
              const change = document.createElement("button");
              change.textContent = "Change pwd";
              Object.assign(change.style, { padding: "6px 8px", borderRadius: "8px", border: "none", background: "#2b7a45", color: "#fff", cursor: "pointer", fontSize: "12px" });
              const unclaim = document.createElement("button");
              unclaim.textContent = "Unclaim";
              Object.assign(unclaim.style, { padding: "6px 8px", borderRadius: "8px", border: "none", background: "#a33", color: "#fff", cursor: "pointer", fontSize: "12px" });
              menu.appendChild(change);
              menu.appendChild(unclaim);
              row.appendChild(menu);

              function cleanupMenu() { try { menu.remove(); } catch (e) {} }

              change.onclick = async () => {
                const ans = await promptPasswordForRoom(r, "update-claim");
                if (!ans || !ans.password) { cleanupMenu(); return alert("Canceled"); }
                const res = await postUpdateClaimPassword(token, r, ans.password);
                if (!res || !res.success) return alert("Update failed: " + (res && res.error ? res.error : "unknown"));
                userRoomPasswords = await fetchUserRoomPasswords(token);
                claimedChatsMap = await fetchClaimedChats();
                renderRoomsList();
                cleanupMenu();
                alert("Password updated");
                // refresh proof
                await fetchRoomProof(token, r);
              };

              unclaim.onclick = async () => {
                if (!confirm(`Unclaim "${r}"? This will remove your claim.`)) { cleanupMenu(); return; }
                const res = await postUnclaimChat(token, r);
                if (!res || !res.success) return alert("Unclaim failed: " + (res && res.error ? res.error : "unknown"));
                claimedChatsMap = await fetchClaimedChats();
                renderRoomsList();
                cleanupMenu();
                alert("Unclaimed");
                // clear proof and related caches
                delete roomProofs[r];
              };
            };
            actions.appendChild(manageBtn);
          } else {
            const ownerLabel = document.createElement("div");
            ownerLabel.textContent = `claimed by ${owner}`;
            ownerLabel.style.opacity = "0.9";
            ownerLabel.style.fontSize = "12px";
            ownerLabel.style.color = "#ddd";
            actions.appendChild(ownerLabel);
          }
        }

        // remove from library button
        const del = document.createElement("button");
        del.textContent = "Remove";
        Object.assign(del.style, { padding: "6px 8px", borderRadius: "8px", border: "none", background: "#666", color: "#fff", cursor: "pointer", fontSize: "12px" });
        del.onclick = () => {
          if (confirm(`Remove "${r}" from your library?`)) {
            removeRoomFromList(r);
            renderRoomsList();
          }
        };
        actions.appendChild(del);

        row.appendChild(actions);
        roomsListEl.appendChild(row);
      }
    }

    function showRoomsOverlay() {
      renderRoomsList();
      overlay.style.display = "flex";
      setTimeout(() => {
        try { newRoomNameInput.focus(); } catch (e) {}
      }, 50);
    }
    function hideRoomsOverlay() { overlay.style.display = "none"; }

    openRoomsBtn.addEventListener("click", () => showRoomsOverlay());
    closeRoomsOverlayBtn.addEventListener("click", () => hideRoomsOverlay());
    overlay.addEventListener("click", (ev) => { if (ev.target === overlay) hideRoomsOverlay(); });

    addRoomBtn.addEventListener("click", () => {
      const name = (newRoomNameInput.value || "").trim();
      if (!name) { newRoomNameInput.style.border = "1px solid #ff5555"; setTimeout(() => newRoomNameInput.style.border = "none", 1200); return; }
      addRoomToList(name);
      newRoomNameInput.value = "";
      renderRoomsList();
    });

    addAndSwitchBtn.addEventListener("click", async () => {
      const name = (newRoomNameInput.value || "").trim();
      if (!name) { newRoomNameInput.style.border = "1px solid #ff5555"; setTimeout(() => newRoomNameInput.style.border = "none", 1200); return; }
      addRoomToList(name);
      newRoomNameInput.value = "";
      renderRoomsList();
      await switchRoom(name);
      hideRoomsOverlay();
    });

    // ---------- chat controller factory (uses proof) ----------
    function getRoomPassword(room) {
      if (sessionRoomPasswords[room]) return sessionRoomPasswords[room];
      if (userRoomPasswords[room]) return userRoomPasswords[room];
      return null;
    }

    function makeChatController() {
      return {
        active: true,
        paused: false,
        backoffMs: 1500,
        errorBackoffMs: 3000,
        lastCount: 0,
        lastMessages: [],
        async getMessages() {
          const url = `${CHAT_BASE}/room/${encodeURIComponent(currentRoom)}/messages`;
          // try to get a short-lived proof first (preferred, cheap for DO)
          let proof = await fetchRoomProof(token, currentRoom);
          // if no proof, we may still attempt with Authorization/token or prompt then retry
          const headers = {};
          if (token) headers.Authorization = token;
          if (proof) headers["X-Room-Auth"] = proof;
          // If user has saved password or session password, include it as X-Room-Password only if proof flow fails later.
          const pwd = getRoomPassword(currentRoom);
          if (pwd) headers["X-Room-Password"] = pwd; // optional; DO may not need it if proof valid
          const res = await fetchWithTimeout(url, { headers }, 8000);
          if (res.status === 401 || res.status === 403) {
            // try to recover: prompt for password and save if requested, then mint proof and retry once
            const ans = await promptPasswordForRoom(currentRoom, "access");
            if (!ans || !ans.password) throw new Error("Auth required");
            // save choice
            if (ans.remember) {
              const saved = await postSaveRoomPassword(token, currentRoom, ans.password);
              if (saved) userRoomPasswords[currentRoom] = ans.password;
            } else {
              sessionRoomPasswords[currentRoom] = ans.password;
            }
            // clear any stale proof and request a fresh one
            delete roomProofs[currentRoom];
            const proof2 = await fetchRoomProof(token, currentRoom);
            const headers2 = {};
            if (token) headers2.Authorization = token;
            if (proof2) headers2["X-Room-Auth"] = proof2;
            headers2["X-Room-Password"] = ans.password;
            const res2 = await fetchWithTimeout(url, { headers: headers2 }, 8000);
            if (res2.status === 401 || res2.status === 403) throw new Error("Auth failed");
            return res2.json();
          }
          return res.json();
        },
        async sendMessage(text) {
          const url = `${CHAT_BASE}/room/${encodeURIComponent(currentRoom)}/send`;
          let proof = await fetchRoomProof(token, currentRoom);
          const headers = { "Content-Type": "application/json" };
          if (token) headers.Authorization = token;
          if (proof) headers["X-Room-Auth"] = proof;
          const pwd = getRoomPassword(currentRoom);
          if (pwd) headers["X-Room-Password"] = pwd;
          const res = await fetchWithTimeout(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ text })
          }, 8000);
          if (res.status === 401 || res.status === 403) {
            const ans = await promptPasswordForRoom(currentRoom, "access");
            if (!ans || !ans.password) throw new Error("Auth required");
            if (ans.remember) {
              const saved = await postSaveRoomPassword(token, currentRoom, ans.password);
              if (saved) userRoomPasswords[currentRoom] = ans.password;
            } else {
              sessionRoomPasswords[currentRoom] = ans.password;
            }
            delete roomProofs[currentRoom];
            const proof2 = await fetchRoomProof(token, currentRoom);
            const headers2 = { "Content-Type": "application/json" };
            if (token) headers2.Authorization = token;
            if (proof2) headers2["X-Room-Auth"] = proof2;
            headers2["X-Room-Password"] = ans.password;
            const res2 = await fetchWithTimeout(url, {
              method: "POST",
              headers: headers2,
              body: JSON.stringify({ text })
            }, 8000);
            if (res2.status === 401 || res2.status === 403) throw new Error("Auth failed");
            return res2.json();
          }
          return res.json();
        },
        isUserAtBottom() {
          const threshold = 80;
          return (msgBox.scrollHeight - (msgBox.scrollTop + msgBox.clientHeight)) < threshold;
        },
        async loadMessagesOnce({ forceScroll = false } = {}) {
          let data;
          try { data = await this.getMessages(); } catch (e) { console.debug("Chat fetch error:", e); return; }
          if (!data || !Array.isArray(data.messages)) return;
          const newMessages = data.messages;
          const { away: messagesAway } = (function() {
            const pixelDist = msgBox.scrollHeight - (msgBox.scrollTop + msgBox.clientHeight);
            const msgDivs = Array.from(msgBox.children).filter(n => n.tagName === "DIV");
            let total = 0, count = 0;
            for (const d of msgDivs) { const h = d.offsetHeight; if (h > 0) { total += h; count++; } }
            const avg = count ? (total / count) : 60;
            const away = Math.max(0, Math.round(pixelDist / Math.max(1, avg)));
            return { away, pixelDist, avg };
          })();
          const wasAtBottom = this.isUserAtBottom();

          if (this.lastCount === 0 || newMessages.length < this.lastCount) {
            msgBox.innerHTML = "";
            msgBox.appendChild(newMsgBtn);
            newMessages.forEach((m, i) => appendMessageToContainer(msgBox, m, i));
            if (wasAtBottom || forceScroll) msgBox.scrollTop = msgBox.scrollHeight;
          } else if (newMessages.length > this.lastCount) {
            const startIndex = this.lastCount;
            const closeEnoughInMsgs = messagesAway <= 2;
            for (let i = startIndex; i < newMessages.length; i++) appendMessageToContainer(msgBox, newMessages[i], i);
            if (wasAtBottom || closeEnoughInMsgs || forceScroll) {
              msgBox.scrollTop = msgBox.scrollHeight;
              newMsgBtn.style.display = "none";
            } else newMsgBtn.style.display = "block";
          }
          this.lastCount = newMessages.length;
          this.lastMessages = newMessages;
        },
        async pollLoop() {
          while (this.active) {
            try { if (!this.paused) await this.loadMessagesOnce(); await new Promise(r => setTimeout(r, this.backoffMs)); }
            catch (e) { await new Promise(r => setTimeout(r, this.errorBackoffMs)); }
          }
        },
        stop() { this.active = false; this.paused = true; },
        pause() { this.paused = true; },
        resume() { this.paused = false; }
      };
    }

    // initialize controller
    let chatController = makeChatController();
    box._chatController = chatController;
    chatController.pollLoop();
    await chatController.loadMessagesOnce().catch(() => {});

    const TIMESTAMP_REFRESH_MS = 30 * 1000;
    box._timeUpdater = setInterval(() => refreshTimestampsIn(msgBox), TIMESTAMP_REFRESH_MS);
    refreshTimestampsIn(msgBox);

    async function doSendMessage(text) {
      if (!text) return;
      try {
        await chatController.sendMessage(text);
        await chatController.loadMessagesOnce({ forceScroll: true });
        newMsgBtn.style.display = "none";
        refreshTimestampsIn(msgBox);
      } catch (e) { console.debug("Send message error:", e); alert("Send failed: " + (e && e.message ? e.message : "unknown")); }
    }

    // Image UI (unchanged)
    imageBtn.addEventListener("click", () => {
      if (imageInputRow.style.display === "none" || imageInputRow.style.display === "") {
        imageInputRow.style.display = "flex";
        imageUrlInput.focus();
      } else {
        imageInputRow.style.display = "none";
      }
    });
    imageUrlCancel.addEventListener("click", () => {
      imageInputRow.style.display = "none";
      imageUrlInput.value = "";
    });
    function validImageUrlCandidate(u) {
      if (!u || typeof u !== "string") return false;
      const t = u.trim();
      if (t.length === 0) return false;
      try {
        const url = new URL(t);
        if (!["http:", "https:"].includes(url.protocol)) return false;
        return IMG_EXT_RE.test(url.pathname);
      } catch (e) { return false; }
    }
    imageUrlSend.addEventListener("click", async () => {
      const url = imageUrlInput.value.trim();
      if (!validImageUrlCandidate(url)) {
        imageUrlInput.style.border = "1px solid #ff5555";
        setTimeout(() => imageUrlInput.style.border = "none", 1500);
        return;
      }
      await doSendMessage(url);
      imageInputRow.style.display = "none";
      imageUrlInput.value = "";
    });
    imageUploadBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async () => {
      const files = fileInput.files;
      if (!files || files.length === 0) return;
      const file = files[0];
      if (!file.type || !file.type.startsWith("image/")) {
        alert("Please select an image file.");
        fileInput.value = "";
        return;
      }
      if (!sessionImgBBKey) sessionImgBBKey = await fetchStoredKeyFromAccount(token);
      if (!sessionImgBBKey) {
        const entered = prompt("No ImgBB API key linked to your account. Paste your ImgBB API key (it will be linked to your account for future uploads):");
        if (!entered || !entered.trim()) { alert("Upload canceled: no API key provided."); fileInput.value = ""; return; }
        const trimmedKey = entered.trim();
        const saved = await saveKeyToAccount(token, trimmedKey);
        if (!saved) {
          if (!confirm("Failed to save key to account. Use this key just for this session? (OK = use for this upload only, Cancel = abort)")) { fileInput.value = ""; return; }
          sessionImgBBKey = trimmedKey;
        } else sessionImgBBKey = trimmedKey;
      }
      const prevUploadText = imageUploadBtn.textContent;
      imageUploadBtn.disabled = true; imageUrlSend.disabled = true; imageUrlInput.disabled = true; imageUrlCancel.disabled = true;
      imageUploadBtn.textContent = "Uploading...";
      try {
        const fd = new FormData(); fd.append("file", file); fd.append("key", sessionImgBBKey);
        let res = await fetchWithTimeout(IMAGE_UPLOAD_WORKER, { method: "POST", body: fd }, 120000);
        if (res.status === 400) {
          const text = await res.text().catch(() => "");
          sessionImgBBKey = null;
          if (/key/i.test(text) || confirm("Upload failed (possible invalid key). Re-enter key and save to account?")) {
            const entered = prompt("Paste your ImgBB API key (will be saved to your account):");
            if (entered && entered.trim()) {
              const trimmedKey = entered.trim();
              const saved = await saveKeyToAccount(token, trimmedKey);
              if (!saved) { alert("Could not save key to account. Aborting."); fileInput.value = ""; throw new Error("Failed to save key"); }
              sessionImgBBKey = trimmedKey;
              const fd2 = new FormData(); fd2.append("file", file); fd2.append("key", sessionImgBBKey);
              const res2 = await fetchWithTimeout(IMAGE_UPLOAD_WORKER, { method: "POST", body: fd2 }, 120000);
              if (!res2.ok) throw new Error("Upload worker error: " + res2.status);
              const data2 = await res2.json().catch(() => null);
              const url2 = data2 && (data2.url || (data2.data && data2.data.url));
              if (!url2) throw new Error("No URL returned from upload worker");
              await doSendMessage(url2);
              imageInputRow.style.display = "none"; imageUrlInput.value = "";
              return;
            } else throw new Error("No key entered");
          } else throw new Error("Upload worker rejected request");
        } else {
          if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error("Upload worker returned " + res.status + " " + text);
          }
          const data = await res.json().catch(() => null);
          const url = data && (data.url || (data.data && data.data.url));
          if (!url) throw new Error("No URL returned from upload worker");
          await doSendMessage(url);
          imageInputRow.style.display = "none";
          imageUrlInput.value = "";
        }
      } catch (err) {
        console.debug("Upload error:", err);
        alert("Upload failed: " + (err && err.message ? err.message : "unknown"));
      } finally {
        imageUploadBtn.disabled = false; imageUrlSend.disabled = false; imageUrlInput.disabled = false; imageUrlCancel.disabled = false;
        imageUploadBtn.textContent = prevUploadText || "Upload"; fileInput.value = "";
      }
    });

    // Right-click on imageBtn clears session cache (not stored account key)
    imageBtn.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      if (!sessionImgBBKey) { alert("No ImgBB key cached in this session."); return; }
      if (confirm("Clear the ImgBB key cached for this session? (This will not remove the key stored on your account)")) {
        sessionImgBBKey = null; alert("Session ImgBB key cleared.");
      }
    }, { passive: false });

    // Minify / close
    let minIcon = null;
    function createMinIcon() {
      const icon = document.createElement("div");
      const rect = box.getBoundingClientRect();
      Object.assign(icon.style, {
        position: "fixed",
        left: Math.max(8, rect.left + 8) + "px",
        top: Math.max(8, rect.top + 8) + "px",
        width: "56px",
        height: "56px",
        background: "#7289da",
        color: "#fff",
        borderRadius: "28px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000000,
        cursor: "pointer",
        boxShadow: "0 8px 20px rgba(0,0,0,0.3)",
        fontSize: "24px",
        touchAction: "manipulation",
      });
      icon.title = "Restore Chat";
      icon.innerText = "✉";
      document.body.appendChild(icon);
      registerEl(icon);

      icon.onclick = () => {
        removeEl(icon);
        minIcon = null;
        box.style.display = "flex";
        chatController.resume();
        chatController.loadMessagesOnce().catch(() => {});
      };

      makeDraggable(icon, { threshold: 6 });
      return icon;
    }

    minifyBtn.onclick = () => {
      if (minIcon) return;
      minIcon = createMinIcon();
      box.style.display = "none";
      chatController.pause();
    };

    closeBtn.onclick = () => {
      if (box._chatController) try { box._chatController.stop(); } catch (e) {}
      if (box._timeUpdater) { try { clearInterval(box._timeUpdater); } catch (e) {} box._timeUpdater = null; }
      if (minIcon) { removeEl(minIcon); minIcon = null; }
      removeEl(box);
    };

    const observer = new MutationObserver(() => {
      if (!document.body.contains(box)) {
        if (box._chatController) try { box._chatController.stop(); } catch (e) {}
        if (box._timeUpdater) { try { clearInterval(box._timeUpdater); } catch (e) {} box._timeUpdater = null; }
        if (minIcon && !document.body.contains(minIcon)) minIcon = null;
        observer.disconnect();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => { try { chatInputEl.focus(); } catch (e) {} }, 300);

    // new messages button
    const newMsgBtn = document.createElement("button");
    Object.assign(newMsgBtn.style, {
      position: "absolute",
      right: "12px",
      bottom: "12px",
      padding: "6px 10px",
      borderRadius: "12px",
      background: "#43b581",
      color: "#fff",
      border: "none",
      display: "none",
      zIndex: 10,
      fontSize: "13px",
    });
    newMsgBtn.textContent = "New messages";
    newMsgBtn.onclick = () => { msgBox.scrollTop = msgBox.scrollHeight; newMsgBtn.style.display = "none"; };
    msgBox.appendChild(newMsgBtn);

    // Room switching logic (updated)
    async function switchRoom(newRoomName) {
      if (!newRoomName || !newRoomName.trim()) { alert("Room name required"); return; }
      const trimmed = newRoomName.trim();
      if (trimmed === currentRoom) {
        currentRoomDisplay.textContent = `room: ${currentRoom}`; return;
      }
      try { chatController.stop(); } catch (e) {}
      if (box._timeUpdater) { try { clearInterval(box._timeUpdater); } catch (e) {} box._timeUpdater = null; }
      msgBox.innerHTML = ""; msgBox.appendChild(newMsgBtn);

      currentRoom = trimmed;
      try { localStorage.setItem("dole_chat_room", currentRoom); } catch (e) {}
      if (currentRoomDisplay) currentRoomDisplay.textContent = `room: ${currentRoom}`;

      // ensure room added to library
      addRoomToList(currentRoom);

      // create new controller and start
      chatController = makeChatController();
      box._chatController = chatController;
      chatController.pollLoop();
      await chatController.loadMessagesOnce({ forceScroll: true }).catch(() => {});
      box._timeUpdater = setInterval(() => refreshTimestampsIn(msgBox), TIMESTAMP_REFRESH_MS);
      refreshTimestampsIn(msgBox);
    }

    // Wire up send
    box.querySelector("#chatSend").onclick = async () => {
      const text = chatInputEl.value.trim();
      if (!text) return;
      await doSendMessage(text);
      chatInputEl.value = "";
    };
    chatInputEl.addEventListener("keydown", async (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const text = chatInputEl.value.trim();
        if (!text) return;
        await doSendMessage(text);
        chatInputEl.value = "";
      }
    });

    // Expose API and done
    box.switchRoom = switchRoom;
    window.__dole_bookmarklet_open = async function() {};

    // Ensure current room is in library
    addRoomToList(currentRoom);
    // Update caches visible in UI
    renderRoomsList();
  }

  // Helper: fetch stored ImgBB key (existing)
  async function fetchStoredKeyFromAccount(token) {
    try {
      const res = await fetchWithTimeout(`${ACCOUNT_BASE}/user/imgbb-key`, {
        method: "GET",
        headers: { Authorization: token },
      }, 8000);
      if (!res.ok) return null;
      const j = await res.json().catch(() => null);
      if (!j) return null;
      if (j.success === true && j.key) return String(j.key);
      return null;
    } catch (e) {
      console.debug("Error fetching stored key:", e);
      return null;
    }
  }
  async function saveKeyToAccount(token, key) {
    try {
      const res = await fetchWithTimeout(`${ACCOUNT_BASE}/user/imgbb-key`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: token },
        body: JSON.stringify({ key })
      }, 8000);
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error("Server returned " + res.status + " " + txt);
      }
      const j = await res.json().catch(() => null);
      if (!j || j.success !== true) throw new Error((j && j.error) ? j.error : "Unknown server error");
      return true;
    } catch (e) {
      console.debug("Failed to save key to account:", e);
      return false;
    }
  }

  // End top-level IIFE
})();
})();
