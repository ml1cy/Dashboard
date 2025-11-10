// /js/app.js
import {GridStack} from 'https://cdn.jsdelivr.net/npm/gridstack@8.0.1/dist/gridstack-h5.js';

// --- CONFIG: replace with your Google CLIENT_ID ---
const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';
const DRIVE_CONFIG_FILENAME = 'gwrk-dashboard-config.json'; // stored in appDataFolder

let grid;
let gisToken = null; // will hold access token
let googleUser = null;

async function initGrid() {
  grid = GridStack.init({
    column: 12,
    float: false,
    animate: true
  }, '#grid');

  // Default widgets if none saved:
  const defaultLayout = [
    {x:0,y:0,w:4,h:4,content:'<div class="widget-header"><h3>Classroom To-Do</h3></div><div id="classroom-widget"></div>'},
    {x:4,y:0,w:4,h:4,content:'<div class="widget-header"><h3>Drive Recent</h3></div><div id="drive-widget"></div>'},
    {x:8,y:0,w:4,h:4,content:'<div class="widget-header"><h3>GitHub</h3></div><div id="github-widget"></div>'}
  ];

  // try to load saved config (after auth)
  const saved = await tryLoadConfig();
  const layout = saved?.layout ?? defaultLayout;

  // add items to grid
  layout.forEach(item => {
    const el = document.createElement('div');
    el.className = 'grid-stack-item';
    el.innerHTML = `<div class="grid-stack-item-content">${item.content}</div>`;
    grid.addWidget(el, {x:item.x, y:item.y, w:item.w, h:item.h});
  });
  
  // wire save on change
  grid.on('change', () => saveLayout());
}

window.addEventListener('DOMContentLoaded', async () => {
  await initGIS();
  await initGrid();
  document.getElementById('signOutBtn').addEventListener('click', signOut);
});

async function initGIS() {
  // load the Google Identity Services library
  await loadScript('https://accounts.google.com/gsi/client');
  // create a token client for obtaining OAuth tokens to call Google APIs
  window.gisTokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/classroom.coursework.me.readonly https://www.googleapis.com/auth/classroom.announcements.readonly https://www.googleapis.com/auth/gmail.readonly profile email',
    callback: (tokenResponse) => {
      gisToken = tokenResponse.access_token;
      // show sign out
      document.getElementById('signInBtn').style.display='none';
      document.getElementById('signOutBtn').style.display='inline-block';
      // now that we have a token, load user-specific widgets
      loadUserWidgets();
    }
  });

  document.getElementById('signInBtn').addEventListener('click', async () => {
    // Request an access token interactively
    window.gisTokenClient.requestAccessToken({prompt: 'consent'});
  });
}

async function signOut() {
  gisToken = null;
  document.getElementById('signInBtn').style.display='inline-block';
  document.getElementById('signOutBtn').style.display='none';
  // optionally revoke token
  // TODO: clear user widgets
}

async function loadUserWidgets() {
  // Example: after sign in, initialize Classroom widget & GitHub widget
  await loadClassroomWidget();
  await loadDriveWidget();
  await loadGitHubWidget();
  // load bookmarks, Gmail widget etc.
}

/* ---------- Config persistence in Drive appDataFolder ---------- */
/* Use Drive REST calls with Authorization: Bearer <gisToken> to store a single JSON file in the appDataFolder. */

async function tryLoadConfig() {
  if (!gisToken) return null;
  // list files in appDataFolder
  const res = await fetch('https://www.googleapis.com/drive/v3/files?q=name=\''+encodeURIComponent(DRIVE_CONFIG_FILENAME)+'\' and trashed=false&spaces=appDataFolder&fields=files(id,name)', {
    headers: { Authorization: 'Bearer '+gisToken }
  });
  if (!res.ok) { console.error('drive list failed', await res.text()); return null; }
  const data = await res.json();
  if (!data.files || data.files.length===0) return null;
  const fileId = data.files[0].id;
  const download = await fetch('https://www.googleapis.com/drive/v3/files/'+fileId+'?alt=media', { headers: { Authorization: 'Bearer '+gisToken }});
  if (!download.ok) return null;
  const json = await download.json();
  return json;
}

async function saveLayout() {
  if (!gisToken) { console.warn('no token: not saving'); return; }
  // build a layout array
  const items = [];
  grid.engine.nodes.forEach(node => {
    const content = node.el.querySelector('.grid-stack-item-content').innerHTML;
    items.push({x: node.x, y: node.y, w: node.w, h: node.h, content});
  });
  const payload = { layout: items, updated: new Date().toISOString() };
  // check if config file exists
  const list = await fetch('https://www.googleapis.com/drive/v3/files?q=name=\''+encodeURIComponent(DRIVE_CONFIG_FILENAME)+'\' and trashed=false&spaces=appDataFolder&fields=files(id,name)', { headers:{ Authorization: 'Bearer '+gisToken }});
  const listJson = await list.json();
  if (listJson.files && listJson.files.length>0) {
    // update existing file (simple resumable or multipart upload) -> use multipart
    const fileId = listJson.files[0].id;
    const metadata = { name: DRIVE_CONFIG_FILENAME, parents: ['appDataFolder'] };
    const boundary = '-------314159265358979323846';
    const bodyParts = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      'Content-Type: application/json',
      '',
      JSON.stringify(payload),
      `--${boundary}--`
    ].join('\r\n');
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files/'+fileId+'?uploadType=multipart&fields=id', {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer '+gisToken,
        'Content-Type': 'multipart/related; boundary=' + boundary
      },
      body: bodyParts
    });
    console.log('save result', await res.json());
  } else {
    // create file in appDataFolder
    const metadata = { name: DRIVE_CONFIG_FILENAME, parents: ['appDataFolder'] };
    const boundary = '-------314159265358979323846';
    const multipart = [
      `--${boundary}`,
      'Content-Type: application/json; charset=UTF-8',
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      'Content-Type: application/json',
      '',
      JSON.stringify(payload),
      `--${boundary}--`
    ].join('\r\n');
    const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer '+gisToken,
        'Content-Type': 'multipart/related; boundary=' + boundary
      },
      body: multipart
    });
    console.log('created config', await res.json());
  }
}

/* ----------- Helpers ----------- */
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

/* ----------- Example widget loaders (sparse) ----------- */

async function loadClassroomWidget() {
  if (!gisToken) return;
  // call Classroom coursework API for this user's coursework
  const res = await fetch('https://classroom.googleapis.com/v1/courses?courseStates=ACTIVE', { headers:{ Authorization: 'Bearer '+gisToken }});
  if (!res.ok) { console.error('classroom list failed', await res.text()); return; }
  const courses = (await res.json()).courses || [];
  const out = document.getElementById('classroom-widget');
  if (!out) return;
  out.innerHTML = '';
  for (const c of courses) {
    const li = document.createElement('div');
    li.innerHTML = `<strong>${escapeHtml(c.name)}</strong> <small>${escapeHtml(c.section ?? '')}</small>`;
    out.appendChild(li);
    // fetch coursework for course
    const cwRes = await fetch(`https://classroom.googleapis.com/v1/courses/${encodeURIComponent(c.id)}/courseWork?orderBy=dueDate`, { headers:{ Authorization: 'Bearer '+gisToken }});
    if (!cwRes.ok) continue;
    const cw = await cwRes.json();
    if (cw.courseWork && cw.courseWork.length) {
      const ul = document.createElement('ul');
      for (const item of cw.courseWork) {
        const due = item.dueDate ? `${item.dueDate.year}-${item.dueDate.month}-${item.dueDate.day}` : 'no due';
        const li2 = document.createElement('li');
        li2.innerHTML = `<span>${escapeHtml(item.title)} (${escapeHtml(due)})</span>`;
        // link to attached materials if any
        if (item.materials) {
          for (const m of item.materials) {
            if (m.driveFile) {
              const link = document.createElement('a');
              link.href = `https://drive.google.com/file/d/${m.driveFile.driveFileId}/view`;
              link.target = '_blank';
              link.textContent = 'attachment';
              li2.appendChild(document.createTextNode(' '));
              li2.appendChild(link);
            }
          }
        }
        ul.appendChild(li2);
      }
      out.appendChild(ul);
    }
  }
}

async function loadDriveWidget() {
  if (!gisToken) return;
  const res = await fetch('https://www.googleapis.com/drive/v3/files?pageSize=10&orderBy=modifiedTime desc&fields=files(id,name,webViewLink,mimeType,modifiedTime)', { headers:{ Authorization: 'Bearer '+gisToken }});
  const json = await res.json();
  const out = document.getElementById('drive-widget');
  if (!out) return;
  out.innerHTML = '<ul>' + (json.files||[]).map(f => `<li><a href="${f.webViewLink}" target="_blank">${escapeHtml(f.name)}</a> <small>${f.modifiedTime}</small></li>`).join('') + '</ul>';
}

async function loadGitHubWidget() {
  const out = document.getElementById('github-widget');
  if (!out) return;
  // GitHub needs separate OAuth. For demo, ask user for a PAT or implement OAuth
  const token = localStorage.getItem('gh_token');
  if (!token) {
    out.innerHTML = '<button id="gh-auth">Connect GitHub (paste PAT)</button>';
    document.getElementById('gh-auth').addEventListener('click', () => {
      const t = prompt('Paste a GitHub Personal Access Token (scopes: repo, codespaces)');
      if (t) { localStorage.setItem('gh_token', t); loadGitHubWidget(); }
    });
    return;
  }
  const res = await fetch('https://api.github.com/user/repos?sort=updated&per_page=10', { headers: { Authorization: 'token '+token }});
  if (!res.ok) { out.textContent = 'GitHub API error'; return; }
  const repos = await res.json();
  out.innerHTML = '<ul>' + repos.map(r => `<li><a href="${r.html_url}" target="_blank">${escapeHtml(r.full_name)}</a></li>`).join('') + '</ul>';
}

// small helper
function escapeHtml(s){ return (s+'').replace(/[&<>"']/g, c=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
