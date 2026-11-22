FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 HOST=0.0.0.0 PORT=8000 DATA_DIR=/data
WORKDIR /srv

# xgboost needs the OpenMP runtime
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY main.py db.py user_routes.py model.json meta.json ./
COPY app ./app
RUN rm -f app/*.bak* && mkdir -p /data && chmod 777 /data   # writable for hosts that run as a non-root user

EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import urllib.request,os;urllib.request.urlopen('http://127.0.0.1:'+os.environ.get('PORT','8000')+'/healthz')"
CMD ["python", "main.py"]
