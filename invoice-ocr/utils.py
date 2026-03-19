import re
import unicodedata
from typing import Optional


def normalize_text_basic(text: str) -> str:
    """
    業務帳票向けの「控えめな」日本語正規化。

    - Unicode 正規化 (NFKC)
      - 全角英数字・記号 → 半角
      - 半角カナ → 全角カナ など
    - 改行コードを LF に統一
    - 行頭末尾の空白を除去
    - 行内の連続スペース・タブを 1 個の半角スペースに圧縮

    ※ ひらがな/カタカナ/漢字の形は変えない（検索やマッチングで壊れにくくするため）
    """
    if text is None:
        return ""

    # Unicode 正規化
    normalized = unicodedata.normalize("NFKC", text)

    # 改行コード統一
    normalized = normalized.replace("\r\n", "\n").replace("\r", "\n")

    # 各行ごとに両端空白削除 & 連続空白圧縮
    lines = []
    for line in normalized.split("\n"):
        # タブもスペース扱いに
        line = line.replace("\t", " ")
        # 連続スペース → 1つ
        line = re.sub(r" {2,}", " ", line)
        lines.append(line.strip())

    # 連続する空行を 1 行に圧縮
    joined = "\n".join(lines)
    joined = re.sub(r"\n{3,}", "\n\n", joined)

    return joined.strip()


def normalize_for_matching(text: str) -> str:
    """
    キー情報のマッチング（請求書番号や会社名等）用の正規化。

    - basic 正規化を実行
    - 全角スペースも半角に寄せて 1 つに圧縮
    - 全角・半角の英数字・記号のゆらぎを抑える (NFKC 済み)
    - 大文字小文字の差異を吸収（ASCII のみ）
    """
    base = normalize_text_basic(text)

    # 全角スペースも含めて圧縮
    base = base.replace("\u3000", " ")
    base = re.sub(r"[ ]{2,}", " ", base)

    # 英字のみ小文字化（日本語はそのまま）
    base = re.sub(
        r"[A-Za-z]+",
        lambda m: m.group(0).lower(),
        base,
    )

    return base


def extract_amount(text: str) -> Optional[int]:
    """
    金額表記から整数金額をざっくり抽出するユーティリティ。

    対応例:
        "¥12,345" → 12345
        "１２３，４５６円（税込）" → 123456
        "合計： 1 234 567 円" → 1234567

    想定用途:
        - 「合計金額」候補の行から数値部分だけを取り出す前処理
    """
    if not text:
        return None

    norm = unicodedata.normalize("NFKC", text)

    # 円記号やカンマ・スペース等を取り除いて数値だけを抜き出す
    # 最後に出てくる「まとまった」数字列を採用する（合計金額を想定）
    candidates = re.findall(r"\d[\d, ]*\d|\d", norm)
    if not candidates:
        return None

    raw = candidates[-1]
    digits = re.sub(r"[^\d]", "", raw)
    if not digits:
        return None

    try:
        return int(digits)
    except ValueError:
        return None


def normalize_date_like(text: str) -> str:
    """
    日付っぽい表記を機械処理しやすい形に寄せる軽めの正規化。

    例:
        "2025年1月2日" → "2025-01-02"
        "令和7年1月2日" → "2025-01-02" （西暦変換は簡易対応）
        "2025/1/2" → "2025-01-02"

    フォーマットとして "YYYY-MM-DD" を返す。
    パースできなければ、入力を basic 正規化したものをそのまま返す。
    """
    from datetime import date

    s = normalize_text_basic(text)

    # 元号 対応（必要になれば拡張）
    era_patterns = [
        # (パターン, 基準年)
        (r"令和(\d+)年(\d+)月(\d+)日", 2018),  # 令和1年 = 2019年
        (r"平成(\d+)年(\d+)月(\d+)日", 1988),  # 平成1年 = 1989年
        (r"昭和(\d+)年(\d+)月(\d+)日", 1925),  # 昭和1年 = 1926年
    ]

    for pat, base_year in era_patterns:
        m = re.search(pat, s)
        if m:
            y = base_year + int(m.group(1))
            m_ = int(m.group(2))
            d_ = int(m.group(3))
            try:
                return date(y, m_, d_).strftime("%Y-%m-%d")
            except ValueError:
                return s

    # 西暦表記パターン
    m = re.search(r"(\d{4})[./年-](\d{1,2})[./月-](\d{1,2})", s)
    if m:
        y = int(m.group(1))
        m_ = int(m.group(2))
        d_ = int(m.group(3))
        try:
            return date(y, m_, d_).strftime("%Y-%m-%d")
        except ValueError:
            return s

    return s


# ----------------------------
# 会社名 正規化
# ----------------------------
_CORP_MARK_CANONICAL = [
    "株式会社",
    "有限会社",
    "合同会社",
    "一般社団法人",
    "一般財団法人",
    "特定非営利活動法人",
    "社会福祉法人",
    "学校法人",
    "医療法人",
    "NPO法人",
]

# 略記・環境依存文字のゆらぎを正規化（先に NFKC 済みが前提：㈱→(株) など）
_CORP_MARK_VARIANTS = [
    (r"\(株\)", "株式会社"),
    (r"\(有\)", "有限会社"),
    (r"\(同\)", "合同会社"),  # 稀に見かける略記
    (r"\(医\)", "医療法人"),
    (r"\(社\)", "一般社団法人"),  # 曖昧さあり。必要に応じて外してください
    (r"\(財\)", "一般財団法人"),
    (r"NPO ?法人", "NPO法人"),
]

_PARENS_ANY = r"[()\uFF08\uFF09]"  # 全半角カッコ


def _normalize_corp_mark(text: str) -> str:
    s = normalize_text_basic(text)
    # 括弧は半角へ統一済みだが、万一の全角も併せて処理
    s = re.sub(r"\uFF08", "(", s)  # （
    s = re.sub(r"\uFF09", ")", s)  # ）

    # 略記を正規表現で置換
    for pat, rep in _CORP_MARK_VARIANTS:
        s = re.sub(pat, rep, s)

    # 連続スペース圧縮（念のため）
    s = re.sub(r"\s{2,}", " ", s).strip()
    return s


def normalize_company_name(raw_name: str, prefer_position: str = "suffix") -> str:
    """
    会社名の正規化。
    - NFKC・空白整形
    - ㈱/㈲/(株)/(有) 等を「株式会社」「有限会社」に正規化
    - 前株/後株を指定の位置（prefix/suffix）に統一
    - 全半角カッコの統一（法人表記内のカッコは外す）
    - カタカナの半角/全角は NFKC で吸収

    prefer_position:
        - "prefix": 株式会社〇〇
        - "suffix": 〇〇株式会社（デフォルト）
    """
    if not raw_name:
        return ""

    s = _normalize_corp_mark(raw_name)

    # 法人種別の抽出（先に長い表記を優先マッチ）
    corp_mark = None
    # 末尾/先頭のいずれかにある法人種別を拾う
    for mark in sorted(_CORP_MARK_CANONICAL, key=len, reverse=True):
        # 前株/後株の両方を検査
        if s.startswith(mark):
            corp_mark = mark
            s = s[len(mark) :].strip()
            break
        if s.endswith(mark):
            corp_mark = mark
            s = s[: -len(mark)].strip()
            break

    # 会社名の中に括弧で括られた法人略記が残っていれば除去（例: "(株)〇〇", "〇〇(株)" → すでに置換済みのはずだが念のため）
    s = re.sub(rf"{_PARENS_ANY}?(株|有|同){_PARENS_ANY}?", "", s).strip()

    # ノイズ的な外側カッコを除去（社名全体を括るケース）
    if len(s) >= 2 and ((s[0] == "(" and s[-1] == ")") or (s[0] == "（" and s[-1] == "）")):
        s = s[1:-1].strip()

    # ここで company_core = s, corp_mark は見つかったもの or None
    company_core = s

    # 会社名に含まれる過剰な空白を圧縮
    company_core = re.sub(r"\s{2,}", " ", company_core)

    # OCR よくある混在（全角スペース）も半角へ寄せて圧縮
    company_core = company_core.replace("\u3000", " ")
    company_core = re.sub(r"[ ]{2,}", " ", company_core).strip()

    # ツ/ッ などの OCR ゆらぎは一律変換は危険なので控えめ対応に留める
    # ここでは半角カナ→全角、濁点結合などは NFKC 済みとする

    # 出力の位置決定
    if corp_mark:
        if prefer_position == "prefix":
            # 株式会社〇〇
            normalized = f"{corp_mark}{company_core}"
        else:
            # 〇〇株式会社
            normalized = f"{company_core}{corp_mark}"
    else:
        # 法人種別が検出できなければ、そのまま（上位ロジックで別途扱う）
        normalized = company_core

    # 最後にトリム
    return normalized.strip()

