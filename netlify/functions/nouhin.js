/* ============================================================
   串焼KEMURI屋 納品書の読み取り（サーバー側）  /api/nouhin
   ------------------------------------------------------------
   ブラウザから納品書の写真（JPEG、縮小ずみ）を受け取り、
   Claude に渡して «仕入先・日付・商品の行» をJSONで返す。

   【なぜこうするか】
   ・Anthropic のキーはここ（Netlifyの環境変数）にしか無い。
     HTMLやリポジトリには一切出ない
   ・合言葉（KEMURI_PASS）はダッシュボードのAIと同じものを使う
   ・指示文はサーバー側で固定。ブラウザから自由な文章は送れない
   ・在庫の商品名の一覧は «ヒント» として渡すだけ。
     どの在庫に結ぶかは、画面で人が決める

   【必要な環境変数（Netlify）】
   ・ANTHROPIC_API_KEY … Anthropic のキー（Secret）
   ・KEMURI_PASS       … 合言葉（/api/ai と共通）
   ・ANTHROPIC_MODEL   … 任意。未設定なら claude-sonnet-5-5
   ============================================================ */
'use strict';

const DEFAULT_MODEL = 'claude-sonnet-5-5';
const MAX_BODY = 5 * 1024 * 1024;   // 写真込みで約5MB（Netlifyの上限6MBの手前）
const MAX_OUT_TOKENS = 4000;
const RATE_MAX = 10;                // 同じ実行環境で1分あたり
const RATE_WINDOW_MS = 60 * 1000;

const hits = [];
function rateLimited() {
  const now = Date.now();
  while (hits.length && now - hits[0] > RATE_WINDOW_MS) hits.shift();
  if (hits.length >= RATE_MAX) return true;
  hits.push(now);
  return false;
}

function stripFence(t) {
  let s = String(t == null ? '' : t).trim();
  const m = s.match(/^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/);
  if (m) s = m[1].trim();
  if (s[0] !== '{') {
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i >= 0 && j > i) s = s.slice(i, j + 1);
  }
  return s;
}

function json(status, obj) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
  };
}

function prompt(known) {
  return [
    'あなたは沖縄の串焼き居酒屋「串焼KEMURI屋」の仕入れを手伝うアシスタントです。',
    '写真は仕入先からの納品書（または請求書・レシート）です。書かれている内容を読み取ってください。',
    '出力は必ず次のJSONだけ（説明文は付けない）：',
    '{"supplier":"仕入先名","date":"YYYY-MM-DD","rows":[{"name":"商品名","qty":数値,"unit":"単位","price":数値,"amount":数値,"sure":true/false}],',
    ' "subtotal":数値,"tax":数値,"total":数値,"note":"気づいたこと"}',
    '・name … 納品書に書かれている商品名をそのまま（略さない・言い換えない）',
    '・qty … 数量。読めなければ 0',
    '・unit … 本 / 袋 / kg / ケース / 個 など。書かれていなければ ""',
    '・price … 単価（円）。書かれていなければ 0',
    '・amount … その行の金額（円）。書かれていなければ 0',
    '・sure … 数字までハッキリ読めれば true、かすれ・推測が入れば false',
    '・合計・小計・消費税・値引き・送料の行は rows に入れず、subtotal / tax / total に入れる（無ければ 0）',
    '・date … 納品日。年が無ければ今年として補う。読めなければ ""',
    '・数字は与えられた写真からだけ読む。勝手に作らない',
    known.length
      ? '・参考：お店の在庫の商品名は次のとおり。商品名は納品書の表記のまま書くこと（在庫名に書き換えない）：' + known.join('、')
      : '',
  ].filter(Boolean).join('\n');
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POSTで呼んでください' });

  const key = String(process.env.ANTHROPIC_API_KEY || '').trim();
  const pass = String(process.env.KEMURI_PASS || '').trim();
  const REDEPLOY = 'Netlifyで設定したあと、いちど再デプロイ（Deploys → 最新のデプロイ → Retry deploy）すると反映されます。';
  if (!pass) return json(500, { error: 'サーバーに合言葉（KEMURI_PASS）が設定されていません。' + REDEPLOY, setup: true });
  if (!key)  return json(500, { error: 'サーバーにAnthropicのキー（ANTHROPIC_API_KEY）が設定されていません。' + REDEPLOY, setup: true });

  const h = event.headers || {};
  const given = String(h['x-kemuri-pass'] || h['X-Kemuri-Pass'] || '').trim();
  if (given !== pass) return json(401, { error: '合言葉が違います。ダッシュボードの設定で入れた合言葉を確認してください', auth: true });

  if (typeof event.body === 'string' && event.body.length > MAX_BODY) {
    return json(413, { error: '写真が大きすぎます。もう一度撮り直してください' });
  }
  if (rateLimited()) return json(429, { error: '短い時間に呼びすぎです。1分ほど待ってからもう一度お願いします' });

  let req;
  try { req = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: '送られた内容を読み取れませんでした' }); }

  const img = String(req.image || '');
  const m = img.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return json(400, { error: '写真の形式が読めませんでした（JPEG/PNGで撮ってください）' });
  const known = (Array.isArray(req.items) ? req.items : [])
    .map(s => String(s || '').slice(0, 40)).filter(Boolean).slice(0, 300);

  const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
  let res, text;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model,
        max_tokens: MAX_OUT_TOKENS,
        system: prompt(known),
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
            { type: 'text', text: 'この納品書を読み取って、指定のJSONで返してください。' },
          ],
        }],
      }),
    });
    text = await res.text();
  } catch (e) {
    return json(502, { error: 'Anthropicに繋がりませんでした。少し待ってもう一度お試しください' });
  }

  if (!res.ok) {
    let detail = '';
    try { detail = (JSON.parse(text).error || {}).message || ''; } catch (e) { detail = text.slice(0, 200); }
    const msg =
      res.status === 401 ? 'Anthropicのキーが正しくないようです。Netlifyの ANTHROPIC_API_KEY を確認してください'
      : res.status === 400 && /credit|balance|billing/i.test(detail)
        ? 'Anthropicのクレジット残高が足りません。console.anthropic.com で確認してください'
      : res.status === 429 || res.status === 529 ? 'AIが混み合っています。少し待ってもう一度お試しください'
      : res.status === 404 || /model/i.test(detail)
        ? ('モデル「' + model + '」が使えませんでした。Netlifyの ANTHROPIC_MODEL で別のモデルを指定できます')
      : 'Anthropicからエラーが返りました';
    return json(502, { error: msg, status: res.status, detail: detail.slice(0, 300), model: model });
  }

  let data, content, stop;
  try {
    data = JSON.parse(text);
    stop = data.stop_reason || '';
    content = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  } catch (e) { return json(502, { error: 'AIの返事を読み取れませんでした' }); }
  if (!content) return json(502, { error: 'AIから中身が返りませんでした（' + (stop || '理由不明') + '）' });
  if (stop === 'max_tokens') {
    return json(502, { error: '行が多すぎて、AIの返事が途中で切れました。納品書を半分ずつ撮ってお試しください', raw: content.slice(-200) });
  }

  let result;
  try { result = JSON.parse(stripFence(content)); }
  catch (e) { return json(502, { error: 'AIの返事が期待した形ではありませんでした', raw: content.slice(0, 400) }); }

  const n = v => { const x = Number(String(v == null ? '' : v).replace(/[,円¥\s]/g, '')); return isFinite(x) ? x : 0; };
  const rows = (Array.isArray(result.rows) ? result.rows : []).map(r => ({
    name: String(r && r.name || '').trim(),
    qty: n(r && r.qty), unit: String(r && r.unit || '').trim(),
    price: n(r && r.price), amount: n(r && r.amount),
    sure: !(r && r.sure === false),
  })).filter(r => r.name);

  const u = data.usage || {};
  return json(200, {
    ok: true,
    result: {
      supplier: String(result.supplier || '').trim(),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(result.date || '')) ? result.date : '',
      rows: rows,
      subtotal: n(result.subtotal), tax: n(result.tax), total: n(result.total),
      note: String(result.note || '').trim(),
    },
    model: data.model || model,
    usage: { in: u.input_tokens || 0, out: u.output_tokens || 0 },
  });
};
