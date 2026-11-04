/**
 * chat.js — talk to Sophia over SSE (`POST /chat`) and read history (`GET /session`).
 *
 * v1 sends signed messages (see auth.js::signMessage) and reads history by
 * `X-Public-Key` + `X-Session-Id`. The brain streams SSE events shaped
 * `data: {"type": ..., ...}\n\n`; `done.response` carries the final text,
 * `heartbeat` is a keep-alive during long tool runs.
 */
(function () {
  'use strict';

  function sessionIdFor(channelId) {
    return 'client:' + channelId;
  }

  /**
   * Parse an SSE byte stream into a list of events.
   * Handles events split across chunk boundaries and CRLF/LF line endings.
   */
  function parseSSE(text) {
    const events = [];
    const lines = text.split(/\r?\n/);
    let dataLines = [];
    for (const line of lines) {
      if (line === '') {
        if (dataLines.length) {
          const raw = dataLines.join('\n');
          dataLines = [];
          if (raw.startsWith('data:')) {
            const json = raw.slice(5).trim();
            if (json && json !== '[DONE]') {
              try { events.push(JSON.parse(json)); } catch (e) { /* ignore malformed */ }
            }
          }
        }
        continue;
      }
      if (line.startsWith('data:')) dataLines.push(line);
    }
    return events;
  }

  /**
   * POST a message (JWT-authenticated) and stream the reply.
   * @param {string} channelId
   * @param {string} message
   * @param {string} token — JWT from /auth-tier
   * @param {object} callbacks {onEvent(evt), onDone(text), onError(err)}
   */
  async function sendMessage(channelId, message, token, callbacks) {
    const url = window.SophiaAuth.baseUrl() + '/chat';

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'X-Session-Id': sessionIdFor(channelId),
      },
      body: JSON.stringify({ message }),
    });

    if (!resp.ok || !resp.body) {
      let detail = 'HTTP ' + resp.status;
      try {
        const j = await resp.json();
        if (j && (j.detail || j.error)) detail = j.detail || j.error;
      } catch (e) { /* ignore */ }
      throw new Error(detail);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalText = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = parseSSE(buffer);
      const lastNewline = buffer.lastIndexOf('\n\n');
      if (lastNewline >= 0) buffer = buffer.slice(lastNewline + 2);
      for (const evt of events) {
        if (callbacks.onEvent) callbacks.onEvent(evt);
        if (evt.type === 'done' && evt.response != null) finalText = evt.response;
      }
    }

    if (callbacks.onDone) callbacks.onDone(finalText || '');
    return finalText || '';
  }

  /** Load conversation history for a channel (public-key keyed). */
  async function loadHistory(channelId, publicKey) {
    const resp = await fetch(window.SophiaAuth.baseUrl() + '/session?limit=500', {
      headers: {
        'X-Public-Key': publicKey,
        'X-Session-Id': sessionIdFor(channelId),
      },
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' loading history');
    return resp.json();
  }

  /**
   * POST a signed message + one or more file attachments via `/chat/upload`
   * (multipart). Signed headers carry the payload (`X-Payload` JSON string +
   * `X-Signature`) and `X-Public-Key`, mirroring auth.js::signMessage.
   * @param {FileList|Array} files
   * @param {object} callbacks {onEvent(evt), onDone(text), onError(err)}
   */
  async function sendMessageWithFiles(channelId, message, files, creds, callbacks) {
    const { body, publicKey } = await window.SophiaAuth.signMessage(message || '');
    const url = window.SophiaAuth.baseUrl() + '/chat/upload';

    const form = new FormData();
    const list = Array.from(files || []);
    list.forEach((f) => form.append('files', f));

    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Public-Key': publicKey,
        'X-Payload': JSON.stringify(body.payload),
        'X-Signature': body.signature,
        'X-Session-Id': sessionIdFor(channelId),
      },
      body: form,
    });

    if (!resp.ok || !resp.body) {
      let detail = 'HTTP ' + resp.status;
      try {
        const j = await resp.json();
        if (j && (j.detail || j.error)) detail = j.detail || j.error;
      } catch (e) { /* ignore */ }
      throw new Error(detail);
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalText = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = parseSSE(buffer);
      const lastNewline = buffer.lastIndexOf('\n\n');
      if (lastNewline >= 0) buffer = buffer.slice(lastNewline + 2);
      for (const evt of events) {
        if (callbacks.onEvent) callbacks.onEvent(evt);
        if (evt.type === 'done' && evt.response != null) finalText = evt.response;
      }
    }

    if (callbacks.onDone) callbacks.onDone(finalText || '');
    return finalText || '';
  }

  /**
   * Find renderable attachments in a reply string. Returns a list of
   * {type:'image'|'file', url} resolved against the Sophia base URL.
   */
  function detectAttachments(text, baseUrl) {
    const out = [];
    const base = (baseUrl || '').replace(/\/+$/, '');
    const seen = new Set();

    const markdown = /!\[[^\]]*\]\((https?:\/\/[^\s)]+|\/uploads\/[^\s)]+)\)/g;
    const bareUpload = /(^|[\s(])(\/uploads\/[A-Za-z0-9._-]+)/g;
    const bareHttp = /(https?:\/\/[^\s)]+\.(?:png|jpe?g|gif|webp|svg)(?:\?[^\s)]*)?)/gi;

    const push = (raw, type) => {
      let u = raw;
      if (u.startsWith('/')) u = base + u;
      if (seen.has(u)) return;
      seen.add(u);
      out.push({ type, url: u });
    };

    let m;
    while ((m = markdown.exec(text)) !== null) push(m[1], 'image');
    while ((m = bareUpload.exec(text)) !== null) push(m[2], 'image');
    while ((m = bareHttp.exec(text)) !== null) push(m[1], 'image');

    return out;
  }

  /**
   * Extract image files from a paste event's clipboard items. Non-file and
   * non-image items are ignored. Pasted images get a deterministic timestamped
   * name, since clipboard-provided names are often empty or "image.png".
   * @param {DataTransferItemList|Array} items
   * @returns {File[]}
   */
  function imageFilesFromClipboardItems(items) {
    const out = [];
    let counter = 0;
    const stamp = Date.now();
    for (const item of Array.from(items || [])) {
      if (!item || item.kind !== 'file') continue;
      const type = (item.type || '').toLowerCase();
      if (type.indexOf('image/') !== 0) continue;
      let file = null;
      try { file = item.getAsFile(); } catch (e) { file = null; }
      if (!file) continue;
      const ext = (type.split('/')[1] || 'png').replace(/^jpeg$/, 'jpg');
      counter += 1;
      const name = 'pasted-' + stamp + '-' + counter + '.' + ext;
      out.push(new File([file], name, { type }));
    }
    return out;
  }

  window.SophiaChat = {
    sendMessage,
    sendMessageWithFiles,
    loadHistory,
    parseSSE,
    detectAttachments,
    imageFilesFromClipboardItems,
    sessionIdFor,
  };
})();
