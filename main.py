"""
Chiropractic Digest Backend
FastAPI service with weekly scheduler + manual trigger endpoint.
"""
import logging
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Literal

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from pipeline import run_digest_pipeline

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)

VALID_PERIODS = {"week", "month", "3months", "6months"}

# ── Shared state ────────────────────────────────────────────────────────────
run_state: dict = {
    "status": "idle",          # idle | running | success | error
    "period": None,
    "last_run": None,
    "last_result": None,
    "last_error": None,
}

scheduler = AsyncIOScheduler()


async def scheduled_job():
    log.info("Scheduler triggered digest pipeline")
    await _run(period="week", trigger="scheduler")


async def _run(period: str = "week", trigger: str = "manual"):
    if run_state["status"] == "running":
        log.warning("Pipeline already running — skipping")
        return
    run_state["status"] = "running"
    run_state["period"] = period
    run_state["last_run"] = datetime.utcnow().isoformat() + "Z"
    run_state["last_error"] = None
    try:
        result = await run_digest_pipeline(period=period)
        run_state["status"] = "success"
        run_state["last_result"] = result
        log.info("Pipeline complete (%s): %s", trigger, result)
    except Exception as exc:
        run_state["status"] = "error"
        run_state["last_error"] = str(exc)
        log.exception("Pipeline failed (%s)", trigger)
    finally:
        run_state["period"] = None


# ── App lifecycle ────────────────────────────────────────────────────────────
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Run every Sunday at 23:00 UTC
    scheduler.add_job(scheduled_job, CronTrigger(day_of_week="sun", hour=23, minute=0))
    scheduler.start()
    log.info("Scheduler started — weekly job: Sunday 23:00 UTC")
    yield
    scheduler.shutdown()


app = FastAPI(title="Chiro Digest API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST"],
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
    period: str = Query("week", description="Time period: week | month | 3months | 6months"),
):
    """Manually trigger a digest pipeline run."""
    if period not in VALID_PERIODS:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid period '{period}'. Must be one of: {', '.join(sorted(VALID_PERIODS))}",
        )
    if run_state["status"] == "running":
        raise HTTPException(status_code=409, detail="Pipeline already running")
    background_tasks.add_task(_run, period, "manual")
    return {"message": "Digest pipeline started", "period": period, "triggered_at": datetime.utcnow().isoformat() + "Z"}
