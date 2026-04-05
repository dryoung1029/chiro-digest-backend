"""
Chiropractic Digest Backend
FastAPI service with weekly scheduler + manual trigger endpoint.
"""
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from typing import List

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from github_updater import delete_digest_entry, get_search_terms, save_search_terms
from pipeline import run_digest_pipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

VALID_PERIODS = {"week", "month", "3months", "6months"}

# ── Shared state ────────────────────────────────────────────────────────────
run_state: dict = {
    "status": "idle",     # idle | running | success | error
    "period": None,
    "step": None,         # human-readable current step
    "last_run": None,
    "last_result": None,
    "last_error": None,
}

scheduler = AsyncIOScheduler()


def _set_step(msg: str | None) -> None:
    run_state["step"] = msg


async def scheduled_job():
    log.info("Scheduler triggered digest pipeline")
    await _run(period="week", trigger="scheduler")


async def _run(period: str = "week", trigger: str = "manual"):
    if run_state["status"] == "running":
        log.warning("Pipeline already running — skipping")
        return
    run_state.update(status="running", period=period, step="Starting...", last_error=None)
    run_state["last_run"] = datetime.utcnow().isoformat() + "Z"
    try:
        result = await run_digest_pipeline(period=period, set_step=_set_step)
        run_state.update(status="success", last_result=result)
        log.info("Pipeline complete (%s): %s", trigger, result)
    except Exception as exc:
        run_state.update(status="error", last_error=str(exc))
        log.exception("Pipeline failed (%s)", trigger)
    finally:
        run_state["period"] = None
        run_state["step"] = None


# ── App lifecycle ────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    scheduler.add_job(scheduled_job, CronTrigger(day_of_week="sun", hour=23, minute=0))
    scheduler.start()
    log.info("Scheduler started — weekly job: Sunday 23:00 UTC")
    yield
    scheduler.shutdown()


app = FastAPI(title="Chiro Digest API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["*"],
)

app.mount("/static", StaticFiles(directory="static"), name="static")


# ── Routes ───────────────────────────────────────────────────────────────────
@app.get("/")
async def serve_frontend():
    return FileResponse("static/index.html")


@app.get("/health")
async def health():
    return {"status": "ok", "service": "chiro-digest-backend"}


@app.get("/status")
async def status():
    return run_state


@app.post("/run")
async def trigger_run(
    background_tasks: BackgroundTasks,
    period: str = Query("week", description="week | month | 3months | 6months"),
):
    if period not in VALID_PERIODS:
        raise HTTPException(400, detail=f"Invalid period. Must be one of: {', '.join(sorted(VALID_PERIODS))}")
    if run_state["status"] == "running":
        raise HTTPException(409, detail="Pipeline already running")
    background_tasks.add_task(_run, period, "manual")
    return {"message": "Digest pipeline started", "period": period, "triggered_at": datetime.utcnow().isoformat() + "Z"}


# ── Search terms ─────────────────────────────────────────────────────────────
class SearchTermsBody(BaseModel):
    terms: List[str]


@app.get("/search-terms")
async def get_terms():
    terms = await get_search_terms()
    return {"terms": terms}


@app.put("/search-terms")
async def put_terms(body: SearchTermsBody):
    terms = [t.strip() for t in body.terms if t.strip()]
    if not terms:
        raise HTTPException(400, detail="At least one search term is required")
    await save_search_terms(terms)
    return {"terms": terms}


# ── Digest management ─────────────────────────────────────────────────────────
@app.delete("/digest")
async def delete_digest(date: str = Query(..., description="Date of the digest entry to delete (YYYY-MM-DD)")):
    try:
        await delete_digest_entry(date)
    except ValueError as e:
        raise HTTPException(404, detail=str(e))
    return {"deleted": date}
