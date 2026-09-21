/* ============================================================
   串焼KEMURI屋 AIの窓口（サーバー側）  /api/ai
   ------------------------------------------------------------
   ブラウザからは「何をしてほしいか（task）」と「材料（payload）」
   だけを送る。OpenAIへの指示文はここで組み立てる。

   【なぜこうするか】
   このサイトは公開URLなので、誰でも /api/ai を叩けてしまう。
   ・合言葉（KEMURI_PASS）が無ければ門前払い
   ・task は決まった3つだけ。自由な文章は投げられない
     → 万一 合言葉が漏れても「お店の分析」以外には使えない
   ・モデルと上限トークンはサーバー側で固定（高いモデルを
     指定される事故を防ぐ）
   ・OpenAIの残高は前払い（自動チャージOFF）なので、
     最悪でもチャージ額を超えて課金されることはない

   【必要な環境変数（Netlify）】
   ・OPENAI_API_KEY … OpenAIのキー（Secret）
   ・KEMURI_PASS    … 合言葉。ダッシュボードの設定に同じものを入れる
   ・OPENAI_MODEL   … 任意。未設定なら gpt-4o-mini
   ============================================================ */
'use strict';

const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_BODY = 200 * 1024;      // 送れる材料の上限（約200KB）
const MAX_OUT_TOKENS = 1500;      // 1回の返答の上限
const RATE_MAX = 20;              // 同じ実行環境で1分あたり
const RATE_WINDOW_MS = 60 * 1000;

/* 簡易レート制限（実行環境が使い回される間だけ有効）。
   本当の歯止めはOpenAIの前払い残高なので、これは事故よけ。 */
const hits = [];
function rateLimited() {
  const now = Date.now();
  while (hits.length && now - hits[0] > RATE_WINDOW_MS) hits.shift();
  if (hits.length >= RATE_MAX) return true;
  hits.push(now);
  return false;
}

function json(status, obj) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    body: JSON.stringify(obj),
  };
}

/* ---------- できること（これ以外は受け付けない） ---------- */

const COMMON = [
  'あなたは沖縄の串焼き居酒屋「串焼KEMURI屋」の運営を手伝うアシスタントです。',
  '回答は日本語。お店のオーナー（ITの専門家ではない）が読む前提で、短く具体的に書きます。',
  '数字は与えられたデータだけから出し、勝手に作らないこと。分からないことは「分からない」と書きます。',
].join('\n');

const TASKS = {
  /* ① 仕入単価の貼り付けを、表の形に整える */
  costs: {
    label: '仕入単価の読み取り',
    build(p) {
      const text = String(p && p.text || '').slice(0, 20000);
      if (!text.trim()) throw new Error('単価のテキストが空です');
      return [
        { role: 'system', content: COMMON + '\n' + [
          '仕入先からの見積もりや、メモ書きの単価リストを読み取って、きれいな表に直す作業をします。',
          '出力は必ず次のJSONだけ：',
          '{"rows":[{"name":"商品名","unit":"単位","price":数値,"note":"補足","sure":true/false}],"skipped":["読めなかった行"]}',
          '・name … 商品名。余計な記号や番号は外す',
          '・unit … kg / 袋 / 本 / 個 / ケース など。書かれていなければ ""',
          '・price … 1単位あたりの仕入価格（円、税抜か税込かは問わない）。数値のみ',
          '・note … 「税込」「10kg入り」など、値段の前提が書かれていれば入れる。無ければ ""',
          '・sure … 読み取りに自信があれば true、推測が入っていれば false',
          '・合計行・見出し行・日付だけの行は rows に入れない',
          '・1つも読み取れなければ rows は空配列にする',
        ].join('\n') },
        { role: 'user', content: '次の内容から単価を読み取ってください。\n\n' + text },
      ];
    },
  },

  /* ② 売上・原価の分析コメント */
  analyze: {
    label: '売上と原価の分析',
    build(p) {
      const d = (p && p.data) || {};
      const body = JSON.stringify(d).slice(0, 60000);
      return [
        { role: 'system', content: COMMON + '\n' + [
          'お店の売上データを見て、オーナーが明日から動けることだけを書きます。',
          '出力は必ず次のJSONだけ：',
          '{"summary":"全体の要約（2〜3文）",',
          ' "good":[{"name":"商品名","why":"伸びている理由や特徴"}],',
          ' "bad":[{"name":"商品名","why":"落ちている・出ていない点"}],',
          ' "cost":[{"name":"商品名","why":"原価率で気になる点"}],',
          ' "risk":[{"name":"商品名","why":"欠品しそうな理由"}],',
          ' "todo":["明日やるとよいこと"],',
          ' "caution":["データ上の注意点（期間が短い・まとめて入っている等）"]}',
          '・各配列は最大5件。該当が無ければ空配列',
          '・原価が未入力(0)の商品について原価率を語らないこと',
          '・「まとめて入っている日」がある場合、日別の傾向は断定せず caution に書くこと',
        ].join('\n') },
        { role: 'user', content: '次のデータを見て分析してください。\n\n' + body },
      ];
    },
  },

  /* ③ つながっているかの確認（ごく短い呼び出し） */
  ping: {
    label: '接続テスト',
    maxTokens: 20,
    build() {
      return [
        { role: 'system', content: '「OK」とだけ返してください。' },
        { role: 'user', content: 'ping' },
      ];
    },
  },
};

/* ---------- 本体 ---------- */

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'POSTで呼んでください' });

  /* 貼り付けたときに前後へ空白や改行が入ることがあるので、両側とも落としてから比べる */
  const key = String(process.env.OPENAI_API_KEY || '').trim();
  const pass = String(process.env.KEMURI_PASS || '').trim();

  /* Netlifyの環境変数は、設定しただけでは動いている関数に届かない。
     いちど再デプロイされて初めて反映されるので、それも書いておく。 */
  const REDEPLOY = 'Netlifyで設定したあと、いちど再デプロイ（Deploys → 最新のデプロイ → Retry deploy）すると反映されます。';
  if (!pass) return json(500, { error: 'サーバーに合言葉（KEMURI_PASS）が設定されていません。' + REDEPLOY, setup: true });
  if (!key)  return json(500, { error: 'サーバーにOpenAIのキー（OPENAI_API_KEY）が設定されていません。' + REDEPLOY, setup: true });

  const h = event.headers || {};
  const given = String(h['x-kemuri-pass'] || h['X-Kemuri-Pass'] || '').trim();
  if (given !== pass) return json(401, { error: '合言葉が違います。ダッシュボードの設定を確認してください', auth: true });

  if (typeof event.body === 'string' && event.body.length > MAX_BODY) {
    return json(413, { error: '送るデータが大きすぎます。期間を短くして試してください' });
  }
  if (rateLimited()) return json(429, { error: '短い時間に呼びすぎです。1分ほど待ってからもう一度お願いします' });

  let req;
  try { req = JSON.parse(event.body || '{}'); }
  catch (e) { return json(400, { error: '送られた内容を読み取れませんでした' }); }

  const spec = TASKS[req.task];
  if (!spec) return json(400, { error: '知らない依頼です: ' + String(req.task).slice(0, 40) });

  let messages;
  try { messages = spec.build(req.payload || {}); }
  catch (e) { return json(400, { error: e.message || '材料が足りません' }); }

  const model = process.env.OPENAI_MODEL || DEFAULT_MODEL;
  const wantJson = req.task !== 'ping';

  const body = {
    model: model,
    messages: messages,
    max_tokens: spec.maxTokens || MAX_OUT_TOKENS,
    temperature: 0.2,                       // 数字を扱うので低めに固定
  };
  if (wantJson) body.response_format = { type: 'json_object' };

  let res, text;
  try {
    res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
    });
    text = await res.text();
  } catch (e) {
    return json(502, { error: 'OpenAIに繋がりませんでした。少し待ってもう一度お試しください' });
  }

  if (!res.ok) {
    /* OpenAI側のエラーは、そのまま出すと分かりにくいので言い換える */
    let detail = '';
    try { detail = (JSON.parse(text).error || {}).message || ''; } catch (e) { detail = text.slice(0, 200); }
    const msg =
      res.status === 401 ? 'OpenAIのキーが正しくないようです。Netlifyの OPENAI_API_KEY を確認してください'
      : res.status === 429 && /quota|billing|insufficient/i.test(detail)
        ? 'OpenAIの残高が足りません。platform.openai.com でクレジットを追加してください'
      : res.status === 429 ? 'OpenAIが混み合っています。少し待ってもう一度お試しください'
      : res.status === 404 || /model/i.test(detail)
        ? ('モデル「' + model + '」が使えませんでした。Netlifyの OPENAI_MODEL で別のモデルを指定できます')
      : 'OpenAIからエラーが返りました';
    return json(502, { error: msg, status: res.status, detail: detail.slice(0, 300), model: model });
  }

  let data, content;
  try {
    data = JSON.parse(text);
    content = ((data.choices || [])[0] || {}).message;
    content = content && content.content;
  } catch (e) { return json(502, { error: 'OpenAIの返事を読み取れませんでした' }); }
  if (!content) return json(502, { error: 'OpenAIから中身が返りませんでした' });

  let result = content;
  if (wantJson) {
    try { result = JSON.parse(content); }
    catch (e) { return json(502, { error: 'AIの返事が期待した形ではありませんでした', raw: String(content).slice(0, 500) }); }
  }

  const u = data.usage || {};
  return json(200, {
    ok: true,
    task: req.task,
    result: result,
    model: data.model || model,
    usage: { in: u.prompt_tokens || 0, out: u.completion_tokens || 0 },
  });
};
