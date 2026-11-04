/**
 * app.js — bootstrap: load config, wire identity + channel list + chat pane,
 * attachments, streaming replies, reactions, and channel management.
 */
(function () {
  'use strict';

  let currentChannelId = null;
  let currentRole = 'guest';
  let creds = null; // { publicKey, privateKey } (for signed upload path)
  let token = null; // JWT from /auth-tier (for text chat)
  let pendingFiles = [];
  let config = null;

  const REACTIONS = ['👍', '👀', '✅', '❌'];

  function el(id) { return document.getElementById(id); }

  function fingerprint(pub) {
    if (!pub) return '';
    return pub.replace(/[\r\n=]/g, '').slice(0, 12);
  }

  function isPrivileged(role) {
    return role === 'governor' || role === 'sentinel';
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  function channelFromHash() {
    const h = (window.location.hash || '').replace(/^#/, '');
    if (h.indexOf('channel=') === 0) {
      try { return decodeURIComponent(h.slice('channel='.length)); } catch (e) { return null; }
    }
    return null;
  }

  function setChannelHash(channelId) {
    const target = '#channel=' + encodeURIComponent(channelId);
    if (window.location.hash !== target) {
      history.replaceState(null, '', target);
    }
  }

  function selectChannelOrFirst() {
    const wanted = channelFromHash();
    const visible = window.SophiaChannels.visibleChannels(config, currentRole);
    if (wanted && visible.some((c) => c.id === wanted)) {
      selectChannel(wanted);
    } else if (visible.length) {
      selectChannel(visible[0].id);
    }
  }

  async function loadConfig() {
    const resp = await fetch('./config.json');
    if (!resp.ok) throw new Error('config.json not found (HTTP ' + resp.status + ')');
    return resp.json();
  }

  // ---- channel list ----

  let dragState = null;

  function positionOf(ch) {
    return (typeof ch._position === 'number') ? ch._position : Number.MAX_SAFE_INTEGER;
  }

  function channelsInCategory(name) {
    return window.SophiaChannels.visibleChannels(config, currentRole)
      .filter((c) => c.categoryName === name)
      .sort((a, b) => positionOf(a) - positionOf(b));
  }

  function clearDropMarks() {
    const sidebar = el('channelList');
    if (!sidebar) return;
    sidebar.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
    sidebar.querySelectorAll('.drop-before, .drop-after').forEach((n) => {
      n.classList.remove('drop-before');
      n.classList.remove('drop-after');
    });
  }

  function renderChannelList() {
    const sidebar = el('channelList');
    sidebar.innerHTML = '';
    const priv = isPrivileged(currentRole);
    const byCat = {};
    window.SophiaChannels.visibleChannels(config, currentRole).forEach((ch) => {
      (byCat[ch.categoryName] = byCat[ch.categoryName] || []).push(ch);
    });
    Object.keys(byCat).forEach((k) => byCat[k].sort((a, b) => positionOf(a) - positionOf(b)));
    window.SophiaChannels.allCategories(config).forEach((catName) => {
      const collapsed = window.SophiaChannels.isCollapsed(catName);
      const catHeader = document.createElement('div');
      catHeader.className = 'category' + (collapsed ? ' collapsed' : '');
      catHeader.dataset.categoryName = catName;
      const caret = document.createElement('span');
      caret.className = 'caret';
      caret.textContent = priv ? '\u25be' : '';
      if (priv) {
        caret.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleCollapsed(catName);
        });
      }
      catHeader.appendChild(caret);
      const label = document.createElement('span');
      label.className = 'category-label';
      label.textContent = catName;
      catHeader.appendChild(label);
      catHeader.addEventListener('contextmenu', (e) => onCategoryContextMenu(e, catName));
      if (priv) wireCategoryDrag(catHeader, catName);
      sidebar.appendChild(catHeader);
      (byCat[catName] || []).forEach((ch) => {
        const item = buildChannelItem(ch);
        if (collapsed) item.classList.add('hidden-collapsed');
        sidebar.appendChild(item);
      });
    });
    el('newChannelBtn').hidden = !priv;
    el('newCategoryBtn').hidden = !priv;
  }

  // ---- collapse -----------------------------------------------------------
  function toggleCollapsed(catName) {
    const want = !window.SophiaChannels.isCollapsed(catName);
    const before = window.SophiaChannels.getLayout();
    const next = before.collapsed.filter((n) => n !== catName);
    if (want) next.push(catName);
    window.SophiaChannels.applyLocalCollapsed(next);
    renderChannelList();
    window.SophiaChannels.setCollapsed(catName, want, token).catch((err) => {
      window.SophiaChannels.replaceLayout(before);
      renderChannelList();
      setAuthBanner('Collapse failed: ' + err.message, 'error');
    });
  }

  // ---- drag & drop --------------------------------------------------------
  function persistMove(channelId, categoryName, position, before) {
    window.SophiaChannels.applyLocalMove(channelId, categoryName, position);
    renderChannelList();
    window.SophiaChannels.moveChannel(channelId, categoryName, position, token).catch((err) => {
      window.SophiaChannels.replaceLayout(before);
      renderChannelList();
      setAuthBanner('Reorder failed: ' + err.message, 'error');
    });
  }

  function wireChannelDrag(item, ch) {
    item.draggable = true;
    item.addEventListener('dragstart', (e) => {
      dragState = { kind: 'channel', id: ch.id, categoryName: ch.categoryName };
      item.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', ch.id); } catch (err) { /* ignore */ }
    });
    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      dragState = null;
      clearDropMarks();
    });
    item.addEventListener('dragover', (e) => {
      if (!dragState || dragState.kind !== 'channel') return;
      e.preventDefault();
      const rect = item.getBoundingClientRect();
      const after = (e.clientY - rect.top) > (rect.height / 2);
      item.classList.toggle('drop-after', after);
      item.classList.toggle('drop-before', !after);
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('drop-before');
      item.classList.remove('drop-after');
    });
    item.addEventListener('drop', (e) => {
      if (!dragState || dragState.kind !== 'channel') return;
      e.preventDefault();
      e.stopPropagation();
      const after = item.classList.contains('drop-after');
      const sourceId = dragState.id;
      const targetCat = ch.categoryName;
      clearDropMarks();
      if (sourceId === ch.id) return;
      const siblings = channelsInCategory(targetCat).filter((c) => c.id !== sourceId);
      let idx = siblings.findIndex((c) => c.id === ch.id);
      if (idx < 0) idx = siblings.length;
      if (after) idx += 1;
      persistMove(sourceId, targetCat, idx, window.SophiaChannels.getLayout());
    });
  }

  function wireCategoryDrag(catHeader, catName) {
    catHeader.draggable = true;
    catHeader.addEventListener('dragstart', (e) => {
      dragState = { kind: 'category', name: catName };
      catHeader.classList.add('dragging');
      try { e.dataTransfer.setData('text/plain', catName); } catch (err) { /* ignore */ }
    });
    catHeader.addEventListener('dragend', () => {
      catHeader.classList.remove('dragging');
      dragState = null;
      clearDropMarks();
    });
    catHeader.addEventListener('dragover', (e) => {
      if (!dragState) return;
      e.preventDefault();
      catHeader.classList.add('drop-target');
    });
    catHeader.addEventListener('dragleave', () => catHeader.classList.remove('drop-target'));
    catHeader.addEventListener('drop', (e) => {
      if (!dragState) return;
      e.preventDefault();
      e.stopPropagation();
      catHeader.classList.remove('drop-target');
      const before = window.SophiaChannels.getLayout();
      if (dragState.kind === 'category') {
        if (dragState.name === catName) { clearDropMarks(); return; }
        const order = window.SophiaChannels.allCategories(config)
          .filter((n) => n !== dragState.name);
        const at = order.indexOf(catName);
        order.splice(at < 0 ? order.length : at, 0, dragState.name);
        window.SophiaChannels.applyLocalCategoryOrder(order);
        renderChannelList();
        window.SophiaChannels.setCategoryOrder(order, token).catch((err) => {
          window.SophiaChannels.replaceLayout(before);
          renderChannelList();
          setAuthBanner('Reorder failed: ' + err.message, 'error');
        });
      } else {
        // channel dropped onto a header -> move into that category (appended)
        const count = channelsInCategory(catName).filter((c) => c.id !== dragState.id).length;
        persistMove(dragState.id, catName, count, before);
      }
      clearDropMarks();
    });
  }

  function buildChannelItem(ch) {
    const item = document.createElement('div');
    item.className = 'channel';
    item.dataset.channelId = ch.id;
    const name = document.createElement('span');
    name.className = 'channel-name';
    name.textContent = '# ' + ch.name;
    item.appendChild(name);
    item.addEventListener('click', () => selectChannel(ch.id));
    item.addEventListener('contextmenu', (e) => onChannelContextMenu(e, ch));
    if (isPrivileged(currentRole)) wireChannelDrag(item, ch);

    if (isPrivileged(currentRole)) {
      const retire = document.createElement('button');
      retire.className = 'channel-retire';
      retire.textContent = '✕';
      retire.title = 'Retire channel';
      retire.addEventListener('click', async (e) => {
        e.stopPropagation();
        try { await window.SophiaChannels.retireChannel(ch.id, token); } catch (err) { setAuthBanner('Retire failed: ' + (err.message || err), 'error'); }
        if (currentChannelId === ch.id) { currentChannelId = null; el('messages').innerHTML = ''; el('chatHeader').textContent = '# select a channel'; }
        renderChannelList();
      });
      item.appendChild(retire);
    }
    return item;
  }

  function hideContextMenu() {
    el('ctxMenu').hidden = true;
  }

  function showContextMenu(x, y, items) {
    const menu = el('ctxMenu');
    menu.innerHTML = '';
    items.forEach((it) => {
      const btn = document.createElement('button');
      btn.className = 'ctx-item' + (it.danger ? ' danger' : '');
      btn.textContent = it.label;
      btn.addEventListener('click', () => { hideContextMenu(); it.action(); });
      menu.appendChild(btn);
    });
    menu.hidden = false;
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    const rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
  }

  function onChannelContextMenu(e, ch) {
    if (!isPrivileged(currentRole)) return;
    e.preventDefault();
    const items = [];
    if (!window.SophiaChannels.isBuiltinChannel(ch.id)) {
      items.push({ label: 'Rename…', action: async () => {
        const n = prompt('Rename channel', ch.name);
        if (n && n.trim()) {
          try { await window.SophiaChannels.renameChannel(ch.id, n.trim(), token); } catch (err) { setAuthBanner('Rename failed: ' + (err.message || err), 'error'); }
          renderChannelList();
        }
      }});
      items.push({ label: ch.visibility === 'public' ? 'Make private' : 'Make public', action: async () => {
        try { await window.SophiaChannels.setChannelVisibility(ch.id, ch.visibility === 'public' ? 'private' : 'public', token); } catch (err) { setAuthBanner('Update failed: ' + (err.message || err), 'error'); }
        renderChannelList();
      }});
    }
    items.push({ label: 'Retire channel', danger: true, action: async () => {
      try { await window.SophiaChannels.retireChannel(ch.id, token); } catch (err) { setAuthBanner('Retire failed: ' + (err.message || err), 'error'); }
      if (currentChannelId === ch.id) { currentChannelId = null; el('messages').innerHTML = ''; el('chatHeader').textContent = '# select a channel'; }
      renderChannelList();
    }});
    showContextMenu(e.clientX, e.clientY, items);
  }

  function onCategoryContextMenu(e, catName) {
    if (!isPrivileged(currentRole)) return;
    if (window.SophiaChannels.isBuiltinCategory(catName)) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: 'Rename category…', action: async () => {
        const n = prompt('Rename category', catName);
        if (n && n.trim()) {
          try { await window.SophiaChannels.renameCategory(catName, n.trim(), token); } catch (err) { setAuthBanner('Rename failed: ' + (err.message || err), 'error'); }
          renderChannelList();
        }
      }},
      { label: 'Delete category', danger: true, action: async () => {
        if (confirm('Delete category "' + catName + '" and its channels?')) {
          try { await window.SophiaChannels.deleteCategory(catName, token); } catch (err) { setAuthBanner('Delete failed: ' + (err.message || err), 'error'); }
          if (currentChannelId && window.SophiaChannels.isRetired(currentChannelId)) { currentChannelId = null; el('messages').innerHTML = ''; el('chatHeader').textContent = '# select a channel'; }
          renderChannelList();
        }
      }},
    ]);
  }

  function openNewChannelModal() {
    const sel = el('channelCategory');
    sel.innerHTML = '';
    window.SophiaChannels.allCategories(config).forEach((catName) => {
      const opt = document.createElement('option');
      opt.value = catName;
      opt.textContent = catName;
      sel.appendChild(opt);
    });
    el('channelName').value = '';
    el('channelVisibility').value = 'private';
    el('channelModal').hidden = false;
    el('channelName').focus();
  }

  function closeNewChannelModal() {
    el('channelModal').hidden = true;
  }

  async function onCreateChannel() {
    const name = el('channelName').value.trim();
    const category = el('channelCategory').value;
    if (!name) { el('channelName').focus(); return; }
    const visibility = el('channelVisibility').value;
    let ch;
    try {
      ch = await window.SophiaChannels.createChannel(category, name, visibility, token);
    } catch (e) {
      setAuthBanner('Create channel failed: ' + (e && e.message ? e.message : e), 'error');
      return;
    }
    closeNewChannelModal();
    renderChannelList();
    selectChannel(ch.id);
  }

  function openCategoryModal() {
    el('categoryName').value = '';
    el('categoryModal').hidden = false;
    el('categoryName').focus();
  }

  function closeCategoryModal() {
    el('categoryModal').hidden = true;
  }

  async function onCreateCategory() {
    const name = el('categoryName').value.trim();
    if (!name) { el('categoryName').focus(); return; }
    try {
      await window.SophiaChannels.createCategory(name, token);
    } catch (e) {
      setAuthBanner('Create category failed: ' + (e && e.message ? e.message : e), 'error');
      return;
    }
    closeCategoryModal();
    renderChannelList();
  }

  async function selectChannel(channelId) {
    currentChannelId = channelId;
    setChannelHash(channelId);
    document.querySelectorAll('.channel').forEach((n) => n.classList.toggle('active', n.dataset.channelId === channelId));
    el('chatHeader').textContent = '#' + channelId;
    el('messages').innerHTML = '';
    appendMessage('system', 'Loading history…');
    try {
      if (!creds) throw new Error('Not connected');
      const history = await window.SophiaChat.loadHistory(channelId, creds.publicKey);
      el('messages').innerHTML = '';
      renderHistory(history);
    } catch (e) {
      appendMessage('system', 'Could not load history: ' + e.message);
    }
  }

  function renderHistory(history) {
    const messages = Array.isArray(history)
      ? history
      : (history && Array.isArray(history.messages)) ? history.messages : [];
    messages.forEach((m) => {
      const content = typeof m === 'string' ? m : (m.content || m.text || '');
      const role = (m && (m.role || m.from)) || 'assistant';
      const who = (role === 'user' || role === 'human') ? 'you' : 'sophia';
      appendMessage(who, String(content));
    });
  }

  /** Render message text as Markdown (headings, code, lists, tables, images…). */
  function renderContent(text) {
    return window.SophiaMarkdown.renderMarkdown(text);
  }

  function scrollToBottom() {
    const box = el('messages');
    if (box) box.scrollTop = box.scrollHeight;
  }

  function appendMessage(who, text, opts) {
    opts = opts || {};
    const box = el('messages');
    const row = document.createElement('div');
    row.className = 'msg ' + who;
    const stack = document.createElement('div');
    stack.className = 'msg-stack';

    if (who === 'you' || who === 'sophia') {
      const sender = document.createElement('div');
      sender.className = 'sender';
      sender.textContent = who === 'you' ? 'You' : 'Sophia';
      stack.appendChild(sender);
    }

    const content = document.createElement('div');
    content.className = 'bubble';
    if (who === 'system') {
      content.textContent = text;
    } else {
      content.innerHTML = renderContent(text);
    }
    if (who !== 'system' && text && text.length > 4000) {
      // Long history bodies (e.g. server-truncated dumps) stay collapsible
      // instead of blowing up the transcript.
      const details = document.createElement('details');
      details.className = 'msg-collapsed';
      const summary = document.createElement('summary');
      summary.textContent = 'Show full message (' + text.length + ' chars)';
      details.appendChild(summary);
      details.appendChild(content);
      stack.appendChild(details);
    } else {
      stack.appendChild(content);
    }

    if (who === 'sophia' && opts.reactive !== false) {
      stack.appendChild(buildReactionBar(text));
    }

    row.appendChild(stack);
    box.appendChild(row);
    scrollToBottom();
    return content;
  }

  // ---- reactions (client-side, persisted in localStorage per channel) ----

  function reactionKey(text) {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function readReactions(channelId, key) {
    try {
      const raw = localStorage.getItem('sophia_reactions_' + channelId);
      const map = raw ? JSON.parse(raw) : {};
      return map[key] || {};
    } catch (e) { return {}; }
  }

  function writeReactions(channelId, key, map) {
    try {
      const raw = localStorage.getItem('sophia_reactions_' + channelId);
      const all = raw ? JSON.parse(raw) : {};
      all[key] = map;
      localStorage.setItem('sophia_reactions_' + channelId, JSON.stringify(all));
    } catch (e) { /* non-fatal */ }
  }

  function buildReactionBar(text) {
    const bar = document.createElement('div');
    bar.className = 'reactions';
    const key = reactionKey(text);
    const state = currentChannelId ? readReactions(currentChannelId, key) : {};
    REACTIONS.forEach((emoji) => {
      const btn = document.createElement('button');
      btn.className = 'reaction' + (state[emoji] ? ' active' : '');
      btn.textContent = emoji;
      btn.addEventListener('click', () => {
        const cur = readReactions(currentChannelId, key);
        if (cur[emoji]) delete cur[emoji]; else cur[emoji] = true;
        writeReactions(currentChannelId, key, cur);
        btn.classList.toggle('active', !!cur[emoji]);
      });
      bar.appendChild(btn);
    });
    return bar;
  }

  function setAuthBanner(text, kind) {
    const banner = el('authBanner');
    banner.textContent = text;
    banner.className = 'auth-banner ' + (kind || '');
    banner.hidden = false;
  }

  async function onConnect() {
    try {
      const auth = await window.SophiaAuth.authenticate();
      token = auth.token;
      creds = await window.SophiaAuth.ensureKeypair();
      currentRole = auth.role;
      await window.SophiaChannels.loadRegistry(token);
      renderChannelList();
      el('identity').textContent = 'identity: ' + fingerprint(creds.publicKey);
      el('connectBtn').hidden = true;
      el('composer').hidden = false;
      setAuthBanner('Signed in as ' + auth.role + ' · identity ' + fingerprint(creds.publicKey), 'ok');
      selectChannelOrFirst();
      renderIdentityLink();
      handleVerificationLink();
    } catch (e) {
      setAuthBanner('Identity failed: ' + e.message, 'error');
    }
  }

  async function handleVerificationLink() {
    const vp = window.SophiaIdentity.verificationParams();
    if (!vp || !creds) return;
    const status = el('identityStatus');
    status.hidden = false;
    status.className = 'identity-status pending';
    status.textContent = 'Completing email verification…';
    const res = await window.SophiaIdentity.verifyEmail(vp.em, vp.vk, creds.publicKey, creds.privateKey);
    history.replaceState(null, '', window.location.pathname + window.location.hash);
    if (!res.ok) {
      status.className = 'identity-status error';
      status.textContent = 'Verification failed: ' + (res.error || 'unknown error');
      return;
    }
    await renderIdentityLink();
    // Refresh the role (verification may have promoted guest -> member/governor).
    try {
      const auth = await window.SophiaAuth.authenticate();
      token = auth.token;
      currentRole = auth.role;
      renderChannelList();
    } catch (e) { /* role refresh is best-effort */ }
  }

  async function renderIdentityLink() {
    if (!creds || !creds.publicKey) return;
    const linkBtn = el('linkIdentityBtn');
    const status = el('identityStatus');
    const cv = el('cvLink');
    let res;
    try {
      res = await window.SophiaIdentity.checkRegistration(creds.publicKey);
    } catch (e) {
      return;
    }
    if (res.registered) {
      linkBtn.hidden = true;
      cv.hidden = false;
      cv.href = 'https://truesight.me/';
      status.hidden = false;
      status.className = 'identity-status ok';
      status.textContent = '✓ DAO identity: ' + (res.contributor_name || res.contributor_email || 'linked');
    } else if (res.pending_verification) {
      linkBtn.hidden = true;
      cv.hidden = true;
      status.hidden = false;
      status.className = 'identity-status pending';
      status.textContent = '⏳ Awaiting email verification (' + (res.contributor_email || 'your inbox') + ')';
    } else {
      linkBtn.hidden = false;
      cv.hidden = true;
      status.hidden = true;
    }
  }

  function openIdentityModal() {
    el('identityModal').hidden = false;
    el('identityEmail').value = '';
    el('identityEmail').focus();
  }

  function closeIdentityModal() {
    el('identityModal').hidden = true;
  }

  async function onLinkIdentity() {
    const email = el('identityEmail').value.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      el('identityEmail').focus();
      return;
    }
    if (!creds) { closeIdentityModal(); return; }
    const btn = el('identitySubmitBtn');
    const status = el('identityStatus');
    btn.disabled = true;
    btn.textContent = 'Linking…';
    const res = await window.SophiaIdentity.registerEmail(email, creds.publicKey, creds.privateKey);
    btn.disabled = false;
    btn.textContent = 'Link';
    if (!res.ok) {
      status.hidden = false;
      status.className = 'identity-status error';
      status.textContent = 'Error: ' + (res.error || 'registration failed');
      return;
    }
    closeIdentityModal();
    await renderIdentityLink();
  }

  function makeCallbacks(thinking, streamed) {
    return {
      onEvent(evt) {
        switch (evt.type) {
          case 'token': {
            const t = evt.content || '';
            if (t && t !== 'Thinking…' && t !== 'Thinking...') {
              streamed.value += t;
              thinking.textContent = streamed.value;
            }
            break;
          }
          case 'tool':
            thinking.textContent = '🔧 ' + (evt.tool || 'tool') + (evt.status === 'calling' ? ' …' : ' done');
            break;
          case 'status':
            thinking.textContent = '🔄 ' + (evt.message || evt.stage || 'processing…');
            break;
          case 'error':
            thinking.textContent = '⚠️ ' + (evt.content || evt.message || 'error');
            break;
          case 'cancelled':
            thinking.textContent = (streamed.value || '') + (evt.reason ? ' (cancelled)' : '');
            break;
          case 'done':
            if (evt.response != null) thinking.innerHTML = renderContent(evt.response);
            break;
        }
        requestAnimationFrame(scrollToBottom);
      },
      onDone(t) {
        if (t) thinking.innerHTML = renderContent(t);
        else if (!streamed.value) thinking.textContent = '(no reply)';
        scrollToBottom();
      },
    };
  }

  async function onSend() {
    const input = el('messageInput');
    const text = input.value.trim();
    if ((!text && !pendingFiles.length) || !currentChannelId) return;
    if (!creds) { setAuthBanner('Not connected — connect first.', 'error'); return; }

    try {
      token = await window.SophiaAuth.ensureFreshToken();
    } catch (e) {
      setAuthBanner('Re-auth failed: ' + (e && e.message ? e.message : e), 'error');
      return;
    }

    const files = pendingFiles.slice();
    pendingFiles = [];
    resetComposer();

    if (text) appendMessage('you', text);
    if (files.length) appendMessage('you', '📎 ' + files.map((f) => f.name).join(', '));

    const thinking = appendMessage('sophia', '🔄 Thinking…', { reactive: false });
    const streamed = { value: '' };
    const cb = makeCallbacks(thinking, streamed);

    try {
      if (files.length) {
        await window.SophiaChat.sendMessageWithFiles(currentChannelId, text, files, creds, cb);
      } else {
        await window.SophiaChat.sendMessage(currentChannelId, text, token, cb);
      }
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (/403|governor|sentinel/i.test(msg)) {
        setAuthBanner('Send rejected — insufficient rights for this key. ' + msg, 'error');
      }
      // 401 = expired/invalid JWT — re-auth once and retry transparently.
      if (/401/i.test(msg)) {
        try {
          token = await window.SophiaAuth.authenticate();
          if (files.length) {
            await window.SophiaChat.sendMessageWithFiles(currentChannelId, text, files, creds, cb);
          } else {
            await window.SophiaChat.sendMessage(currentChannelId, text, token, cb);
          }
          scrollToBottom();
          return;
        } catch (e2) {
          const m2 = e2 && e2.message ? e2.message : String(e2);
          thinking.textContent = 'Error: ' + m2;
          scrollToBottom();
          return;
        }
      }
      thinking.textContent = 'Error: ' + msg;
    }
    scrollToBottom();
  }

  function updateAttachLabel() {
    el('attachBtn').textContent = pendingFiles.length ? '📎 ' + pendingFiles.length : '📎';
  }

  function autoResizeTextarea() {
    const t = el('messageInput');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 220) + 'px';
  }

  function resetComposer() {
    const t = el('messageInput');
    t.value = '';
    t.style.height = 'auto';
    updateAttachLabel();
  }

  function onFilesChosen() {
    const input = el('fileInput');
    pendingFiles = Array.from(input.files || []);
    input.value = '';
    updateAttachLabel();
  }

  function onPaste(e) {
    const cd = e.clipboardData || (window.clipboardData || null);
    if (!cd || !cd.items) return;
    const files = window.SophiaChat.imageFilesFromClipboardItems(cd.items);
    if (!files.length) return;
    e.preventDefault();
    pendingFiles = pendingFiles.concat(files);
    updateAttachLabel();
  }

  async function boot() {
    try {
      config = await loadConfig();
      window.AppConfig = config;
      document.title = config.appTitle || 'TrueSight Ops Console';
      el('appTitle').textContent = config.appTitle || 'TrueSight Ops Console';
      el('deployment').textContent = 'deployment: ' + (config.deployment || 'local') +
        ' → ' + (config.sophiaBaseUrl || '');
      const pub = window.SophiaAuth.getStoredPublicKey();
      el('identity').textContent = 'identity: ' + (pub ? fingerprint(pub) : '(none)');
      renderChannelList();
      if (pub) onConnect(); // already have a key → connect immediately
    } catch (e) {
      setAuthBanner('Boot error: ' + e.message, 'error');
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    el('connectBtn').addEventListener('click', onConnect);
    el('sendBtn').addEventListener('click', onSend);
    el('attachBtn').addEventListener('click', () => el('fileInput').click());
    el('fileInput').addEventListener('change', onFilesChosen);
    el('messageInput').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.isComposing || e.keyCode === 229) return; // IME: never send mid-composition
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); onSend(); return; } // always-send
      const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      if (coarse) return; // soft keyboards have no Shift -> Enter is a newline
      if (e.shiftKey) return; // Shift+Enter -> break line
      e.preventDefault();
      onSend();
    });
    el('messageInput').addEventListener('paste', onPaste);
    el('messageInput').addEventListener('input', autoResizeTextarea);
    el('newChannelBtn').addEventListener('click', openNewChannelModal);
    el('channelCreateBtn').addEventListener('click', onCreateChannel);
    el('channelCancelBtn').addEventListener('click', closeNewChannelModal);
    el('newCategoryBtn').addEventListener('click', openCategoryModal);
    el('categoryCreateBtn').addEventListener('click', onCreateCategory);
    el('categoryCancelBtn').addEventListener('click', closeCategoryModal);
    el('linkIdentityBtn').addEventListener('click', openIdentityModal);
    el('identitySubmitBtn').addEventListener('click', onLinkIdentity);
    el('identityCancelBtn').addEventListener('click', closeIdentityModal);
    document.addEventListener('click', hideContextMenu);
    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.url-copy, .copy-btn');
      if (!btn) return;
      let text;
      if (btn.classList.contains('copy-btn')) {
        const code = btn.parentElement.querySelector('code');
        text = code ? code.textContent : '';
      } else {
        const wrap = btn.closest('.url-wrap, .attach-fig') || btn.parentElement;
        const a = wrap.querySelector('a');
        const img = wrap.querySelector('img');
        text = a ? a.href : (img ? img.src : '');
      }
      if (!text) return;
      copyToClipboard(text);
      const orig = btn.textContent;
      btn.textContent = '✓';
      btn.classList.add('copied');
      setTimeout(() => { btn.textContent = orig; btn.classList.remove('copied'); }, 1200);
    });
    document.addEventListener('contextmenu', (e) => {
      if (!e.target.closest('.channel') && !e.target.closest('.category')) hideContextMenu();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideContextMenu(); });
    window.addEventListener('hashchange', () => {
      const wanted = channelFromHash();
      if (wanted && wanted !== currentChannelId && creds) {
        selectChannel(wanted);
      }
    });
    boot();
  });
})();
