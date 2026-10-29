// Pure parts of the Brewer UI (no DOM): packet decoders and the three transports.
// Runs in the browser (window.BU) and in Node (module.exports) so `node test.js` can test it.
//
// Every transport gives the page the same events, so the page does not care where the data comes from:
//   'live'    {temp, cj, weight, state, elapsedMs, pours, auto, pourOpen, weightMode, scaleConnected, sim, fault, scaleBat, rssi}
//             temp, cj, weight are numbers or null; scaleBat is 0..100 or null.
//   'battery' {which: 'brewer'|'scale', pct}
//   'status'  {connected: bool, text: string}
//   'reply'   {id, text}              (answer to send())
// and the same methods: connect(), disconnect(), send(command) -> Promise.
(function (root) {
  'use strict';

  // ---- UUIDs ----
  // C1 (BrewScale, final) and C3 (Brewer, DRAFT v0.1 in handoff/C3-draft.md: change them only with the contract).
  const SCALE = {
    SVC: 'b5a10001-5e1d-4c2a-9a3b-2f3c8d6e0001', WEIGHT: 'b5a10002-5e1d-4c2a-9a3b-2f3c8d6e0001',
    CMD: 'b5a10003-5e1d-4c2a-9a3b-2f3c8d6e0001', NAME: 'BrewScale',
  };
  const BREWER = {
    SVC: 'b5a20001-5e1d-4c2a-9a3b-2f3c8d6e0001', LIVE: 'b5a20002-5e1d-4c2a-9a3b-2f3c8d6e0001',
    CMD: 'b5a20003-5e1d-4c2a-9a3b-2f3c8d6e0001', RESP: 'b5a20004-5e1d-4c2a-9a3b-2f3c8d6e0001',
    DATA: 'b5a20005-5e1d-4c2a-9a3b-2f3c8d6e0001', INFO: 'b5a20006-5e1d-4c2a-9a3b-2f3c8d6e0001',
    NAME: 'Brewer', PROTOCOL: 1,   // protocol version of the draft
  };
  const BAT_SVC = 0x180f, BAT_LEVEL = 0x2a19;   // standard Battery Service

  // ---- C1: scale weight packet, 7 bytes ----
  function parseScalePacket(dv) {
    if (!dv || dv.byteLength < 7) return null;
    const cg = dv.getInt32(0, true), seq = dv.getUint16(4, true), flags = dv.getUint8(6);
    const noData = (flags & 4) !== 0;
    return { seq, flags, noData, tared: !!(flags & 1), calibrated: !!(flags & 2), g: noData ? null : cg / 100 };
  }

  // ---- C3 draft: live packet, 17 bytes ----
  function parseLive(dv) {
    if (!dv || dv.byteLength < 17) return null;
    const t = dv.getInt16(0, true), cj = dv.getInt16(2, true), w = dv.getInt32(4, true);
    const f = dv.getUint8(14), bat = dv.getUint8(16);
    return {
      temp: t === -32768 ? null : t / 100, cj: cj === -32768 ? null : cj / 100,
      weight: w === -2147483648 ? null : w / 100,
      state: dv.getUint8(8), elapsedMs: dv.getUint32(9, true), pours: dv.getUint8(13),
      auto: !!(f & 1), pourOpen: !!(f & 2), weightMode: !!(f & 4), scaleConnected: !!(f & 8), sim: !!(f & 16),
      fault: dv.getUint8(15), scaleBat: bat === 255 ? null : bat, rssi: null,
    };
  }
  function buildLive(o) {   // inverse of parseLive: used by the tests and the fake GATT server
    const dv = new DataView(new ArrayBuffer(17));
    dv.setInt16(0, o.temp == null ? -32768 : Math.round(o.temp * 100), true);
    dv.setInt16(2, o.cj == null ? -32768 : Math.round(o.cj * 100), true);
    dv.setInt32(4, o.weight == null ? -2147483648 : Math.round(o.weight * 100), true);
    dv.setUint8(8, o.state | 0); dv.setUint32(9, o.elapsedMs >>> 0, true); dv.setUint8(13, o.pours | 0);
    dv.setUint8(14, (o.auto ? 1 : 0) | (o.pourOpen ? 2 : 0) | (o.weightMode ? 4 : 0) | (o.scaleConnected ? 8 : 0) | (o.sim ? 16 : 0));
    dv.setUint8(15, o.fault | 0); dv.setUint8(16, o.scaleBat == null ? 255 : o.scaleBat);
    return dv;
  }

  function parseInfo(dv) {   // uint16 protocol, uint16 capabilities, UTF-8 firmware name and version
    if (!dv || dv.byteLength < 4) return null;
    const text = new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset + 4, dv.byteLength - 4));
    return { protocol: dv.getUint16(0, true), caps: dv.getUint16(2, true), firmware: text };
  }

  // Reply frames: 1-byte header (bit7 = last frame, bits0-6 = frame number) + at most 19 bytes of text.
  class FrameJoin {
    constructor() { this.parts = []; this.next = 0; }
    reset() { this.parts = []; this.next = 0; }
    // returns the complete text when the last frame arrived, else null; a gap in the numbers drops the message
    feed(dv) {
      if (!dv || dv.byteLength < 1) return null;
      const h = dv.getUint8(0), n = h & 0x7f, last = (h & 0x80) !== 0;
      if (n === 0) this.reset();
      if (n !== this.next) { this.reset(); return null; }
      this.parts.push(new Uint8Array(dv.buffer, dv.byteOffset + 1, dv.byteLength - 1).slice());
      this.next++;
      if (!last) return null;
      let len = 0; for (const p of this.parts) len += p.length;
      const all = new Uint8Array(len); let o = 0;
      for (const p of this.parts) { all.set(p, o); o += p.length; }
      this.reset();
      return new TextDecoder().decode(all);
    }
  }

  let cmdId = 0;
  const buildCommand = (cmd, id) => 'c|' + (id == null ? ++cmdId : id) + '|' + cmd;

  // ---- tiny event base ----
  class Emitter {
    constructor() { this.h = {}; }
    on(ev, fn) { (this.h[ev] = this.h[ev] || []).push(fn); return this; }
    emit(ev, d) { for (const fn of this.h[ev] || []) { try { fn(d); } catch (e) { if (typeof console !== 'undefined') console.error(e); } } }
  }

  // ---- Transport 1: demo (no hardware) ----
  // A 3 minute pour-over: bloom at 0 s, pours of 50 g at 45, 65, 85, 105 s. `timer` can be replaced in tests.
  class DemoTransport extends Emitter {
    constructor(opt) { super(); this.kind = 'demo'; this.opt = opt || {}; this.t = 0; this.timer = null; this.st = 0; }
    get running() { return this.st === 1; }
    async connect() {
      this.emit('status', { connected: true, text: 'Demo' });
      this.emit('battery', { which: 'brewer', pct: 87 }); this.emit('battery', { which: 'scale', pct: 64 });
      if (!this.opt.manual) this.timer = setInterval(() => this.step(0.1), 100);
    }
    disconnect() { clearInterval(this.timer); this.timer = null; this.emit('status', { connected: false, text: 'Not connected' }); }
    // state as the Brewer has it: 0 idle, 1 running, 2 paused (a finished brew stays on the chart until `Brew end`)
    async send(cmd) {
      let m;
      if (/^Brew start/i.test(cmd)) { this.st = 1; this.t = 0; }
      else if (/^Brew (stop|pause)/i.test(cmd)) { if (this.st === 1) this.st = 2; }
      else if (/^Brew end/i.test(cmd)) { this.st = 0; this.t = 0; }
      else if ((m = /^BrewKettle ([\d.]+)/i.exec(cmd))) { this.st = 2; this.emit('kettle', { c: parseFloat(m[1]) }); }
      this.emit('reply', { id: null, text: JSON.stringify({ ack: 1, cmd }) });
    }
    step(dt) {
      if (this.st === 1) this.t += dt;
      const t = this.t, poured = t > 0 ? [0, 45, 65, 85, 105].filter(x => t >= x).length : 0;
      const pourAt = [[0, 12], [45, 55], [65, 75], [85, 95], [105, 113]];
      let w = 0;
      for (const [a, b] of pourAt) w += 50 * Math.min(1, Math.max(0, (t - a) / (b - a)));
      const open = pourAt.some(([a, b]) => t >= a && t < b);
      const temp = 30 + 56 * (1 - Math.exp(-t / 12)) * (t > 0 ? 1 : 0.1) - Math.max(0, t - 120) * 0.15;
      this.emit('live', {
        temp: this.st || t > 0 ? temp : 24.5, cj: 24.1, weight: w, state: this.st,
        elapsedMs: Math.round(t * 1000), pours: poured, auto: true, pourOpen: open && this.st === 1, weightMode: true,
        scaleConnected: true, sim: true, fault: 0, scaleBat: 64, rssi: null,
      });
    }
  }

  // ---- Transport 2: WebSocket, the current Wi-Fi protocol of the old page (transition only) ----
  // JSON per tick: {"t","cj","fault","rssi","ms","r","bs","el","k","np","au","po","sim","w","wc","wm"}
  // Page -> board: "c|<id>|<command>", answered with {"ack":id}. Needs ws:// so only from http://, not from https Pages.
  class WsTransport extends Emitter {
    constructor(url, WS) { super(); this.kind = 'ws'; this.url = url; this.WS = WS || (typeof WebSocket !== 'undefined' ? WebSocket : null); this.ws = null; this.waiting = {}; }
    static mapLive(m) {
      return {
        temp: m.t == null ? null : m.t, cj: m.cj == null ? null : m.cj, weight: m.w == null ? null : m.w,
        state: m.bs | 0, elapsedMs: m.el | 0, pours: m.np | 0, auto: !!m.au, pourOpen: !!m.po, weightMode: !!m.wm,
        scaleConnected: !!m.wc, sim: !!m.sim, fault: m.fault && m.fault !== 'ok' && m.fault !== '' ? 1 : 0,
        scaleBat: null, rssi: m.rssi || null,
      };
    }
    connect() {
      return new Promise((res, rej) => {
        if (!this.WS) return rej(new Error('No WebSocket here'));
        const ws = this.ws = new this.WS(this.url);
        ws.onopen = () => { this.emit('status', { connected: true, text: 'Wi-Fi' }); res(); };
        ws.onerror = () => rej(new Error('WebSocket failed'));
        ws.onclose = () => this.emit('status', { connected: false, text: 'Not connected' });
        ws.onmessage = ev => {
          let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.ack != null) { const r = this.waiting[m.ack]; if (r) { delete this.waiting[m.ack]; r(m); } this.emit('reply', { id: m.ack, text: ev.data }); }
          else if ('t' in m && 'bs' in m) this.emit('live', WsTransport.mapLive(m));
          else this.emit('reply', { id: null, text: ev.data });   // sync, hist, cfg ...: the brew logic step handles them later
        };
      });
    }
    disconnect() { if (this.ws) this.ws.close(); }
    // The board runs an id once, so a retry with the same id is safe (as in the old page: 4 tries).
    async send(cmd) {
      const id = ++cmdId, text = buildCommand(cmd, id);
      for (let i = 0; i < 4; i++) {
        const got = new Promise(r => { this.waiting[id] = r; });
        this.ws.send(text);
        const ok = await Promise.race([got, new Promise(r => setTimeout(() => r(null), this.retryMs || 1000))]);
        if (ok) return ok;
      }
      delete this.waiting[id];
      throw new Error('No answer from the board');
    }
  }

  // ---- Transport 3: Bluetooth to the Brewer (C3 draft) ----
  // `bluetooth` is navigator.bluetooth (or a fake in the tests).
  class BleBrewerTransport extends Emitter {
    constructor(bluetooth) { super(); this.kind = 'ble-brewer'; this.bt = bluetooth; this.dev = null; this.cmd = null; this.join = new FrameJoin(); this.waiting = {}; }
    async connect() {
      this.dev = await this.bt.requestDevice({ filters: [{ services: [BREWER.SVC] }, { name: BREWER.NAME }], optionalServices: [BREWER.SVC, BAT_SVC] });
      this.dev.addEventListener('gattserverdisconnected', () => this.emit('status', { connected: false, text: 'Connection lost' }));
      const server = await this.dev.gatt.connect(), svc = await server.getPrimaryService(BREWER.SVC);
      try {
        const info = parseInfo(await (await svc.getCharacteristic(BREWER.INFO)).readValue());
        if (info && info.protocol !== BREWER.PROTOCOL) this.emit('status', { connected: true, text: 'Brewer protocol ' + info.protocol + ': this page knows ' + BREWER.PROTOCOL });
        this.info = info;
      } catch (e) { /* info is optional in the draft */ }
      const live = await svc.getCharacteristic(BREWER.LIVE);
      live.addEventListener('characteristicvaluechanged', e => { const p = parseLive(e.target.value); if (p) this.emit('live', p); });
      await live.startNotifications();
      try {
        const rs = await svc.getCharacteristic(BREWER.RESP);
        rs.addEventListener('characteristicvaluechanged', e => {
          const text = this.join.feed(e.target.value); if (text == null) return;
          let id = null; try { id = JSON.parse(text).ack; } catch (er) { /* not JSON */ }
          const r = id != null && this.waiting[id]; if (r) { delete this.waiting[id]; r(text); }
          this.emit('reply', { id, text });
        });
        await rs.startNotifications();
        this.cmd = await svc.getCharacteristic(BREWER.CMD);
      } catch (e) { this.cmd = null; }
      try {   // the Brewer has no battery today: the service is optional
        const bs = await server.getPrimaryService(BAT_SVC), bc = await bs.getCharacteristic(BAT_LEVEL);
        bc.addEventListener('characteristicvaluechanged', e => this.emit('battery', { which: 'brewer', pct: e.target.value.getUint8(0) }));
        await bc.startNotifications();
        this.emit('battery', { which: 'brewer', pct: (await bc.readValue()).getUint8(0) });
      } catch (e) { /* no battery service */ }
      this.emit('status', { connected: true, text: 'Bluetooth' });
    }
    disconnect() { if (this.dev && this.dev.gatt.connected) this.dev.gatt.disconnect(); }
    async send(cmd) {
      if (!this.cmd) throw new Error('No command channel');
      const id = ++cmdId, text = buildCommand(cmd, id);
      const got = new Promise((res, rej) => { this.waiting[id] = res; setTimeout(() => { if (this.waiting[id]) { delete this.waiting[id]; rej(new Error('No answer from the Brewer')); } }, this.timeoutMs || 6000); });
      await this.cmd.writeValueWithResponse(new TextEncoder().encode(text));
      return got;
    }
  }

  // ---- Transport 4: Bluetooth to the scale alone (C1, final) ----
  // Only works when nothing else (the Brewer) holds the scale. Writes only `t` (tare), after a user tap, as C1 v1.1 allows.
  class BleScaleTransport extends Emitter {
    constructor(bluetooth) { super(); this.kind = 'ble-scale'; this.bt = bluetooth; this.dev = null; this.cmd = null; }
    async connect() {
      this.dev = await this.bt.requestDevice({ filters: [{ services: [SCALE.SVC] }, { name: SCALE.NAME }], optionalServices: [SCALE.SVC, BAT_SVC] });
      this.dev.addEventListener('gattserverdisconnected', () => this.emit('status', { connected: false, text: 'Connection lost' }));
      const server = await this.dev.gatt.connect(), svc = await server.getPrimaryService(SCALE.SVC);
      const ch = await svc.getCharacteristic(SCALE.WEIGHT);
      ch.addEventListener('characteristicvaluechanged', e => {
        const p = parseScalePacket(e.target.value); if (!p) return;
        this.emit('live', { temp: null, cj: null, weight: p.g, state: 0, elapsedMs: 0, pours: 0, auto: false, pourOpen: false, weightMode: true, scaleConnected: true, sim: false, fault: p.noData ? 4 : 0, scaleBat: null, rssi: null });
      });
      await ch.startNotifications();
      try { this.cmd = await svc.getCharacteristic(SCALE.CMD); } catch (e) { this.cmd = null; }
      try {
        const bs = await server.getPrimaryService(BAT_SVC), bc = await bs.getCharacteristic(BAT_LEVEL);
        bc.addEventListener('characteristicvaluechanged', e => this.emit('battery', { which: 'scale', pct: e.target.value.getUint8(0) }));
        await bc.startNotifications();
        this.emit('battery', { which: 'scale', pct: (await bc.readValue()).getUint8(0) });
      } catch (e) { /* old firmware: no battery service */ }
      this.emit('status', { connected: true, text: 'Scale only' });
    }
    disconnect() { if (this.dev && this.dev.gatt.connected) this.dev.gatt.disconnect(); }
    async send(cmd) {
      if (cmd !== 't') throw new Error('The page may only send t (tare) to the scale');
      if (!this.cmd) throw new Error('No command channel');
      await this.cmd.writeValueWithResponse(new TextEncoder().encode('t'));
      return 'sent';
    }
  }

  // ---- Chart data ----
  // Collects the live packets. While a brew runs or is paused (state 1, 2) the whole brew is kept, time = brew time.
  // When idle (state 0) the last `liveWin` seconds are kept, time = seconds since the page started.
  // Pour spans come from the pourOpen flag. Same idea as the old page: brew view while bs != 0, live view otherwise.
  class BrewTrace {
    constructor(opt) {
      opt = opt || {};
      this.liveWin = opt.liveWin || 60; this.maxBrew = opt.maxBrew || 4800 + 600;   // 8 min at 10 Hz, a little extra
      this.live = []; this.brew = []; this.pours = []; this.state = 0; this.last = null; this.clock = 0;
    }
    // l = a 'live' event; nowS = wall clock in seconds (only used for the live window)
    push(l, nowS) {
      this.last = l; this.clock = nowS;
      if (l.state !== 0) {
        if (this.state === 0) { this.brew = []; this.pours = []; }   // a new brew starts
        const t = l.elapsedMs / 1000, open = this.pours.length && this.pours[this.pours.length - 1][1] == null;
        if (l.pourOpen && !open) this.pours.push([t, null]);
        else if (!l.pourOpen && open) this.pours[this.pours.length - 1][1] = t;
        if (this.brew.length < this.maxBrew) this.brew.push([t, l.temp, BrewTrace.okWeight(l.weight)]);
      } else {
        this.live.push([nowS, l.temp, BrewTrace.okWeight(l.weight)]);
        while (this.live.length && nowS - this.live[0][0] > this.liveWin) this.live.shift();
      }
      this.state = l.state;
    }
    // What the chart shows: points [t, temp, weight], x range, the weight axis top (0 = no weight), pour spans.
    view() {
      const brewView = this.state !== 0;
      if (brewView) {
        const el = this.last ? this.last.elapsedMs / 1000 : 0;
        const pours = this.pours.map(p => [p[0], p[1] == null ? el : p[1], p[1] == null]);
        return { brewView, pts: this.brew, x0: 0, x1: Math.max(210, el + 20), wtop: BrewTrace.weightTop(this.brew), pours };
      }
      return { brewView, pts: this.live, x0: this.clock - this.liveWin, x1: this.clock, wtop: 0, pours: [] };
    }
    // A weight below -5 g means the scale was lifted or the dripper was moved (b11.csv: -140 g for 2.6 s): a gap, not a value.
    static okWeight(w) { return w == null || w < -5 ? null : w; }
    // Weight axis top: at least 300 g, rounded up to 50 g; 0 when the brew has no weights.
    static weightTop(pts) {
      let m = -1e9, has = false;
      for (const p of pts) if (p[2] != null) { has = true; if (p[2] > m) m = p[2]; }
      return has ? Math.max(300, Math.ceil(m / 50) * 50) : 0;
    }
  }

  // ---- C2 brew CSV: time_s,temp_c,event,weight_g ----
  // Sample rows have an empty event field (index k = k*0.1 s); event rows carry their OWN time, which is earlier than the
  // row before them (the Brewer writes an event when it detects it), so the file order is not the time order.
  // Identical event rows (the kettle row twice in b11.csv) are counted once.
  function parseBrewCsv(text) {
    const samples = [], events = [], seen = new Set(); let dupes = 0;
    for (const ln of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
      const f = ln.trim().split(',');
      const t = parseFloat(f[0]);
      if (!isFinite(t)) continue;   // header, blank line
      const ev = (f[2] || '').trim();
      if (ev) {
        const key = t + '|' + ev;
        if (seen.has(key)) { dupes++; continue; }
        seen.add(key); events.push({ t, name: ev });
      } else {
        const T = parseFloat(f[1]), W = parseFloat(f[3]);
        samples.push([t, isFinite(T) ? T : null, isFinite(W) ? W : null]);
      }
    }
    events.sort((a, b) => a.t - b.t);
    const last = samples.length ? samples[samples.length - 1][0] : 0;
    const endEv = events.find(e => e.name === 'end');
    const duration = endEv ? endEv.t : last;
    // pours: bloom = pour 1; "pour N [auto]" opens pour N; "stop N" closes it; a pour left open ends at the next start
    const open = {}, list = [];
    for (const e of events) {
      let m;
      if (e.name === 'bloom') { const p = { n: 1, start: e.t, end: null }; open[1] = p; list.push(p); }
      else if ((m = /^pour (\d+)/.exec(e.name))) { const p = { n: +m[1], start: e.t, end: null }; open[p.n] = p; list.push(p); }
      else if ((m = /^stop (\d+)/.exec(e.name)) && open[+m[1]]) { open[+m[1]].end = e.t; }
    }
    list.sort((a, b) => a.start - b.start);
    list.forEach((p, i) => { if (p.end == null) p.end = i + 1 < list.length ? list[i + 1].start : duration; });
    const kEv = events.filter(e => /^kettle /.test(e.name)).pop();
    return {
      samples, events, dupes, duration, pours: list.map(p => [p.start, p.end]),
      kettle: kEv ? parseFloat(kEv.name.slice(7)) : null, hasWeight: samples.some(p => p[2] != null),
    };
  }

  // value of column `col` (1 temp, 2 weight) at time t: the nearest sample (binary search on sorted points)
  function valueAt(pts, t, col) {
    let lo = 0, hi = pts.length - 1;
    if (hi < 0) return null;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (pts[mid][0] < t) lo = mid + 1; else hi = mid; }
    if (lo > 0 && Math.abs(pts[lo - 1][0] - t) < Math.abs(pts[lo][0] - t)) lo--;
    return pts[lo][col];
  }
  // A CLOSED pour that added less than this is not a pour (b11.csv: pour 6 added 8.7 g, the user poured 5 times). A pour that is
  // still open is never small. This is a page-side rule until the Brewer stops reporting such pours itself.
  const MIN_POUR_G = 15;
  // chips under the chart: number, start, duration, grams (weight at the end minus weight at the start); span = [start, end, open?]
  function pourChips(spans, pts) {
    return spans.map((p, i) => {
      const a = valueAt(pts, p[0], 2), b = valueAt(pts, p[1], 2), g = a == null || b == null ? null : b - a;
      return { i, label: i ? String(i + 1) : 'B', start: p[0], end: p[1], dur: p[1] - p[0], g, small: i > 0 && !p[2] && g != null && g < MIN_POUR_G };
    });
  }
  // only the real pours, numbered again in order (B, 2, 3 ...); `ignored` = how many were dropped
  function realChips(spans, pts) {
    const all = pourChips(spans, pts), real = all.filter(c => !c.small);
    real.forEach((c, k) => { c.label = k ? String(k + 1) : 'B'; c.i = k; });
    return { chips: real, ignored: all.length - real.length };
  }

  // Scaled view: the curve as if the kettle had been at `kref`: T' = t0 + (T - t0) / (kettle - t0) * (kref - t0),
  // t0 = mean of the first 10 temperatures (the cold probe and dripper).
  function t0Of(pts) {
    let s = 0, n = 0;
    for (const p of pts) if (p[1] != null) { s += p[1]; if (++n >= 10) break; }
    return n ? s / n : null;
  }
  function scaleT(T, t0, kettle, kref) {
    if (T == null || t0 == null || !(kettle > t0)) return T;
    return t0 + (T - t0) / (kettle - t0) * (kref - t0);
  }

  // Reference curve: a finished brew kept for comparison.
  function makeRef(brew, name) {
    const t0 = t0Of(brew.samples);
    return { name: name || '', kettle: brew.kettle, t0, v: brew.samples.map(p => p[1] == null ? null : Math.round(p[1] * 100) / 100), p: realChips(brew.pours, brew.samples.map(p => [p[0], p[1], BrewTrace.okWeight(p[2])])).chips.map(c => c.start) };
  }
  // reference temperature at brew time t; with kref, scaled with the reference's own kettle temperature
  function refValue(ref, t, kref) {
    const v = ref.v[Math.round(t * 10)];
    if (v == null) return null;
    return kref != null && ref.kettle ? scaleT(v, ref.t0, ref.kettle, kref) : v;
  }

  // ---- Transport 5: replay of a recorded brew (C2 CSV) ----
  // Plays the recorded samples as live packets: 10 Hz of brew time, `speed` times faster. It uses the RECORDED events (pours,
  // kettle); it does not detect pours again, the Brewer does that. At the end the state is 2 (paused) and 'kettle' is emitted.
  class ReplayTransport extends Emitter {
    constructor(brew, opt) {
      super(); this.kind = 'replay'; this.b = brew; this.opt = opt || {}; this.speed = this.opt.speed || 1;
      this.idx = -1; this.playing = false; this.done = false; this.timer = null; this.carry = 0; this.lastWall = 0;
    }
    async connect() {
      this.emit('status', { connected: true, text: 'Replay' });
      if (!this.opt.manual) this.play();
    }
    disconnect() { this.pause(); this.emit('status', { connected: false, text: 'Not connected' }); }
    async send() { return JSON.stringify({ ack: 0 }); }   // commands do nothing in a replay
    play() {
      if (this.done) this.restart();
      this.playing = true; this.lastWall = Date.now();
      if (!this.opt.manual && !this.timer) this.timer = setInterval(() => { const n = Date.now(), dt = (n - this.lastWall) / 1000; this.lastWall = n; this.step(dt * this.speed); }, 100);
    }
    pause() { this.playing = false; clearInterval(this.timer); this.timer = null; }
    setSpeed(x) { this.speed = x; }
    restart() { this.idx = -1; this.done = false; this.carry = 0; this.emit('status', { connected: true, text: 'Replay' }); }
    // advance by dt seconds of BREW time; every recorded sample on the way is emitted
    step(dt) {
      const S = this.b.samples; if (!S.length || this.done) return;
      this.carry += dt;
      let n = Math.floor(this.carry * 10 + 1e-9);
      this.carry -= n / 10;
      while (n-- > 0 && !this.done) {
        this.idx++;
        const p = S[this.idx], t = p[0], last = this.idx >= S.length - 1;
        this.emit('live', {
          temp: p[1], cj: null, weight: p[2], state: last ? 2 : 1, elapsedMs: Math.round(t * 1000),
          pours: this.b.pours.filter(q => q[0] <= t).length, auto: true, pourOpen: this.b.pours.some(q => q[0] <= t && t < q[1]),
          weightMode: this.b.hasWeight, scaleConnected: this.b.hasWeight, sim: true, fault: 0, scaleBat: null, rssi: null,
        });
        if (last) {
          this.done = true; this.pause();
          if (this.b.kettle != null) this.emit('kettle', { c: this.b.kettle });
          this.emit('status', { connected: true, text: 'Replay done' });
        }
      }
    }
    progress() { const n = this.b.samples.length; return n ? Math.max(0, this.idx) / n : 0; }
  }

  root.BU = {
    parseBrewCsv, valueAt, pourChips, realChips, MIN_POUR_G, t0Of, scaleT, makeRef, refValue, ReplayTransport,
    BrewTrace,
    SCALE, BREWER, BAT_SVC, BAT_LEVEL, parseScalePacket, parseLive, buildLive, parseInfo, FrameJoin, buildCommand,
    DemoTransport, WsTransport, BleBrewerTransport, BleScaleTransport,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.BU;
})(typeof window !== 'undefined' ? window : globalThis);
