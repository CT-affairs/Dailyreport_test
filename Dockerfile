# Python 3.11の公式イメージをベースにする
FROM python:3.11-slim

# 環境変数を設定
ENV PYTHONUNBUFFERED True

# 作業ディレクトリを作成・設定
WORKDIR /app

# 依存関係ファイルをコピー
COPY requirements.txt requirements.txt

# 依存関係をインストール
RUN pip install --no-cache-dir -r requirements.txt

# アプリケーションコードをコピー
COPY . .

# Gunicornを起動するコマンド (Cloud RunがPORT環境変数を自動的に設定)
CMD exec gunicorn --bind :$PORT --workers 1 --threads 8 --timeout 0 main:app