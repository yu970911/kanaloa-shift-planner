/**
 * ホテルかなろあ ― 作成済みのGoogleフォームの「お名前」の選択肢を、今の名簿に直すスクリプト
 *
 * 新しいフォームを作り直すとURLが変わってしまうので、
 * すでにスタッフへ配った後は、こちらで中身だけ直します。
 *
 * 【使い方】
 *  1. https://script.google.com を開いて「新しいプロジェクト」
 *  2. 中身を全部消して、このファイルの中身を貼り付ける
 *  3. 下の STAFF を今の名簿に直す（すでに10月の名簿を入れてあります）
 *  4. 上の関数の選択で updateFormStaff を選び、▶ 実行 → 承認
 *  5. 「実行ログ」に結果が出ます。そのままのURLで、選択肢だけ新しくなります
 */

// 直したいフォーム。https://docs.google.com/forms/d/【ここ】/edit の部分
const FORM_ID = '1P_8B7kMBYd1JTXPoLHYLA_CtpRyJaL7j8H5Fa8Uplbk';

// 念のための確認用。スタッフに配った回答用URL（forms.gle/… を開いたときのアドレス）に含まれる文字列。
// 違うフォームを触ってしまわないよう、一致しなければ何もしません。空にすると確認を飛ばします。
const PUBLISHED_ID = '1FAIpQLSeg15s1HnOIvsuJi9M6bPW4o_JkaaImibPASk6oZNs1WHp9XA';

// 今の名簿
const STAFF = [
  '宮平 絹江',
  '日下 堅人',
  '薄田 裕花',
  'EI KAY ZIN HAN',
  'KYI SU THAR',
  'ギミレ アスナ',
  'サムパツ',
  '島村 友子',
  // 石橋 大樹は長期休暇で2026年は不在のため入れていません
  // アメリーさんは屋外の仕事でシフト表とは関係ないため入れていません
];

function updateFormStaff() {
  const form = FormApp.openById(FORM_ID);

  if (PUBLISHED_ID && form.getPublishedUrl().indexOf(PUBLISHED_ID) === -1) {
    Logger.log('！ 配ったフォームと違うようです。FORM_ID を確認してください。');
    Logger.log('  このフォームの回答用URL: ' + form.getPublishedUrl());
    return;
  }

  // 「お名前」の質問（プルダウン）を探す
  const items = form.getItems(FormApp.ItemType.LIST);
  let target = null;
  for (let i = 0; i < items.length; i++) {
    if (items[i].getTitle().indexOf('名前') !== -1) { target = items[i].asListItem(); break; }
  }
  if (!target) {
    Logger.log('！「お名前」のプルダウンが見つかりませんでした。');
    return;
  }

  const before = target.getChoices().map(function (c) { return c.getValue(); });
  target.setChoiceValues(STAFF);

  const added = STAFF.filter(function (n) { return before.indexOf(n) === -1; });
  const removed = before.filter(function (n) { return STAFF.indexOf(n) === -1; });

  Logger.log('================ 直しました ================');
  Logger.log('変更前: ' + before.join('、'));
  Logger.log('変更後: ' + STAFF.join('、'));
  Logger.log('追加: ' + (added.join('、') || 'なし'));
  Logger.log('削除: ' + (removed.join('、') || 'なし'));
  Logger.log('回答用URL（変わりません）: ' + form.getPublishedUrl());
  Logger.log('※すでに届いている回答は消えません。');
  Logger.log('==========================================');
}
