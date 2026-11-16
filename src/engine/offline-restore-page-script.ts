/**
 * The script inside `_RESTORE cAdtree.html` (see offline-restore-page.ts).
 *
 * It is kept as one plain string of ES2020 so it can be written into a self-contained page. It must not contain a
 * backtick or a "${" sequence (it is a String.raw template literal), must not use eval, and must never put data
 * into the page as HTML: every name and summary goes in through textContent. The page's tests run it in a real
 * browser (tests/browser/restore-page.spec.ts).
 *
 * Mode 1 hashes the dropped or chosen files and looks them up in the embedded table. Mode 2 reads the project's
 * vault folder directly (read-only: it only ever calls getDirectoryHandle, getFileHandle and getFile on the vault,
 * never create, remove or write) and rebuilds one revision into an empty folder the person chooses.
 */
export const RESTORE_PAGE_SCRIPT = String.raw`
(function () {
  'use strict';

  var byId = function (id) { return document.getElementById(id); };
  var DATA;
  try {
    DATA = JSON.parse(byId('cadtree-restore-data').textContent);
  } catch (error) {
    document.body.textContent = 'This restore page is damaged. Use the steps in the _MAP cAdtree.txt file next to it instead.';
    return;
  }

  function el(tag, text, className) {
    var node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function formatRevision(n) { return 'Rev ' + String(n).padStart(3, '0'); }
  function formatSize(n) {
    if (n < 1024) return n + ' bytes';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  function errorText(error) {
    if (!error) return 'unknown error';
    return (error.name ? error.name + ': ' : '') + (error.message || String(error));
  }
  function isCancel(error) { return !!error && error.name === 'AbortError'; }
  function formatDate(text) {
    var date = new Date(text);
    return isNaN(date.getTime()) ? String(text) : date.toLocaleString();
  }

  byId('project-name').textContent = DATA.projectName;
  byId('generated-at').textContent = formatDate(DATA.generatedAt) + ' (' + DATA.generatedAt + ')';
  byId('project-id').textContent = DATA.projectId;

  var subtle = (window.crypto && window.crypto.subtle) || null;
  async function sha256Hex(buffer) {
    var bytes = new Uint8Array(await subtle.digest('SHA-256', buffer));
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return out;
  }

  // ------------------------------------------------------------------------------------------------
  // Mode 1: single files
  // ------------------------------------------------------------------------------------------------

  var results1 = byId('results1');
  var picker = byId('file-picker');
  var dropZone = byId('drop-zone');
  var busy1 = false;

  function describeOccurrence(o) {
    if (o.kind === 'reference') {
      return 'Reference: ' + o.title + ', version ' + o.version + ' (saved as ' + o.name + ')';
    }
    return formatRevision(o.revisionNumber) + ', ' + o.branchName + ', ' + o.path;
  }

  function saveAs(blob, name) {
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
  }

  async function checkFile(file) {
    var card = el('div', null, 'card');
    card.appendChild(el('div', file.name + ' (' + formatSize(file.size) + ')', 'card-title'));
    var status = el('p', 'Reading the file...', 'status');
    card.appendChild(status);
    results1.appendChild(card);
    var hash;
    try {
      var buffer = await file.arrayBuffer();
      status.textContent = 'Computing its SHA-256 checksum...';
      hash = await sha256Hex(buffer);
      buffer = null;
    } catch (error) {
      status.className = 'status bad';
      status.textContent = 'Could not read this file: ' + errorText(error) + '. Very large files (over 2 GB) cannot be checked by this page; use the steps in the Map instead.';
      return;
    }
    var named = /^([0-9a-f]{64})\.bin$/i.exec(file.name);
    var entry = Object.prototype.hasOwnProperty.call(DATA.files, hash) ? DATA.files[hash] : null;
    if (named && named[1].toLowerCase() !== hash) {
      status.className = 'status bad';
      status.textContent = "Damaged: the bytes don't match the name. This file is named " + named[1].toLowerCase() + ' but its checksum is ' + hash + '. Do not use it.';
      return;
    }
    if (!entry) {
      status.className = 'status warn';
      status.textContent = "Not in this project's history (as of " + DATA.generatedAt + '). Its checksum is ' + hash + '. If you saved it more recently, use the vault itself.';
      return;
    }
    status.className = 'status good';
    status.textContent = "Matches the project's history: " + formatSize(entry.size) + ', SHA-256 ' + hash + '.';
    card.appendChild(el('p', 'It was saved as:', 'label'));
    var list = el('ul', null, 'plain');
    entry.occurrences.forEach(function (o) { list.appendChild(el('li', describeOccurrence(o))); });
    if (entry.more > 0) list.appendChild(el('li', 'and ' + entry.more + ' more place(s) in the project.'));
    card.appendChild(list);
    var actions = el('div', null, 'actions');
    entry.names.forEach(function (name) {
      var button = el('button', 'Save as "' + name + '"', 'primary');
      button.type = 'button';
      button.addEventListener('click', function () { saveAs(file, name); });
      actions.appendChild(button);
    });
    card.appendChild(actions);
    card.appendChild(el('p', 'A matching checksum shows these are the bytes that were saved. It does not show that the design is right.', 'fine'));
  }

  async function handleFiles(files) {
    if (busy1) return;
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    clear(results1);
    if (!subtle) {
      results1.appendChild(el('p', 'This browser does not provide checksums (crypto.subtle) for pages opened from a file, so single files cannot be checked here. Try Chrome or Edge, or use the steps in the Map.', 'status bad'));
      return;
    }
    busy1 = true;
    try {
      for (var i = 0; i < list.length; i++) await checkFile(list[i]);
    } finally {
      busy1 = false;
    }
  }

  picker.addEventListener('change', function () {
    var files = picker.files;
    handleFiles(files).then(function () { picker.value = ''; });
  });
  ['dragenter', 'dragover'].forEach(function (type) {
    window.addEventListener(type, function (event) { event.preventDefault(); });
    dropZone.addEventListener(type, function (event) { event.preventDefault(); dropZone.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (type) {
    dropZone.addEventListener(type, function () { dropZone.classList.remove('over'); });
  });
  window.addEventListener('drop', function (event) { event.preventDefault(); });
  dropZone.addEventListener('drop', function (event) {
    event.preventDefault();
    handleFiles(event.dataTransfer && event.dataTransfer.files);
  });

  // ------------------------------------------------------------------------------------------------
  // Mode 2: rebuild a whole revision
  // ------------------------------------------------------------------------------------------------

  var mode2 = byId('mode2-body');
  var CLUTTER = /^(\.DS_Store|Thumbs\.db|desktop\.ini|\._.*)$/i;
  var vault = null;
  var objectsDir = null;
  var revisions = [];
  var selected = null;
  var dest = null;
  var running = false;

  var vaultButton = byId('choose-vault');
  var vaultStatus = byId('vault-status');
  var revisionList = byId('revision-list');
  var destButton = byId('choose-dest');
  var destStatus = byId('dest-status');
  var rebuildButton = byId('rebuild');
  var progress2 = byId('progress2');
  var report = byId('report');

  function updateButtons() {
    vaultButton.disabled = running;
    destButton.disabled = running || !selected;
    rebuildButton.disabled = running || !selected || !dest;
  }

  if (!window.showDirectoryPicker || !subtle) {
    clear(mode2);
    mode2.appendChild(el('p', !window.showDirectoryPicker
      ? 'Rebuilding a whole revision needs a browser that can open folders, such as Google Chrome or Microsoft Edge on a computer. This browser cannot. You can still restore single files above, or use the steps in the Map.'
      : 'This browser does not provide checksums (crypto.subtle) for pages opened from a file, so a revision cannot be rebuilt and checked here. Try Chrome or Edge, or use the steps in the Map.', 'status warn'));
    return;
  }

  async function readFileText(dir, name) {
    var file = await (await dir.getFileHandle(name)).getFile();
    if (file.size > 67108864) throw new Error('the record is unexpectedly large');
    return { bytes: await file.arrayBuffer(), file: file };
  }
  async function readJson(dir, name) {
    var read = await readFileText(dir, name);
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)), bytes: read.bytes };
  }

  function isHash(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
  function isCount(value) { return typeof value === 'number' && isFinite(value) && value >= 0 && Math.floor(value) === value && value <= Number.MAX_SAFE_INTEGER; }

  async function loadVault(handle) {
    var revisionsDir, completedDir, branchesDir = null;
    objectsDir = null;
    try {
      revisionsDir = await handle.getDirectoryHandle('revisions');
      objectsDir = await handle.getDirectoryHandle('objects');
      completedDir = await handle.getDirectoryHandle('completed');
    } catch (error) {
      return { error: "That folder doesn't look like a project's vault. A vault folder contains the folders revisions, objects and completed. Choose the folder named vault inside the project folder." };
    }
    try { branchesDir = await handle.getDirectoryHandle('branches'); } catch (error) { branchesDir = null; }

    var branchNames = {};
    var problems = [];
    if (branchesDir) {
      for await (var branchEntry of branchesDir.entries()) {
        var branchName = branchEntry[0];
        if (branchEntry[1].kind !== 'file' || !/\.json$/.test(branchName) || /\.ready\.json$/.test(branchName)) continue;
        try {
          var branch = (await readJson(branchesDir, branchName)).value;
          if (branch && typeof branch.branchId === 'string' && typeof branch.name === 'string') branchNames[branch.branchId] = branch.name;
        } catch (error) {
          problems.push('Branch record ' + branchName + ' could not be read (' + errorText(error) + ').');
        }
      }
    }

    var list = [];
    for await (var entry of completedDir.entries()) {
      var doneName = entry[0];
      if (entry[1].kind !== 'file' || !/\.done\.json$/.test(doneName)) continue;
      var id = doneName.slice(0, doneName.length - '.done.json'.length);
      try {
        var done = (await readJson(completedDir, doneName)).value;
        if (!done || done.revisionId !== id || !isHash(done.manifestSha256)) throw new Error('the completion record is not valid');
        var read = await readJson(revisionsDir, id + '.manifest.json');
        var manifest = read.value;
        if (await sha256Hex(read.bytes) !== done.manifestSha256) throw new Error("the revision record's checksum does not match its completion record");
        if (!manifest || manifest.revisionId !== id || !isCount(manifest.displayNumber) || !Array.isArray(manifest.files) || !Array.isArray(manifest.directories)) {
          throw new Error('the revision record is not valid');
        }
        manifest.files.forEach(function (file) {
          if (!file || typeof file.path !== 'string' || !isHash(file.sha256) || !isCount(file.size)) throw new Error('a file entry is not valid');
        });
        manifest.directories.forEach(function (dir) { if (typeof dir !== 'string') throw new Error('a folder entry is not valid'); });
        list.push({
          id: id,
          number: manifest.displayNumber,
          branch: Object.prototype.hasOwnProperty.call(branchNames, manifest.branchId) ? branchNames[manifest.branchId] : 'Unknown branch',
          completedAt: typeof manifest.captureCompletedAt === 'string' ? manifest.captureCompletedAt : '',
          summary: typeof manifest.summary === 'string' ? manifest.summary : '',
          manifest: manifest
        });
      } catch (error) {
        problems.push('Revision ' + id + ' is not listed: ' + errorText(error) + '.');
      }
    }
    list.sort(function (a, b) { return a.completedAt < b.completedAt ? -1 : a.completedAt > b.completedAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return { revisions: list, problems: problems };
  }

  function renderRevisions(problems) {
    clear(revisionList);
    if (!revisions.length) revisionList.appendChild(el('p', 'This vault has no complete revisions.', 'status warn'));
    revisions.forEach(function (revision) {
      var label = el('label', null, 'choice');
      var radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'revision';
      radio.addEventListener('change', function () { selected = revision; clear(report); progress2.textContent = ''; updateButtons(); });
      label.appendChild(radio);
      var text = el('span', null, 'choice-text');
      text.appendChild(el('strong', formatRevision(revision.number)));
      text.appendChild(document.createTextNode(' · ' + revision.branch + ' · ' + formatDate(revision.completedAt) + ' · ' + revision.manifest.files.length + ' file(s)'));
      if (revision.summary) text.appendChild(el('span', revision.summary, 'summary'));
      label.appendChild(text);
      revisionList.appendChild(label);
    });
    if (problems.length) {
      var box = el('div', null, 'status warn');
      box.appendChild(el('p', 'Some records could not be used (the rest are listed above):'));
      var list = el('ul', null, 'plain');
      problems.forEach(function (problem) { list.appendChild(el('li', problem)); });
      box.appendChild(list);
      revisionList.appendChild(box);
    }
  }

  vaultButton.addEventListener('click', async function () {
    if (running) return;
    var handle;
    try {
      handle = await window.showDirectoryPicker({ mode: 'read' });
    } catch (error) {
      if (!isCancel(error)) { vaultStatus.className = 'status bad'; vaultStatus.textContent = 'Could not open the folder: ' + errorText(error); }
      return;
    }
    vaultStatus.className = 'status';
    vaultStatus.textContent = 'Reading the vault...';
    selected = null; dest = null; vault = null; revisions = [];
    destStatus.textContent = ''; clear(revisionList); clear(report); progress2.textContent = '';
    updateButtons();
    var loaded;
    try {
      loaded = await loadVault(handle);
    } catch (error) {
      vaultStatus.className = 'status bad';
      vaultStatus.textContent = 'Could not read the vault: ' + errorText(error);
      return;
    }
    if (loaded.error) { vaultStatus.className = 'status bad'; vaultStatus.textContent = loaded.error; return; }
    vault = handle;
    revisions = loaded.revisions;
    vaultStatus.className = 'status good';
    vaultStatus.textContent = 'Vault found: ' + revisions.length + ' complete revision(s). It is opened read-only; nothing is written to it.';
    renderRevisions(loaded.problems);
    updateButtons();
  });

  async function checkDestination(handle) {
    if (await handle.isSameEntry(vault)) return 'That is the vault itself. Choose a different, empty folder outside the vault.';
    if (await vault.resolve(handle)) return 'That folder is inside the vault. Choose an empty folder outside the vault; nothing may be written into the vault.';
    if (await handle.resolve(vault)) return 'The vault is inside that folder. Choose an empty folder that does not contain the vault.';
    for await (var entry of handle.entries()) {
      if (!CLUTTER.test(entry[0])) return 'That folder is not empty (it contains "' + entry[0] + '"). Make a new, empty folder and choose it.';
    }
    return null;
  }

  destButton.addEventListener('click', async function () {
    if (running || !vault) return;
    var handle;
    try {
      handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    } catch (error) {
      if (!isCancel(error)) { destStatus.className = 'status bad'; destStatus.textContent = 'Could not open the folder: ' + errorText(error); }
      return;
    }
    dest = null;
    clear(report);
    updateButtons();
    try {
      var problem = await checkDestination(handle);
      if (problem) { destStatus.className = 'status bad'; destStatus.textContent = problem; return; }
    } catch (error) {
      destStatus.className = 'status bad';
      destStatus.textContent = 'Could not check that folder: ' + errorText(error);
      return;
    }
    dest = handle;
    destStatus.className = 'status good';
    destStatus.textContent = 'Empty folder chosen (' + (handle.name || 'folder') + '). Ready to rebuild.';
    updateButtons();
  });

  function safeSegments(path) {
    if (typeof path !== 'string' || !path) return null;
    var segments = path.split('/');
    for (var i = 0; i < segments.length; i++) {
      var s = segments[i];
      if (!s || s === '.' || s === '..' || /[\\\u0000-\u001f]/.test(s)) return null;
    }
    return segments;
  }

  async function rebuild(revision) {
    var manifest = revision.manifest;
    var rows = [];
    var counts = { written: 0, missing: 0, damaged: 0, failed: 0, folders: 0 };
    var dirCache = new Map();
    dirCache.set('', dest);
    var seen = new Set();

    async function ensureDir(segments) {
      var key = '';
      var current = dest;
      for (var i = 0; i < segments.length; i++) {
        key = key ? key + '/' + segments[i] : segments[i];
        var cached = dirCache.get(key);
        if (cached) { current = cached; continue; }
        current = await current.getDirectoryHandle(segments[i], { create: true });
        dirCache.set(key, current);
        counts.folders++;
      }
      return current;
    }

    for (var d = 0; d < manifest.directories.length; d++) {
      var dirPath = manifest.directories[d];
      var dirSegments = safeSegments(dirPath);
      if (!dirSegments) { counts.failed++; rows.push({ state: 'failed', path: dirPath, detail: 'Folder skipped: its path is not safe to create.' }); continue; }
      try { await ensureDir(dirSegments); } catch (error) { counts.failed++; rows.push({ state: 'failed', path: dirPath, detail: 'Could not create the folder: ' + errorText(error) }); }
    }

    var total = manifest.files.length;
    for (var i = 0; i < total; i++) {
      var file = manifest.files[i];
      progress2.textContent = 'Rebuilding ' + (i + 1) + ' of ' + total + ': ' + file.path;
      var segments = safeSegments(file.path);
      if (!segments) { counts.failed++; rows.push({ state: 'failed', path: file.path, detail: 'Skipped: the path is not safe to write.' }); continue; }
      var lower = segments.join('/').toLowerCase();
      if (seen.has(lower)) { counts.failed++; rows.push({ state: 'failed', path: file.path, detail: 'Skipped: another file in this revision has the same name apart from capital letters.' }); continue; }
      seen.add(lower);
      var buffer;
      try {
        var objectHandle;
        try {
          var shard = await objectsDir.getDirectoryHandle(file.sha256.slice(0, 2));
          objectHandle = await shard.getFileHandle(file.sha256 + '.bin');
        } catch (error) {
          if (error && error.name === 'NotFoundError') {
            counts.missing++;
            rows.push({ state: 'missing', path: file.path, detail: 'The saved file is missing from the vault (objects/' + file.sha256.slice(0, 2) + '/' + file.sha256 + '.bin).' });
            continue;
          }
          throw error;
        }
        var object = await objectHandle.getFile();
        if (object.size !== file.size) {
          counts.damaged++;
          rows.push({ state: 'damaged', path: file.path, detail: 'The saved file is ' + object.size + ' bytes but the record says ' + file.size + '. It was not written.' });
          continue;
        }
        buffer = await object.arrayBuffer();
        var actual = await sha256Hex(buffer);
        if (actual !== file.sha256) {
          counts.damaged++;
          rows.push({ state: 'damaged', path: file.path, detail: "The saved file's checksum does not match its record. It was not written." });
          continue;
        }
      } catch (error) {
        counts.failed++;
        rows.push({ state: 'failed', path: file.path, detail: 'Could not read the saved file: ' + errorText(error) });
        continue;
      }
      try {
        var parent = await ensureDir(segments.slice(0, -1));
        var name = segments[segments.length - 1];
        var exists = false;
        try {
          await parent.getFileHandle(name);
          exists = true;
        } catch (error) {
          if (error && error.name === 'TypeMismatchError') exists = true;
          else if (!error || error.name !== 'NotFoundError') throw error;
        }
        if (exists) {
          counts.failed++;
          rows.push({ state: 'failed', path: file.path, detail: 'Skipped: something with this name is already in the destination folder (nothing is overwritten).' });
          continue;
        }
        var handle = await parent.getFileHandle(name, { create: true });
        var writable = await handle.createWritable();
        try {
          await writable.write(buffer);
          await writable.close();
        } catch (error) {
          try { await writable.abort(); } catch (ignored) { /* nothing to undo */ }
          throw error;
        }
        var back = await (await handle.getFile()).arrayBuffer();
        if (await sha256Hex(back) !== file.sha256) {
          try { await parent.removeEntry(name); } catch (ignored) { /* reported below */ }
          counts.failed++;
          rows.push({ state: 'failed', path: file.path, detail: 'The file was written but reading it back did not match its checksum, so the copy was removed.' });
          continue;
        }
        counts.written++;
        rows.push({ state: 'written', path: file.path, detail: formatSize(file.size) + ', checksum checked before and after writing' });
      } catch (error) {
        counts.failed++;
        rows.push({ state: 'failed', path: file.path, detail: 'Write failed: ' + errorText(error) });
      }
      buffer = null;
    }
    progress2.textContent = '';
    return { rows: rows, counts: counts, total: total };
  }

  function renderReport(revision, result) {
    clear(report);
    var counts = result.counts;
    var problems = result.rows.filter(function (row) { return row.state !== 'written'; });
    var ok = !problems.length;
    var summary = formatRevision(revision.number) + ': ' + counts.written + ' of ' + result.total + ' file(s) written, ' + counts.missing + ' missing, ' + counts.damaged + ' damaged, ' + counts.failed + ' failed; ' + counts.folders + ' folder(s) created.';
    report.appendChild(el('p', summary, ok ? 'status good' : 'status bad'));
    if (!ok) {
      report.appendChild(el('p', 'Do not use this rebuilt folder as the full revision. Files that are missing, damaged or failed were not written:', 'label'));
      report.appendChild(reportTable(problems));
    } else {
      report.appendChild(el('p', 'Every file was checked against its saved checksum before it was written and again after. That shows the bytes are the ones that were saved. It does not show that the design is right: open the assembly in your CAD program and check it.', 'fine'));
    }
    var written = result.rows.filter(function (row) { return row.state === 'written'; });
    if (written.length) {
      var details = el('details');
      details.appendChild(el('summary', 'Show the ' + written.length + ' written file(s)'));
      details.appendChild(reportTable(written));
      report.appendChild(details);
    }
  }

  function reportTable(rows) {
    var table = el('table');
    var head = el('tr');
    ['Result', 'File', 'Detail'].forEach(function (title) { head.appendChild(el('th', title)); });
    table.appendChild(head);
    rows.forEach(function (row) {
      var tr = el('tr');
      tr.appendChild(el('td', row.state, 'state-' + row.state));
      tr.appendChild(el('td', row.path));
      tr.appendChild(el('td', row.detail));
      table.appendChild(tr);
    });
    return table;
  }

  rebuildButton.addEventListener('click', async function () {
    if (running || !selected || !dest || !vault) return;
    running = true;
    updateButtons();
    clear(report);
    try {
      // The destination is checked again: it may have been changed since it was chosen.
      var problem = await checkDestination(dest);
      if (problem) { destStatus.className = 'status bad'; destStatus.textContent = problem; dest = null; return; }
      var result = await rebuild(selected);
      renderReport(selected, result);
    } catch (error) {
      progress2.textContent = '';
      report.appendChild(el('p', 'The rebuild stopped: ' + errorText(error), 'status bad'));
    } finally {
      running = false;
      dest = null;
      destStatus.className = 'status';
      destStatus.textContent = 'To rebuild again, choose another empty folder.';
      updateButtons();
    }
  });

  updateButtons();
})();
`;
