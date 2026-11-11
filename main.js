import "./shim.js";
import { TelegramClient, utils, sessions, Api } from "telegram";

const StringSession = sessions.StringSession;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const initials = (s) => String(s || "?").trim().split(/\s+/).slice(0, 2).map((x) => x[0] || "").join("").toUpperCase() || "?";
const hashColor = (s) => {
  let h = 0;
  for (const c of String(s || "?")) h = (h * 31 + c.charCodeAt(0)) | 0;
  return `hsl(${Math.abs(h) % 360} 48% 42%)`;
};
const toast = (message, ms = 3800) => {
  const el = $("toast");
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.add("hidden"), ms);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------- локальная база: текст, реакции, история изменений и медиа ---------- */
const dbp = new Promise((resolve, reject) => {
  const request = indexedDB.open("tgclient", 1);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains("msgs")) db.createObjectStore("msgs", { keyPath: "key" });
    if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
async function tx(store, mode, operation) {
  const db = await dbp;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = operation(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request && request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Операция с базой отменена"));
  });
}
const persist = (record) => tx("msgs", "readwrite", (s) => s.put(record)).catch(() => {});

/* ---------- состояние приложения ---------- */
let client = null;
let current = null;
let dialogs = [];
let ghost = localStorage.getItem("ghost") !== "0";
let replyTarget = null;
let loadingOlder = false;
let loadingAll = false;
let historyEnd = false;
let senderCache = new Map();
const store = new Map();
const mediaRef = new Map();
const objectUrls = new Set();

/* ---------- режим без отметки прочтения ---------- */
const BLOCKED_REQUESTS = new Set([
  "account.UpdateStatus",
  "messages.ReadHistory",
  "channels.ReadHistory",
  "messages.ReadMessageContents",
  "channels.ReadMessageContents",
  "messages.SetTyping",
  "messages.ReadDiscussion",
]);
function patchInvoke() {
  const original = client.invoke.bind(client);
  client._originalInvoke = original;
  client.invoke = async (request, ...rest) => {
    if (ghost && request && BLOCKED_REQUESTS.has(request.className)) return true;
    return original(request, ...rest);
  };
}
function paintGhost() {
  const button = $("ghostBtn");
  button.classList.toggle("ghost-on", ghost);
  button.textContent = ghost ? "Призрак: вкл" : "Призрак: выкл";
  button.title = "При включении клиент блокирует часть запросов о прочтении";
}
async function setGhost(value) {
  ghost = value;
  localStorage.setItem("ghost", value ? "1" : "0");
  paintGhost();
  if (value && client?._originalInvoke) {
    try { await client._originalInvoke(new Api.account.UpdateStatus({ offline: true })); } catch {}
  }
  toast(value ? "Режим призрака включён" : "Режим призрака выключен");
}

/* ---------- данные Telegram ---------- */
function peerId(peer) {
  try { return peer ? String(utils.getPeerId(peer)) : ""; } catch { return ""; }
}
function getMessageKind(message) {
  const media = message.media;
  const className = media?.className;
  if (className === "MessageMediaPhoto") return "photo";
  if (className === "MessageMediaDocument") {
    const mime = media.document?.mimeType || "";
    const attrs = media.document?.attributes || [];
    if (mime.startsWith("video/") || attrs.some((a) => a.className === "DocumentAttributeVideo")) return "video";
    if (mime.startsWith("image/")) return "photo";
    return "file";
  }
  return media ? "other" : "";
}
function reactionRows(message) {
  const results = message.reactions?.results || [];
  return results.map((item) => ({
    emoji: item.reaction?.emoticon || (item.reaction?.className === "ReactionCustomEmoji" ? "✨" : "👍"),
    count: Number(item.count || 0),
    chosen: item.chosenOrder != null,
  }));
}
function getReplyId(message) {
  return Number(message.replyToMsgId || message.replyTo?.replyToMsgId || 0) || 0;
}
async function resolveSenderName(message) {
  if (message.out) return "Вы";
  const senderId = message.senderId != null ? String(message.senderId) : "";
  if (senderId && senderCache.has(senderId)) return senderCache.get(senderId);
  let sender = null;
  try { sender = await message.getSender(); } catch {}
  if (!sender && message.senderId != null) {
    try { sender = await client.getEntity(message.senderId); } catch {}
  }
  const fullName = [sender?.firstName, sender?.lastName].filter(Boolean).join(" ").trim();
  const name = message.postAuthor || fullName || sender?.title || sender?.username || (senderId ? `Участник ${senderId}` : "Участник");
  if (senderId) senderCache.set(senderId, name);
  return name;
}
function recordMessage(message) {
  if (!message || message.className !== "Message" || !message.peerId) return null;
  const chatId = peerId(message.peerId);
  if (!chatId) return null;
  const key = `${chatId}:${message.id}`;
  const text = message.message || "";
  const old = store.get(key);
  const record = old || {
    key,
    chatId,
    id: message.id,
    isChannel: message.peerId.className === "PeerChannel",
    out: !!message.out,
    senderId: message.senderId == null ? "" : String(message.senderId),
    senderName: "",
    date: message.date,
    text,
    kind: getMessageKind(message),
    ttl: message.media?.ttlSeconds || 0,
    replyToId: getReplyId(message),
    reactions: [],
    deleted: false,
    edits: [],
    saved: false,
  };
  if (old && old.text !== text) {
    record.edits = [...(old.edits || []), old.text];
    record.text = text;
  }
  record.out = !!message.out;
  record.senderId = message.senderId == null ? record.senderId : String(message.senderId);
  record.date = message.date || record.date;
  record.kind = getMessageKind(message) || record.kind;
  record.ttl = message.media?.ttlSeconds || record.ttl || 0;
  record.replyToId = getReplyId(message) || record.replyToId || 0;
  record.reactions = reactionRows(message);
  store.set(key, record);
  persist(record);
  return record;
}
async function handleMessage(message) {
  const record = recordMessage(message);
  if (!record) return null;
  if (message.media) mediaRef.set(record.key, message.media);
  const senderName = await resolveSenderName(message);
  if (senderName && record.senderName !== senderName) {
    record.senderName = senderName;
    persist(record);
  }
  if (!record.out && record.ttl && !record.saved && message.media) {
    downloadMedia(record).then(() => {
      if (current?.id === record.chatId) renderChat();
    }).catch(() => {});
  }
  return record;
}
async function downloadMedia(record) {
  const media = mediaRef.get(record.key);
  if (!media) return null;
  const bytes = await client.downloadMedia(media, {});
  if (!bytes) return null;
  const mime = media.document?.mimeType || (record.kind === "photo" ? "image/jpeg" : "video/mp4");
  const blob = new Blob([bytes], { type: mime });
  await tx("blobs", "readwrite", (s) => s.put(blob, record.key));
  record.saved = true;
  await persist(record);
  return blob;
}
async function getBlob(record) {
  const cached = await tx("blobs", "readonly", (s) => s.get(record.key));
  if (cached) return cached;
  // После перезапуска вкладки ссылки на Telegram media не хранятся в памяти.
  // Повторно получаем сообщение по ID и только затем скачиваем вложение.
  if (!mediaRef.has(record.key) && current && current.id === record.chatId) {
    try {
      const result = await client.getMessages(current.entity, { ids: record.id });
      if (result?.[0]?.media) mediaRef.set(record.key, result[0].media);
    } catch {}
  }
  return downloadMedia(record);
}

/* ---------- обновления в реальном времени ---------- */
function onUpdate(update) {
  const name = update.className;
  if (name === "UpdateDeleteMessages" || name === "UpdateDeleteChannelMessages") {
    const channelChatId = name === "UpdateDeleteChannelMessages" ? `-100${String(update.channelId)}` : null;
    for (const record of store.values()) {
      const samePeer = channelChatId ? record.chatId === channelChatId : !record.isChannel;
      if (update.messages.includes(record.id) && samePeer && !record.deleted) {
        record.deleted = true;
        persist(record);
      }
    }
    if (current) renderChat();
    return;
  }
  if (name === "UpdateMessageReactions") {
    const chatId = peerId(update.peer);
    const record = store.get(`${chatId}:${update.msgId}`);
    if (record) {
      const results = update.reactions?.results || [];
      record.reactions = results.map((item) => ({
        emoji: item.reaction?.emoticon || "✨",
        count: Number(item.count || 0),
        chosen: item.chosenOrder != null,
      }));
      persist(record);
      if (current?.id === record.chatId) renderChat();
    }
    return;
  }
  if (["UpdateNewMessage", "UpdateNewChannelMessage", "UpdateEditMessage", "UpdateEditChannelMessage"].includes(name)) {
    handleMessage(update.message).then(() => { if (current) renderChat(); }).catch(() => {});
  }
}

/* ---------- авторизация и список чатов ---------- */
function showScreen(screen) {
  $("login").classList.toggle("hidden", screen !== "login");
  $("main").classList.toggle("hidden", screen !== "main");
}
function ask(label, secret = false) {
  return new Promise((resolve) => {
    $("mLabel").textContent = label;
    const input = $("mInput");
    input.type = secret ? "password" : "text";
    input.value = "";
    $("modal").classList.remove("hidden");
    input.focus();
    const finish = () => {
      $("modal").classList.add("hidden");
      $("mOk").removeEventListener("click", finish);
      input.removeEventListener("keydown", onKey);
      resolve(input.value.trim());
    };
    const onKey = (event) => { if (event.key === "Enter") finish(); };
    $("mOk").addEventListener("click", finish, { once: true });
    input.addEventListener("keydown", onKey);
  });
}
async function start(apiId, apiHash) {
  const session = new StringSession(localStorage.getItem("sess") || "");
  client = new TelegramClient(session, Number(apiId), apiHash, {
    connectionRetries: 5,
    useWSS: true,
    deviceModel: "iPhone",
    systemVersion: "iOS",
    appVersion: "6.0",
    langCode: "ru",
    systemLangCode: "ru",
  });
  await client.start({
    phoneNumber: () => ask("Номер телефона в формате +7…"),
    phoneCode: () => ask("Код подтверждения из Telegram"),
    password: () => ask("Пароль двухэтапной проверки", true),
    onError: (error) => { toast(`Ошибка: ${error.message || error}`, 8000); return true; },
  });
  localStorage.setItem("sess", client.session.save());
  patchInvoke();
  client.addEventHandler(onUpdate);
  const saved = await tx("msgs", "readonly", (s) => s.getAll());
  for (const record of saved || []) store.set(record.key, record);
  showScreen("main");
  paintGhost();
  if (ghost) await setGhost(true);
  await loadDialogs();
}
function dialogName(dialog) {
  return dialog.title || dialog.name || dialog.entity?.firstName || dialog.entity?.username || "Без названия";
}
function renderDialogs() {
  const query = $("search").value.trim().toLowerCase();
  const filtered = dialogs.map((dialog, index) => ({ dialog, index })).filter(({ dialog }) => {
    const name = dialogName(dialog).toLowerCase();
    const username = String(dialog.entity?.username || "").toLowerCase();
    return !query || name.includes(query) || username.includes(query);
  });
  $("list").innerHTML = filtered.map(({ dialog, index }) => {
    const name = dialogName(dialog);
    const last = dialog.message?.message || (dialog.message?.media ? "📎 Вложение" : "");
    const when = dialog.message?.date ? formatListDate(dialog.message.date) : "";
    const selected = current?.id === String(dialog.id) ? " active" : "";
    return `<button class="dialog${selected}" type="button" data-index="${index}">
      <span class="avatar" style="--avatar:${hashColor(name)}">${esc(initials(name))}</span>
      <span class="dialog-content"><span class="dialog-line"><span class="dialog-title">${esc(name)}</span><span class="dialog-date">${esc(when)}</span></span>
      <span class="dialog-line"><span class="dialog-preview">${dialog.message?.out ? "Вы: " : ""}${esc(last)}</span>${dialog.unreadCount ? `<span class="unread">${dialog.unreadCount}</span>` : ""}</span></span>
    </button>`;
  }).join("") || '<div class="empty-state">Ничего не найдено</div>';
  $("chatCount").textContent = String(dialogs.length);
  $("emptyChats").classList.toggle("hidden", dialogs.length > 0);
}
async function loadDialogs() {
  $("list").innerHTML = '<div class="empty-state">Загружаю чаты…</div>';
  try {
    dialogs = await client.getDialogs({ limit: 100 });
    renderDialogs();
  } catch (error) {
    $("list").innerHTML = '<div class="empty-state">Не удалось загрузить чаты</div>';
    toast(`Ошибка загрузки чатов: ${error.message || error}`, 7000);
  }
}

/* ---------- открытие и загрузка истории ---------- */
function setChatHeader() {
  const name = current?.name || "Чат";
  $("chatTitle").textContent = name;
  $("chatAvatar").textContent = initials(name);
  $("chatAvatar").style.setProperty("--avatar", hashColor(name));
  $("chatSubtitle").textContent = current?.isGroup ? "Группа" : "Личный чат";
  $("chatHeader").classList.remove("hidden");
  $("chatBlank").classList.add("hidden");
  $("conversation").classList.add("conversation-active");
  $("main").classList.add("chat-open");
}
async function openChat(dialog) {
  current = {
    id: String(dialog.id),
    entity: dialog.inputEntity || dialog.entity,
    name: dialogName(dialog),
    isGroup: !!dialog.isGroup || dialog.entity?.className === "Chat" || (dialog.entity?.className === "Channel" && !dialog.entity?.broadcast),
  };
  replyTarget = null;
  historyEnd = false;
  loadingOlder = false;
  loadingAll = false;
  $("replyBar").classList.add("hidden");
  $("historyStatus").textContent = "";
  $("msgs").classList.remove("hidden");
  $("msgs").innerHTML = '<div class="empty-state">Загружаю историю…</div>';
  $("historyTools").classList.remove("hidden");
  $("composer").classList.remove("hidden");
  setChatHeader();
  renderDialogs();
  const chatAtStart = current;
  try {
    const latest = await client.getMessages(chatAtStart.entity, { limit: 100 });
    for (const message of latest.slice().reverse()) await handleMessage(message);
    if (current !== chatAtStart) return;
    renderChat(true);
    updateHistoryButtons();
  } catch (error) {
    if (current === chatAtStart) toast(`Не удалось загрузить сообщения: ${error.message || error}`, 7000);
  }
}
function messagesForChat(chatId) {
  return [...store.values()].filter((record) => record.chatId === chatId)
    .sort((a, b) => a.date - b.date || a.id - b.id);
}
function messagesForCurrentChat() {
  return messagesForChat(current?.id);
}
async function loadOlder() {
  if (!current || loadingOlder || historyEnd) return;
  const chatAtStart = current;
  const existing = messagesForChat(chatAtStart.id);
  const oldest = existing[0];
  if (!oldest) { historyEnd = true; updateHistoryButtons(); return; }
  loadingOlder = true;
  const box = $("msgs");
  const oldHeight = box.scrollHeight;
  const oldTop = box.scrollTop;
  $("loadOlder").disabled = true;
  $("loadOlder").textContent = "Загружаю…";
  try {
    const batch = await client.getMessages(chatAtStart.entity, { limit: 100, offsetId: oldest.id });
    for (const message of batch.slice().reverse()) await handleMessage(message);
    if (current !== chatAtStart) return;
    if (!batch.length) historyEnd = true;
    const newOldest = messagesForChat(chatAtStart.id)[0];
    if (!newOldest || newOldest.id === oldest.id) historyEnd = true;
    renderChat(false);
    box.scrollTop = box.scrollHeight - oldHeight + oldTop;
  } catch (error) {
    toast(`Не удалось загрузить ранние сообщения: ${error.message || error}`, 7000);
  } finally {
    loadingOlder = false;
    if (current === chatAtStart) updateHistoryButtons();
  }
}
async function loadAllHistory() {
  if (!current || loadingAll || historyEnd) return;
  const chatAtStart = current;
  loadingAll = true;
  $("loadAll").disabled = true;
  let loaded = 0;
  try {
    while (current === chatAtStart && !historyEnd) {
      const existing = messagesForChat(chatAtStart.id);
      const oldest = existing[0];
      if (!oldest) { historyEnd = true; break; }
      const batch = await client.getMessages(chatAtStart.entity, { limit: 100, offsetId: oldest.id });
      for (const message of batch.slice().reverse()) await handleMessage(message);
      if (current !== chatAtStart) break;
      if (!batch.length) { historyEnd = true; break; }
      loaded += batch.length;
      const newOldest = messagesForChat(chatAtStart.id)[0];
      if (!newOldest || newOldest.id === oldest.id) historyEnd = true;
      if (current === chatAtStart) {
        $("loadAll").textContent = `Загружено ${loaded}…`;
        $("historyStatus").textContent = `Получено ещё ${loaded} сообщений`;
      }
      if (loaded % 500 === 0) {
        renderChat(false);
        await sleep(1000); // не отправляем слишком много GetHistory подряд
      } else {
        await sleep(120);
      }
    }
    if (current === chatAtStart) {
      renderChat(false);
      toast(historyEnd ? `История загружена до начала. Добавлено: ${loaded}` : `Загружено сообщений: ${loaded}`);
    }
  } catch (error) {
    toast(`Загрузка остановлена: ${error.message || error}`, 8000);
  } finally {
    loadingAll = false;
    if (current === chatAtStart) updateHistoryButtons();
  }
}
function updateHistoryButtons() {
  const label = historyEnd ? "Начало истории" : "Загрузить предыдущие сообщения";
  $("loadOlder").textContent = label;
  $("loadOlder").disabled = historyEnd || loadingOlder || loadingAll;
  $("loadAll").classList.toggle("hidden", historyEnd);
  $("loadAll").disabled = loadingAll || loadingOlder || historyEnd;
  if (historyEnd) $("historyStatus").textContent = "Показана вся доступная история этого чата";
}

/* ---------- отображение сообщений ---------- */
function formatTime(timestamp) {
  return new Date(timestamp * 1000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
function formatDay(timestamp) {
  const date = new Date(timestamp * 1000);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Сегодня";
  if (date.toDateString() === yesterday.toDateString()) return "Вчера";
  return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: date.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}
function formatListDate(timestamp) {
  const date = new Date(timestamp * 1000);
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
    : date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}
function excerpt(record) {
  if (!record) return "Сообщение";
  if (record.text) return record.text.slice(0, 140);
  if (record.kind === "photo") return "Фото";
  if (record.kind === "video") return "Видео";
  if (record.kind) return "Вложение";
  return "Сообщение";
}
function renderReactionChips(record) {
  if (!record.reactions?.length) return "";
  return `<div class="reaction-list">${record.reactions.map((reaction) =>
    `<button type="button" class="reaction-chip${reaction.chosen ? " chosen" : ""}" data-act="reactionPeople" data-k="${esc(record.key)}" data-emoji="${esc(reaction.emoji)}" title="Посмотреть, кто поставил реакцию">${esc(reaction.emoji)} <span>${reaction.count}</span></button>`
  ).join("")}</div>`;
}
function renderMessage(record) {
  const author = record.out ? "Вы" : (record.senderName || (current?.isGroup ? "Участник" : current?.name));
  const showAuthor = true; // Автор виден и в личных, и в групповых чатах.
  const reply = record.replyToId ? store.get(`${record.chatId}:${record.replyToId}`) : null;
  const replyMarkup = record.replyToId
    ? `<button type="button" class="reply-preview" data-act="jumpReply" data-k="${esc(record.key)}"><span class="reply-accent"></span><span><b>${esc(reply?.senderName || "Ответ на сообщение")}</b><span>${esc(excerpt(reply) || `Сообщение #${record.replyToId}`)}</span></span></button>`
    : "";
  let mediaMarkup = "";
  if (record.kind) {
    const label = record.kind === "photo" ? "Фото" : record.kind === "video" ? "Видео" : record.kind === "file" ? "Файл" : "Вложение";
    mediaMarkup = `<div class="media-actions"><button type="button" class="media-open" data-act="showMedia" data-k="${esc(record.key)}">${record.kind === "photo" ? "▧" : record.kind === "video" ? "▶" : "↧"} ${label}</button>${(record.kind === "photo" || record.kind === "video") ? `<button type="button" class="media-save" data-act="saveMedia" data-k="${esc(record.key)}" title="Сохранить медиа">↓</button>` : ""}</div>`;
  }
  const tags = `${record.deleted ? '<span class="deleted-tag">Сообщение удалено</span>' : ""}${record.ttl ? `<span class="ttl-tag">Временное медиа${record.saved ? " · сохранено" : ""}</span>` : ""}${record.edits?.length ? `<button type="button" class="edited-tag" data-act="editHistory" data-k="${esc(record.key)}">изменено</button>` : ""}`;
  const text = record.text ? `<div class="message-text">${esc(record.text).replace(/\n/g, "<br>")}</div>` : "";
  const quick = `<div class="quick-reactions hidden">${["👍", "❤️", "😂", "🔥", "👏", "😮"].map((emoji) => `<button type="button" data-act="sendReaction" data-k="${esc(record.key)}" data-emoji="${emoji}">${emoji}</button>`).join("")}</div>`;
  return `<div class="message-row${record.out ? " own" : ""}" data-mid="${record.id}">
    <div class="message-avatar" style="--avatar:${hashColor(author)}">${esc(initials(author))}</div>
    <article class="bubble${record.out ? " own" : ""}${record.deleted ? " deleted" : ""}" data-k="${esc(record.key)}">
      ${showAuthor ? `<div class="message-author" style="color:${hashColor(author)}">${esc(author)}</div>` : ""}
      ${tags}${replyMarkup}${mediaMarkup}${text}
      <div class="bubble-bottom"><span class="bubble-time">${formatTime(record.date)}${record.out ? '<span class="checkmark">✓✓</span>' : ""}</span>
        <div class="message-tools"><button type="button" data-act="reply" data-k="${esc(record.key)}" title="Ответить">↩</button><button type="button" data-act="toggleReactions" data-k="${esc(record.key)}" title="Поставить реакцию">☺</button></div>
      </div>
      ${quick}${renderReactionChips(record)}
    </article>
  </div>`;
}
function renderChat(scrollToBottom = false) {
  if (!current) return;
  const box = $("msgs");
  const wasAtBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 90;
  const rows = messagesForCurrentChat();
  let previousDay = "";
  const html = rows.map((record) => {
    const day = new Date(record.date * 1000).toDateString();
    let divider = "";
    if (day !== previousDay) {
      previousDay = day;
      divider = `<div class="day-divider"><span>${esc(formatDay(record.date))}</span></div>`;
    }
    return divider + renderMessage(record);
  }).join("");
  box.innerHTML = `${html || '<div class="empty-state">Сообщений пока нет</div>'}<div class="history-end-marker"></div>`;
  if (scrollToBottom || wasAtBottom) box.scrollTop = box.scrollHeight;
}
function scrollToMessage(messageId) {
  const element = $("msgs").querySelector(`.message-row[data-mid="${Number(messageId)}"]`);
  if (element) {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
    element.classList.add("flash-message");
    setTimeout(() => element.classList.remove("flash-message"), 1800);
    return true;
  }
  return false;
}

/* ---------- календарь: перейти к выбранному дню ---------- */
async function jumpToDate(value) {
  if (!current || !value) return;
  const chatAtStart = current;
  const [year, month, day] = value.split("-").map(Number);
  const start = Math.floor(new Date(year, month - 1, day).getTime() / 1000);
  const end = Math.floor(new Date(year, month - 1, day + 1).getTime() / 1000);
  toast(`Ищу сообщения за ${new Date(start * 1000).toLocaleDateString("ru-RU")}…`, 2500);
  let found = 0;
  try {
    for await (const message of client.iterMessages(chatAtStart.entity, { offsetDate: new Date(end * 1000), limit: undefined, waitTime: 1 })) {
      if (current !== chatAtStart) return;
      if (message.date < start) break;
      if (message.date < end) {
        await handleMessage(message);
        found++;
      }
    }
    if (current !== chatAtStart) return;
    renderChat(false);
    if (found) {
      const first = messagesForChat(chatAtStart.id).find((record) => record.date >= start && record.date < end);
      scrollToMessage(first?.id);
      toast(`Найдено сообщений за день: ${found}`);
    } else {
      toast("За эту дату сообщений не найдено");
    }
  } catch (error) {
    toast(`Не удалось перейти к дате: ${error.message || error}`, 7000);
  }
}

/* ---------- ответы ---------- */
function setReply(record) {
  replyTarget = record;
  $("replyName").textContent = record.out ? "Вы" : (record.senderName || "Участник");
  $("replyText").textContent = excerpt(record);
  $("replyBar").classList.remove("hidden");
  $("text").focus();
}
function clearReply() {
  replyTarget = null;
  $("replyBar").classList.add("hidden");
}
async function jumpToReply(record) {
  if (!record.replyToId || !current) return;
  const chatAtStart = current;
  let replied = store.get(`${record.chatId}:${record.replyToId}`);
  if (!replied) {
    try {
      const result = await client.getMessages(chatAtStart.entity, { ids: record.replyToId });
      if (current !== chatAtStart) return;
      if (result?.[0]) {
        await handleMessage(result[0]);
        replied = store.get(`${record.chatId}:${record.replyToId}`);
        renderChat(false);
      }
    } catch {}
  }
  if (!scrollToMessage(record.replyToId)) toast("Исходное сообщение недоступно в истории Telegram");
}

/* ---------- реакции ---------- */
async function sendReaction(record, emoji) {
  const chatAtStart = current;
  if (!chatAtStart) return;
  try {
    const currentReaction = (record.reactions || []).find((reaction) => reaction.emoji === emoji && reaction.chosen);
    await client.invoke(new Api.messages.SendReaction({
      peer: chatAtStart.entity,
      msgId: record.id,
      reaction: currentReaction ? [] : [new Api.ReactionEmoji({ emoticon: emoji })],
    }));
    const fresh = await client.getMessages(chatAtStart.entity, { ids: record.id });
    if (fresh?.[0]) await handleMessage(fresh[0]);
    if (current === chatAtStart) renderChat(false);
  } catch (error) {
    toast(`Не удалось поставить реакцию: ${error.message || error}`, 7000);
  }
}
async function showReactionPeople(record, emoji) {
  const chatAtStart = current;
  if (!chatAtStart) return;
  try {
    const result = await client.invoke(new Api.messages.GetMessageReactionsList({
      peer: chatAtStart.entity,
      id: record.id,
      reaction: new Api.ReactionEmoji({ emoticon: emoji }),
      offset: "",
      limit: 100,
    }));
    const users = result.users || [];
    const names = (result.reactions || []).map((reaction) => {
      const id = peerId(reaction.peerId);
      const user = users.find((item) => String(item.id) === id.replace(/^-/, "")) || users.find((item) => String(item.id) === id);
      return user ? ([user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || "Участник") : "Участник";
    });
    $("peopleTitle").textContent = `${emoji} Кто поставил реакцию`;
    $("peopleList").innerHTML = names.length ? names.map((name) => `<div class="people-row"><span class="avatar small" style="--avatar:${hashColor(name)}">${esc(initials(name))}</span>${esc(name)}</div>`).join("") : '<div class="empty-state">Список участников недоступен</div>';
  } catch (error) {
    $("peopleTitle").textContent = `${emoji} Реакции`;
    $("peopleList").innerHTML = `<div class="empty-state">Telegram не предоставил список пользователей для этой реакции.<br>${esc(error.message || "")}</div>`;
  }
  $("peopleModal").classList.remove("hidden");
}

/* ---------- фото, видео и файлы ---------- */
async function showMedia(button, record) {
  button.disabled = true;
  button.textContent = "Загружаю…";
  try {
    const blob = await getBlob(record);
    if (!blob) throw new Error("Telegram больше не отдаёт этот файл");
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    const wrap = button.closest(".media-actions");
    const container = document.createElement("div");
    container.className = "media-preview";
    if (blob.type.startsWith("video/")) {
      const video = document.createElement("video");
      video.src = url;
      video.controls = true;
      video.playsInline = true;
      container.append(video);
    } else if (blob.type.startsWith("image/")) {
      const image = document.createElement("img");
      image.src = url;
      image.alt = "Фото из Telegram";
      container.append(image);
    } else {
      const link = document.createElement("a");
      link.href = url;
      link.download = `telegram_${record.id}`;
      link.textContent = "Открыть файл";
      container.append(link);
    }
    wrap?.before(container);
    button.textContent = "Скрыть";
    button.disabled = false;
    button.dataset.act = "hideMedia";
  } catch (error) {
    button.textContent = "Недоступно";
    button.disabled = false;
    toast(error.message || "Не удалось загрузить файл", 6500);
  }
}
async function saveMedia(record) {
  try {
    const blob = await getBlob(record);
    if (!blob) throw new Error("Файл недоступен");
    const extension = blob.type.includes("video") ? "mp4" : blob.type.includes("png") ? "png" : "jpg";
    const file = new File([blob], `telegram_${record.id}.${extension}`, { type: blob.type });
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
    else {
      const url = URL.createObjectURL(blob);
      objectUrls.add(url);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.name;
      link.click();
    }
  } catch (error) {
    if (error.name !== "AbortError") toast(`Не удалось сохранить файл: ${error.message || error}`, 6500);
  }
}
async function sendAttachment(file) {
  if (!file || !current) return;
  const caption = $("text").value.trim();
  const options = { file, caption, replyTo: replyTarget?.id };
  toast("Отправляю файл…", 2500);
  try {
    const sent = await client.sendFile(current.entity, options);
    $("text").value = "";
    clearReply();
    if (Array.isArray(sent)) {
      for (const message of sent) await handleMessage(message);
    } else await handleMessage(sent);
    renderChat(true);
  } catch (error) {
    toast(`Не удалось отправить файл: ${error.message || error}`, 8000);
  } finally {
    $("fileInput").value = "";
  }
}

/* ---------- обработчики интерфейса ---------- */
$("list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-index]");
  if (!button) return;
  const dialog = dialogs[Number(button.dataset.index)];
  if (dialog) openChat(dialog);
});
$("search").addEventListener("input", renderDialogs);
$("msgs").addEventListener("scroll", () => {
  if ($("msgs").scrollTop < 55 && !loadingOlder && !loadingAll && !historyEnd) loadOlder();
});
$("loadOlder").addEventListener("click", loadOlder);
$("loadAll").addEventListener("click", loadAllHistory);
$("calendarBtn").addEventListener("click", () => {
  const input = $("dateInput");
  if (typeof input.showPicker === "function") input.showPicker();
  else input.click();
});
$("dateInput").addEventListener("change", (event) => jumpToDate(event.target.value));
$("backBtn").addEventListener("click", () => {
  current = null;
  replyTarget = null;
  $("main").classList.remove("chat-open");
  $("conversation").classList.remove("conversation-active");
  $("chatBlank").classList.remove("hidden");
  $("chatHeader").classList.add("hidden");
  $("msgs").classList.add("hidden");
  $("composer").classList.add("hidden");
  $("historyTools").classList.add("hidden");
  renderDialogs();
});
$("send").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = $("text").value.trim();
  if (!text || !current) return;
  $("text").value = "";
  try {
    const message = await client.sendMessage(current.entity, { message: text, replyTo: replyTarget?.id });
    clearReply();
    await handleMessage(message);
    renderChat(true);
  } catch (error) {
    $("text").value = text;
    toast(`Сообщение не отправлено: ${error.message || error}`, 7000);
  }
});
$("attachBtn").addEventListener("click", () => $("fileInput").click());
$("fileInput").addEventListener("change", (event) => sendAttachment(event.target.files?.[0]));
$("cancelReply").addEventListener("click", clearReply);
$("ghostBtn").addEventListener("click", () => setGhost(!ghost));
$("menuBtn").addEventListener("click", async () => {
  const value = await ask("Введите «обновить» для перезагрузки чатов или «выход» для выхода");
  if (value.toLowerCase() === "обновить") {
    if (current) $("backBtn").click();
    await loadDialogs();
  }
  if (value.toLowerCase() === "выход") {
    localStorage.removeItem("sess");
    localStorage.removeItem("apiId");
    localStorage.removeItem("apiHash");
    location.reload();
  }
});
$("msgs").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-act]");
  if (!button) return;
  const record = store.get(button.dataset.k);
  if (!record) return;
  const action = button.dataset.act;
  if (action === "reply") setReply(record);
  else if (action === "jumpReply") await jumpToReply(record);
  else if (action === "editHistory") {
    const bubble = button.closest(".bubble");
    const old = bubble.querySelector(".edit-history");
    if (old) { old.remove(); return; }
    const panel = document.createElement("div");
    panel.className = "edit-history";
    panel.textContent = (record.edits || []).slice().reverse().map((text, index) => `${index + 1}. ${text || "(пустое сообщение)"}`).join("\n");
    button.after(panel);
  } else if (action === "showMedia") await showMedia(button, record);
  else if (action === "hideMedia") {
    button.closest(".bubble")?.querySelector(".media-preview")?.remove();
    button.dataset.act = "showMedia";
    button.textContent = record.kind === "photo" ? "▧ Фото" : record.kind === "video" ? "▶ Видео" : "↧ Файл";
  } else if (action === "saveMedia") await saveMedia(record);
  else if (action === "toggleReactions") {
    const menu = button.closest(".bubble")?.querySelector(".quick-reactions");
    menu?.classList.toggle("hidden");
  } else if (action === "sendReaction") await sendReaction(record, button.dataset.emoji);
  else if (action === "reactionPeople") await showReactionPeople(record, button.dataset.emoji);
});
$("closePeople").addEventListener("click", () => $("peopleModal").classList.add("hidden"));
$("peopleModal").addEventListener("click", (event) => {
  if (event.target === $("peopleModal")) $("peopleModal").classList.add("hidden");
});
$("loginBtn").addEventListener("click", async () => {
  const id = $("apiId").value.trim();
  const hash = $("apiHash").value.trim();
  if (!id || !hash) { toast("Введите api_id и api_hash"); return; }
  localStorage.setItem("apiId", id);
  localStorage.setItem("apiHash", hash);
  $("loginBtn").disabled = true;
  $("loginBtn").textContent = "Подключаюсь…";
  try { await start(id, hash); }
  catch (error) {
    showScreen("login");
    $("err").textContent = `${error.name || "Ошибка"}: ${error.message || error}\n${error.stack || ""}`;
    toast("Не удалось войти в Telegram", 5000);
  } finally {
    $("loginBtn").disabled = false;
    $("loginBtn").textContent = "Войти";
  }
});

/* ---------- запуск ---------- */
const savedId = localStorage.getItem("apiId");
const savedHash = localStorage.getItem("apiHash");
if (savedId && savedHash) {
  showScreen("main");
  start(savedId, savedHash).catch((error) => {
    showScreen("login");
    $("err").textContent = `${error.name || "Ошибка"}: ${error.message || error}\n${error.stack || ""}`;
    toast("Ошибка подключения к Telegram", 5000);
  });
} else showScreen("login");
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
