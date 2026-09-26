FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY services/browser-use-worker/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt \
  && python -m playwright install --with-deps chromium \
  && chmod -R a+rX /ms-playwright
COPY services/browser-use-worker/app.py ./app.py
RUN useradd --create-home --uid 10001 browserworker \
  && mkdir -p /state/profiles /state/artifacts \
  && chown -R browserworker:browserworker /state
USER browserworker
EXPOSE 8765
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8765"]
