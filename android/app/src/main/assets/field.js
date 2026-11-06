const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const OFFICER_KEY = 'dispatch-field-officer';
const QUEUE_KEY = 'dispatch-field-queue';
let fieldState = null;
let currentUser = null;
let serverUnavailable = false;
let selectedOfficerId = localStorage.getItem(OFFICER_KEY) || '';
let stateTimer = null;
let stateBusy = false;
let stateFailures = 0;
let stateRetryAt = 0;
let rtcTimer = null;
let rtcPeerId = '';
let rtcBusy = false;
let lastRegisterAt = 0;
let gpsPermissionWarned = false;
let activeCall = null;
let pendingOffer = null;
let pendingIce = new Map();
let toastTimer = null;

function toast(message, error = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('error', error);
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), 3200);
}

async function api(path, method = 'GET', payload = null) {
  const result = await window.DispatchAPI.request(path, method, payload == null ? '' : JSON.stringify(payload));
  let data = {};
  try { data = result.body ? JSON.parse(result.body) : {}; } catch { data = {}; }
  if (result.status === 304) return null;
  if (result.status < 200 || result.status >= 300 || data.ok === false) {
    const error = new Error(data.error || `Request failed (${result.status})`);
    error.status = result.status;
    if (result.status >= 500) { serverUnavailable = true; setNetworkBadge(); }
    throw error;
  }
  serverUnavailable = false;
  setNetworkBadge();
  return data;
}

function showPanel(panel) {
  $('#loginPanel').classList.toggle('hidden', panel !== 'login');
  $('#fieldPanel').classList.toggle('hidden', panel !== 'field');
}

function setNetworkBadge() {
  const node = $('#networkBadge');
  const online = Boolean(navigator.onLine);
  node.textContent = !online ? 'NO NETWORK' : serverUnavailable ? 'RECONNECTING' : fieldState?.officer?.online ? 'ONLINE' : 'OFF DUTY / OFFLINE';
  node.className = `network-badge ${online && !serverUnavailable && fieldState?.officer?.online ? 'online' : online ? '' : 'offline'}`;
}

function selectedUnitOption(unit) {
  return `${unit.callSign || 'Unit'}${unit.name ? ` · ${unit.name}` : ''}`;
}

function renderMessages() {
  const messages = fieldState?.messages || [];
  $('#messageCount').textContent = String(messages.filter(message => !message.readAt).length);
  $('#messageList').innerHTML = messages.length ? messages.map(message => `
    <article class="message-item">
      <div class="message-meta"><span>${escapeHtml(message.from || 'Control')}</span><span>${escapeHtml(formatTime(message.createdAt))}</span></div>
      <div class="message-body">${escapeHtml(message.body)}</div>
      <div class="message-state">${message.readAt ? 'Read' : message.deliveredAt ? 'Received' : 'Queued'}${!message.readAt ? ` · <button class="text-button mark-read" type="button" data-id="${escapeHtml(message.id)}">Mark read</button>` : ''}</div>
    </article>`).join('') : '<p class="muted small">No messages yet.</p>';
}

function formatTime(value) {
  if (!value) return '—';
  try { return new Intl.DateTimeFormat('en-ZA', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }).format(new Date(value)); }
  catch { return '—'; }
}

function render() {
  if (!fieldState?.officer) return;
  const officer = fieldState.officer;
  const online = Boolean(officer.online && navigator.onLine);
  $('#unitName').textContent = `${officer.callSign || 'Field unit'} · ${officer.name || ''}`.trim();
  $('#unitDetails').textContent = `${officer.group || 'No group'} · ${siteName(officer.siteId)}`;
  const chip = $('#unitState');
  chip.textContent = officer.stunned ? 'STUNNED' : online ? 'ONLINE' : officer.shiftId ? 'OFFLINE' : 'OFF DUTY';
  chip.className = `state-chip ${online ? 'online' : officer.shiftId ? 'offline' : ''}`;
  $('#shiftValue').textContent = officer.shiftId ? statusLabel(officer.status) : 'Off duty';
  $('#gpsValue').textContent = officer.accuracy == null ? 'Waiting' : `±${Math.round(officer.accuracy)} m`;
  $('#batteryValue').textContent = officer.battery == null ? '—' : `${Math.round(officer.battery)}%`;
  const picker = $('#unitPicker'),pickerLabel = document.querySelector('.unit-picker-label'),canChooseUnit = currentUser?.role !== 'field';
  if (pickerLabel) pickerLabel.hidden = !canChooseUnit;
  picker.hidden = !canChooseUnit;
  picker.innerHTML = (fieldState.officers || []).map(unit => `<option value="${escapeHtml(unit.id)}" ${unit.id === officer.id ? 'selected' : ''}>${escapeHtml(selectedUnitOption(unit))}</option>`).join('');
  $('#sitePickerWrap').classList.toggle('hidden', Boolean(officer.shiftId));
  $('#sitePicker').innerHTML = (fieldState.sites || []).map(site => `<option value="${escapeHtml(site.id)}" ${site.id === officer.siteId ? 'selected' : ''}>${escapeHtml(site.name)}</option>`).join('');
  const onShift = Boolean(officer.shiftId);
  $('#shiftButton').textContent = onShift ? 'Clock out' : 'Clock in';
  $('#shiftButton').className = `button ${onShift ? 'ghost' : 'primary'}`;
  $('#presenceButton').disabled = !onShift || Boolean(officer.stunned);
  $('#presenceButton').textContent = !navigator.onLine ? (officer.online ? 'Queue offline' : 'Queue online') : officer.online ? 'Go offline' : 'Go online';
  $('#presenceButton').className = `button ${officer.online ? 'ghost' : 'primary'}`;
  $('#sosButton').disabled = !onShift || Boolean(officer.stunned);
  $('#callButton').disabled = !onShift || !officer.online || Boolean(officer.stunned) || !navigator.onLine || Boolean(activeCall);
  $('#messageInput').disabled = !onShift || Boolean(officer.stunned);
  $('#sendMessageButton').disabled = !onShift || Boolean(officer.stunned);
  $('#trackingNote').textContent = onShift && online
    ? `GPS sharing is active at ${Number(officer.config?.locationInterval || fieldState.settings?.locationInterval || 15)} second intervals.`
    : 'Location is shared only while clocked in and online.';
  const sos = (fieldState.alerts || [])[0];
  $('#sosNotice').classList.toggle('hidden', !sos);
  $('#sosNotice').textContent = sos ? `SOS active · raised ${formatTime(sos.raisedAt)}${sos.offline ? ' · phone was offline' : ''}` : '';
  $('#lastContact').textContent = `Last sync ${new Date().toLocaleTimeString('en-ZA', {hour:'2-digit',minute:'2-digit'})}`;
  renderMessages();
  setNetworkBadge();
}

function siteName(siteId) {
  return (fieldState?.sites || []).find(site => site.id === siteId)?.name || 'No work site';
}
function statusLabel(status) {
  return ({'en-route':'On shift · en route','on-site':'On shift · at site','on-break':'On break','left-site':'Outside assigned site'})[status] || 'On shift';
}

function stopNativeTracking() {
  try { window.DispatchNative?.stopTracking?.(); } catch (_) { }
}
function syncNativeTracking() {
  const officer = fieldState?.officer;
  if (officer?.shiftId && officer.online && !officer.stunned) {
    const interval = Number(officer.config?.locationInterval || fieldState.settings?.locationInterval || 15);
    const started = window.DispatchNative?.startTracking?.(officer.id, interval);
    if (started === false) {
      if (!gpsPermissionWarned) {
        gpsPermissionWarned = true;
        toast('Location is blocked. Allow Precise location for Dispatch Field in Android settings so control can see this unit.', true);
      }
    } else gpsPermissionWarned = false;
  } else stopNativeTracking();
}

async function loadState(force = false) {
  if (!navigator.onLine) {
    setNetworkBadge();
    return;
  }
  if (stateBusy || (!force && Date.now() < stateRetryAt)) return;
  stateBusy = true;
  try {
    const query = new URLSearchParams();
    if (currentUser?.role === 'field') query.set('scope', 'unit');
    if (selectedOfficerId && currentUser?.role !== 'field') query.set('officerId', selectedOfficerId);
    if (!force && fieldState?.updatedAt) query.set('since', fieldState.updatedAt);
    let changed = false;
    try {
      const search = query.toString();
      const next = await api(`/api/field/state${search ? `?${search}` : ''}`);
      if (next) { fieldState = next; changed = true; }
    } catch (error) {
      if (error.status === 404 && selectedOfficerId) {
        selectedOfficerId = '';
        localStorage.removeItem(OFFICER_KEY);
        fieldState = await api('/api/field/state');
        changed = true;
      } else throw error;
    }
    stateFailures = 0;
    stateRetryAt = 0;
    if (!fieldState?.officer) throw new Error('The server returned no field unit state');
    if (currentUser?.role === 'field' || !selectedOfficerId) selectedOfficerId = fieldState.officer.id;
    if (changed) {
      localStorage.setItem(OFFICER_KEY, selectedOfficerId);
      localStorage.setItem('dispatch-field-last-state', JSON.stringify(fieldState));
      render();
    } else $('#lastContact').textContent = `Last sync ${new Date().toLocaleTimeString('en-ZA', {hour:'2-digit',minute:'2-digit'})}`;
    await flushQueue();
    syncNativeTracking();
  } catch (error) {
    stateFailures++;
    stateRetryAt = Date.now() + Math.min(30000, 1500 * 2 ** Math.min(stateFailures - 1, 4));
    throw error;
  } finally { stateBusy = false; }
}

async function fieldAction(type, details = {}) {
  const body = { type, officerId: fieldState?.officer?.id, ...details };
  const data = await api('/api/field/action', 'POST', body);
  if (data.state) fieldState = data.state;
  render();
  syncNativeTracking();
  return data.result || {};
}

function offlineQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); }
  catch (_) { return []; }
}
function queueAction(body) {
  const queue = offlineQueue();
  queue.push({ body, queuedAt: new Date().toISOString() });
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
}
async function flushQueue() {
  if (!navigator.onLine) return;
  const queue = offlineQueue();
  while (queue.length) {
    try {
      const item = queue[0];
      const data = await api('/api/field/action', 'POST', item.body);
      if (data.state) fieldState = data.state;
      queue.shift();
      localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
    } catch (_) { break; }
  }
  render();
  syncNativeTracking();
}

async function login(email, password) {
  await api('/api/auth/login', 'POST', { email, password });
  $('#password').value = '';
  await enterField();
}
async function enterField() {
  const session = await api('/api/auth/me');
  currentUser = session.user;
  const previousUser = localStorage.getItem('dispatch-field-user-id') || '';
  if (previousUser && previousUser !== currentUser.id) {
    stopNativeTracking();
    localStorage.removeItem('dispatch-field-last-state');
    localStorage.removeItem(QUEUE_KEY);
    fieldState = null;
  }
  localStorage.setItem('dispatch-field-user-id', currentUser.id);
  await loadState();
  showPanel('field');
  clearInterval(stateTimer);
  stateTimer = setInterval(() => loadState().catch(handleNetworkError), 3000);
  clearInterval(rtcTimer);
  rtcTimer = setInterval(() => rtcPulse().catch(() => {}), 2500);
  await rtcPulse();
}
function handleNetworkError(error) {
  if (error?.status === 401) {
    clearInterval(stateTimer);
    clearInterval(rtcTimer);
    stateTimer = rtcTimer = null;
    stopNativeTracking();
    closeActiveCall(false).catch(() => {});
    currentUser = null;
    showPanel('login');
    $('#loginError').textContent = 'Your sign-in expired. Please sign in again.';
    $('#loginError').classList.remove('hidden');
    return;
  }
  setNetworkBadge();
  if (error && error.status !== 504 && error.status !== 503) toast(error.message || 'Could not reach Dispatch', true);
}

async function startShift() {
  const officer = fieldState?.officer;
  if (!officer) return;
  if (officer.shiftId) {
    if (!confirm('Clock out and stop location tracking?')) return;
    stopNativeTracking();
    await fieldAction('clock-out');
    return;
  }
  const siteId = $('#sitePicker').value;
  if (!siteId) return toast(currentUser?.role === 'field' ? 'Ask Control to assign this unit to a work site before clocking in.' : 'Choose a work site before clocking in.', true);
  await fieldAction('clock-in', { siteId });
  await fieldAction('field-presence', { online: true });
  toast('Shift started. GPS tracking is on.');
}

async function togglePresence() {
  const officer = fieldState?.officer;
  if (!officer?.shiftId) return toast('Clock in before going online.', true);
  const goingOnline = !officer.online;
  if (!goingOnline) {
    stopNativeTracking();
    if (activeCall) await endCall();
  }
  const body = { type: 'field-presence', officerId: officer.id, online: goingOnline };
  if (!navigator.onLine) {
    queueAction(body);
    fieldState.officer.online = goingOnline;
    fieldState.officer.tracking = goingOnline;
    render();
    syncNativeTracking();
    toast(goingOnline ? 'Online request queued; GPS points will sync when connected.' : 'You are offline. Your status will sync when connected.');
    return;
  }
  try {
    await fieldAction('field-presence', { online: goingOnline });
    toast(goingOnline ? 'You are online and location sharing has started.' : 'You are offline. Location sharing has stopped.');
  } catch (error) {
    if (error.status >= 500 || !error.status) {
      queueAction(body);
      if (!goingOnline) {
        fieldState.officer.online = false;
        fieldState.officer.tracking = false;
        render();
        syncNativeTracking();
        toast('Offline locally. Status will sync when the server is available.');
      } else toast('Online request queued until the server is available.');
    } else throw error;
  }
}

function currentLocation() {
  const officer = fieldState?.officer || {};
  return {
    lat: officer.lat ?? null,
    lng: officer.lng ?? null,
    accuracy: officer.accuracy ?? null,
    locationAt: officer.lastSeen || null,
    battery: officer.battery ?? null,
    signal: officer.signal ?? null
  };
}
async function sendSos() {
  const officer = fieldState?.officer;
  if (!officer?.shiftId || officer.stunned) return toast('Clock in and be active before sending SOS.', true);
  const body = { type: 'sos', officerId: officer.id, raisedAt: new Date().toISOString(), offline: !navigator.onLine || !officer.online, location: currentLocation() };
  if (!navigator.onLine) {
    queueAction(body);
    $('#sosNotice').textContent = 'SOS saved on this phone; it will send when a connection returns.';
    $('#sosNotice').classList.remove('hidden');
    toast('No connection: SOS saved on this phone for retry.', true);
    return;
  }
  try {
    await fieldAction('sos', { raisedAt: body.raisedAt, offline: body.offline, location: body.location });
    toast('SOS sent to control.');
  } catch (error) {
    if (!error.status || error.status >= 500 || !navigator.onLine) {
      queueAction(body);
      $('#sosNotice').textContent = 'SOS saved on this phone; it will send when a connection returns.';
      $('#sosNotice').classList.remove('hidden');
      toast('No connection: SOS saved on this phone for retry.', true);
    } else toast(error.message, true);
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const officer = fieldState?.officer;
  const text = $('#messageInput').value.trim();
  if (!text || !officer?.shiftId || officer.stunned) return;
  const body = { type: 'message', officerId: officer.id, from: officer.callSign, to: 'all', group: officer.group, body: text };
  $('#sendMessageButton').disabled = true;
  try {
    if (!navigator.onLine) throw new Error('offline');
    await fieldAction('message', { from: body.from, to: body.to, group: body.group, body: body.body });
    $('#messageInput').value = '';
    toast('Message sent to control.');
  } catch (error) {
    if (!navigator.onLine || !error.status || error.status >= 500) {
      queueAction(body);
      $('#messageInput').value = '';
      toast('Message saved on this phone; it will send when a connection returns.');
    } else toast(error.message, true);
  } finally { render(); }
}

function getPeerId() {
  if (rtcPeerId) return rtcPeerId;
  try {
    rtcPeerId = sessionStorage.getItem('dispatchVoicePeer') || '';
    if (!rtcPeerId) { rtcPeerId = crypto.randomUUID(); sessionStorage.setItem('dispatchVoicePeer', rtcPeerId); }
  } catch (_) { rtcPeerId = `field-peer-${Date.now()}-${Math.random().toString(36).slice(2)}`; }
  return rtcPeerId;
}
async function rtcRegister() {
  const officer = fieldState?.officer;
  if (!officer?.shiftId || !officer.online || officer.stunned || !navigator.onLine) return;
  await api('/api/rtc/register', 'POST', { peerId: getPeerId(), role: 'field', officerId: officer.id, label: officer.callSign || 'Field unit' });
  lastRegisterAt = Date.now();
}
async function signal(toPeer, callId, type, payload = {}) {
  return api('/api/rtc/signal', 'POST', { fromPeer: getPeerId(), toPeer, callId, type, payload });
}
async function rtcPulse() {
  if (rtcBusy || !fieldState?.officer?.shiftId || !fieldState.officer.online || fieldState.officer.stunned || !navigator.onLine) return;
  rtcBusy = true;
  try {
    if (Date.now() - lastRegisterAt > 7000) await rtcRegister();
    const inbox = await api(`/api/rtc/poll?peer=${encodeURIComponent(getPeerId())}`);
    for (const message of inbox.messages || []) await handleSignal(message);
    if (activeCall?.outgoing && !activeCall.offerSent && Date.now() < activeCall.expiresAt) await connectToControl();
    if (activeCall?.outgoing && !activeCall.answered && Date.now() >= activeCall.expiresAt) {
      const callId = activeCall.callId;
      await closeActiveCall(false);
      await fieldAction('call-fail', { id: callId, reason: 'No control-room endpoint answered' }).catch(() => {});
      setCallStatus('No control-room answer');
    }
  } catch (_) { }
  finally { rtcBusy = false; }
}

function createConnection(session, peer) {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  const connection = { peer, pc, remoteIce: [] };
  session.connections.set(peer.peerId, connection);
  if (session.stream) session.stream.getTracks().forEach(track => pc.addTrack(track, session.stream));
  pc.onicecandidate = event => {
    if (event.candidate) signal(peer.peerId, session.callId, 'ice', { candidate: event.candidate }).catch(() => {});
  };
  pc.ontrack = event => {
    let audio = document.querySelector('#remoteAudio');
    if (!audio) { audio = document.createElement('audio'); audio.id = 'remoteAudio'; audio.autoplay = true; audio.playsInline = true; document.body.appendChild(audio); }
    audio.srcObject = event.streams[0] || new MediaStream([event.track]);
    audio.play().catch(() => toast('Tap once to enable call audio.', true));
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') setCallStatus('Connected to control');
    else if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') setCallStatus('Voice connection interrupted');
  };
  const queued = pendingIce.get(`${session.callId}:${peer.peerId}`) || [];
  pendingIce.delete(`${session.callId}:${peer.peerId}`);
  connection.remoteIce.push(...queued);
  return connection;
}

async function connectToControl() {
  if (!activeCall?.outgoing || activeCall.offerSent) return;
  const result = await api(`/api/rtc/peers?role=control&exclude=${encodeURIComponent(getPeerId())}`);
  const peer = (result.peers || [])[0];
  if (!peer) { setCallStatus('Calling control… waiting for an operator'); return; }
  const connection = createConnection(activeCall, peer);
  const offer = await connection.pc.createOffer();
  await connection.pc.setLocalDescription(offer);
  await signal(peer.peerId, activeCall.callId, 'offer', {
    description: connection.pc.localDescription,
    fromLabel: fieldState.officer.callSign || 'Field unit',
    channel: 1,
    participant: fieldState.officer.id,
    receiveOnly: false
  });
  activeCall.offerSent = true;
  setCallStatus('Ringing control…');
}

async function startCall() {
  const officer = fieldState?.officer;
  if (!officer?.shiftId || officer.stunned || activeCall) return;
  if (!navigator.mediaDevices?.getUserMedia) return toast('Microphone calls are not supported on this device.', true);
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }); }
  catch (error) { return toast(`Microphone unavailable: ${error.message}`, true); }
  try {
    const data = await fieldAction('call-start', { callType: 'intercom', from: officer.callSign, to: 'control', participantIds: [officer.id], channel: 1, live: true });
    activeCall = { callId: data.call, stream, connections: new Map(), outgoing: true, offerSent: false, expiresAt: Date.now() + 90000 };
    $('#callButton').classList.add('hidden');
    $('#muteButton').classList.remove('hidden');
    $('#endCallButton').classList.remove('hidden');
    setCallStatus('Calling control…');
    await connectToControl();
  } catch (error) {
    if (activeCall) await closeActiveCall(false);
    else stream?.getTracks().forEach(track => track.stop());
    toast(error.message, true);
  }
}

async function acceptIncomingCall() {
  const message = pendingOffer;
  if (!message) return;
  const { callId, fromPeer, payload = {} } = message;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const officer = fieldState.officer;
    const session = { callId, stream, connections: new Map(), outgoing: false, expiresAt: Infinity };
    activeCall = session;
    const peer = { peerId: fromPeer, label: payload.fromLabel || 'Control room' };
    const connection = createConnection(session, peer);
    await connection.pc.setRemoteDescription(new RTCSessionDescription(payload.description));
    for (const candidate of connection.remoteIce.splice(0)) try { await connection.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) { }
    const claim = await fieldAction('call-answer', { id: callId, participant: officer.id });
    if (claim.accepted === false) throw new Error('This call has already ended or was answered elsewhere.');
    const answer = await connection.pc.createAnswer();
    await connection.pc.setLocalDescription(answer);
    await signal(fromPeer, callId, 'answer', { description: connection.pc.localDescription, participant: officer.id, label: officer.callSign || 'Field unit' });
    pendingOffer = null;
    $('#incomingCall').classList.add('hidden');
    $('#callButton').classList.add('hidden');
    $('#muteButton').classList.remove('hidden');
    $('#endCallButton').classList.remove('hidden');
    setCallStatus('Connecting to control…');
  } catch (error) {
    stream?.getTracks().forEach(track => track.stop());
    activeCall = null;
    toast(`Could not answer: ${error.message}`, true);
  }
}

async function handleSignal(message) {
  if (message.type === 'offer') {
    if (activeCall || pendingOffer) {
      await signal(message.fromPeer, message.callId, 'reject', { reason: 'field-busy' }).catch(() => {});
      return;
    }
    pendingOffer = message;
    $('#incomingCaller').textContent = `${message.payload?.fromLabel || 'Control room'} is calling`;
    $('#incomingCall').classList.remove('hidden');
    setCallStatus('Incoming call');
    return;
  }
  if (message.type === 'answer') {
    const connection = activeCall?.connections.get(message.fromPeer);
    if (!connection) return;
    activeCall.answered = true;
    await connection.pc.setRemoteDescription(new RTCSessionDescription(message.payload.description));
    for (const candidate of connection.remoteIce.splice(0)) try { await connection.pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (_) { }
    const claim = await fieldAction('call-answer', { id: message.callId, participant: message.payload.participant || message.fromPeer });
    if (claim.accepted === false) await signal(message.fromPeer, message.callId, 'reject', { reason: 'another-controller-answered' }).catch(() => {});
    return;
  }
  if (message.type === 'ice') {
    const connection = activeCall?.connections.get(message.fromPeer);
    if (!connection || !connection.pc.remoteDescription) {
      const key = `${message.callId}:${message.fromPeer}`;
      const queue = pendingIce.get(key) || [];
      queue.push(message.payload.candidate);
      pendingIce.set(key, queue);
    } else {
      try { await connection.pc.addIceCandidate(new RTCIceCandidate(message.payload.candidate)); } catch (_) { }
    }
    return;
  }
  if (message.type === 'reject') {
    toast('The control-room call was declined.', true);
    await closeActiveCall(false);
    await fieldAction('call-fail', { id: message.callId, reason: 'Control-room call declined' }).catch(() => {});
    return;
  }
  if (message.type === 'hangup') {
    await closeActiveCall(false);
    await fieldAction('call-end', { id: message.callId }).catch(() => {});
    toast('Control room ended the call.');
  }
}

async function declineIncomingCall() {
  const message = pendingOffer;
  if (!message) return;
  await signal(message.fromPeer, message.callId, 'reject', { reason: 'field-declined' }).catch(() => {});
  pendingOffer = null;
  $('#incomingCall').classList.add('hidden');
  setCallStatus('Call declined');
}

async function closeActiveCall(notify = true) {
  const session = activeCall;
  activeCall = null;
  if (session) {
    if (notify) for (const connection of session.connections.values()) signal(connection.peer.peerId, session.callId, 'hangup', {}).catch(() => {});
    for (const connection of session.connections.values()) connection.pc.close();
    session.stream?.getTracks().forEach(track => track.stop());
  }
  const audio = document.querySelector('#remoteAudio');
  if (audio) { audio.pause(); audio.srcObject = null; audio.remove(); }
  $('#callButton').classList.remove('hidden');
  $('#muteButton').classList.add('hidden');
  $('#endCallButton').classList.add('hidden');
  $('#incomingCall').classList.add('hidden');
  setCallStatus('Not connected');
}
function setCallStatus(value) { $('#callState').textContent = value; }
async function endCall() {
  const callId = activeCall?.callId;
  await closeActiveCall(true);
  if (callId) await fieldAction('call-end', { id: callId }).catch(() => {});
}
function toggleMute() {
  const tracks = activeCall?.stream?.getAudioTracks() || [];
  if (!tracks.length) return;
  const enabled = !tracks[0].enabled;
  tracks.forEach(track => track.enabled = enabled);
  $('#muteButton').textContent = enabled ? 'Mute microphone' : 'Unmute microphone';
}

async function signOut() {
  stopNativeTracking();
  if (navigator.onLine && fieldState?.officer?.shiftId && fieldState.officer.online)
    await fieldAction('field-presence', { online: false }).catch(() => {});
  clearInterval(stateTimer);
  clearInterval(rtcTimer);
  await closeActiveCall(true);
  try { await api('/api/auth/logout', 'POST', {}); } catch (_) { }
  fieldState = null;
  currentUser = null;
  localStorage.removeItem('dispatch-field-last-state');
  localStorage.removeItem('dispatch-field-user-id');
  localStorage.removeItem(QUEUE_KEY);
  showPanel('login');
  toast('Signed out.');
}

function bindEvents() {
  $('#loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('#loginButton');
    button.disabled = true;
    $('#loginError').classList.add('hidden');
    try { await login($('#email').value.trim(), $('#password').value); }
    catch (error) { $('#loginError').textContent = error.message; $('#loginError').classList.remove('hidden'); }
    finally { button.disabled = false; }
  });
  $('#serverButton').addEventListener('click', () => window.DispatchNative?.openServerSettings?.());
  $('#unitPicker').addEventListener('change', async event => {
    stopNativeTracking();
    if (activeCall) await endCall();
    if (navigator.onLine && fieldState?.officer?.shiftId && fieldState.officer.online)
      await fieldAction('field-presence', { online: false }).catch(() => {});
    selectedOfficerId = event.target.value;
    localStorage.setItem(OFFICER_KEY, selectedOfficerId);
    try { await loadState(); } catch (error) { handleNetworkError(error); }
  });
  $('#shiftButton').addEventListener('click', () => startShift().catch(error => toast(error.message, true)));
  $('#presenceButton').addEventListener('click', () => togglePresence().catch(error => toast(error.message, true)));
  $('#sosButton').addEventListener('click', () => sendSos());
  $('#messageForm').addEventListener('submit', sendMessage);
  $('#messageList').addEventListener('click', async event => {
    const button = event.target.closest('.mark-read');
    if (!button) return;
    try { await fieldAction('mark-read', { id: button.dataset.id }); }
    catch (error) { toast(error.message, true); }
  });
  $('#callButton').addEventListener('click', () => startCall());
  $('#muteButton').addEventListener('click', toggleMute);
  $('#endCallButton').addEventListener('click', () => endCall());
  $('#acceptCallButton').addEventListener('click', () => acceptIncomingCall());
  $('#declineCallButton').addEventListener('click', () => declineIncomingCall());
  $('#refreshButton').addEventListener('click', () => loadState(true).catch(handleNetworkError));
  $('#signOutButton').addEventListener('click', () => signOut());
  window.addEventListener('online', () => { setNetworkBadge(); flushQueue().then(() => loadState()).catch(handleNetworkError); });
  window.addEventListener('offline', () => { setNetworkBadge(); });
}

async function boot() {
  bindEvents();
  if (!navigator.onLine) {
    try {
      const cached = localStorage.getItem('dispatch-field-last-state');
      if (cached) { fieldState = JSON.parse(cached); if (fieldState?.officer) { const unit = fieldState.officer; fieldState.officers = [{ id: unit.id, name: unit.name, callSign: unit.callSign, shiftId: unit.shiftId, status: unit.status }]; fieldState.sites = (fieldState.sites || []).filter(site => site.id === unit.siteId); fieldState.messages = (fieldState.messages || []).filter(message => message.to === unit.id || (message.to === 'all' && (!message.group || message.group === unit.group))); fieldState.alerts = (fieldState.alerts || []).filter(alert => !alert.officerId || alert.officerId === unit.id); selectedOfficerId = unit.id; showPanel('field'); render(); } else showPanel('login'); }
      else showPanel('login');
    } catch (_) { showPanel('login'); }
    setNetworkBadge();
    return;
  }
  try { await enterField(); }
  catch (error) {
    if (error.status === 401) showPanel('login');
    else {
      showPanel('login');
      $('#loginError').textContent = error.message || 'Could not connect to Dispatch.';
      $('#loginError').classList.remove('hidden');
    }
  }
}

boot();
