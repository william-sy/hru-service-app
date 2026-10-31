// Smoke test: serves www/ over HTTP and loads it in jsdom with a mocked Capacitor bridge, the way the Android WebView
// does. It catches the failures that left the app with dead buttons before: script errors at load, load-order bugs,
// and broken saved-data handling. Run with `npm test`. Passwords and serials below are made up.
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const http = require('http');
const path = require('path');

const WWW = path.join(__dirname, '..', 'www');
const FIXTURE = path.join(__dirname, 'fixtures', 'firmware_metadata.json');
const wait = ms => new Promise(r => setTimeout(r, ms));
const text = el => el.textContent.replace(/\s+/g, ' ').trim();

let failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${!cond && detail ? '  -> ' + detail : ''}`);
  if (!cond) failed++;
};

// A paired-devices reply with one device in slot 1 (RF id 0x0096EB6B) and one in slot 3.
const PAIRED = ['82', '8A', 'A4', '01', '04', '00', ...Array(9).fill('00').map((v, i) => i === 8 ? '0A' : v),
  '00', '00', '96', 'EB', '6B', '01', '00', '00', '00', '00', '00', '00', '00', '0A', '0B', '0C', '0D', '07', '99'].join(' ');

function serve() {
  return http.createServer((req, res) => {
    const url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    const file = url === '/firmware_metadata.json' ? FIXTURE : path.join(WWW, url);
    try { res.end(fs.readFileSync(file)); } catch { res.statusCode = 404; res.end(); }
  }).listen(0);
}

// Opens the app. `baseVersion` is what the mocked unit reports as its base firmware byte (software version).
async function open(port, { seed = {}, baseVersion = '08', serial = 'WT0000000001', paired = PAIRED } = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', e => errors.push(e.message));
  const dom = await JSDOM.fromURL(`http://localhost:${port}/`, {
    runScripts: 'dangerously', resources: 'usable', virtualConsole: vc,
    beforeParse(w) {
      w.fetch = (u, o) => fetch(new URL(u, `http://localhost:${port}/`), o);
      for (const [k, v] of Object.entries(seed)) w.localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v));
      w.Capacitor = {
        isNativePlatform: () => true,
        Plugins: {
          BluetoothLe: {},
          BarcodeScanner: { isGoogleBarcodeScannerModuleAvailable: async () => ({ available: true }), scan: async () => ({ barcodes: [] }) },
          DeviceHttp: {
            wifiConnected: async () => ({ connected: true }),
            listFiles: async () => ({ files: [] }),
            request: async a => {
              if (a.url.endsWith('/identification')) return { status: 200, body: JSON.stringify({ serialNumber: serial }) };
              if (a.url.endsWith('/version')) return { status: 200, body: '{"productVersion":21,"softwareVersion":2}' };
              if (a.body && a.body.includes('8A 8A A4')) return { status: 200, body: JSON.stringify({ message: paired }) };
              return { status: 200, body: JSON.stringify({ message: `82 8A 90 E0 04 00 28 00 01 01 ${baseVersion} 01 01 00 01 99` }) };
            },
          },
        },
      };
    },
  });
  await wait(1500);
  return { dom, w: dom.window, d: dom.window.document, errors };
}

async function main() {
  const server = serve();
  const port = server.address().port;
  const oldUnit = { id: { serialNumber: 'WT0000000001' }, ver: { productVersion: 21, softwareVersion: 2 }, base: '8.1', at: '2026-01-01T10:00:00Z' };

  // 1. loads cleanly with data saved by an older version of the app, and migrates it into the units list
  {
    const { w, d, errors } = await open(port, { seed: { myUnit: oldUnit, wfSsid: 'ID-Gateway-WT0000000001', wfPw: 'made-up-pw' } });
    const units = JSON.parse(w.localStorage.getItem('units') || 'null');
    check('page loads without script errors', errors.length === 0, errors.join(' | '));
    check('old "My unit" data is migrated', units && units.list.length === 1 && units.list[0].serial === 'WT0000000001' && units.list[0].password === 'made-up-pw');
    check('start screen lists the unit', /WT0000000001/.test(text(d.getElementById('unitsCard'))));

    // 2. sticker parsing
    const sensor = w.parseSticker('23011297232500013210207267-A0101?IE.VMS-12C39?Vh12s10?R96EB6B?');
    check('RF sticker -> address 0x0096EB6B', sensor && sensor.kind === 'sensor' && sensor.addr === '0x0096EB6B' && sensor.model === 'E.VMS-12C39');
    const unit = w.parseSticker('03-00632;001;#WT0000000001;ID-Gateway-WT0000000001;made-up-pw');
    check('unit sticker -> article, serial, SSID, password', unit && unit.kind === 'unit' && unit.article === '03-00632' && unit.serial === 'WT0000000001' && unit.ssid === 'ID-Gateway-WT0000000001' && unit.password === 'made-up-pw');
    const wifi = w.parseSticker('WIFI:T:WPA;S:ID-Gateway-WT0000000001;P:made-up-pw;;');
    check('standard Wi-Fi QR is understood', wifi && wifi.kind === 'unit' && wifi.serial === 'WT0000000001' && wifi.password === 'made-up-pw');
    check('other codes are rejected', w.parseSticker('https://example.com') === null);

    // 3. connected: sensors page adds a sensor and finds its slot by itself
    w.document.querySelector('.drawer button[data-t=devices]').click();
    await wait(300);
    d.getElementById('dvId').value = '96eb6b';
    d.getElementById('dvAdd').click();
    await wait(900);
    check('sensor added by ID, slot read from the unit', /0x0096EB6B · slot 1 when last read/.test(text(d.getElementById('dvCard'))), text(d.getElementById('dvCard')));

    // 4. Home button and back
    d.getElementById('homeBtn').click();
    check('home button shows the start screen', !d.getElementById('gate').hidden && d.getElementById('app').hidden);
    d.getElementById('gateBackBtn').click();
    check('"Back to the app" returns', d.getElementById('gate').hidden && !d.getElementById('app').hidden);
  }

  // 5. firmware list is filtered by the unit's software version (base 8.1 = software version 8)
  {
    const { d, errors } = await open(port, { seed: { myUnit: oldUnit } });
    d.querySelector('.drawer button[data-t=firmware]').click();
    await wait(600);
    const btns = [...d.querySelectorAll('#firmware button[data-flash]')].map(b => ({ t: b.textContent, off: b.disabled }));
    const label = b => b.t.replace(' on the unit', '').trim();
    const off = v => (btns.find(b => label(b).endsWith(' ' + v)) || {}).off;   // e.g. "Update unit to 22.11"
    check('firmware page renders without errors', errors.length === 0 && btns.length > 0, errors.join(' | '));
    check('sw 8: BASE 8.1 and WIFI 21.2 allowed', off('8.1') === false && off('21.2') === false, JSON.stringify(btns));
    check('sw 8: WIFI 22.11 (sw 9 only) and 13.1 (sw 6 only) are blocked', off('22.11') === true && off('13.1') === true, JSON.stringify(btns));
  }

  // 6. the unit's article number blocks firmware listed for other models
  {
    const unit = { ...oldUnit };
    const units = { current: 'a', list: [{ key: 'a', name: '', article: '03-00851', serial: 'WT0000000001', ssid: '', password: '', added: '2026-01-01T00:00:00Z', data: unit }] };
    const meta = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
    meta.firmware.find(e => e.firmware_version === '21.2').products = ['03-00632'];
    fs.writeFileSync(FIXTURE + '.tmp', JSON.stringify(meta));
    const orig = fs.readFileSync(FIXTURE);
    try {
      fs.copyFileSync(FIXTURE + '.tmp', FIXTURE);
      const { d } = await open(port, { seed: { units } });
      d.querySelector('.drawer button[data-t=firmware]').click();
      await wait(600);
      const btn = [...d.querySelectorAll('#firmware button[data-flash]')].find(b => b.textContent.replace(' on the unit', '').trim().endsWith(' 21.2'));
      check('firmware for another model is blocked by article number', btn && btn.disabled);
    } finally { fs.writeFileSync(FIXTURE, orig); fs.unlinkSync(FIXTURE + '.tmp'); }
  }

  // 7. hostile data is shown as text, never as markup
  {
    // a rogue "unit" whose paired-devices reply carries markup where an RF address should be
    const evil = PAIRED.replace('00 00 96 EB 6B 01', '00 <img src=x onerror=window.__pwned=1> 6B 01');
    const { w, d } = await open(port, { seed: { myUnit: oldUnit }, paired: evil });
    d.querySelector('.drawer button[data-t=paired]').click();
    await wait(900);
    check('paired reply with markup is refused, nothing injected', !d.querySelector('#paired img') && !w.__pwned && /Read failed/.test(text(d.getElementById('pairedOut'))), text(d.getElementById('pairedOut')));
  }
  {
    // manifest with an HTML model name (shown via the unit's article number) and a version that is a path
    const units = { current: 'a', list: [{ key: 'a', name: '', article: '03-00999', serial: 'WT0000000001', ssid: '', password: '', added: '2026-01-01T00:00:00Z', data: { ...oldUnit } }] };
    const { w, d } = await open(port, { seed: { units } });
    d.querySelector('.drawer button[data-t=firmware]').click();
    await wait(600);
    const fw = d.getElementById('firmware');
    check('model name with markup is shown as text', !fw.querySelector('img') && !w.__pwned && fw.textContent.includes('<img src=x'), fw.querySelector('img') ? 'img element injected' : 'text missing');
    check('firmware version that is a path is dropped', !fw.textContent.includes('evil'));
  }

  server.close();
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
