'use strict';

/* ============ 工具函数 ============ */

function uid() {
  if (window.crypto && typeof crypto.randomUUID === 'function') {
    try {
      return crypto.randomUUID();
    } catch (e) {
      /* file:// 下可能受限，走兜底方案 */
    }
  }
  const a = crypto.getRandomValues(new Uint32Array(4));
  return a.map((x) => x.toString(16).padStart(8, '0')).join('');
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(1) + ' MB';
}

function formatDate(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function baseName(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

function extName(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i) : '';
}

let toastTimer = null;
function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type === 'error' ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2600);
}

/* ============ IndexedDB 数据层 ============ */

const DB_NAME = 'pdf-vault';
const STORE = 'pdfs';

let db = null;
let items = []; // { id, name, blob, size, pinned, createdAt }
let searchQuery = '';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbPut(item) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbDelete(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function dbGetAll() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/* ============ 保存与管理 ============ */

function uniqueName(name) {
  const names = new Set(items.map((it) => it.name));
  if (!names.has(name)) return name;
  for (let n = 1; ; n++) {
    const candidate = baseName(name) + ' (' + n + ')' + extName(name);
    if (!names.has(candidate)) return candidate;
  }
}

async function addFile(file, opts = {}) {
  if (!db) return;
  const item = {
    id: uid(),
    name: uniqueName(opts.name || file.name),
    blob: file,
    size: file.size,
    pinned: !!opts.pinned,
    createdAt: opts.createdAt || Date.now(),
  };
  await dbPut(item);
  items.push(item);
  render();
}

async function handleFiles(files) {
  const pdfs = files.filter((f) => f.name.toLowerCase().endsWith('.pdf'));
  const rejected = files.length - pdfs.length;
  if (!pdfs.length) {
    toast('仅支持 PDF 文件', 'error');
    return;
  }
  let saved = 0;
  for (const f of pdfs) {
    try {
      await addFile(f);
      saved++;
    } catch (e) {
      console.error('保存失败:', f.name, e);
    }
  }
  if (saved === 0) {
    toast('保存失败，请按 F12 查看控制台', 'error');
    return;
  }
  let msg = '已保存 ' + saved + ' 个 PDF';
  if (rejected > 0) msg += '，忽略 ' + rejected + ' 个非 PDF 文件';
  toast(msg);
}

async function togglePin(item) {
  item.pinned = !item.pinned;
  await dbPut(item);
  render();
}

async function deleteItem(item) {
  await dbDelete(item.id);
  items = items.filter((it) => it.id !== item.id);
  if (viewerItem === item) closeViewer();
  render();
  toast('已删除');
}

async function copyItem(item) {
  const file = new File([item.blob], item.name, { type: item.blob.type || 'application/pdf' });
  await addFile(file, { name: baseName(item.name) + ' 副本' + extName(item.name) });
  toast('已生成副本');
}

async function renameItem(item, name) {
  item.name = name;
  await dbPut(item);
  if (viewerItem === item) {
    document.getElementById('viewer-name').textContent = name;
  }
  render();
  toast('已重命名');
}

function downloadItem(item) {
  const url = URL.createObjectURL(item.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = item.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/* ============ 渲染 ============ */

const grid = document.getElementById('grid');
const emptyEl = document.getElementById('empty');
const emptyTitle = document.getElementById('empty-title');
const emptyHint = document.getElementById('empty-hint');

function sortedItems() {
  const q = searchQuery.trim().toLowerCase();
  const list = q ? items.filter((it) => it.name.toLowerCase().includes(q)) : items.slice();
  list.sort((a, b) => (a.pinned !== b.pinned) ? (a.pinned ? -1 : 1) : (b.createdAt - a.createdAt));
  return list;
}

let openMenuEl = null;
function closeMenu() {
  if (openMenuEl) {
    openMenuEl.classList.add('hidden');
    openMenuEl = null;
  }
}

function render() {
  const list = sortedItems();
  grid.textContent = '';
  if (items.length === 0) {
    emptyTitle.textContent = '把 PDF 拖到这里保存';
    emptyHint.textContent = '也可以按 Ctrl+V 粘贴剪贴板中的文件';
    emptyEl.classList.remove('hidden');
    return;
  }
  if (list.length === 0) {
    emptyTitle.textContent = '没有找到匹配的 PDF';
    emptyHint.textContent = '换个关键词试试';
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  for (const item of list) grid.appendChild(buildCard(item));
}

function buildCard(item) {
  const card = document.createElement('div');
  card.className = 'card' + (item.pinned ? ' pinned' : '');

  const icon = document.createElement('div');
  icon.className = 'card-icon';
  icon.textContent = 'PDF';

  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = item.name;
  name.title = item.name;

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  meta.textContent = formatSize(item.size) + ' · ' + formatDate(item.createdAt);

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  const pinBtn = document.createElement('button');
  pinBtn.className = 'pin-btn' + (item.pinned ? ' on' : '');
  pinBtn.textContent = item.pinned ? '★' : '☆';
  pinBtn.title = item.pinned ? '取消置顶' : '置顶';
  pinBtn.addEventListener('click', () => togglePin(item));

  const menuWrap = document.createElement('div');
  menuWrap.className = 'menu-wrap';

  const menuBtn = document.createElement('button');
  menuBtn.className = 'menu-btn';
  menuBtn.textContent = '⋯';
  menuBtn.title = '更多操作';

  const menu = document.createElement('div');
  menu.className = 'menu hidden';
  [
    ['复制', () => { closeMenu(); copyItem(item); }],
    ['重命名', () => { closeMenu(); askRename(item); }],
    ['下载', () => { closeMenu(); downloadItem(item); }],
    ['删除', () => { closeMenu(); askDelete(item); }, true],
  ].forEach(([label, fn, danger]) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (danger) b.className = 'danger';
    b.addEventListener('click', fn);
    menu.appendChild(b);
  });

  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (openMenuEl && openMenuEl !== menu) closeMenu();
    menu.classList.toggle('hidden');
    openMenuEl = menu.classList.contains('hidden') ? null : menu;
  });

  menuWrap.appendChild(menuBtn);
  menuWrap.appendChild(menu);
  actions.appendChild(pinBtn);
  actions.appendChild(menuWrap);

  // 单击打开查看器（延迟 220ms，用于区分双击重命名）
  let clickTimer = null;
  card.addEventListener('click', (e) => {
    if (e.target.closest('.card-actions') || e.target.closest('.menu')) return;
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
      return;
    }
    clickTimer = setTimeout(() => {
      clickTimer = null;
      openViewer(item);
    }, 220);
  });
  card.addEventListener('dblclick', (e) => {
    if (e.target.closest('.card-actions') || e.target.closest('.menu')) return;
    if (clickTimer) {
      clearTimeout(clickTimer);
      clickTimer = null;
    }
    askRename(item);
  });

  card.appendChild(icon);
  card.appendChild(name);
  card.appendChild(meta);
  card.appendChild(actions);
  return card;
}

// 点击页面其他位置时收起已打开的菜单
document.addEventListener('click', (e) => {
  if (openMenuEl && !e.target.closest('.menu')) closeMenu();
});

/* ============ 查看器 ============ */

const viewer = document.getElementById('viewer');
const viewerFrame = document.getElementById('viewer-frame');
const viewerName = document.getElementById('viewer-name');
let viewerItem = null;
let viewerUrl = null;

function openViewer(item) {
  viewerItem = item;
  if (viewerUrl) URL.revokeObjectURL(viewerUrl);
  viewerUrl = URL.createObjectURL(item.blob);
  viewerName.textContent = item.name;
  viewerFrame.src = viewerUrl;
  viewer.classList.remove('hidden');
}

function closeViewer() {
  viewerItem = null;
  if (viewerUrl) {
    URL.revokeObjectURL(viewerUrl);
    viewerUrl = null;
  }
  viewerFrame.src = 'about:blank';
  viewer.classList.add('hidden');
}

document.getElementById('viewer-close').addEventListener('click', closeViewer);
document.getElementById('viewer-download').addEventListener('click', () => { if (viewerItem) downloadItem(viewerItem); });
document.getElementById('viewer-copy').addEventListener('click', () => { if (viewerItem) copyItem(viewerItem); });
document.getElementById('viewer-rename').addEventListener('click', () => { if (viewerItem) askRename(viewerItem); });
document.getElementById('viewer-delete').addEventListener('click', () => { if (viewerItem) askDelete(viewerItem); });

/* ============ 确认 / 重命名对话框 ============ */

const confirmEl = document.getElementById('confirm');
let confirmCb = null;

function askConfirm(text, okLabel, cb) {
  confirmCb = cb;
  document.getElementById('confirm-text').textContent = text;
  document.getElementById('confirm-ok').textContent = okLabel || '确定';
  confirmEl.classList.remove('hidden');
}

function closeConfirm() {
  confirmEl.classList.add('hidden');
  confirmCb = null;
}

function askDelete(item) {
  askConfirm('确定删除「' + item.name + '」吗？删除后无法恢复。', '删除', () => deleteItem(item));
}

document.getElementById('confirm-ok').addEventListener('click', () => {
  const cb = confirmCb;
  closeConfirm();
  if (cb) cb();
});
document.getElementById('confirm-cancel').addEventListener('click', closeConfirm);
confirmEl.addEventListener('click', (e) => { if (e.target === confirmEl) closeConfirm(); });

const renameEl = document.getElementById('rename');
const renameInput = document.getElementById('rename-input');
let renameTarget = null;

function askRename(item) {
  renameTarget = item;
  renameInput.value = item.name;
  const i = item.name.lastIndexOf('.');
  renameEl.classList.remove('hidden');
  renameInput.focus();
  renameInput.setSelectionRange(0, i > 0 ? i : item.name.length);
}

function closeRename() {
  renameEl.classList.add('hidden');
  renameTarget = null;
}

async function doRename() {
  const item = renameTarget;
  if (!item) return;
  let name = renameInput.value.trim();
  if (!name) {
    toast('名字不能为空', 'error');
    return;
  }
  if (!name.toLowerCase().endsWith('.pdf')) name += '.pdf';
  if (name !== item.name) name = uniqueName(name);
  if (name !== item.name) await renameItem(item, name);
  closeRename();
}

document.getElementById('rename-ok').addEventListener('click', doRename);
document.getElementById('rename-cancel').addEventListener('click', closeRename);
renameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doRename();
  if (e.key === 'Escape') closeRename();
});

/* ============ 拖拽保存 ============ */

const dropOverlay = document.getElementById('drop-overlay');
let dragDepth = 0;

function hasFiles(e) {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
}

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  dropOverlay.classList.remove('hidden');
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) dropOverlay.classList.add('hidden');
});
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  dropOverlay.classList.add('hidden');
  handleFiles(Array.from(e.dataTransfer.files || []));
});

/* ============ 剪贴板粘贴保存 ============ */

document.addEventListener('paste', (e) => {
  const files = [];
  const list = e.clipboardData && e.clipboardData.items;
  if (list) {
    for (const it of list) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  if (!files.length) return; // 剪贴板中没有文件，交给默认行为
  e.preventDefault();
  handleFiles(files);
});

/* ============ 导出 / 导入备份 ============ */

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function base64ToBlob(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'application/pdf' });
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function exportBackup() {
  if (!items.length) {
    toast('还没有 PDF，无需导出', 'error');
    return;
  }
  try {
    toast('正在导出…');
    const files = await Promise.all(items.map(async (it) => ({
      name: it.name,
      pinned: it.pinned,
      createdAt: it.createdAt,
      base64: await blobToBase64(it.blob),
    })));
    const json = JSON.stringify({ app: 'pdf-vault', version: 1, files });
    const stamp = new Date().toISOString().slice(0, 10);
    downloadBlob(new Blob([json], { type: 'application/json' }), 'PDF备份-' + stamp + '.json');
    toast('已导出 ' + files.length + ' 个 PDF');
  } catch (e) {
    console.error(e);
    toast('导出失败', 'error');
  }
}

const importInput = document.getElementById('import-input');

async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.files)) throw new Error('格式不正确');
    let saved = 0;
    for (const f of data.files) {
      if (!f || !f.name || !f.base64) continue;
      const blob = base64ToBlob(f.base64);
      await addFile(new File([blob], f.name, { type: 'application/pdf' }), {
        name: f.name,
        pinned: !!f.pinned,
        createdAt: Number(f.createdAt) || Date.now(),
      });
      saved++;
    }
    if (saved) {
      toast('已导入 ' + saved + ' 个 PDF');
    } else {
      toast('备份中没有可导入的文件', 'error');
    }
  } catch (e) {
    console.error(e);
    toast('导入失败：不是有效的备份文件', 'error');
  }
}

importInput.addEventListener('change', () => {
  const f = importInput.files[0];
  if (f) importBackup(f);
  importInput.value = '';
});

document.getElementById('btn-export').addEventListener('click', exportBackup);
document.getElementById('btn-import').addEventListener('click', () => importInput.click());

/* ============ 搜索 / 快捷键 ============ */

document.getElementById('search').addEventListener('input', (e) => {
  searchQuery = e.target.value;
  render();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!viewer.classList.contains('hidden')) {
    closeViewer();
    return;
  }
  if (!confirmEl.classList.contains('hidden')) {
    closeConfirm();
    return;
  }
  if (!renameEl.classList.contains('hidden')) {
    closeRename();
    return;
  }
  closeMenu();
});

/* ============ 初始化 ============ */

(async function init() {
  try {
    db = await openDB();
    items = await dbGetAll();
  } catch (e) {
    console.error(e);
    if (!window.indexedDB) {
      // 360 浏览器等用 IE 兼容内核打开时的提示
      toast('当前浏览器内核不支持，请切换到极速模式', 'error');
      emptyTitle.textContent = '当前浏览器内核不支持';
      emptyHint.textContent = '360浏览器请点击地址栏的图标切换到「极速模式」，或使用 Edge / Chrome 打开';
      emptyEl.classList.remove('hidden');
    } else {
      toast('浏览器存储不可用（无痕模式下无法使用）', 'error');
    }
    return;
  }
  render();
})();
