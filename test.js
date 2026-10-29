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

  // BrewTrace: live window, brew view, pour spans, weight axis
  const tc = new BU.BrewTrace({ liveWin: 5 }), L = (o) => Object.assign({ temp: 25, weight: 0, state: 0, elapsedMs: 0, pours: 0, pourOpen: false }, o);
  for (let i = 0; i < 100; i++) tc.push(L({ temp: 25 + i / 100 }), i / 10);   // 10 s idle at 10 Hz
  let vw = tc.view();
  assert.strictEqual(vw.brewView, false); assert.ok(vw.pts.length <= 52 && vw.pts.length >= 50); assert.strictEqual(vw.wtop, 0);
  for (let i = 0; i < 400; i++) {   // brew: pour open 5 s to 15 s, weight up to 350 g
    const t = i / 10; tc.push(L({ state: 1, elapsedMs: i * 100, temp: 80, weight: Math.min(350, t * 10), pourOpen: t >= 5 && t < 15 }), 10 + t);
  }
  vw = tc.view();
  assert.strictEqual(vw.brewView, true); assert.strictEqual(vw.pts.length, 400); assert.strictEqual(vw.x0, 0); assert.strictEqual(vw.x1, 210 > 59.9 ? 210 : 0);
  assert.strictEqual(vw.pours.length, 1); assert.deepStrictEqual(vw.pours[0], [5, 15, false]); assert.strictEqual(vw.wtop, 350);
  tc.push(L({ state: 0 }), 60); assert.strictEqual(tc.view().brewView, false);
  tc.push(L({ state: 1, elapsedMs: 0 }), 61); assert.strictEqual(tc.view().pts.length, 1);   // a new brew starts empty
  assert.strictEqual(BU.BrewTrace.weightTop([[0, 1, null]]), 0); assert.strictEqual(BU.BrewTrace.weightTop([[0, 1, 120]]), 300); assert.strictEqual(BU.BrewTrace.weightTop([[0, 1, 301]]), 350);

  // C2 CSV: out of order event rows, a duplicated kettle row, a scale lift (-140 g), an old 3 column file
  const synth = ['time_s,temp_c,event,weight_g', '0.0,,start', '0.0,,bloom'];
  for (let k = 0; k <= 400; k++) {
    const t = k / 10, w = t < 3 ? 0 : t < 13 ? (t - 3) * 5 : t < 32 ? 50 : t < 40 ? 50 + (t - 32) * 6 : 98;
    const lift = t >= 20 && t < 22.6;
    synth.push(t.toFixed(1) + ',' + (30 + t / 2).toFixed(2) + ',,' + (lift ? -140 : w).toFixed(1));
    if (k === 132) synth.push('12.9,,stop 1');          // detected 0.3 s later than it happened, written after the sample
    if (k === 322) synth.push('32.0,,pour 2 auto');
    if (k === 400) synth.push('39.4,,stop 2');
  }
  synth.push('40.0,,kettle 92.0', '40.0,,kettle 92.0', '40.0,,end');
  const sbrew = BU.parseBrewCsv(synth.join('\r\n') + '\r\n');
  assert.strictEqual(sbrew.samples.length, 401); assert.strictEqual(sbrew.dupes, 1); assert.strictEqual(sbrew.kettle, 92);
  assert.strictEqual(sbrew.duration, 40); assert.ok(sbrew.hasWeight);
  assert.deepStrictEqual(sbrew.pours, [[0, 12.9], [32, 39.4]]);
  const schips = BU.pourChips(sbrew.pours, sbrew.samples.map(p => [p[0], p[1], BU.BrewTrace.okWeight(p[2])]));
  assert.deepStrictEqual(schips.map(c => c.label), ['B', '2']);
  assert.ok(Math.abs(schips[0].g - 49.5) < 0.6 && Math.abs(schips[1].g - 44.4) < 0.6, JSON.stringify(schips));
  assert.strictEqual(BU.BrewTrace.okWeight(-140.6), null); assert.strictEqual(BU.BrewTrace.okWeight(-0.6), -0.6);
  const old3 = BU.parseBrewCsv('time_s,temp_c,event\n0.0,,start\n0.0,36.5,\n0.1,36.6,\n0.1,,end\n');
  assert.strictEqual(old3.samples.length, 2); assert.strictEqual(old3.hasWeight, false); assert.strictEqual(old3.samples[0][2], null);
  // scaling: reference from docs/brewer.md (kettle 99.5, t0 35.3, peak 86.7 -> 96 gives 83.9; 92 -> 80.7; 100 -> 87.1)
  assert.ok(Math.abs(BU.scaleT(86.7, 35.3, 99.5, 96) - 83.9) < 0.06); assert.ok(Math.abs(BU.scaleT(86.7, 35.3, 99.5, 92) - 80.7) < 0.06);
  assert.ok(Math.abs(BU.scaleT(86.7, 35.3, 99.5, 100) - 87.1) < 0.06); assert.strictEqual(BU.scaleT(50, 35, 30, 96), 50);   // kettle <= t0: unchanged
  const ref = BU.makeRef(sbrew, 'x'); assert.strictEqual(ref.kettle, 92); assert.deepStrictEqual(ref.p, [0, 32]);
  assert.strictEqual(BU.refValue(ref, 10, null), ref.v[100]); assert.ok(BU.refValue(ref, 10, 96) > ref.v[100]);

  // small pours: an open pour is never small; a closed pour under 15 g is dropped and the rest are renumbered
  const sp = [[0, 12, false], [30, 38, false], [50, 52, false], [70, 71, true]], spts = [[0, 20, 0], [12, 20, 50], [30, 20, 50], [38, 20, 97], [50, 20, 97], [52, 20, 101], [70, 20, 101], [71, 20, 103]];
  const rcs = BU.realChips(sp, spts); assert.deepStrictEqual(rcs.chips.map(c => c.label), ['B', '2', '3']); assert.strictEqual(rcs.ignored, 1);
  // Replay: every sample is emitted, speed changes only the pace, state 2 and the kettle at the end
  const rp = new BU.ReplayTransport(sbrew, { manual: true }), re = [], rk = [];
  rp.on('live', l => re.push(l)); rp.on('kettle', k => rk.push(k)); await rp.connect();
  rp.step(1); assert.strictEqual(re.length, 10); assert.strictEqual(re[9].elapsedMs, 900);
  rp.step(50);
  assert.strictEqual(re.length, 401); assert.strictEqual(re[400].state, 2); assert.strictEqual(re[399].state, 1); assert.ok(rp.done);
  assert.deepStrictEqual(rk, [{ c: 92 }]);
  assert.deepStrictEqual([re[100].pourOpen, re[135].pourOpen, re[330].pourOpen, re[395].pourOpen, re[399].pourOpen], [true, false, true, false, false]);
  assert.strictEqual(re[330].pours, 2); assert.strictEqual(re[50].pours, 1);
  // a trace fed by the replay has the same pours and chips as the CSV
  const rt = new BU.BrewTrace(); re.forEach((l, i) => rt.push(l, i / 10));
  assert.strictEqual(rt.view().pours.length, 2); assert.ok(Math.abs(rt.view().pours[1][0] - 32) < 0.11);
  // 0.1 s steps at 30x speed also give every sample once
  const rq = new BU.ReplayTransport(sbrew, { manual: true }); let nq = 0; rq.on('live', () => nq++); await rq.connect();
  for (let i = 0; i < 200; i++) rq.step(0.1 * 30 * 0.1); assert.strictEqual(nq, 401);
  // Demo: stop keeps the brew (state 2), BrewKettle announces the kettle, Brew end returns to idle
  const dd = new BU.DemoTransport({ manual: true }), de = []; dd.on('live', l => de.push(l)); dd.on('kettle', k => de.push(k)); await dd.connect();
  await dd.send('Brew start'); dd.step(5); await dd.send('Brew stop'); dd.step(0.1); assert.strictEqual(de[de.length - 1].state, 2);
  await dd.send('BrewKettle 92.5'); assert.deepStrictEqual(de[de.length - 1], { c: 92.5 }); await dd.send('Brew end'); dd.step(0.1); assert.strictEqual(de[de.length - 1].state, 0);

  // The real brew b11.csv (the user's recording), only when the file is on this computer
  const b11p = process.env.B11 || require('os').homedir() + '/Downloads/b11.csv';
  if (fs.existsSync(b11p)) {
    const b = BU.parseBrewCsv(fs.readFileSync(b11p, 'utf8')), ch = BU.pourChips(b.pours, b.samples.map(p => [p[0], p[1], BU.BrewTrace.okWeight(p[2])]));
    assert.strictEqual(b.samples.length, 1241); assert.strictEqual(b.dupes, 1); assert.strictEqual(b.kettle, 92); assert.strictEqual(b.duration, 124.1);
    assert.deepStrictEqual(b.pours, [[0, 13.2], [32, 38.7], [52.1, 60.2], [70.9, 79.1], [91.2, 98.9], [107.1, 108.8]]);
    assert.deepStrictEqual(ch.map(c => +c.g.toFixed(1)), [54.1, 46.1, 49.5, 51.4, 54.6, 8.7]);
    assert.deepStrictEqual(ch.map(c => c.small), [false, false, false, false, false, true]);   // the user poured 5 times: pour 6 (8.7 g) is not one
    const rcb = BU.realChips(b.pours, b.samples.map(p => [p[0], p[1], BU.BrewTrace.okWeight(p[2])]));
    assert.strictEqual(rcb.chips.length, 5); assert.strictEqual(rcb.ignored, 1); assert.deepStrictEqual(rcb.chips.map(c => c.label), ['B', '2', '3', '4', '5']);
    assert.deepStrictEqual(BU.makeRef(b, 'b11').p, [0, 32, 52.1, 70.9, 91.2]);
    assert.ok(Math.abs(BU.t0Of(b.samples) - 34.364) < 0.001);
    assert.ok(Math.abs(BU.scaleT(84.58, BU.t0Of(b.samples), 92, 96) - 88.07) < 0.02);
    const gl = b.samples.filter(p => BU.BrewTrace.okWeight(p[2]) === null); assert.strictEqual(gl.length, 27);   // 17.3 to 19.9 s: scale lifted
    console.log('b11.csv checked');
  }

  // 6. page wiring: the files that the page and the service worker name exist, no secrets or IPs are published
  const html = fs.readFileSync('index.html', 'utf8'), swText = fs.readFileSync('sw.js', 'utf8');
  for (const f of ['core.js', 'manifest.webmanifest', 'icon.svg', 'sw.js', 'index.html']) assert.ok(fs.existsSync(f), f);
  for (const f of ['core.js', 'manifest.webmanifest', 'icon.svg', 'index.html']) assert.ok(swText.includes("'" + f + "'"), 'sw caches ' + f);
  for (const k of ['Connect to Brewer', 'Connect to scale', 'bBrewer', 'bScale', "q.has('demo')", 'serviceWorker', 'id="cv"', 'bStart']) assert.ok(html.includes(k), k);
  for (const f of ['index.html', 'core.js', 'sw.js', 'README.md']) {
    if (!fs.existsSync(f)) continue;
    const s = fs.readFileSync(f, 'utf8');
    assert.ok(!/\b(?:192\.168|10\.\d+\.\d+)\.\d+(?:\.\d+)?\b/.test(s), 'IP address in ' + f);
    assert.ok(!/WIFI_PASS|OTA_PASS|SCALE_AP_PASS/.test(s), 'secret name in ' + f);
  }
  console.log('all tests passed');
})().catch(e => { console.error(e); process.exit(1); });
