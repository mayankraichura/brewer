// node test.js : decoders, frame joining, the transports (with a fake GATT server and a fake WebSocket), and wiring of the page files.
const assert = require('assert'), fs = require('fs');
const BU = require('./core.js');
const dv = a => { const u = Uint8Array.from(a); return new DataView(u.buffer); };

// 1. C3 draft live packet: golden bytes (17 bytes, little endian). Same bytes must go in handoff/c3-vectors.md.
const golden = [0x4A,0x22, 0x0A,0x09, 0xB0,0xAD,0x01,0x00, 0x01, 0x10,0x27,0x00,0x00, 0x03, 0x0D, 0x00, 0x40];
let p = BU.parseLive(dv(golden));
assert.deepStrictEqual(p, { temp: 87.78, cj: 23.14, weight: 1100.0, state: 1, elapsedMs: 10000, pours: 3,
  auto: true, pourOpen: false, weightMode: true, scaleConnected: true, sim: false, fault: 0, scaleBat: 64, rssi: null });
assert.deepStrictEqual(Array.from(new Uint8Array(BU.buildLive(p).buffer)), golden);   // round trip
// "none" values
const none = BU.parseLive(BU.buildLive({ temp: null, cj: null, weight: null, state: 0, elapsedMs: 0, pours: 0, scaleBat: null }));
assert.strictEqual(none.temp, null); assert.strictEqual(none.cj, null); assert.strictEqual(none.weight, null); assert.strictEqual(none.scaleBat, null);
assert.strictEqual(BU.parseLive(dv([1, 2, 3])), null);   // too short
const neg = BU.parseLive(BU.buildLive({ temp: -5.5, weight: -0.2, state: 2, elapsedMs: 4294967295, pours: 255, fault: 255, scaleBat: 100, sim: true, pourOpen: true }));
assert.deepStrictEqual([neg.temp, neg.weight, neg.state, neg.elapsedMs, neg.pours, neg.fault, neg.scaleBat, neg.sim, neg.pourOpen], [-5.5, -0.2, 2, 4294967295, 255, 255, 100, true, true]);

// 2. C1 scale packet
const sp = BU.parseScalePacket(dv([0xE0, 0x4C, 0, 0, 0xFF, 0xFF, 3]));
assert.deepStrictEqual([sp.g, sp.seq, sp.tared, sp.calibrated, sp.noData], [196.8, 65535, true, true, false]);
assert.strictEqual(BU.parseScalePacket(dv([0, 0, 0, 0, 0, 0, 4])).g, null);
assert.strictEqual(BU.parseScalePacket(dv([1, 2])), null);

// 3. info
const info = BU.parseInfo(dv([1, 0, 7, 0, ...Buffer.from('Brewer 0.1')]));
assert.deepStrictEqual(info, { protocol: 1, caps: 7, firmware: 'Brewer 0.1' });

// 4. reply frames: header bit7 = last, bits0-6 = number
const enc = s => Array.from(Buffer.from(s));
const fj = new BU.FrameJoin();
assert.strictEqual(fj.feed(dv([0, ...enc('{"ack":')])), null);
assert.strictEqual(fj.feed(dv([0x81, ...enc('12}')])), '{"ack":12}');
assert.strictEqual(fj.feed(dv([0x80, ...enc('{"x":1}')])), '{"x":1}');           // one frame message
assert.strictEqual(fj.feed(dv([0, ...enc('aa')])), null);
assert.strictEqual(fj.feed(dv([0x82, ...enc('cc')])), null);                      // frame 1 lost: dropped
assert.strictEqual(fj.feed(dv([0x80, ...enc('ok')])), 'ok');                      // and the next message is fine
assert.strictEqual(BU.buildCommand('ScaleTare', 5), 'c|5|ScaleTare');

// 5. fake GATT server (an event target per characteristic)
class Chr {
  constructor(v) { this.value = v; this.h = []; this.written = []; this.notifying = false; }
  addEventListener(_, f) { this.h.push(f); }
  async startNotifications() { this.notifying = true; }
  async readValue() { return this.value; }
  async writeValueWithResponse(b) { this.written.push(Buffer.from(b).toString()); if (this.onWrite) this.onWrite(this.written[this.written.length - 1]); }
  push(v) { this.value = v; this.h.forEach(f => f({ target: this })); }
}
function fakeBt(services, name) {
  const dev = { gatt: { connected: false, async connect() { dev.gatt.connected = true; return srv; }, disconnect() { dev.gatt.connected = false; dev.hs.forEach(f => f()); } },
    hs: [], addEventListener(_, f) { dev.hs.push(f); } };
  const srv = { async getPrimaryService(u) { const s = services[u]; if (!s) throw new Error('no service ' + u); return { async getCharacteristic(c) { const x = s[c]; if (!x) throw new Error('no chr'); return x; } }; } };
  return { req: null, async requestDevice(o) { this.req = o; return dev; }, dev };
}
(async () => {
  // Brewer over Bluetooth
  const C = BU.BREWER, chr = { [C.LIVE]: new Chr(), [C.CMD]: new Chr(), [C.RESP]: new Chr(), [C.INFO]: new Chr(dv([1, 0, 0, 0, ...enc('Brewer 0.1')])) };
  const bat = new Chr(dv([81])), bt = fakeBt({ [C.SVC]: chr, [BU.BAT_SVC]: { [BU.BAT_LEVEL]: bat } });
  const t = new BU.BleBrewerTransport(bt), ev = [];
  ['live', 'battery', 'status', 'reply'].forEach(e => t.on(e, d => ev.push([e, d])));
  await t.connect();
  assert.deepStrictEqual(bt.req.filters, [{ services: [C.SVC] }, { name: 'Brewer' }]);
  assert.ok(ev.some(([e, d]) => e === 'battery' && d.which === 'brewer' && d.pct === 81));
  assert.ok(ev.some(([e, d]) => e === 'status' && d.connected));
  chr[C.LIVE].push(dv(golden));
  assert.strictEqual(ev.filter(([e]) => e === 'live')[0][1].temp, 87.78);
  chr[C.CMD].onWrite = w => {   // the "Brewer": answers every command in two frames
    const id = w.split('|')[1], j = JSON.stringify({ ack: +id }), a = enc(j.slice(0, 5)), b = enc(j.slice(5));
    chr[C.RESP].push(dv([0, ...a])); chr[C.RESP].push(dv([0x81, ...b]));
  };
  const rep = JSON.parse(await t.send('ScaleTare'));
  assert.ok(rep.ack > 0); assert.ok(/^c\|\d+\|ScaleTare$/.test(chr[C.CMD].written[0]));
  // no answer -> error, not a hang
  chr[C.CMD].onWrite = null; t.timeoutMs = 30;
  await assert.rejects(t.send('Brew start'), /No answer/);
  // link loss
  bt.dev.gatt.disconnect();
  assert.ok(ev.some(([e, d]) => e === 'status' && !d.connected && d.text === 'Connection lost'));

  // Brewer without a battery service and without a command channel still works
  const bt2 = fakeBt({ [C.SVC]: { [C.LIVE]: new Chr() } }), t2 = new BU.BleBrewerTransport(bt2);
  await t2.connect(); await assert.rejects(t2.send('Brew start'), /No command channel/);

  // A Brewer with another protocol version is flagged
  const bt3 = fakeBt({ [C.SVC]: { [C.LIVE]: new Chr(), [C.INFO]: new Chr(dv([9, 0, 0, 0, 65])) } }), t3 = new BU.BleBrewerTransport(bt3), e3 = [];
  t3.on('status', s => e3.push(s)); await t3.connect();
  assert.ok(e3.some(s => /protocol 9/.test(s.text)));

  // Scale alone: C1 weight, battery, tare is the only command
  const S = BU.SCALE, sw = new Chr(), scmd = new Chr(), sb = new Chr(dv([64]));
  const bs = fakeBt({ [S.SVC]: { [S.WEIGHT]: sw, [S.CMD]: scmd }, [BU.BAT_SVC]: { [BU.BAT_LEVEL]: sb } }), ts = new BU.BleScaleTransport(bs), es = [];
  ['live', 'battery'].forEach(e => ts.on(e, d => es.push([e, d])));
  await ts.connect();
  sw.push(dv([0xE0, 0x4C, 0, 0, 1, 0, 3]));
  assert.strictEqual(es.find(([e]) => e === 'live')[1].weight, 196.8);
  assert.ok(es.some(([e, d]) => e === 'battery' && d.which === 'scale' && d.pct === 64));
  await ts.send('t'); assert.deepStrictEqual(scmd.written, ['t']);
  await assert.rejects(ts.send('c 100'), /only send t/);
  await assert.rejects(ts.send('ota'), /only send t/);
  assert.deepStrictEqual(scmd.written, ['t']);

  // WebSocket transport with a fake socket: live mapping and retry with the same id
  class FakeWS { constructor(u) { FakeWS.last = this; this.sent = []; setTimeout(() => this.onopen(), 0); } send(s) { this.sent.push(s); if (FakeWS.answerAt && this.sent.length >= FakeWS.answerAt) this.onmessage({ data: JSON.stringify({ ack: +s.split('|')[1] }) }); } close() { this.onclose(); } }
  const tw = new BU.WsTransport('ws://x/ws', FakeWS), ew = [];
  tw.on('live', l => ew.push(l)); tw.retryMs = 20; await tw.connect();
  FakeWS.last.onmessage({ data: '{"t":88.5,"cj":24.0,"fault":"ok","rssi":-60,"ms":1,"r":88.4,"bs":1,"el":12300,"k":123,"np":2,"au":1,"po":1,"sim":0,"w":150.25,"wc":1,"wm":1}' });
  assert.deepStrictEqual([ew[0].temp, ew[0].weight, ew[0].state, ew[0].elapsedMs, ew[0].pours, ew[0].auto, ew[0].pourOpen, ew[0].weightMode, ew[0].scaleConnected, ew[0].fault], [88.5, 150.25, 1, 12300, 2, true, true, true, true, 0]);
  FakeWS.last.onmessage({ data: '{"t":null,"cj":null,"fault":"open circuit","rssi":0,"ms":1,"r":null,"bs":0,"el":0,"k":-1,"np":0,"au":0,"po":0,"sim":0,"w":null,"wc":0,"wm":0}' });
  assert.strictEqual(ew[1].temp, null); assert.strictEqual(ew[1].weight, null); assert.strictEqual(ew[1].fault, 1);
  FakeWS.answerAt = 3;   // answered on the 3rd try
  await tw.send('Brew start');
  const ids = new Set(FakeWS.last.sent.map(s => s.split('|')[1]));
  assert.strictEqual(FakeWS.last.sent.length, 3); assert.strictEqual(ids.size, 1);   // same id on every retry
  FakeWS.answerAt = 99; await assert.rejects(tw.send('Brew stop'), /No answer/);

  // Demo: the numbers climb and the battery slots fill
  const td = new BU.DemoTransport({ manual: true }), ed = [];
  td.on('live', l => ed.push(l)); td.on('battery', b => ed.push(b));
  await td.connect(); await td.send('Brew start');
  for (let i = 0; i < 1200; i++) td.step(0.1);
  const lastLive = ed.filter(x => 'weight' in x).pop();
  assert.ok(Math.abs(lastLive.weight - 250) < 0.01); assert.strictEqual(lastLive.pours, 5); assert.ok(lastLive.temp > 60 && lastLive.temp < 100);
  assert.ok(ed.some(x => x.which === 'brewer') && ed.some(x => x.which === 'scale'));

  // 6. page wiring: the files that the page and the service worker name exist, no secrets or IPs are published
  const html = fs.readFileSync('index.html', 'utf8'), swText = fs.readFileSync('sw.js', 'utf8');
  for (const f of ['core.js', 'manifest.webmanifest', 'icon.svg', 'sw.js', 'index.html']) assert.ok(fs.existsSync(f), f);
  for (const f of ['core.js', 'manifest.webmanifest', 'icon.svg', 'index.html']) assert.ok(swText.includes("'" + f + "'"), 'sw caches ' + f);
  for (const k of ['Connect to Brewer', 'Connect to scale', 'bBrewer', 'bScale', "q.has('demo')", 'serviceWorker']) assert.ok(html.includes(k), k);
  for (const f of ['index.html', 'core.js', 'sw.js', 'README.md']) {
    if (!fs.existsSync(f)) continue;
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/\b(?:192\.168|10\.\d+\.\d+)\.\d+(?:\.\d+)?\b/.test(s), 'IP address in ' + f);
    assert.ok(!/WIFI_PASS|OTA_PASS|SCALE_AP_PASS/.test(s), 'secret name in ' + f);
  }
  console.log('all tests passed');
})().catch(e => { console.error(e); process.exit(1); });
