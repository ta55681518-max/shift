/* ============================================================
   串焼KEMURI屋 冷凍在庫 — 納品書から入荷（テスト版）
   ------------------------------------------------------------
   流れ：📷 納品書を撮る → /api/nouhin（Claude）が行を読む
        → 行ごとに «どの在庫商品か» を選ぶ → 登録

   【在庫との紐付け】
   納品書の商品名と在庫の商品名は、たいてい違う
   （例：「アサヒスーパードライ中瓶 12本」→ 在庫「ビール中瓶」）。
   そこで行ごとに在庫の商品を «検索して選ぶ» ようにし、
   一度選んだ組み合わせは覚えて、次から自動で当てる。
     ・覚える単位 … 仕入先 ＋ 納品書の商品名（同じ名前でも仕入先で中身が違うことがあるため）
                    仕入先が違っても、名前だけ一致すれば候補として出す
     ・倍率（×n） … 納品書の1単位で在庫がいくつ増えるか（1ケース＝24本 など）。これも覚える
     ・「在庫に入れない」 … 消耗品や送料など、経費だけのもの。これも覚える

   【テスト版の約束】 NOUHIN_TEST = true のあいだは
     ・保存先は localStorage['kmtest_nouhin_v1'] だけ
     ・本物の在庫（kemuri_reitou_v1）の数は一切動かさない
       （在庫の商品一覧は «選ぶため» に読むだけ）
   本番にするときは NOUHIN_TEST を false にする。
   ============================================================ */
'use strict';

const NOUHIN_TEST = true;
const NH_KEY = NOUHIN_TEST ? 'kmtest_nouhin_v1' : 'kemuri_nouhin_v1';
const NH_PASS_KEY = 'kemuri_ai_pass';          /* ダッシュボードのAIと同じ合言葉 */
const NH_SKIP = '__skip__';

/* ---------- 保存 ----------
   map      … { 紐付けキー: { item:itemId | '__skip__', mult, label, sup, at } }
   receipts … 登録した納品書 { id, at, sup, date, total, lines:[{name,qty,unit,amount,item,mult,add}] }
*/
function nhLoad(){
  try{
    const d = JSON.parse(localStorage.getItem(NH_KEY) || '{}');
    return { map: d.map || {}, receipts: Array.isArray(d.receipts) ? d.receipts : [] };
  }catch(e){ return { map:{}, receipts:[] }; }
}
function nhSave(d){ try{ localStorage.setItem(NH_KEY, JSON.stringify(d)); }catch(e){ toast('保存できんかった…'); } }

function nhKey(sup, name){ return norm(sup) + '\u0001' + norm(name); }

/* 覚えている紐付けを探す。同じ仕入先が最優先、無ければ名前だけ一致 */
function nhRemembered(store, sup, name){
  const k = nhKey(sup, name);
  if(store.map[k]) return { m: store.map[k], how:'mem' };
  const tail = '\u0001' + norm(name);
  const ks = Object.keys(store.map).filter(x=>x.slice(-tail.length) === tail);
  if(ks.length) return { m: store.map[ks[0]], how:'mem2' };
  return null;
}

/* 1行の «最初の選択» を決める：覚えている ＞ 同じ名前 ＞ 似ている名前 ＞ 未選択 */
function nhGuess(store, sup, name){
  const r = nhRemembered(store, sup, name);
  if(r){
    const ok = r.m.item === NH_SKIP || item(r.m.item);   /* 在庫から消えた商品なら使わない */
    if(ok) return { item: r.m.item, mult: Number(r.m.mult) || 1, how: r.how };
  }
  const same = itemByName(name);
  if(same) return { item: same.id, mult: 1, how:'same' };
  const sug = suggestItem(name);
  if(sug) return { item: sug.id, mult: 1, how:'sug' };
  return { item: null, mult: 1, how:'' };
}

/* ---------- 画面の状態 ---------- */
let NH = { open:false, step:'shot', err:'', raw:'', res:null, rows:[], sup:'', date:'', pick:-1, q:'' };

function nhOpen(){ NH = { open:true, step:'shot', err:'', raw:'', res:null, rows:[], sup:'', date:'', pick:-1, q:'' }; render(); window.scrollTo(0,0); }
function nhClose(){ NH.open = false; render(); window.scrollTo(0,0); }
function nhPass(){ try{ return localStorage.getItem(NH_PASS_KEY) || ''; }catch(e){ return ''; } }
function nhSetPass(v){
  v = String(v||'').trim(); if(!v) return;
  try{ localStorage.setItem(NH_PASS_KEY, v); }catch(e){}
  toast('合言葉を保存しました'); render();
}
const nhYen = n => '¥' + Math.round(Number(n)||0).toLocaleString('ja-JP');
const nhQ = n => { const x = Math.round((Number(n)||0)*100)/100; return String(x); };

function viewNouhin(){
  let h = '<div class="pad">';
  h += '<button class="btn btn-gray btn-sm" onclick="nhClose()">‹ 入荷にもどる</button>';
  if(NOUHIN_TEST){
    h += '<div class="warn gap"><b>テスト版です。</b>在庫の数は動きません。'
       + '読み取りと紐付けの確認だけを、テスト用の保存場所（kmtest_）に記録します。</div>';
  }

  if(!nhPass()){
    h += '<div class="card gap"><h2>合言葉</h2>'
       + '<div class="muted">ダッシュボードのAIで使っている合言葉を入れてください（この端末に保存）。</div>'
       + '<input class="txt gap" id="nh-pass" type="password" placeholder="合言葉">'
       + '<button class="btn btn-dark gap" onclick="nhSetPass(document.getElementById(\'nh-pass\').value)">合言葉を保存</button></div>';
    return h + '</div>';
  }

  if(NH.step === 'shot' || NH.step === 'loading'){
    h += '<div class="card gap"><h2>📷 納品書を撮る</h2>'
       + '<div class="muted">明るい所で、紙全体が入るように撮ってください。読み取りに10〜30秒かかります。</div>'
       + (NH.step === 'loading'
          ? '<button class="btn btn-primary gap" disabled>読み取り中…</button>'
          : '<button class="btn btn-primary gap" onclick="document.getElementById(\'nhfile\').click()">撮影する／写真を選ぶ</button>')
       + '</div>';
    if(NH.err) h += nhErrBox();
    h += nhMemList();
    return h + '</div>';
  }

  if(NH.step === 'done') return h + nhDoneView() + '</div>';

  /* ---- 紐付け ---- */
  const r = NH.res || {};
  h += '<div class="card gap"><h2>読み取った納品書</h2>'
     + '<label class="lab">仕入先</label><input class="txt" value="'+esc(NH.sup)+'" onchange="nhSup(this.value)" placeholder="仕入先">'
     + '<label class="lab gap" style="display:block">納品日</label><input class="txt" type="date" value="'+esc(NH.date)+'" onchange="NH.date=this.value">'
     + (r.total ? '<div class="muted gap">合計 '+nhYen(r.total)+(r.tax?'（うち税 '+nhYen(r.tax)+'）':'')+'</div>' : '')
     + (r.note ? '<div class="muted">メモ：'+esc(r.note)+'</div>' : '')
     + '</div>';

  const undecided = NH.rows.filter(x=>x.item == null).length;
  h += '<div class="muted" style="margin:4px 2px 10px">'
     + '行ごとに «どの在庫か» をタップして選んでください。選んだ組み合わせは次から自動で入ります。'
     + (undecided ? '<br><b style="color:#d92d20">未選択 '+undecided+'行</b>' : '') + '</div>';

  NH.rows.forEach((x,i)=>{ h += nhRowCard(x,i); });

  h += '<button class="btn btn-primary gap" '+(undecided?'disabled':'')+' onclick="nhCommit()">'
     + (undecided ? 'すべての行を選ぶと登録できます' : (NOUHIN_TEST ? '登録する（テスト：在庫は動きません）' : '入荷を登録する'))
     + '</button>'
     + '<button class="btn btn-out gap" onclick="nhOpen()">撮り直す</button>';
  return h + '</div>';
}

function nhErrBox(){
  let h = '<div class="warn gap">' + esc(NH.err);
  if(NH.raw){
    h += '<details style="margin-top:8px"><summary style="cursor:pointer;font-weight:700">AIが返した内容を見る</summary>'
       + '<div style="margin-top:6px;font-size:12px;background:#fff;border-radius:8px;padding:8px;white-space:pre-wrap;word-break:break-all;max-height:200px;overflow:auto">'
       + esc(NH.raw) + '</div></details>';
  }
  return h + '</div>';
}

const NH_HOW = { mem:['覚えた','#0a7a44','#eafaf1'], mem2:['覚えた（別の仕入先）','#0a7a44','#eafaf1'],
                 same:['同じ名前','#3a4d8f','#f4f7ff'], sug:['候補・確認して','#8a6100','#fff8e6'],
                 hand:['選んだ','#e8531f','#fff4ef'] };

function nhRowCard(x, i){
  const it = (x.item != null && x.item !== NH_SKIP) ? item(x.item) : null;
  const how = NH_HOW[x.how];
  let sel;
  if(x.item === NH_SKIP)      sel = '<span style="color:#888">🚫 在庫に入れない（経費のみ）</span>';
  else if(it)                 sel = '📦 '+esc(it.name);
  else                        sel = '<span style="color:#d92d20">在庫の商品を選ぶ</span>';
  const add = it ? nhQ((Number(x.qty)||0) * (Number(x.mult)||1)) : '';
  return '<div class="card" style="'+(x.item==null?'border-color:#ffc9bf;background:#fffaf9':'')+'">'
    + '<div style="font-size:16px;font-weight:700;line-height:1.35;word-break:break-word">'+esc(x.name)
    +   (x.sure ? '' : ' <span style="font-size:12px;color:#c07d00">⚠️読み取り不確か</span>') + '</div>'
    + '<div class="muted">'+nhQ(x.qty)+esc(x.unit||'')+(x.amount?'　'+nhYen(x.amount):'')+'</div>'
    + '<button class="btn btn-out gap" style="text-align:left;font-size:16px;padding:13px 14px" onclick="nhPickOpen('+i+')">'
    +   sel + '<span style="float:right;color:#bbb">▾</span></button>'
    + (how && x.item != null ? '<div style="margin-top:6px"><span style="font-size:12px;font-weight:700;border-radius:999px;padding:3px 9px;color:'+how[1]+';background:'+how[2]+'">'+how[0]+'</span></div>' : '')
    + (it ? '<div class="gap" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px">'
          +   '<span>1'+esc(x.unit||'単位')+'で在庫</span>'
          +   '<input class="txt" style="width:76px;padding:8px;text-align:center" inputmode="decimal" value="'+nhQ(x.mult)+'" onchange="nhMult('+i+',this.value)">'
          +   '<span>'+esc(it.unit||'個')+'</span>'
          +   '<b style="margin-left:auto;color:#0a7a44">在庫 +'+add+(it.unit&&it.unit!=='個'?esc(it.unit):'')+'</b>'
          + '</div>' : '')
    + '</div>';
}

function nhSup(v){
  NH.sup = String(v||'').trim();
  /* 仕入先が変わると «覚えた紐付け» も変わるので、手で選んでいない行だけ当て直す */
  const store = nhLoad();
  NH.rows.forEach(x=>{ if(x.how !== 'hand'){ const g = nhGuess(store, NH.sup, x.name); x.item = g.item; x.mult = g.mult; x.how = g.how; } });
  render();
}
function nhMult(i, v){
  const x = NH.rows[i]; if(!x) return;
  const n = num(v); x.mult = n > 0 ? n : 1; render();
}

/* ---------- 在庫の商品を選ぶシート ---------- */
function nhPickOpen(i){
  NH.pick = i; NH.q = '';
  const x = NH.rows[i];
  openSheet('<h3>どの在庫ですか？</h3><div class="sh-sub">納品書：'+esc(x.name)+'</div>'
    + '<input class="txt" id="nh-q" placeholder="在庫の商品名で検索" oninput="nhFilter(this.value)" autocomplete="off">'
    + '<div id="nh-list" class="gap"></div>'
    + '<button class="btn btn-gray gap" onclick="closeSheet()">閉じる</button>');
  nhFilter('');
  /* 候補があるときは、その名前で絞った状態から始めない（全部見せた方が選びやすい） */
}
function nhFilter(q){
  NH.q = q;
  const x = NH.rows[NH.pick]; if(!x) return;
  const t = loose(q);
  const sug = suggestItem(x.name);
  let list = DB.items.slice();
  if(t) list = list.filter(it=>loose(it.name).indexOf(t) >= 0 || loose(it.sup||'').indexOf(t) >= 0);
  /* 並び：いま選んでいる → 候補 → 同じ仕入先 → 分類順 */
  const supN = norm(NH.sup);
  const score = it => (it.id === x.item ? 0 : sug && it.id === sug.id ? 1 : (supN && norm(it.sup||'') === supN) ? 2 : 3);
  const order = CATS.map(c=>c.k);
  list.sort((a,b)=> score(a)-score(b) || order.indexOf(a.cat||CAT0)-order.indexOf(b.cat||CAT0));

  let h = '<button class="btn '+(x.item===NH_SKIP?'btn-dark':'btn-out')+'" style="text-align:left;margin-bottom:8px" onclick="nhPick(\''+NH_SKIP+'\')">'
        + '🚫 在庫に入れない（経費のみ）</button>';
  if(!list.length) h += '<div class="muted" style="padding:10px 2px">見つかりません。在庫に無い商品は、設定タブで先に追加してください。</div>';
  list.slice(0, 120).forEach(it=>{
    const on = it.id === x.item, isSug = sug && it.id === sug.id;
    h += '<button class="btn '+(on?'btn-primary':'btn-out')+'" style="text-align:left;margin-bottom:8px;padding:13px 14px" onclick="nhPick('+it.id+')">'
       + catOf(it).ic+' '+esc(it.name)
       + '<span style="float:right;font-size:12px;font-weight:600;opacity:.75">'
       +   (isSug && !on ? '候補　' : '') + esc(it.sup||'') + '</span></button>';
  });
  const el = document.getElementById('nh-list'); if(el) el.innerHTML = h;
}
function nhPick(id){
  const x = NH.rows[NH.pick]; if(!x) return;
  if(id !== NH_SKIP) id = Number(id);
  if(x.item !== id) x.mult = 1;      /* 別の商品にしたら倍率は1から */
  x.item = id; x.how = 'hand';
  /* 同じ納品書に同じ名前の行があれば、まとめて揃える */
  NH.rows.forEach(y=>{ if(y !== x && y.item == null && norm(y.name) === norm(x.name)){ y.item = id; y.how = 'hand'; } });
  closeSheet(); render();
}

/* ---------- 撮影 → 読み取り ---------- */
async function nhOnFile(input){
  const f = input.files && input.files[0]; input.value = '';
  if(!f) return;
  NH.step = 'loading'; NH.err = ''; NH.raw = ''; render();
  let img;
  try{ img = await nhShrink(f); }
  catch(e){ NH.step = 'shot'; NH.err = '写真を読み込めませんでした。別の写真でお試しください'; render(); return; }

  let res, j = null;
  try{
    res = await fetch('/api/nouhin', {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'X-Kemuri-Pass': nhPass() },
      body: JSON.stringify({ image: img, items: DB.items.map(i=>i.name) }),
    });
    try{ j = await res.json(); }catch(e){}
  }catch(e){
    NH.step = 'shot'; NH.err = 'サーバーに繋がりませんでした。通信を確認してください'; render(); return;
  }
  if(!res.ok || !j || j.error){
    NH.step = 'shot';
    NH.err = (j && j.error) || ('エラー（'+res.status+'）');
    if(res.status === 404) NH.err = '読み取りの窓口が見つかりません。Netlifyにデプロイされているか確認してください';
    if(j && j.auth){ try{ localStorage.removeItem(NH_PASS_KEY); }catch(e){} }
    NH.raw = (j && j.raw) || '';
    render(); return;
  }
  nhSetResult(j.result);
}

/* 読み取り結果を画面の行に（テストでダミーを流し込むときもここを通す） */
function nhSetResult(r){
  r = r || {};
  NH.res = r;
  NH.sup = String(r.supplier || '').trim();
  NH.date = r.date || KemuriCore.todayStr();
  const store = nhLoad();
  NH.rows = (r.rows || []).map(x=>{
    const g = nhGuess(store, NH.sup, x.name);
    return { name:x.name, qty:Number(x.qty)||0, unit:x.unit||'', price:Number(x.price)||0,
             amount:Number(x.amount)||0, sure:x.sure !== false, item:g.item, mult:g.mult, how:g.how };
  });
  if(!NH.rows.length){ NH.step = 'shot'; NH.err = '商品の行が読み取れませんでした。もう少し近づいて撮り直してください'; render(); return; }
  NH.step = 'match'; render(); window.scrollTo(0,0);
}

/* 長辺1600pxのJPEGに縮める（送る量を減らし、読み取りにも十分な大きさ） */
function nhShrink(file){
  return new Promise((ok, ng)=>{
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = ()=>{
      const MAX = 1600, s = Math.min(1, MAX / Math.max(im.width, im.height));
      const c = document.createElement('canvas');
      c.width = Math.round(im.width * s); c.height = Math.round(im.height * s);
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      ok(c.toDataURL('image/jpeg', 0.85));
    };
    im.onerror = ()=>{ URL.revokeObjectURL(url); ng(new Error('img')); };
    im.src = url;
  });
}

/* ---------- 登録 ---------- */
function nhCommit(){
  if(NH.rows.some(x=>x.item == null)) return;
  const store = nhLoad(), at = nowISO();
  const lines = NH.rows.map(x=>{
    const it = x.item !== NH_SKIP ? item(x.item) : null;
    /* 紐付けを覚える（仕入先＋納品書の商品名） */
    store.map[nhKey(NH.sup, x.name)] = { item:x.item, mult:Number(x.mult)||1, label:x.name, sup:NH.sup, at };
    return { name:x.name, qty:x.qty, unit:x.unit, amount:x.amount,
             item:x.item, itemName: it ? it.name : '', mult:Number(x.mult)||1,
             add: it ? q1(x.qty * (Number(x.mult)||1)) : 0 };
  });
  const r = NH.res || {};
  const sum = lines.reduce((s,l)=>s+(Number(l.amount)||0), 0);
  store.receipts.unshift({ id: Date.now(), at, sup:NH.sup, date:NH.date, total: r.total || sum, tax: r.tax || 0, lines, test: NOUHIN_TEST });
  if(store.receipts.length > 200) store.receipts.length = 200;
  nhSave(store);

  if(!NOUHIN_TEST){
    lines.forEach(l=>{ const it = l.add > 0 ? item(l.item) : null;
      if(it){ move(it, it.stock + l.add, '入荷（納品書）'); fillPending(it.id, l.add); } });
    save();
  }
  NH.done = lines; NH.step = 'done'; render(); window.scrollTo(0,0);
  toast(NOUHIN_TEST ? '記録しました（テスト）' : '入荷を登録しました');
}

function nhDoneView(){
  const lines = NH.done || [];
  let h = '<div class="ok-box gap">'+(NOUHIN_TEST ? '<b>テストとして記録しました。</b>本番なら次のように在庫が増えます。'
                                               : '<b>入荷を登録しました。</b>')+'</div>';
  h += '<div class="card gap"><h2>'+esc(NH.sup||'仕入先なし')+'　'+esc(NH.date||'')+'</h2>';
  lines.forEach(l=>{
    const it = l.add > 0 ? item(l.item) : null;
    h += '<div class="orow"><div class="ob"><b>'+esc(l.name)+'</b>'
       + '<small class="muted">'+(it ? '→ 📦 '+esc(it.name)+'　<b style="color:#0a7a44">+'+nhQ(l.add)+'</b>'
                                     : '→ 在庫に入れない') + '</small></div></div>';
  });
  h += '</div><button class="btn btn-primary gap" onclick="nhOpen()">次の納品書を撮る</button>'
     + '<button class="btn btn-out gap" onclick="nhClose()">入荷にもどる</button>';
  return h;
}

/* ---------- 覚えた紐付けの一覧（間違えて覚えたら消せるように） ---------- */
function nhMemList(){
  const store = nhLoad(), ks = Object.keys(store.map);
  if(!ks.length) return '';
  let h = '<details class="card gap"><summary style="font-weight:700;cursor:pointer">覚えた紐付け（'+ks.length+'件）</summary>'
        + '<div class="muted gap">間違って覚えたものは✕で消せます。次の読み取りで選び直してください。</div>';
  ks.sort((a,b)=>a.localeCompare(b,'ja')).forEach(k=>{
    const m = store.map[k], it = m.item !== NH_SKIP ? item(m.item) : null;
    h += '<div class="orow"><div class="ob"><b>'+esc(m.label||'')+'</b>'
       + '<small class="muted">'+esc(m.sup||'仕入先なし')+' → '
       + (m.item === NH_SKIP ? '在庫に入れない' : it ? esc(it.name)+(Number(m.mult)!==1?'（×'+nhQ(m.mult)+'）':'') : '（消えた商品）')
       + '</small></div><button class="btn btn-danger btn-sm" onclick="nhForget(decodeURIComponent(\''+encodeURIComponent(k)+'\'))">✕</button></div>';
  });
  return h + '</details>';
}
function nhForget(k){
  const store = nhLoad(); delete store.map[k]; nhSave(store); render(); toast('紐付けを消しました');
}
