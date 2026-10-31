// Unit Wi-Fi credentials over Bluetooth LE (port of web/credentials.html, which uses Web Bluetooth),
// then join the unit's Wi-Fi from inside the app.

const BLE_SERVICE = '95f1c177-1acc-46c3-a7bf-b5dbaad6c2bb';
const BLE_CH_SSID = '335c016c-91e0-4798-8e6b-02af3fbc5813';
const BLE_CH_PW   = 'b6025ff0-acb8-481b-9dde-04d08e835509';
const BLE_CH_KEY  = '15194e5a-7d05-4d96-a509-4ee1d0fadeec';
const DEFAULT_PW  = 'ithodaalderop';

const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const BLE = isNative ? window.Capacitor.Plugins.BluetoothLe : null;
const toHex = u8 => Array.from(u8, b => b.toString(16).padStart(2, '0')).join('');
const fromHex = h => Uint8Array.from(h.match(/../g) || [], x => parseInt(x, 16));

// Name from the advertisement itself (AD type 0x09 complete / 0x08 shortened local name). The plugin's own
// name filter looks at Android's cached device name instead, which is empty until the phone has connected once.
function advertisedName(hex) {
  const b = fromHex((hex || '').replace(/[^0-9a-f]/gi, ''));
  let full = '', short = '';
  for (let i = 0; i < b.length && b[i];) {
    const len = b[i], type = b[i + 1], data = b.slice(i + 2, i + 1 + len);
    if (type === 9) full = new TextDecoder().decode(data);
    else if (type === 8) short = new TextDecoder().decode(data);
    i += len + 1;
  }
  return full || short;
}
const isUnit = d => d.svc || /^ID-Gateway/i.test(d.name);

// Scan for up to `seconds` (stops a second after the unit shows up). Returns every device seen.
async function scanBle(say, seconds = 15) {
  await BLE.initialize({ androidNeverForLocation: true });
  const seen = new Map();
  const handle = window.Capacitor.addListener('BluetoothLe', 'onScanResult', r => {
    const id = r.device.deviceId, prev = seen.get(id) || {};
    seen.set(id, {
      id, rssi: r.rssi,
      name: advertisedName(r.rawAdvertisement) || r.localName || r.device.name || prev.name || '',
      svc: !!prev.svc || (r.uuids || []).some(u => u.toLowerCase() === BLE_SERVICE),
    });
  });
  try {
    await BLE.requestLEScan({ allowDuplicates: true });
    let found = 0;
    for (let left = seconds; left > 0 && found < 2; left--) {
      say(`Scanning for the unit... ${left}s (${seen.size} Bluetooth devices seen)`);
      await new Promise(r => setTimeout(r, 1000));
      if ([...seen.values()].some(isUnit)) found++;
    }
  } finally {
    try { await BLE.stopLEScan(); } catch {}
    try { await handle.remove(); } catch {}
  }
  return [...seen.values()].sort((a, b) => b.rssi - a.rssi);
}

// One match -> use it. Otherwise let the person choose from what was found.
function chooseBle(list, say) {
  const matches = list.filter(isUnit);
  if (matches.length === 1) return Promise.resolve(matches[0]);
  return new Promise(resolve => {
    const box = $('btList'), row = d => `<div class="row"><span><strong>${esc(d.name || 'no name')}</strong><br><span class="hint">${esc(d.id)} · ${d.rssi} dBm</span></span><span class="ed"><button data-bt="${esc(d.id)}">Use</button></span></div>`;
    const others = list.filter(d => !isUnit(d));
    box.hidden = false;
    say(matches.length ? 'Pick your unit below.' : 'No ID-Gateway found. See below.');
    box.innerHTML = (matches.length ? `<div class="hint">More than one unit found. Pick yours (the strongest signal is closest):</div><div class="grp">${matches.map(row).join('')}</div>`
        : `<div class="hint"><strong>No ID-Gateway found</strong> among ${list.length} Bluetooth devices. Press the Wi-Fi button on the unit and keep the phone close (a metre or less), then scan again. If you think the unit shows under another name, pick it below.</div>`)
      + (others.length ? `<details style="margin-top:8px"><summary class="hint">All other devices (${others.length})</summary><div class="grp" style="margin-top:8px">${others.map(row).join('')}</div></details>` : '')
      + '<div class="bar" style="margin-top:8px"><button data-bt="">Cancel</button></div>';
    box.querySelectorAll('[data-bt]').forEach(b => b.onclick = () => {
      box.hidden = true; box.innerHTML = '';
      resolve(list.find(d => d.id === b.dataset.bt) || null);
    });
  });
}

async function readCredentialsOverBle(say) {
  if (!BLE) throw new Error('Bluetooth only works inside the Android app');
  const list = await scanBle(say);
  const dev = await chooseBle(list, say);
  if (!dev) throw new Error('cancelled');
  const id = dev.id;
  say('Connecting to ' + (dev.name || id) + '...');
  await BLE.connect({ deviceId: id, timeout: 15000 });
  try {
    const rd = async ch => fromHex((await BLE.read({ deviceId: id, service: BLE_SERVICE, characteristic: ch })).value);
    const ssid = new TextDecoder().decode(await rd(BLE_CH_SSID));
    say('Exchanging keys...');
    // The unit encrypts the password to a public key we hand it (RSA-2048, OAEP/SHA-1 like Java's default).
    const kp = await crypto.subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-1' }, true, ['decrypt']);
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', kp.publicKey));
    await BLE.write({ deviceId: id, service: BLE_SERVICE, characteristic: BLE_CH_KEY, value: toHex(spki) });
    const enc = await rd(BLE_CH_PW);
    const pw = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, kp.privateKey, enc));
    return { ssid, pw };
  } finally { try { await BLE.disconnect({ deviceId: id }); } catch {} }
}

window.addEventListener('DOMContentLoaded', () => {
  const st = t => { $('wfSt').textContent = t; };
  if (!$('wfSsid').value) $('wfSsid').value = lsGet('wfSsid', '');      // the selected unit (index.html) fills these first
  if (!$('wfPw').value) $('wfPw').value = lsGet('wfPw', DEFAULT_PW);

  $('btRead').onclick = async () => {
    $('btRead').disabled = true;
    try {
      const { ssid, pw } = await readCredentialsOverBle(st);
      $('wfSsid').value = ssid; $('wfPw').value = pw;
      lsSet('wfSsid', ssid); lsSet('wfPw', pw); setUnitWifi(ssid, pw);
      st('Got credentials. Press "Join this Wi-Fi".');
    } catch (e) { st(e.message === 'cancelled' ? 'Cancelled.' : 'Bluetooth failed: ' + (e.message || e)); }
    $('btRead').disabled = false;
  };

  $('wfJoin').onclick = async () => {
    const ssid = $('wfSsid').value.trim(), password = $('wfPw').value;
    if (!ssid) { st('Enter or read the Wi-Fi name first.'); return; }
    if (!isNative) { st('Joining only works inside the Android app.'); return; }
    lsSet('wfSsid', ssid); lsSet('wfPw', password); setUnitWifi(ssid, password);
    $('wfJoin').disabled = true; st('Joining... accept the Android prompt.');
    try { await Native.joinWifi({ ssid, password }); st('Joined ' + ssid + '. Press "Yes, connect".'); }
    catch (e) { st('Join failed: ' + (e.message || e)); }
    $('wfJoin').disabled = false;
  };
});
