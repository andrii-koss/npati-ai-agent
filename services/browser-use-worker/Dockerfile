FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY services/browser-use-worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
  && python -m playwright install --with-deps chromium \
  && chmod -R a+rX /ms-playwright
COPY services/browser-use-worker/app.py services/browser-use-worker/egress_guard.py ./
# /app/data/browser-uploads is a volume of its own shared with the API (audit M4: the worker no longer sees the rest
# of the API's data). This worker may create it first, so it carries the API image's owner (node, uid 1000).
RUN useradd --create-home --uid 10001 browserworker \
  && mkdir -p /state/profiles /state/artifacts /app/data/browser-uploads \
  && chown -R browserworker:browserworker /state \
  && chown 1000:1000 /app/data/browser-uploads
USER browserworker
EXPOSE 8765
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8765"]
