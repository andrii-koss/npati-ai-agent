from __future__ import annotations

import asyncio
import hashlib
import ipaddress
import json
import os
import secrets
import socket
import sqlite3
import time
import uuid
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from playwright.async_api import async_playwright

STATE_DIR = Path(os.getenv("NPATI_BROWSER_STATE_DIR", "/state")).resolve()
PROFILE_DIR = STATE_DIR / "profiles"
ARTIFACT_DIR = STATE_DIR / "artifacts"
DB_PATH = STATE_DIR / "jobs.sqlite3"
TOKEN = os.getenv("NPATI_BROWSER_INTERNAL_TOKEN", "")
if len(TOKEN) < 32:
    raise RuntimeError("NPATI_BROWSER_INTERNAL_TOKEN must contain at least 32 characters")
if os.getenv("NPATI_ENV") == "production" and TOKEN.startswith("npati-local-"):
    raise RuntimeError("Replace the local Browser Worker token before production")
MAX_RETRIES = max(0, min(int(os.getenv("NPATI_BROWSER_MAX_RETRIES", "2")), 5))
PROFILE_DIR.mkdir(parents=True, exist_ok=True)
ARTIFACT_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="NPATI Browser Use Worker", version="1.0.0")
PROFILE_LOCKS: dict[str, asyncio.Lock] = {}
RUNNING_JOBS: dict[str, asyncio.Task[Any]] = {}
DB_RECOVERED = False


class ExecuteRequest(BaseModel):
    request_id: str | None = None
    tenant_scope: str = Field(pattern=r"^[a-f0-9]{64}$")
    profile_scope: str = Field(pattern=r"^[a-f0-9]{64}$")
    action: Literal["navigate", "fill_form", "register_account", "upload", "extract", "screenshot", "task", "pause", "resume"]
    input: dict[str, Any] = Field(default_factory=dict)
    secrets: dict[str, str] = Field(default_factory=dict)


def authorize(authorization: str | None = Header(default=None)) -> None:
    if not authorization or not secrets.compare_digest(authorization, f"Bearer {TOKEN}"):
        raise HTTPException(status_code=401, detail="Invalid internal Browser Use token")


def db() -> sqlite3.Connection:
    global DB_RECOVERED
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("""
      CREATE TABLE IF NOT EXISTS jobs(
        id TEXT PRIMARY KEY, request_id TEXT, tenant_scope TEXT NOT NULL, profile_scope TEXT NOT NULL,
        action TEXT NOT NULL, input_json TEXT NOT NULL, status TEXT NOT NULL,
        result_json TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        created_at REAL NOT NULL, updated_at REAL NOT NULL
      )
    """)
    columns = {row[1] for row in connection.execute("PRAGMA table_info(jobs)").fetchall()}
    if "request_id" not in columns:
        connection.execute("ALTER TABLE jobs ADD COLUMN request_id TEXT")
    connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_tenant_request ON jobs(tenant_scope,request_id) WHERE request_id IS NOT NULL")
    if not DB_RECOVERED:
        connection.execute("UPDATE jobs SET status='failed',last_error='Worker restarted during execution',updated_at=? WHERE status='running'", (time.time(),))
        DB_RECOVERED = True
    connection.commit()
    return connection


def safe_scope(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


def profile_path(scope: str) -> Path:
    target = (PROFILE_DIR / safe_scope(scope)).resolve()
    if PROFILE_DIR not in target.parents:
        raise HTTPException(status_code=400, detail="Invalid profile scope")
    target.mkdir(parents=True, exist_ok=True)
    return target


def validate_public_url(value: str) -> str:
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise HTTPException(status_code=400, detail="Only absolute HTTP(S) URLs are supported")
    try:
        addresses = socket.getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80))
    except socket.gaierror as exc:
        raise HTTPException(status_code=400, detail="Browser destination could not be resolved") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved:
            raise HTTPException(status_code=403, detail="Browser destination resolves to a protected network")
    return value


def trace(action: str, status: str, *, url: str | None = None, detail: str | None = None) -> dict[str, Any]:
    return {"action": action, "status": status, "url": url, "detail": detail, "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


async def deterministic(req: ExecuteRequest, action: str, payload: dict[str, Any]) -> tuple[Any, list[dict[str, Any]], list[dict[str, str]]]:
    traces: list[dict[str, Any]] = []
    artifacts: list[dict[str, str]] = []
    async with async_playwright() as playwright:
        context = await playwright.chromium.launch_persistent_context(
            str(profile_path(req.profile_scope)), headless=True,
            viewport={"width": 1440, "height": 1000}, accept_downloads=True,
        )
        try:
            page = context.pages[0] if context.pages else await context.new_page()
            url = payload.get("url")
            if url:
                await page.goto(validate_public_url(str(url)), wait_until="domcontentloaded", timeout=60_000)
                traces.append(trace("navigate", "succeeded", url=page.url))

            if action == "navigate":
                return {"url": page.url, "title": await page.title()}, traces, artifacts
            if action == "fill_form":
                fields = payload.get("fields", [])
                if not isinstance(fields, list):
                    raise ValueError("fields must be an array")
                for field in fields[:100]:
                    selector = str(field.get("selector", "")).strip()
                    if not selector:
                        raise ValueError("Every form field requires selector")
                    if field.get("secretRef"):
                        alias = str(field["secretRef"])
                        if alias not in req.secrets:
                            raise ValueError(f"Unknown secretRef: {alias}")
                        value = req.secrets[alias]
                    else:
                        value = str(field.get("value", ""))
                    await page.locator(selector).fill(value)
                    traces.append(trace("secure_fill" if field.get("secretRef") else "fill", "succeeded", url=page.url, detail=selector))
                if payload.get("submitSelector"):
                    await page.locator(str(payload["submitSelector"])).click()
                    await page.wait_for_load_state("domcontentloaded")
                    traces.append(trace("submit", "succeeded", url=page.url))
                return {"url": page.url, "title": await page.title(), "fieldsFilled": len(fields)}, traces, artifacts
            if action == "upload":
                selector = str(payload.get("selector", "input[type=file]"))
                files = [str(Path(item).resolve()) for item in payload.get("files", [])]
                if not files or any(not Path(item).is_file() for item in files):
                    raise ValueError("Upload files are missing from the approved shared directory")
                await page.locator(selector).set_input_files(files)
                traces.append(trace("upload", "succeeded", url=page.url, detail=f"{len(files)} file(s)"))
                return {"url": page.url, "filesUploaded": len(files)}, traces, artifacts
            if action == "extract":
                selector = str(payload.get("selector", "body"))
                mode = str(payload.get("mode", "text"))
                locator = page.locator(selector).first
                value = await locator.get_attribute(str(payload.get("attribute"))) if mode == "attribute" else await locator.inner_text()
                traces.append(trace("extract", "succeeded", url=page.url, detail=selector))
                return {"url": page.url, "content": (value or "")[:200_000]}, traces, artifacts
            if action == "screenshot":
                artifact_id = str(uuid.uuid4())
                tenant_artifacts = ARTIFACT_DIR / safe_scope(req.tenant_scope)
                tenant_artifacts.mkdir(parents=True, exist_ok=True)
                target = tenant_artifacts / f"{artifact_id}.png"
                await page.screenshot(path=str(target), full_page=bool(payload.get("fullPage", True)))
                artifacts.append({"id": artifact_id, "kind": "screenshot"})
                traces.append(trace("screenshot", "succeeded", url=page.url, detail=artifact_id))
                return {"url": page.url, "artifactId": artifact_id}, traces, artifacts
            raise ValueError(f"Unsupported deterministic browser action: {action}")
        finally:
            await context.close()


async def autonomous(req: ExecuteRequest, payload: dict[str, Any]) -> tuple[Any, list[dict[str, Any]], list[dict[str, str]]]:
    task = str(payload.get("task") or payload.get("goal") or "").strip()
    url = payload.get("url")
    if url:
        validate_public_url(str(url))
        task = f"Open {url} and {task}"
    if not task:
        raise ValueError("Autonomous browser task is required")
    # Values in sensitive_data are injected by Browser Use at action time. The model sees aliases only.
    from browser_use import Agent, BrowserSession, ChatBrowserUse

    allowed_domains = payload.get("allowedDomains") or ([urlparse(str(url)).hostname] if url else [])
    allowed_domains = [str(domain).lower() for domain in allowed_domains if domain]
    if not allowed_domains:
        raise ValueError("Autonomous tasks require url or allowedDomains")
    for domain in allowed_domains:
        validate_public_url(f"https://{domain.removeprefix('*.')}")
    browser = BrowserSession(user_data_dir=str(profile_path(req.profile_scope)), headless=True, allowed_domains=allowed_domains)
    llm = ChatBrowserUse(model=os.getenv("BROWSER_USE_MODEL", "bu-2-0"))
    domain_secrets = {domain: dict(req.secrets) for domain in allowed_domains} if req.secrets else None
    available_files = [str(Path(item).resolve()) for item in payload.get("files", [])]
    if any(not Path(item).is_file() for item in available_files):
        raise ValueError("Autonomous task file is missing from the approved shared directory")
    agent = Agent(task=task, llm=llm, browser_session=browser, sensitive_data=domain_secrets,
                  available_file_paths=available_files or None)
    history = await agent.run(max_steps=max(1, min(int(payload.get("maxSteps", 50)), 200)))
    final = history.final_result() if hasattr(history, "final_result") else str(history)
    urls = history.urls() if hasattr(history, "urls") else []
    model_actions = history.model_actions() if hasattr(history, "model_actions") else []
    steps: list[dict[str, Any]] = []
    for index, action_group in enumerate(model_actions[-100:]):
        names = list(action_group.keys()) if isinstance(action_group, dict) else [type(action_group).__name__]
        steps.append(trace("autonomous." + "+".join(names)[:120], "succeeded", url=urls[index] if index < len(urls) else None))
    steps.append(trace("autonomous_task", "succeeded", url=urls[-1] if urls else None))
    return {"final": final, "urls": urls[-100:]}, steps, []


async def run_job(req: ExecuteRequest, job_id: str, action: str, payload: dict[str, Any]) -> dict[str, Any]:
    if payload.get("pause") is True:
        return {"jobId": job_id, "status": "paused", "result": {}, "artifacts": [], "trace": [trace(action, "paused")]}
    last_error: Exception | None = None
    for attempt in range(MAX_RETRIES + 1):
        try:
            if action in {"task", "register_account"}:
                result, traces, artifacts = await autonomous(req, payload)
            else:
                result, traces, artifacts = await deterministic(req, action, payload)
            if payload.get("waitForEmail") is True:
                traces.append(trace("wait_email", "waiting_email", detail=str(payload.get("emailHint", "Awaiting verification email"))))
                return {"jobId": job_id, "status": "waiting_email", "result": {"resumeToken": job_id, "browserResult": result}, "artifacts": artifacts, "trace": traces}
            return {"jobId": job_id, "status": "completed", "result": result, "artifacts": artifacts, "trace": traces}
        except Exception as exc:
            last_error = exc
            if attempt < MAX_RETRIES:
                await asyncio.sleep(min(2 ** attempt, 4))
    assert last_error is not None
    raise last_error


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/v1/artifacts/{artifact_id}", dependencies=[Depends(authorize)])
async def artifact(artifact_id: str, x_tenant_scope: str = Header()) -> FileResponse:
    try:
        uuid.UUID(artifact_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Artifact not found") from exc
    if not x_tenant_scope or len(x_tenant_scope) != 64:
        raise HTTPException(status_code=403, detail="Invalid tenant scope")
    target = (ARTIFACT_DIR / safe_scope(x_tenant_scope) / f"{artifact_id}.png").resolve()
    if not target.is_file() or ARTIFACT_DIR not in target.parents:
        raise HTTPException(status_code=404, detail="Artifact not found")
    return FileResponse(target, media_type="image/png", filename=f"browser-{artifact_id}.png")


@app.get("/v1/jobs/{job_id}", dependencies=[Depends(authorize)])
async def job_status(job_id: str, x_tenant_scope: str = Header(), x_profile_scope: str = Header()) -> dict[str, Any]:
    connection = db()
    try:
        row = connection.execute("SELECT id,status,attempts,last_error,created_at,updated_at FROM jobs WHERE id=? AND tenant_scope=? AND profile_scope=?",
                                 (job_id, x_tenant_scope, x_profile_scope)).fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Browser job not found")
        return dict(row)
    finally:
        connection.close()


@app.post("/v1/execute", dependencies=[Depends(authorize)])
async def execute(req: ExecuteRequest) -> dict[str, Any]:
    connection = db()
    now = time.time()
    try:
        if req.action == "pause":
            job_id = str(req.input.get("jobId", ""))
            row = connection.execute("SELECT status FROM jobs WHERE id=? AND tenant_scope=? AND profile_scope=?", (job_id, req.tenant_scope, req.profile_scope)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Browser job was not found in this tenant/profile")
            task = RUNNING_JOBS.get(job_id)
            if task and not task.done():
                task.cancel()
            connection.execute("UPDATE jobs SET status='paused',updated_at=? WHERE id=?", (time.time(), job_id))
            connection.commit()
            return {"jobId": job_id, "status": "paused", "result": {}, "artifacts": [], "trace": [trace("pause", "paused")]}
        if req.action == "resume":
            job_id = str(req.input.get("jobId", ""))
            row = connection.execute("SELECT * FROM jobs WHERE id=? AND tenant_scope=? AND profile_scope=?", (job_id, req.tenant_scope, req.profile_scope)).fetchone()
            if not row:
                raise HTTPException(status_code=404, detail="Browser job was not found in this tenant/profile")
            if row["status"] not in {"waiting_email", "paused", "failed"}:
                raise HTTPException(status_code=409, detail=f"Browser job cannot resume from {row['status']}")
            original = json.loads(row["input_json"])
            payload = {**original, **dict(req.input.get("resumeInput", {})), "waitForEmail": False, "pause": False}
            action = row["action"]
        else:
            existing = connection.execute("SELECT * FROM jobs WHERE tenant_scope=? AND request_id=?", (req.tenant_scope, req.request_id)).fetchone() if req.request_id else None
            if existing and existing["result_json"]:
                return json.loads(existing["result_json"])
            if existing and existing["status"] == "running":
                raise HTTPException(status_code=409, detail="Browser job is already running")
            if existing:
                job_id = existing["id"]
                payload = json.loads(existing["input_json"])
                action = existing["action"]
                connection.execute("UPDATE jobs SET status='running',last_error=NULL,updated_at=? WHERE id=?", (now, job_id))
            else:
                job_id = str(uuid.uuid4())
                payload = dict(req.input)
                action = req.action
                connection.execute("INSERT INTO jobs(id,request_id,tenant_scope,profile_scope,action,input_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
                                   (job_id, req.request_id, req.tenant_scope, req.profile_scope, action, json.dumps(payload), "running", now, now))
            connection.commit()
        lock = PROFILE_LOCKS.setdefault(req.profile_scope, asyncio.Lock())
        async with lock:
            running = asyncio.create_task(run_job(req, job_id, action, payload))
            RUNNING_JOBS[job_id] = running
            try:
                result = await running
            except asyncio.CancelledError:
                result = {"jobId": job_id, "status": "paused", "result": {}, "artifacts": [], "trace": [trace(action, "paused")]}
            finally:
                RUNNING_JOBS.pop(job_id, None)
        connection.execute("UPDATE jobs SET status=?,result_json=?,attempts=attempts+1,last_error=NULL,updated_at=? WHERE id=? AND tenant_scope=?",
                           (result["status"], json.dumps(result), time.time(), job_id, req.tenant_scope))
        connection.commit()
        return result
    except HTTPException:
        raise
    except Exception as exc:
        if "job_id" in locals():
            connection.execute("UPDATE jobs SET status='failed',attempts=attempts+1,last_error=?,updated_at=? WHERE id=? AND tenant_scope=?",
                               (str(exc)[:2000], time.time(), job_id, req.tenant_scope))
            connection.commit()
        raise HTTPException(status_code=502, detail=f"Browser execution failed: {exc}") from exc
    finally:
        # Secrets are request-local and are never written to SQLite or returned.
        req.secrets.clear()
        connection.close()
