/**
 * ホテルかなろあ ― 月のシフト希望（休み希望）を集めるGoogleフォームを作るスクリプト
 *
 * 【使い方】
 *  1. https://script.google.com を開いて「新しいプロジェクト」
 *     （シフト連携用の Code.gs とは<別のプロジェクト>にしてください。
 *       同じプロジェクトに入れると、権限の追加でシフト連携を承認し直す必要が出ます）
 *  2. 中身を全部消して、このファイルの中身を貼り付ける
 *  3. すぐ下の設定（年・月・締切・スタッフ名簿）を直す
 *  4. 上の関数の選択で createShiftRequestForm を選び、▶ 実行 → 承認
 *  5. 「実行ログ」に出てくる〈回答用URL〉をLINEでスタッフに送る
 *
 * 翌月も同じ手順です。MONTH を変えて、もう一度実行すれば新しいフォームができます。
 */

// ===== ここを毎月変える =====
const YEAR = 2026;
const MONTH = 10;                    // 1〜12
const DEADLINE = '9月25日（金）まで'; // 締切の文言。空にすると出しません
// ===========================

// スタッフ名簿（辞めた人は消す／新しい人は足す。ツールのスタッフ名と同じ書き方にしてください）
const STAFF = [
  '宮平 絹江',
  '日下 堅人',
  'EI KAY ZIN HAN',
  'KYI SU THAR',
  'ギミレ アスナ',
  'サムパツ',
  '薄田 裕花',
  '島村 友子',
  // 石橋 大樹は長期休暇で2026年は不在のため入れていません
  // アメリーさんは屋外の仕事でシフト表とは関係ないため入れていません
];

// 回答をためるスプレッドシートのID（URLの /d/ と /edit の間）。
// 空のままでも大丈夫です（フォームの「回答」タブから後でつなげます）。
const SPREADSHEET_ID = '';

const DOW = ['日', '月', '火', '水', '木', '金', '土'];

function createShiftRequestForm() {
  const dayChoices = buildDayChoices_(YEAR, MONTH);

  const form = FormApp.create(`${YEAR}年${MONTH}月 シフト希望（ホテルかなろあ）`);
  form.setDescription(
    [
      `${MONTH}月のシフトを組みます。休みたい日を選んで送信してください。`,
      DEADLINE ? `締切：${DEADLINE}` : '',
      '',
      '・希望休は、ほかの人と重なると通らないことがあります',
      '・出し直したいときは、もう一度送信してください（新しい回答を使います）',
    ].filter(String).join('\n'),
  );
  form.setCollectEmail(false);
  form.setAllowResponseEdits(true);
  form.setConfirmationMessage(`送信しました。${MONTH}月のシフトができたら共有します。`);

  form.addListItem()
    .setTitle('お名前')
    .setChoiceValues(STAFF)
    .setRequired(true);

  form.addCheckboxItem()
    .setTitle(`${MONTH}月の希望休`)
    .setHelpText('休みたい日をすべて選んでください。特に無ければ、選ばずに送信して大丈夫です。')
    .setChoiceValues(dayChoices);

  form.addListItem()
    .setTitle('連休の希望')
    .setHelpText('日にちは決めず「まとまった休みがほしい」ときに選んでください。予約の少ない時期に入れます。')
    .setChoiceValues(['なし', '2連休', '3連休', '4連休', '5連休']);

  form.addParagraphTextItem()
    .setTitle('連絡事項')
    .setHelpText('「10日まで出勤で退社」「15日から復帰」など、期間の希望や伝えたいことがあれば書いてください（任意）。');

  if (SPREADSHEET_ID) {
    form.setDestination(FormApp.DestinationType.SPREADSHEET, SPREADSHEET_ID);
  }

  const publicUrl = form.getPublishedUrl();
  Logger.log('================ できました ================');
  Logger.log('〈回答用URL〉スタッフにこれを送ってください：');
  Logger.log(publicUrl);
  Logger.log('〈短いURL〉' + form.shortenFormUrl(publicUrl));
  Logger.log('〈編集用URL〉自分で中身を直すとき：');
  Logger.log(form.getEditUrl());
  Logger.log('==========================================');
  return publicUrl;
}

/** 「10/1（木）」の形で、その月の日数ぶん作る */
function buildDayChoices_(year, month) {
  const last = new Date(year, month, 0).getDate();
  const out = [];
  for (let d = 1; d <= last; d++) {
    out.push(`${month}/${d}（${DOW[new Date(year, month - 1, d).getDay()]}）`);
  }
  return out;
}
