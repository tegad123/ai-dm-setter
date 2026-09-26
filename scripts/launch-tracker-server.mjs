// Local browser view for docs/launch-tracker.json. Binds only to loopback.
// Run: node scripts/launch-tracker-server.mjs
import { createServer } from 'node:http';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const trackerPath = resolve(root, 'docs/launch-tracker.json');
const port = Number(process.env.LAUNCH_TRACKER_PORT || 8765);
const allowedStatuses = new Set([
  'todo',
  'in_progress',
  'blocked',
  'verified',
  'retired'
]);
let writeQueue = Promise.resolve();

async function readTracker() {
  return JSON.parse(await readFile(trackerPath, 'utf8'));
}

function respond(response, code, body, contentType = 'application/json') {
  response.writeHead(code, {
    'Content-Type': `${contentType}; charset=utf-8`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(
    contentType === 'application/json' ? JSON.stringify(body) : body
  );
}

async function updateTask(id, patch) {
  const taskId = decodeURIComponent(id);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('Invalid update');
  }
  const { status, evidence, note } = patch;
  if (!allowedStatuses.has(status)) throw new Error('Invalid status');
  if (typeof evidence !== 'string' || evidence.length > 10000) {
    throw new Error('Evidence must be text under 10000 characters');
  }
  if (typeof note !== 'string' || note.length > 10000) {
    throw new Error('Note must be text under 10000 characters');
  }
  if (status === 'verified' && !evidence.trim()) {
    throw new Error('Add closure evidence before marking a task verified');
  }

  const tracker = await readTracker();
  const task = tracker.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error('Task not found');
  Object.assign(task, { status, evidence: evidence.trim(), note: note.trim() });
  tracker.updatedAt = new Date().toISOString();
  const temporaryPath = `${trackerPath}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(tracker, null, 2)}\n`,
    'utf8'
  );
  await rename(temporaryPath, trackerPath);
  return task;
}

const page = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Convlo P0 launch tracker</title>
  <style>
    :root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#eaf0fb;background:#0d1421}
    *{box-sizing:border-box}body{margin:0}main{max-width:1300px;margin:auto;padding:30px 24px 72px}
    h1{font-size:clamp(2rem,4vw,3rem);letter-spacing:-.04em;margin:0 0 8px}h2{font-size:1.3rem;margin:32px 0 14px}
    p{line-height:1.5;color:#acb9ce}a{color:#9fc2ff}.intro{max-width:920px}
    .milestones,.stats,.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}
    .milestone,.stat,.toolbar select{background:#182335;border:1px solid #2b3a52;border-radius:12px;padding:11px 14px}
    .milestone b,.stat b{display:block;color:#fff}.milestone span,.stat span{font-size:.85rem;color:#aab8cb}
    .stat{min-width:120px}.stat b{font-size:1.35rem}
    select,textarea,button{font:inherit}select,textarea{color:#edf3ff;background:#101b2b;border:1px solid #33445d;border-radius:9px}
    select{padding:8px 10px}.toolbar select{min-width:160px}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,340px),1fr));gap:14px}
    .card{background:#172236;border:1px solid #2a3b55;border-radius:16px;padding:18px;display:flex;flex-direction:column;gap:12px}
    .card.verified{border-color:#28684c}.card.blocked{border-color:#a06d39}.card.in_progress{border-color:#4e6fb9}.card.retired{border-color:#6b7280;opacity:.72}
    .top{display:flex;justify-content:space-between;align-items:start;gap:8px}.id{font-size:.8rem;font-weight:700;letter-spacing:.05em;color:#9fc2ff}
    .due{font-size:.8rem;color:#a9b8cc;white-space:nowrap}.title{font-size:1.13rem;font-weight:700;line-height:1.25;margin:4px 0 0}
    .acceptance{font-size:.9rem;line-height:1.48;color:#c6d2e5}.dependencies{font-size:.8rem;color:#a9b8cc}
    label{font-size:.79rem;color:#b5c4d8;display:block;margin-bottom:5px}textarea{resize:vertical;width:100%;min-height:65px;padding:9px;line-height:1.4}
    .controls{display:flex;gap:8px;align-items:center;margin-top:auto}.controls select{flex:1}.save{border:0;background:#a6c3ff;color:#0b1830;border-radius:9px;padding:9px 14px;font-weight:700;cursor:pointer}
    .save:disabled{opacity:.5;cursor:wait}.feedback{min-height:20px;font-size:.8rem;color:#88dbb4}.feedback.error{color:#ffb1a5}
    .foot{margin-top:28px;padding-top:14px;border-top:1px solid #29394e;font-size:.84rem}
  </style>
</head>
<body>
  <main>
    <h1>Convlo launch tracker</h1>
    <p class="intro">One task at a time, with evidence before sign-off. Edits here save directly to <code>docs/launch-tracker.json</code> on this computer. Commit and push that file to share updates with Tega.</p>
    <div id="milestones" class="milestones"></div>
    <div id="stats" class="stats"></div>
    <div class="toolbar">
      <select id="lane" aria-label="Filter by owner"><option value="all">All owners</option><option>Shazim</option><option>Tega</option><option>Daniel</option><option>After launch</option></select>
      <select id="state" aria-label="Filter by status"><option value="all">All statuses</option><option value="todo">To do</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="verified">Verified</option><option value="retired">Retired for v3</option></select>
    </div>
    <div id="tasks"></div>
    <p class="foot">Only mark a task verified after the commit, production version, script version, conversation/job/trace and observed result are recorded where applicable. The six preserved review conversations stay untouched.</p>
  </main>
  <script>
    let tracker;
    const statuses = [['todo','To do'],['in_progress','In progress'],['blocked','Blocked'],['verified','Verified'],['retired','Retired for v3']];
    const make = (tag, className, value) => { const el=document.createElement(tag); if(className) el.className=className; if(value!==undefined) el.textContent=value; return el; };
    async function load() { const response=await fetch('/api/tracker'); if(!response.ok) throw new Error('Tracker unavailable'); tracker=await response.json(); render(); }
    function render() {
      const milestones=document.getElementById('milestones'); milestones.replaceChildren();
      for (const item of tracker.milestones) { const box=make('div','milestone'); box.append(make('b','',item.date),make('span','',item.label)); milestones.append(box); }
      renderStats();
      const host=document.getElementById('tasks'); host.replaceChildren();
      const lane=document.getElementById('lane').value, state=document.getElementById('state').value;
      for (const owner of ['Shazim','Tega','Daniel','After launch']) {
        if (lane!=='all' && lane!==owner) continue;
        const items=tracker.tasks.filter(task=>task.lane===owner && (state==='all'||task.status===state));
        if (!items.length) continue;
        host.append(make('h2','',owner)); const grid=make('div','grid');
        for (const task of items) grid.append(renderTask(task)); host.append(grid);
      }
    }
    function renderTask(task) {
      const card=make('article','card '+task.status); const top=make('div','top');
      const heading=make('div'); heading.append(make('div','id',task.id+(task.priority ? ' · '+task.priority : '')),make('div','title',task.title));
      top.append(heading,make('div','due',task.due)); card.append(top,make('div','acceptance',task.acceptance));
      if (task.dependsOn.length) card.append(make('div','dependencies','Depends on: '+task.dependsOn.join(', ')));
      const evidenceLabel=make('label','', 'Closure evidence'); const evidence=make('textarea'); evidence.value=task.evidence; evidenceLabel.append(evidence);
      const noteLabel=make('label','', 'Working note / next action'); const note=make('textarea'); note.value=task.note; noteLabel.append(note);
      card.append(evidenceLabel,noteLabel);
      const controls=make('div','controls'); const select=make('select'); select.setAttribute('aria-label','Status for '+task.id);
      for (const [value,label] of statuses) { const option=make('option','',label); option.value=value; option.selected=value===task.status; select.append(option); }
      const button=make('button','save','Save'); button.type='button'; const feedback=make('div','feedback');
      button.addEventListener('click',async()=>{
        button.disabled=true; feedback.textContent='Saving…'; feedback.className='feedback';
        try {
          const response=await fetch('/api/tasks/'+encodeURIComponent(task.id),{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:select.value,evidence:evidence.value,note:note.value})});
          const result=await response.json(); if(!response.ok) throw new Error(result.error||'Save failed');
          Object.assign(task,result.task); feedback.textContent='Saved'; card.className='card '+task.status; renderStats();
        } catch(error) { feedback.textContent=error.message; feedback.className='feedback error'; }
        finally { button.disabled=false; }
      });
      controls.append(select,button); card.append(controls,feedback); return card;
    }
    function renderStats(){
      const stats=document.getElementById('stats'); stats.replaceChildren();
      const active=tracker.tasks.filter(task=>task.status!=='retired');
      const verified=active.filter(task=>task.status==='verified').length;
      const progress=make('div','stat');
      progress.append(make('b','',active.length ? Math.round(100*verified/active.length)+'%' : 'N/A'),make('span','',verified+'/'+active.length+' full-plan items verified'));
      stats.append(progress);
      for(const [key,label] of statuses){const box=make('div','stat'); box.append(make('b','',tracker.tasks.filter(task=>task.status===key).length),make('span','',label));stats.append(box);}
    }
    document.getElementById('lane').addEventListener('change',render);
    document.getElementById('state').addEventListener('change',render);
    load().catch(error=>{document.getElementById('tasks').textContent=error.message;});
  </script>
</body>
</html>`;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (request.method === 'GET' && url.pathname === '/') {
      respond(response, 200, page, 'text/html');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/tracker') {
      respond(response, 200, await readTracker());
      return;
    }
    if (request.method === 'PATCH' && url.pathname.startsWith('/api/tasks/')) {
      const origin = request.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}`) {
        respond(response, 403, { error: 'Cross-origin updates are blocked' });
        return;
      }
      if (
        request.headers['content-type']?.split(';')[0] !== 'application/json'
      ) {
        respond(response, 415, { error: 'JSON required' });
        return;
      }
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 25000) throw new Error('Update is too large');
      }
      const taskId = url.pathname.slice('/api/tasks/'.length);
      const task = await (writeQueue = writeQueue.then(() =>
        updateTask(taskId, JSON.parse(body))
      ));
      respond(response, 200, { task });
      return;
    }
    respond(response, 404, { error: 'Not found' });
  } catch (error) {
    writeQueue = Promise.resolve();
    respond(response, 400, { error: error.message || 'Request failed' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Convlo launch tracker: http://127.0.0.1:${port}`);
});
