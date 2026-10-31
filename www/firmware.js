// Firmware: download from GitHub (normal network), flash over the unit's Wi-Fi.
// Flash protocol is a port of firmware_update/flash_base_appliance.py and flash_wifi_module.py.

const lsGet = (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const FW_DEFAULT_URL = 'https://raw.githubusercontent.com/william-sy/esphome-Itho-Daalderop-HRU400/main/firmware_update/firmware_metadata.json';
if (lsGet('fwManifestUrl', '').endsWith('/firmware_update/firmware.json')) lsSet('fwManifestUrl', FW_DEFAULT_URL);   // old default
const FW_BLOCK = 8192;

const fwUrl = () => lsGet('fwManifestUrl', FW_DEFAULT_URL);
const fwManifest = () => { try { return JSON.parse(lsGet('fwManifest', 'null')); } catch { return null; } };
const fwKey = e => `${e.type}_${e.version}`;                 // cached file name stem
const fwFileName = e => `${fwKey(e)}.bin`;

async function fwCached() {
  if (!Native) return {};
  const { files } = await Native.listFiles();
  return Object.fromEntries(files.map(f => [f.name, f.size]));
}

// firmware_metadata.json (the server's own metadata) -> flat list of BASE/WIFI entries. Each file is expected next to
// the metadata as hru400_<TYPE>_<version>.bin unless the entry carries its own "file" (and optional "sha256").
function fwNormalize(meta, url) {
  return {
    products: meta.products || (meta.product_code ? { [meta.product_code]: meta.product_description || '' } : {}),
    // The version becomes part of a cached file name and of the page, so only plain versions (1.9.1, 22.11) are accepted.
    firmware: (meta.firmware || []).filter(e => (e.type === 'BASE' || e.type === 'WIFI') && /^[0-9A-Za-z._-]{1,20}$/.test(String(e.firmware_version ?? e.version))).map(e => {
      const version = String(e.firmware_version ?? e.version);
      return {
        type: e.type, version, id: e.id, forProducts: e.products || [], softwareVersions: (e.software_versions || []).map(String),
        explicit: !!e.file,
        file: new URL(e.file || `hru400_${e.type}_${version}.bin`, url).href,
        sha256: e.sha256 || '',
        imageHash: e.hash_text ?? e.imageHash ?? '',
        address: e.appliance_address || e.address || (e.type === 'BASE' ? '82' : '8A'),
        factoryReset: !!(e.apply_factory_reset_after_update ?? e.factoryReset),
        notes: e.description ?? e.notes ?? '',
        missing: false,
      };
    }),
  };
}

// The list that was built into this app (copy of firmware_metadata.json). Used until "Check GitHub" has been run.
// Entries without a "file" are not in the repo yet, so they are shown as unavailable instead of guessed.
async function fwBundled() {
  try {
    const r = await fetch('firmware_metadata.json');
    if (!r.ok) return null;
    const m = fwNormalize(await r.json(), fwUrl());
    m.firmware.forEach(e => { e.missing = !e.explicit; });
    return m;
  } catch { return null; }
}

// STAGE 1 - "Check GitHub": fetch the firmware list and see which files exist in the repo. Downloads no firmware.
async function fwCheck(say) {
  if (!Native) throw new Error('Only works inside the Android app');
  say('Fetching the firmware list from GitHub...');
  const url = fwUrl();
  const r = await Native.request({ url, method: 'GET', timeoutMs: 15000, network: 'internet' });
  if (r.status !== 200) throw new Error(`Firmware list HTTP ${r.status} (${url})`);
  const m = fwNormalize(JSON.parse(r.body), url);
  if (!m.firmware.length) throw new Error('No BASE/WIFI firmware in the list');
  let n = 0;
  for (const e of m.firmware) {
    say(`Checking ${++n}/${m.firmware.length}: ${e.type} ${e.version}...`);
    const h = await Native.request({ url: e.file, method: 'HEAD', timeoutMs: 15000, network: 'internet' });
    if (h.status === 404) e.missing = true;
    else if (h.status < 200 || h.status >= 300) throw new Error(`${e.type} ${e.version}: HTTP ${h.status}`);
  }
  lsSet('fwManifest', JSON.stringify(m));
  lsSet('fwChecked', new Date().toISOString());
  const ok = m.firmware.filter(e => !e.missing);
  say(`Found ${ok.length} firmware file(s) in the repo` + (ok.length < m.firmware.length ? `, ${m.firmware.length - ok.length} listed but not in the repo.` : '.'));
  return m;
}

// STAGE 2 helper: get the file onto the phone right before installing (uses mobile data or any Wi-Fi with internet).
async function fwEnsureFile(e, log, prog) {
  prog(0.03, 'Downloading from GitHub...');
  log(`downloading ${e.file}`);
  try {
    const r = await Native.download({ url: e.file, name: fwFileName(e), sha256: e.sha256 });
    log(`downloaded ${r.size} bytes` + (e.sha256 ? ', checksum OK' : ' (no checksum in the list, not verified)'));
  } catch (x) {
    const have = (await fwCached())[fwFileName(e)];
    if (!have) throw new Error('Could not download the firmware: ' + x.message + '. Turn on mobile data (or use a Wi-Fi with internet) and try again.');
    log('Download failed (' + x.message + '); using the copy already on the phone.');
  }
}

// ---- flashing ----
const sendRaw = (path, size, off, name) => raw('POST', path, {
  file: { name, offset: off, size },
  headers: { 'Content-Type': 'application/octet-stream', 'Accept': 'application/json' },
  timeoutMs: 60000,
});
const postJson = (path, obj, timeoutMs = 50000) => raw('POST', path, { body: JSON.stringify(obj), headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, timeoutMs });

class BlockFailed extends Error {
  constructor(cause, first) { super(cause.message); this.cause = cause; this.first = first; this.noResponse = cause instanceof NoResponse; }
}

async function sendBlocks(path0, name, size, log, prog) {
  let off = 0, no = 0;
  const total = Math.ceil(size / FW_BLOCK);
  while (off < size) {
    const n = Math.min(FW_BLOCK, size - off);
    no++;
    prog(off / size, `block ${no}/${total}`);
    try {
      const r = await sendRaw(`${path0}${path0.includes('?') ? '&' : '?'}blockOffset=${off}&blockSize=${n}`, n, off, name);
      if (r.status < 200 || r.status >= 300) throw new HttpError(path0, r.status);
    } catch (e) { throw new BlockFailed(e, no === 1); }
    off += n;
    if (off < size) await sleep(100);
  }
  prog(1, 'all blocks sent');
}

async function flashBase(e, size, opts, log, prog) {
  const a = e.address || '82';
  const startUpdate = async () => {
    try { const r = await postJson(`/i2c-appliance/${a}/firmware/start-update`, { imageSize: size, imageHash: e.imageHash || '' }); log(`start-update: HTTP ${r.status} ${r.body}`); }
    catch (x) { log('start-update failed: ' + x.message); }
  };
  for (let attempt = 0; ; attempt++) {
    log(`=== main phase, attempt ${attempt + 1}/3 ===`);
    try {
      const st = await raw('GET', `/i2c-appliance/${a}/firmware/status`, { timeoutMs: 10000 });
      log('status: ' + st.body);
      if (/updating/i.test(st.body)) throw new Error('The unit reports an update already in progress. Aborting.');
    } catch (x) { if (!(x instanceof NoResponse) && !(x instanceof HttpError)) throw x; log('status check failed: ' + x.message); }
    try {
      await sendBlocks(`/i2c-appliance/${a}/firmware`, fwFileName(e), size, log, prog);
      break;
    } catch (x) {
      if (!(x instanceof BlockFailed)) throw x;
      log('block upload failed: ' + x.message);
      await startUpdate();
      if ((x.first || x.noResponse) && attempt < 2) { log('restarting phase from byte 0...'); continue; }
      throw new Error('Update failed: ' + x.message);
    }
  }
  await startUpdate();
  log('waiting 8 s, then start-update again (as the original app does)...');
  await sleep(8000);
  await startUpdate();
  if (opts.factoryReset) {
    log('sending FactoryReset (wipes settings to factory defaults)...');
    for (let i = 0; i < 4; i++) {
      try { const r = await postJson('/i2c-bus/message', { message: '82 8A CA BC 06 01 01 66' }); log(`factory reset: HTTP ${r.status} ${r.body}`); break; }
      catch (x) { log(`factory reset attempt ${i + 1} failed: ${x.message}`); await sleep(100); }
    }
  }
}

async function flashWifi(e, size, opts, log, prog) {
  const apply = async () => {
    log('applying update...');
    const r = await raw('POST', '/wifi-module/firmware/apply-update', { body: '', headers: { 'Accept': 'application/json' }, timeoutMs: 60000 });
    log(`apply-update: HTTP ${r.status}`);
  };
  for (let attempt = 0; ; attempt++) {
    log(`=== update attempt ${attempt + 1}/3 ===`);
    try {
      await sendBlocks('/wifi-module/firmware/block', fwFileName(e), size, log, prog);
      break;
    } catch (x) {
      if (!(x instanceof BlockFailed)) throw x;
      log('block upload failed: ' + x.message);
      try { await apply(); } catch (y) { log('apply failed: ' + y.message); }
      if (x.noResponse && attempt < 2) { log('no response from unit, restarting from byte 0...'); continue; }
      throw new Error('Update failed: ' + x.message);
    }
  }
  await apply();
}

async function flashEntry(e, opts, log, prog) {
  const cached = await fwCached();
  const size = cached[fwFileName(e)];
  if (!size) throw new Error('Firmware file is not on the phone.');
  let wake = null;
  try { wake = await navigator.wakeLock.request('screen'); } catch {}
  try {
    log(`${e.type} ${e.version}: ${size} bytes`);
    if (e.type === 'BASE') await flashBase(e, size, opts, log, prog);
    else await flashWifi(e, size, opts, log, prog);
    log('Done. Do not remove power from the unit while it flashes and reboots.');
  } finally { try { wake && wake.release(); } catch {} }
}

// ---- UI ----
const cmpVer = (a, b) => {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d < 0 ? -1 : 1; }
  return 0;
};

async function renderFirmware() {
  const saved = fwManifest();
  const m = saved || await fwBundled();
  const cached = await fwCached();
  const kinds = [
    ['BASE', 'Base unit (main controller)', baseVer()],
    ['WIFI', 'Wi-Fi module', wifiVer()],
  ];
  // The catalog offers each firmware only to units on certain software versions. The unit's base version
  // "8.1" is software version 8, release 1 (same rule as the original app). Unknown on either side = allowed.
  const sw = baseVer() ? String(parseInt(baseVer(), 10)) : null;
  const art = typeof curArticle === 'function' ? curArticle() : '';       // article number of the selected unit (from its sticker)
  const forUnit = e => !art || !e.forProducts || !e.forProducts.length || e.forProducts.includes(art);
  const forSw = e => !sw || !e.softwareVersions || !e.softwareVersions.length || e.softwareVersions.includes(sw);
  const fits = e => forUnit(e) && forSw(e);
  const label = (c, v) => c === 0 ? `Reinstall ${v} on the unit` : c < 0 ? `Downgrade unit to ${v}` : c > 0 ? `Update unit to ${v}` : `Install ${v} on the unit`;
  const flashBtn = (e, i, installed, primary) => {
    const have = cached[fwFileName(e)];
    const c = installed ? cmpVer(e.version, installed) : null;
    const dis = e.missing || !fits(e) ? 'disabled' : '';
    return `<button class="${primary ? 'p' : ''}" data-flash="${i}" ${dis}>${esc(label(c, e.version))}</button>`;
  };
  const stateOf = e => e.missing ? 'not in repo' : !forUnit(e) ? `not for ${unitName(art)}` : !fits(e) ? `not offered for software version ${sw}` : cached[fwFileName(e)] ? 'on phone' : 'downloads when installed';
  const unitName = a => ((m && m.products && m.products[a]) || a).replace(/^WTW-unit /, '');
  const extraOf = e => [e.notes, e.factoryReset ? 'resets all settings afterwards' : '',
    e.forProducts && e.forProducts.length ? 'for ' + e.forProducts.map(unitName).join(', ') : ''].filter(Boolean).map(esc).join(' · ');

  const section = ([type, title, installed]) => {
    const list = (m && m.firmware ? m.firmware : []).map((e, i) => [e, i]).filter(([e]) => e.type === type).sort((a, b) => cmpVer(b[0].version, a[0].version));
    const avail = list.filter(([e]) => !e.missing && fits(e));
    const latest = avail[0];
    let status, action = '';
    if (!list.length) status = '<span class="hint">No firmware in the list. Press Download.</span>';
    else if (!latest) status = `<span class="badge old">${list.every(([e]) => e.missing) ? 'none of these are in your repo' : 'none of these are offered for your unit'}</span>`;
    else if (!installed) { status = '<span class="badge">installed version unknown</span>'; action = flashBtn(latest[0], latest[1], null, false); }
    else {
      const c = cmpVer(latest[0].version, installed);
      if (c === 0) { status = '<span class="badge ok">up to date</span>'; action = flashBtn(latest[0], latest[1], installed, false); }
      else if (c > 0) { status = '<span class="badge new">update available</span>'; action = flashBtn(latest[0], latest[1], installed, true); }
      else status = '<span class="badge">installed is newer than the latest in your repo</span>';
    }
    const others = list.filter(x => !latest || x[0] !== latest[0]);
    const otherRows = others.map(([e, i]) => `<div class="row"><span><strong>${esc(e.version)}</strong><br><span class="hint">${extraOf(e) ? extraOf(e) + ' · ' : ''}${esc(stateOf(e))}</span></span>
        <span class="ed">${flashBtn(e, i, installed, false)}</span></div>`).join('');
    return `<h2>${esc(title)}</h2>
      <div class="card">
        <div class="slot"><span>Installed</span><span class="val">${esc(installed || 'unknown')}</span></div>
        <div class="slot"><span>Latest available</span><span class="val">${latest ? esc(latest[0].version) : '-'}</span></div>
        <div style="margin-top:8px">${status}</div>
        ${latest && extraOf(latest[0]) ? `<p class="hint">${extraOf(latest[0])}</p>` : ''}
        ${action ? `<div style="margin-top:8px">${action.replace('<button', '<button style="width:100%"')}</div>` : ''}
        ${others.length ? `<details style="margin-top:12px"><summary class="hint">Other versions (${others.length})</summary><div class="grp" style="margin-top:8px">${otherRows}</div></details>` : ''}
      </div>`;
  };
  $('firmware').innerHTML = `
    <div class="warn"><strong>Unofficial. Use at your own risk.</strong> This app is not made, approved or supported by Itho Daalderop.
      A failed update can leave the base unit or the Wi-Fi module unusable.</div>
    <details class="card"><summary><strong>How this list works</strong></summary>
      <p class="hint">The firmware files are Itho's own, copied unchanged from their servers into a public GitHub repo. Itho publishes no release notes, so you cannot see what a version changes.</p>
      <p class="hint">Itho's catalog offers each firmware only to certain <em>software versions</em>. Your unit's software version is the whole-number part of its base version (base 8.1 is software version 8). Like the original app, this app only lets you install firmware the catalog lists for your unit's software version. If the selected unit has an article number (scanned from its sticker), firmware listed for other models is greyed out too. Anything blocked says why.</p>
      <p class="hint">That is a safeguard, not a guarantee. A listed version can still fail, and a greyed-out one might even work, but nobody has checked. The HRU 400, 300 and 375 share most of this firmware. The unit does not report its article number, so the app only knows it from the sticker you scanned.</p>
      <p class="hint">Do not leave the app, switch Wi-Fi or power off the unit while an update runs. Back up your settings first (Tools tab).</p>
    </details>
    <div class="card">
      <strong>1 · Check GitHub</strong>
      <p class="hint">Fetches the list of firmware versions that exist in your repo. Nothing is sent to the unit.</p>
      <button id="fwCheck" class="big">Check GitHub for firmware</button>
      <div id="fwDlSt" class="hint">${lsGet('fwChecked', '') && saved ? 'Last checked ' + esc(new Date(lsGet('fwChecked', '')).toLocaleString()) : 'Showing the list built into the app. Check GitHub to refresh it.'}</div>
    </div>
    <div class="card">
      <strong>2 · Read the unit</strong>
      <p class="hint">Shows what is installed now. The install buttons below send firmware to the unit.</p>
      <button id="fwRead" class="big">Read installed versions</button>
    </div>
    ${kinds.map(section).join('')}
    <div id="fwOpts" hidden class="warn">
      <label><input type="checkbox" id="fwReset"> Factory reset after update (wipes ALL settings; the original app does this for BASE 8.1)</label>
    </div>
    <div class="prog"><div id="fwBar"></div></div>
    <div id="fwStep" class="hint"></div>
    <pre class="log" id="fwLog" hidden></pre>
    <details style="margin-top:16px"><summary class="hint">Firmware source</summary>
      <div class="bar" style="margin-top:8px"><input id="fwUrl" style="flex:1;min-width:0" value="${esc(fwUrl())}"><button id="fwSave">Save</button></div>
      <p class="hint">URL of <code>firmware_metadata.json</code> in your GitHub repo; the <code>.bin</code> files are read from the same folder. Downloads use mobile data or any Wi-Fi with internet, even while joined to the unit.</p>
    </details>`;

  $('fwRead').onclick = async () => {
    $('fwRead').disabled = true; $('fwDlSt').textContent = 'Reading...';
    try { await connect(); await refreshBase(); } catch {}
    await renderFirmware();
  };
  $('fwSave').onclick = () => { lsSet('fwManifestUrl', $('fwUrl').value.trim()); status('Source saved', 'ok'); };
  $('fwCheck').onclick = async () => {
    lsSet('fwManifestUrl', $('fwUrl').value.trim());
    $('fwCheck').disabled = true;
    try { await fwCheck(t => { $('fwDlSt').textContent = t; }); const msg = $('fwDlSt').textContent; await renderFirmware(); $('fwDlSt').textContent = msg; }
    catch (e) { $('fwDlSt').textContent = 'Failed: ' + e.message + ' (is mobile data on?)'; $('fwCheck').disabled = false; }
  };
  document.querySelectorAll('[data-flash]').forEach(b => b.onclick = () => {
    const e = m.firmware[b.dataset.flash];
    $('fwOpts').hidden = e.type !== 'BASE';
    $('fwReset').checked = !!e.factoryReset;
    startFlash(e);
  });
}

// "At your own risk" dialog. Resolves true only after the box is ticked and Install is pressed.
function fwRiskDialog(e, installed, factoryReset) {
  return new Promise(resolve => {
    const c = installed ? cmpVer(e.version, installed) : null;
    const what = c === null ? 'install' : c === 0 ? 'reinstall' : c < 0 ? 'DOWNGRADE to' : 'update to';
    const part = e.type === 'BASE' ? 'base unit' : 'Wi-Fi module';
    const o = document.createElement('div');
    o.setAttribute('style', 'position:fixed;inset:0;z-index:99;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:16px');
    o.innerHTML = `<div role="dialog" aria-modal="true" style="background:var(--card);color:var(--fg);border:1px solid var(--bd);border-radius:12px;padding:16px;max-width:460px;width:100%;max-height:90vh;overflow:auto">
      <h2 style="margin:0 0 8px;color:var(--bad)">At your own risk</h2>
      <p style="margin:0 0 8px">You are about to <strong>${esc(what)} ${esc(e.version)}</strong> on the <strong>${part}</strong>${installed ? ` (now ${esc(installed)})` : ''}.</p>
      <ul class="hint" style="margin:0 0 8px;padding-left:20px">
        <li>This app is unofficial. Itho Daalderop did not make, test or approve it, and gives no support or warranty for it.</li>
        <li>A failed or interrupted update can leave the unit unusable and may need a service visit. It may also affect your warranty.</li>
        <li>The catalog lists this version for your unit's software version, but that does not guarantee it works.</li>
        <li>Keep the phone on the unit's Wi-Fi, stay in the app and do not power off the unit until it says done.</li>
        ${factoryReset ? '<li><strong>This also factory-resets the unit and ERASES ALL SETTINGS.</strong> Back them up first (Tools tab).</li>' : ''}
      </ul>
      <label style="display:flex;gap:8px;align-items:flex-start;margin:12px 0"><input type="checkbox" id="riskOk" style="margin-top:3px"> <span>I understand and accept the risk. Nobody else is responsible for what happens to my unit.</span></label>
      <div class="bar"><button id="riskNo" style="flex:1">Cancel</button><button id="riskGo" class="p" style="flex:1" disabled>Install</button></div>
    </div>`;
    document.body.appendChild(o);
    const done = v => { o.remove(); resolve(v); };
    o.querySelector('#riskOk').onchange = ev => { o.querySelector('#riskGo').disabled = !ev.target.checked; };
    o.querySelector('#riskNo').onclick = () => done(false);
    o.querySelector('#riskGo').onclick = () => done(true);
  });
}

async function startFlash(e) {
  const factoryReset = e.type === 'BASE' && $('fwReset').checked;
  if (!await fwRiskDialog(e, e.type === 'BASE' ? baseVer() : wifiVer(), factoryReset)) return;
  const lg = $('fwLog'); lg.hidden = false; lg.textContent = '';
  const log = t => { lg.textContent += t + '\n'; lg.scrollTop = lg.scrollHeight; };
  const prog = (f, t) => { $('fwBar').style.width = (f * 100).toFixed(1) + '%'; $('fwStep').textContent = t; };
  document.querySelectorAll('[data-flash]').forEach(b => b.disabled = true);
  try {
    await fwEnsureFile(e, log, prog);
    await flashEntry(e, { factoryReset: e.type === 'BASE' && $('fwReset').checked }, log, prog);
    status('Firmware installed', 'ok');
  }
  catch (x) { log('FAILED: ' + x.message); status('Install failed: ' + x.message, 'bad'); }
  document.querySelectorAll('[data-flash]').forEach(b => b.disabled = false);
}

// Start-screen button: just checks what is available on GitHub.
document.getElementById('gateDl').onclick = async () => {
  const b = document.getElementById('gateDl'), st = document.getElementById('gateFw');
  const u = document.getElementById('gateUrl').value.trim();
  if (u) lsSet('fwManifestUrl', u);
  b.disabled = true;
  try { await fwCheck(t => { st.textContent = t; }); }
  catch (e) { st.textContent = 'Failed: ' + e.message + ' (check the URL and that mobile data is on)'; }
  b.disabled = false;
};
document.getElementById('gateUrl').value = lsGet('fwManifestUrl', '') === FW_DEFAULT_URL ? '' : lsGet('fwManifestUrl', '');
