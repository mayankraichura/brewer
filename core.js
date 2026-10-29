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
    constructor(opt) { super(); this.kind = 'demo'; this.opt = opt || {}; this.t = 0; this.timer = null; this.running = false; this.pending = false; }
    async connect() {
      this.emit('status', { connected: true, text: 'Demo' });
      this.emit('battery', { which: 'brewer', pct: 87 }); this.emit('battery', { which: 'scale', pct: 64 });
      if (!this.opt.manual) this.timer = setInterval(() => this.step(0.1), 100);
    }
    disconnect() { clearInterval(this.timer); this.timer = null; this.emit('status', { connected: false, text: 'Not connected' }); }
    async send(cmd) {
      if (/^Brew start/i.test(cmd)) { this.running = true; this.t = 0; }
      else if (/^Brew (stop|end)/i.test(cmd)) this.running = false;
      this.emit('reply', { id: null, text: JSON.stringify({ ack: 1, cmd }) });
    }
    step(dt) {
      if (this.running) this.t += dt;
      const t = this.t, poured = t > 0 ? [0, 45, 65, 85, 105].filter(x => t >= x).length : 0;
      const pourAt = [[0, 12], [45, 55], [65, 75], [85, 95], [105, 113]];
      let w = 0;
      for (const [a, b] of pourAt) w += 50 * Math.min(1, Math.max(0, (t - a) / (b - a)));
      const open = pourAt.some(([a, b]) => t >= a && t < b);
      const temp = 30 + 56 * (1 - Math.exp(-t / 12)) * (t > 0 ? 1 : 0.1) - Math.max(0, t - 120) * 0.15;
      this.emit('live', {
        temp: this.running || t > 0 ? temp : 24.5, cj: 24.1, weight: w, state: this.running ? 1 : 0,
        elapsedMs: Math.round(t * 1000), pours: poured, auto: true, pourOpen: open && this.running, weightMode: true,
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
        if (this.brew.length < this.maxBrew) this.brew.push([t, l.temp, l.weight]);
      } else {
        this.live.push([nowS, l.temp, l.weight]);
        while (this.live.length && nowS - this.live[0][0] > this.liveWin) this.live.shift();
      }
      this.state = l.state;
    }
    // What the chart shows: points [t, temp, weight], x range, the weight axis top (0 = no weight), pour spans.
    view() {
      const brewView = this.state !== 0;
      if (brewView) {
        const el = this.last ? this.last.elapsedMs / 1000 : 0;
        const pours = this.pours.map(p => [p[0], p[1] == null ? el : p[1]]);
        return { brewView, pts: this.brew, x0: 0, x1: Math.max(210, el + 20), wtop: BrewTrace.weightTop(this.brew), pours };
      }
      return { brewView, pts: this.live, x0: this.clock - this.liveWin, x1: this.clock, wtop: 0, pours: [] };
    }
    // Weight axis top: at least 300 g, rounded up to 50 g; 0 when the brew has no weights.
    static weightTop(pts) {
      let m = -1e9, has = false;
      for (const p of pts) if (p[2] != null) { has = true; if (p[2] > m) m = p[2]; }
      return has ? Math.max(300, Math.ceil(m / 50) * 50) : 0;
    }
  }

  root.BU = {
    BrewTrace,
    SCALE, BREWER, BAT_SVC, BAT_LEVEL, parseScalePacket, parseLive, buildLive, parseInfo, FrameJoin, buildCommand,
    DemoTransport, WsTransport, BleBrewerTransport, BleScaleTransport,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.BU;
})(typeof window !== 'undefined' ? window : globalThis);
