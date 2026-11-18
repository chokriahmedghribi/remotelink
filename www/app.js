/* RemoteLink — مشاركة شاشة، تحكم عن بعد، ونقل ملفات P2P عبر WebRTC */
'use strict';

/* ---------- إعدادات (يمكن تعديلها في config.js) ---------- */
const CFG = Object.assign({
  // اتركه فارغاً لاستخدام خادم PeerJS السحابي المجاني، أو ضع خادمك (انظر server/)
  peerServer: null,            // مثال: { host:'my.server.com', port:443, path:'/rl', secure:true }
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // لاتصال موثوق خلف الشبكات المقيدة أضف خادم TURN:
    // { urls:'turn:turn.example.com:3478', username:'user', credential:'pass' }
  ],
  agentUrl: 'ws://127.0.0.1:8765',
  chunkSize: 64 * 1024,
}, window.RL_CONFIG || {});

const PFX = 'rlk-';
const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem('rl.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('rl.' + k, JSON.stringify(v)); } catch {} },
};
const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());

/* ---------- الحالة ---------- */
let peer = null, conn = null, mediaCall = null, localStream = null;
let remotePerms = {}, remoteInfo = {}, controlOn = false, agent = null;
const outgoing = new Map();   // id -> {file, el, cancelled, ackResolve}
const incoming = new Map();   // id -> {meta, parts, received, el, t0}

/* ---------- أدوات واجهة ---------- */
function toast(msg, ms = 3500) {
  const d = document.createElement('div'); d.className = 'toast'; d.textContent = msg;
  $('#toasts').appendChild(d); setTimeout(() => d.remove(), ms);
}
const fmtId = id => String(id).replace(/(\d{3})(?=\d)/g, '$1 ');
const cleanId = s => String(s).replace(/\D/g, '');
function fmtSize(b) { const u = ['B','KB','MB','GB','TB']; let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; } return b.toFixed(i ? 1 : 0) + ' ' + u[i]; }
function fmtTime(s) { if (!isFinite(s)) return '—'; s = Math.round(s); return s < 60 ? s + ' ث' : Math.floor(s / 60) + ' د ' + (s % 60) + ' ث'; }
function setNet(state, text) {
  const el = $('#netStatus'); el.querySelector('.dot').className = 'dot ' + (state || '');
  el.querySelector('span:last-child').textContent = text;
}
function show(view) { $('#home').classList.toggle('hidden', view !== 'home'); $('#session').classList.toggle('hidden', view !== 'session'); }

/* ---------- الهوية والإعدادات المحلية ---------- */
function genId() { let s = String(1 + Math.floor(Math.random() * 9)); while (s.length < 9) s += Math.floor(Math.random() * 10); return s; }
let myId = store.get('id') || genId(); store.set('id', myId);
$('#deviceName').value = store.get('name', (isNative ? 'Android' : navigator.platform || 'جهاز') + '-' + myId.slice(-3));
$('#deviceName').onchange = e => store.set('name', e.target.value.trim());
$('#unattended').checked = store.get('unattended', false);
$('#unattendedPass').value = store.get('upass', '');
$('#unattendedPass').classList.toggle('hidden', !$('#unattended').checked);
$('#unattended').onchange = e => { store.set('unattended', e.target.checked); $('#unattendedPass').classList.toggle('hidden', !e.target.checked); };
$('#unattendedPass').onchange = e => store.set('upass', e.target.value);
['permControl', 'permFiles', 'permClipboard', 'autoSave'].forEach(k => {
  const el = $('#' + k); el.checked = store.get(k, true);
  el.onchange = () => { store.set(k, el.checked); if (conn) send({ t: 'perms', perms: myPerms() }); };
});
const myPerms = () => ({ control: $('#permControl').checked, files: $('#permFiles').checked, clipboard: $('#permClipboard').checked });

$('#copyIdBtn').onclick = async () => { try { await navigator.clipboard.writeText(myId); toast('تم نسخ الرقم'); } catch { toast(myId); } };
$('#newIdBtn').onclick = () => { if (conn) return toast('أنهِ الجلسة أولاً'); myId = genId(); store.set('id', myId); startPeer(); };

/* ---------- الاتصال بخادم الإشارة ---------- */
function startPeer() {
  if (peer) { try { peer.destroy(); } catch {} }
  $('#myId').textContent = fmtId(myId);
  setNet('', 'جارٍ الاتصال بالخادم…');
  const opts = Object.assign({ config: { iceServers: CFG.iceServers }, debug: 1 }, CFG.peerServer || {});
  peer = new Peer(PFX + myId, opts);
  peer.on('open', () => setNet('on', 'جاهز للاتصال'));
  peer.on('disconnected', () => { setNet('off', 'انقطع الاتصال بالخادم، إعادة المحاولة…'); setTimeout(() => peer && !peer.destroyed && peer.reconnect(), 2000); });
  peer.on('error', err => {
    if (err.type === 'unavailable-id') { myId = genId(); store.set('id', myId); return startPeer(); }
    if (err.type === 'peer-unavailable') return toast('الجهاز البعيد غير متصل أو الرقم خاطئ');
    if (err.type === 'network' || err.type === 'server-error') setNet('off', 'تعذّر الوصول للخادم');
    console.warn(err); toast('خطأ: ' + err.type);
  });
  peer.on('connection', onIncomingConnection);
  peer.on('call', call => {
    if (!conn || call.peer !== conn.peer) return call.close();
    call.answer();
    call.on('stream', s => { $('#remoteVideo').srcObject = s; $('#screenEmpty').classList.add('hidden'); });
    call.on('close', clearRemoteVideo);
  });
}

/* ---------- الاتصال الصادر ---------- */
$('#connectForm').onsubmit = e => {
  e.preventDefault();
  const rid = cleanId($('#remoteId').value);
  if (rid.length < 6) return toast('أدخل رقماً صحيحاً');
  if (rid === myId) return toast('لا يمكنك الاتصال بنفسك');
  connectTo(rid, $('#remotePass').value);
};
function connectTo(rid, pass = '') {
  if (conn) return toast('توجد جلسة مفتوحة');
  toast('جارٍ الاتصال بـ ' + fmtId(rid) + ' … بانتظار القبول');
  const c = peer.connect(PFX + rid, { reliable: true, serialization: 'binary', metadata: { name: store.get('name'), id: myId, pass } });
  const timer = setTimeout(() => { if (!c.__accepted) { toast('لم يتم الرد على الطلب'); c.close(); } }, 60000);
  c.on('data', function first(msg) {
    if (msg.t === 'accept') {
      c.__accepted = true; clearTimeout(timer); c.off('data', first);
      remotePerms = msg.perms || {}; remoteInfo = { name: msg.name, id: rid };
      beginSession(c);
    } else if (msg.t === 'reject') {
      clearTimeout(timer); toast(msg.reason === 'busy' ? 'الجهاز مشغول بجلسة أخرى' : 'تم رفض الاتصال'); c.close();
    }
  });
}

/* ---------- الاتصال الوارد ---------- */
function onIncomingConnection(c) {
  c.on('open', () => {
    if (conn) { c.send({ t: 'reject', reason: 'busy' }); return setTimeout(() => c.close(), 300); }
    const meta = c.metadata || {};
    const accept = (share) => {
      c.send({ t: 'accept', name: store.get('name'), perms: myPerms() });
      remoteInfo = { name: meta.name, id: meta.id || c.peer.replace(PFX, '') };
      remotePerms = {}; beginSession(c);
      if (share) startShare();
    };
    const up = store.get('upass', '');
    if ($('#unattended').checked && up && meta.pass === up) { toast('اتصال دون حضور من ' + (meta.name || '')); return accept(true); }

    $('#inName').textContent = meta.name || 'جهاز مجهول';
    $('#inId').textContent = '(' + fmtId(meta.id || '') + ')';
    $('#inPermControl').checked = $('#permControl').checked;
    $('#inPermFiles').checked = $('#permFiles').checked;
    $('#incomingModal').classList.remove('hidden');
    notify('طلب اتصال من ' + (meta.name || meta.id));
    $('#acceptBtn').onclick = () => {
      $('#permControl').checked = $('#inPermControl').checked; $('#permFiles').checked = $('#inPermFiles').checked;
      $('#incomingModal').classList.add('hidden'); accept($('#inShare').checked);
    };
    $('#rejectBtn').onclick = () => { $('#incomingModal').classList.add('hidden'); c.send({ t: 'reject' }); setTimeout(() => c.close(), 300); };
    c.on('close', () => $('#incomingModal').classList.add('hidden'));
  });
}
function notify(text) {
  try { if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('RemoteLink', { body: text }); } catch {}
}

/* ---------- الجلسة ---------- */
function beginSession(c) {
  conn = c;
  try { conn.dataChannel.bufferedAmountLowThreshold = 1 << 20; } catch {}
  conn.on('data', onData);
  conn.on('close', () => endSession(true));
  conn.on('error', e => console.warn('conn', e));
  $('#peerName').textContent = remoteInfo.name || 'جهاز بعيد';
  $('#peerIdLbl').textContent = fmtId(remoteInfo.id || '');
  addRecent(remoteInfo.id, remoteInfo.name);
  setControl(false); chatSys('بدأت الجلسة');
  show('session');
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
}
function send(msg) { if (conn && conn.open) conn.send(msg); }

function endSession(remote = false) {
  if (!conn) return;
  if (!remote) { send({ t: 'bye' }); }
  const c = conn; conn = null;
  setTimeout(() => { try { c.close(); } catch {} }, 200);
  stopShare(false); clearRemoteVideo();
  if (mediaCall) { try { mediaCall.close(); } catch {} mediaCall = null; }
  outgoing.forEach(o => o.cancelled = true); outgoing.clear(); incoming.clear();
  $('#transferList').innerHTML = ''; $('#chatList').innerHTML = '';
  toast(remote ? 'أنهى الطرف الآخر الجلسة' : 'تم إنهاء الجلسة');
  show('home');
}
$('#hangupBtn').onclick = () => endSession(false);

function onData(msg) {
  switch (msg.t) {
    case 'bye': return endSession(true);
    case 'perms': remotePerms = msg.perms || {}; if (!remotePerms.control && controlOn) setControl(false); return;
    case 'chat': return chatAdd(msg.text, 'them');
    case 'share-stop': return clearRemoteVideo();
    case 'clip': return onClip(msg.text);
    case 'input': return onRemoteInput(msg);
    case 'file-meta': return onFileMeta(msg);
    case 'file-ack': { const o = outgoing.get(msg.id); o && o.ackResolve(msg.ok); return; }
    case 'file-chunk': return onFileChunk(msg);
    case 'file-end': return onFileEnd(msg);
    case 'file-cancel': return onFileCancel(msg.id);
  }
}

/* ---------- مشاركة الشاشة ---------- */
const QUALITY = {
  high: { width: 1920, height: 1080, frameRate: 30 },
  balanced: { width: 1280, height: 720, frameRate: 24 },
  low: { width: 854, height: 480, frameRate: 15 },
  auto: {},
};
$('#qualitySel').value = store.get('quality', 'balanced');
$('#qualitySel').onchange = async e => {
  store.set('quality', e.target.value);
  if (localStream) {
    const q = QUALITY[e.target.value]; const tr = localStream.getVideoTracks()[0];
    try { await tr.applyConstraints(q.width ? { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate } } : {}); toast('تم تغيير الجودة'); } catch {}
  }
};
$('#shareScreenBtn').onclick = () => localStream ? stopShare() : startShare();
$('#stopShareBtn').onclick = () => stopShare();

async function startShare() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    return toast(isNative ? 'مشاركة شاشة الهاتف تتطلب الإضافة الأصلية (انظر README). يمكنك عرض والتحكم بشاشة الكمبيوتر ونقل الملفات.' : 'هذا المتصفح لا يدعم مشاركة الشاشة', 6000);
  }
  const q = QUALITY[$('#qualitySel').value] || {};
  try {
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: q.width ? { width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.frameRate }, cursor: 'always' } : { cursor: 'always' },
      audio: true,
    });
  } catch { return toast('تم إلغاء مشاركة الشاشة'); }
  const vt = localStream.getVideoTracks()[0];
  try { vt.contentHint = 'detail'; } catch {}
  vt.onended = () => stopShare();
  mediaCall = peer.call(conn.peer, localStream);
  $('#sharingBadge').classList.remove('hidden');
  $('#shareScreenBtn').classList.add('active');
  $('#shareScreenBtn span').textContent = 'إيقاف المشاركة';
  chatSys('بدأت مشاركة شاشتك');
  connectAgent();
}
function stopShare(notifyPeer = true) {
  if (!localStream) return;
  localStream.getTracks().forEach(t => t.stop()); localStream = null;
  if (mediaCall) { try { mediaCall.close(); } catch {} mediaCall = null; }
  if (notifyPeer) send({ t: 'share-stop' });
  $('#sharingBadge').classList.add('hidden');
  $('#shareScreenBtn').classList.remove('active');
  $('#shareScreenBtn span').textContent = 'مشاركة شاشتي';
}
function clearRemoteVideo() { $('#remoteVideo').srcObject = null; $('#screenEmpty').classList.remove('hidden'); if (controlOn) setControl(false); }

$('#fullBtn').onclick = () => {
  const el = $('#screenWrap');
  if (document.fullscreenElement) document.exitFullscreen(); else (el.requestFullscreen || el.webkitRequestFullscreen).call(el);
};

/* ---------- التحكم عن بعد (الطرف المُشاهِد) ---------- */
$('#controlBtn').onclick = () => {
  if (!controlOn && !remotePerms.control) return toast('الطرف الآخر لم يسمح بالتحكم');
  if (!controlOn && !$('#remoteVideo').srcObject) return toast('لا توجد شاشة بعيدة للتحكم بها');
  setControl(!controlOn);
};
function setControl(on) {
  controlOn = on;
  $('#controlBtn').classList.toggle('active', on);
  $('#controlBtn span').textContent = 'التحكم: ' + (on ? 'تشغيل' : 'إيقاف');
  $('#screenWrap').classList.toggle('control', on);
  if (on) $('#remoteVideo').tabIndex = 0, $('#remoteVideo').focus();
}
// تحويل إحداثيات المؤشر إلى نسبة داخل الفيديو الفعلي (مع مراعاة الحواف السوداء)
function normPos(e) {
  const v = $('#remoteVideo'), r = v.getBoundingClientRect();
  const vw = v.videoWidth || r.width, vh = v.videoHeight || r.height;
  const scale = Math.min(r.width / vw, r.height / vh);
  const w = vw * scale, h = vh * scale, ox = r.left + (r.width - w) / 2, oy = r.top + (r.height - h) / 2;
  const x = (e.clientX - ox) / w, y = (e.clientY - oy) / h;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return { x: +x.toFixed(4), y: +y.toFixed(4) };
}
let pendingMove = null, moveScheduled = false;
const video = $('#remoteVideo');
video.addEventListener('pointermove', e => {
  if (!controlOn) return; const p = normPos(e); if (!p) return;
  pendingMove = p;
  if (!moveScheduled) { moveScheduled = true; requestAnimationFrame(() => { moveScheduled = false; pendingMove && send({ t: 'input', k: 'move', ...pendingMove }); }); }
});
let longPress = null;
video.addEventListener('pointerdown', e => {
  if (!controlOn) return; e.preventDefault(); video.focus();
  const p = normPos(e); if (!p) return;
  let btn = ['left', 'middle', 'right'][e.button] || 'left';
  if (e.pointerType === 'touch') { // ضغط مطوّل = زر أيمن
    longPress = setTimeout(() => { send({ t: 'input', k: 'click', button: 'right', ...p }); longPress = 'fired'; }, 600);
    send({ t: 'input', k: 'move', ...p }); return;
  }
  send({ t: 'input', k: 'down', button: btn, ...p });
});
video.addEventListener('pointerup', e => {
  if (!controlOn) return; const p = normPos(e) || pendingMove || {};
  if (e.pointerType === 'touch') { if (longPress !== 'fired') { clearTimeout(longPress); send({ t: 'input', k: 'click', button: 'left', ...p }); } longPress = null; return; }
  send({ t: 'input', k: 'up', button: ['left', 'middle', 'right'][e.button] || 'left', ...p });
});
video.addEventListener('dblclick', e => controlOn && e.preventDefault());
video.addEventListener('contextmenu', e => controlOn && e.preventDefault());
video.addEventListener('wheel', e => { if (!controlOn) return; e.preventDefault(); send({ t: 'input', k: 'wheel', dx: Math.sign(e.deltaX), dy: Math.sign(e.deltaY) }); }, { passive: false });
const keyHandler = type => e => {
  if (!controlOn || document.activeElement !== video) return;
  e.preventDefault();
  send({ t: 'input', k: type, key: e.key, code: e.code, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey });
};
window.addEventListener('keydown', keyHandler('keydown'));
window.addEventListener('keyup', keyHandler('keyup'));

/* ---------- تنفيذ أوامر التحكم (الطرف المُشارِك) عبر العميل المحلي ---------- */
function connectAgent() {
  if (isNative) return;
  if (agent && (agent.readyState === 0 || agent.readyState === 1)) return;
  try { agent = new WebSocket(CFG.agentUrl); } catch { return setAgent(false); }
  agent.onopen = () => setAgent(true);
  agent.onclose = () => setAgent(false);
  agent.onerror = () => setAgent(false);
}
function setAgent(ok) { $('#agentStatus').textContent = ok ? 'متصل ✓ (التحكم الكامل مفعّل)' : 'غير متصل'; $('#agentStatus').style.color = ok ? 'var(--ok)' : ''; }
$('#agentRetry').onclick = connectAgent;
let agentWarned = false;
function onRemoteInput(msg) {
  if (!$('#permControl').checked || !localStream) return;
  if (agent && agent.readyState === 1) {
    const vt = localStream.getVideoTracks()[0]; const s = vt.getSettings ? vt.getSettings() : {};
    agent.send(JSON.stringify({ ...msg, surface: s.displaySurface || 'monitor' }));
  } else if (!agentWarned) {
    agentWarned = true; toast('الطرف الآخر يحاول التحكم — شغّل agent.py لتفعيل التحكم', 6000);
  }
}

/* ---------- الحافظة ---------- */
$('#clipBtn').onclick = async () => {
  if (!remotePerms.clipboard) return toast('الطرف الآخر لم يسمح بمزامنة الحافظة');
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch {}
  if (!text) { text = window.getSelection().toString(); }
  if (!text) return toast('الحافظة فارغة أو لا يمكن قراءتها');
  send({ t: 'clip', text }); toast('تم إرسال الحافظة');
};
async function onClip(text) {
  if (!$('#permClipboard').checked) return;
  try { await navigator.clipboard.writeText(text); toast('تم استلام نص إلى الحافظة'); }
  catch { chatAdd('📋 ' + text, 'them'); toast('تم وضع نص الحافظة في الدردشة'); }
}

/* ---------- الدردشة ---------- */
$('#chatForm').onsubmit = e => {
  e.preventDefault(); const t = $('#chatInput').value.trim(); if (!t) return;
  send({ t: 'chat', text: t }); chatAdd(t, 'me'); $('#chatInput').value = '';
};
let unread = 0;
function chatAdd(text, who) {
  const li = document.createElement('li'); li.className = who; li.textContent = text;
  $('#chatList').appendChild(li); li.scrollIntoView({ block: 'end' });
  if (who === 'them' && $('#tab-chat').classList.contains('hidden')) { unread++; $('#chatBadge').textContent = unread; $('#chatBadge').classList.remove('hidden'); notify(text); }
}
const chatSys = t => chatAdd(t, 'sys');
document.querySelectorAll('.tab').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === b));
  ['files', 'chat', 'perm'].forEach(n => $('#tab-' + n).classList.toggle('hidden', n !== b.dataset.tab));
  if (b.dataset.tab === 'chat') { unread = 0; $('#chatBadge').classList.add('hidden'); }
});

/* ---------- نقل الملفات ---------- */
const uid = () => Math.random().toString(36).slice(2, 10);
function transferEl(name, size, dir) {
  const li = document.createElement('li');
  li.innerHTML = `<div class="tr-top"><span class="tr-name"></span><button class="btn tiny">إلغاء</button></div>
    <div class="bar"><i></i></div><div class="tr-meta"><span class="st"></span><span class="sp"></span></div>`;
  li.querySelector('.tr-name').textContent = (dir === 'out' ? '⬆ ' : '⬇ ') + name;
  li.querySelector('.st').textContent = '0 / ' + fmtSize(size);
  $('#transferList').prepend(li); return li;
}
function updateEl(el, done, total, t0) {
  const pct = total ? done / total * 100 : 100; const secs = (performance.now() - t0) / 1000; const speed = done / Math.max(secs, 0.001);
  el.querySelector('.bar i').style.width = pct.toFixed(1) + '%';
  el.querySelector('.st').textContent = fmtSize(done) + ' / ' + fmtSize(total) + ' (' + pct.toFixed(0) + '%)';
  el.querySelector('.sp').textContent = fmtSize(speed) + '/ث · متبقٍ ' + fmtTime((total - done) / speed);
}
function finishEl(el, text, ok = true) {
  el.classList.toggle('tr-done', ok); el.querySelector('.bar i').style.width = ok ? '100%' : el.querySelector('.bar i').style.width;
  el.querySelector('.sp').textContent = text; const b = el.querySelector('button'); b.remove();
}

// قائمة انتظار: ملف واحد في كل مرة لأقصى سرعة
const queue = []; let sending = false;
function enqueue(files) {
  if (!conn) return toast('لا توجد جلسة');
  if (!remotePerms.files) return toast('الطرف الآخر لم يسمح باستقبال الملفات');
  for (const f of files) {
    const id = uid(); const path = f._path || f.webkitRelativePath || f.name;
    const el = transferEl(path, f.size, 'out'); el.querySelector('.sp').textContent = 'في الانتظار';
    const o = { id, file: f, path, el, cancelled: false };
    el.querySelector('button').onclick = () => { o.cancelled = true; send({ t: 'file-cancel', id }); finishEl(el, 'أُلغي', false); };
    outgoing.set(id, o); queue.push(o);
  }
  pump();
}
async function pump() {
  if (sending) return; sending = true;
  while (queue.length) { const o = queue.shift(); if (!o.cancelled) { try { await sendFile(o); } catch (e) { console.warn(e); finishEl(o.el, 'فشل', false); } } }
  sending = false;
}
function waitDrain() {
  const dc = conn && conn.dataChannel; if (!dc || dc.bufferedAmount < 8 * (1 << 20)) return Promise.resolve();
  return new Promise(r => { const h = () => { dc.removeEventListener('bufferedamountlow', h); r(); }; dc.addEventListener('bufferedamountlow', h); setTimeout(h, 2000); });
}
async function sendFile(o) {
  const { id, file, path, el } = o;
  const ack = new Promise(r => { o.ackResolve = r; setTimeout(() => r(false), 30000); });
  send({ t: 'file-meta', id, name: file.name, path, size: file.size, type: file.type });
  el.querySelector('.sp').textContent = 'بانتظار الموافقة';
  if (!await ack) { finishEl(el, 'رُفض الاستلام', false); return; }
  const t0 = performance.now(); let off = 0, last = 0;
  while (off < file.size) {
    if (o.cancelled || !conn) return;
    await waitDrain();
    const buf = await file.slice(off, off + CFG.chunkSize).arrayBuffer();
    send({ t: 'file-chunk', id, data: buf }); off += buf.byteLength;
    if (performance.now() - last > 200) { last = performance.now(); updateEl(el, off, file.size, t0); }
  }
  send({ t: 'file-end', id }); updateEl(el, file.size, file.size, t0);
  finishEl(el, 'تم الإرسال ✓ في ' + fmtTime((performance.now() - t0) / 1000)); outgoing.delete(id);
}

function onFileMeta(m) {
  if (!$('#permFiles').checked) return send({ t: 'file-ack', id: m.id, ok: false });
  const el = transferEl(m.path || m.name, m.size, 'in');
  el.querySelector('button').onclick = () => { send({ t: 'file-cancel', id: m.id }); onFileCancel(m.id); };
  incoming.set(m.id, { meta: m, parts: [], received: 0, el, t0: performance.now(), last: 0 });
  send({ t: 'file-ack', id: m.id, ok: true });
  if ($('#tab-files').classList.contains('hidden')) toast('جارٍ استلام: ' + m.name);
}
function onFileChunk(m) {
  const r = incoming.get(m.id); if (!r) return;
  const data = m.data instanceof ArrayBuffer ? m.data : (m.data.buffer || m.data);
  r.parts.push(data); r.received += data.byteLength;
  if (performance.now() - r.last > 200) { r.last = performance.now(); updateEl(r.el, r.received, r.meta.size, r.t0); }
}
async function onFileEnd(m) {
  const r = incoming.get(m.id); if (!r) return; incoming.delete(m.id);
  const blob = new Blob(r.parts, { type: r.meta.type || 'application/octet-stream' }); r.parts = null;
  updateEl(r.el, blob.size, r.meta.size, r.t0);
  finishEl(r.el, 'تم الاستلام ✓');
  const name = r.meta.path || r.meta.name;
  const a = document.createElement('a'); a.className = 'btn tiny'; a.textContent = 'حفظ';
  a.onclick = e => { e.preventDefault(); saveFile(blob, name); };
  r.el.querySelector('.tr-top').appendChild(a);
  if ($('#autoSave').checked) saveFile(blob, name);
  chatSys('📥 استلمت: ' + name + ' (' + fmtSize(blob.size) + ')');
}
function onFileCancel(id) {
  const r = incoming.get(id); if (r) { incoming.delete(id); finishEl(r.el, 'أُلغي', false); }
  const o = outgoing.get(id); if (o && !o.cancelled) { o.cancelled = true; finishEl(o.el, 'ألغاه الطرف الآخر', false); }
}
async function saveFile(blob, name) {
  if (isNative && window.Capacitor.Plugins.Filesystem) {
    // على أندرويد: الحفظ في Documents/RemoteLink مع الحفاظ على بنية المجلدات
    const b64 = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
    try {
      await window.Capacitor.Plugins.Filesystem.writeFile({ path: 'RemoteLink/' + name, data: b64, directory: 'DOCUMENTS', recursive: true });
      toast('حُفظ في Documents/RemoteLink/' + name);
    } catch (e) { toast('تعذّر الحفظ: ' + e.message); }
    return;
  }
  const url = URL.createObjectURL(blob); const a = document.createElement('a');
  a.href = url; a.download = name.replace(/[\\/]/g, '_'); document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// السحب والإفلات (يدعم المجلدات)
async function entriesToFiles(items) {
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) { await new Promise(r => entry.file(f => { f._path = prefix + f.name; out.push(f); r(); }, r)); }
    else if (entry.isDirectory) {
      const reader = entry.createReader(); let batch;
      do { batch = await new Promise(r => reader.readEntries(r, () => r([]))); for (const e of batch) await walk(e, prefix + entry.name + '/'); } while (batch.length);
    }
  };
  for (const it of items) { const e = it.webkitGetAsEntry && it.webkitGetAsEntry(); if (e) await walk(e, ''); else { const f = it.getAsFile(); f && out.push(f); } }
  return out;
}
let dragDepth = 0;
window.addEventListener('dragenter', e => { if (conn) { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', e => conn && e.preventDefault());
window.addEventListener('drop', async e => {
  if (!conn) return; e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const files = e.dataTransfer.items ? await entriesToFiles([...e.dataTransfer.items].filter(i => i.kind === 'file')) : [...e.dataTransfer.files];
  if (files.length) enqueue(files);
});
$('#fileInput').onchange = e => { enqueue([...e.target.files]); e.target.value = ''; };
$('#folderInput').onchange = e => { enqueue([...e.target.files]); e.target.value = ''; };
// لصق ملف/صورة مباشرة (Ctrl+V) لإرسالها
window.addEventListener('paste', e => {
  if (!conn || controlOn) return; const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); enqueue(files); }
});

/* ---------- الاتصالات السابقة ---------- */
function addRecent(id, name) {
  if (!id) return; let list = store.get('recent', []).filter(r => r.id !== id);
  list.unshift({ id, name, ts: Date.now() }); store.set('recent', list.slice(0, 12)); renderRecent();
}
function renderRecent() {
  const ul = $('#recentList'); ul.innerHTML = '';
  const list = store.get('recent', []);
  if (!list.length) { ul.innerHTML = '<li class="muted" style="cursor:default">لا توجد اتصالات بعد</li>'; return; }
  for (const r of list) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="nm"></span><span class="rid"></span>';
    li.querySelector('.nm').textContent = r.name || 'جهاز'; li.querySelector('.rid').textContent = fmtId(r.id);
    li.onclick = () => { $('#remoteId').value = fmtId(r.id); $('#remotePass').focus(); };
    ul.appendChild(li);
  }
}
$('#remoteId').addEventListener('input', e => { const d = cleanId(e.target.value).slice(0, 12); e.target.value = fmtId(d); });

window.addEventListener('beforeunload', () => conn && send({ t: 'bye' }));
if ('serviceWorker' in navigator && location.protocol === 'https:' && !isNative) navigator.serviceWorker.register('sw.js').catch(() => {});

renderRecent();
startPeer();
