"""
AWS S3 operations — upload, download, list, mark processed.
"""
import asyncio
import logging
import os

import boto3
from botocore.exceptions import ClientError

log = logging.getLogger(__name__)

BUCKET = os.environ["S3_BUCKET"]
REGION = os.getenv("AWS_DEFAULT_REGION", "us-west-2")

_s3 = None


def _client():
    global _s3
    if _s3 is None:
        _s3 = boto3.client(
            "s3",
            region_name=REGION,
            aws_access_key_id=os.environ["AWS_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["AWS_SECRET_ACCESS_KEY"],
        )
    return _s3


async def list_unprocessed_pdfs() -> list[str]:
    """Return S3 keys of PDFs in pdfs/ that haven't been processed yet."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _list_unprocessed_sync)


def _list_unprocessed_sync() -> list[str]:
    s3 = _client()
    response = s3.list_objects_v2(Bucket=BUCKET, Prefix="pdfs/")
    keys = []
    for obj in response.get("Contents", []):
        key = obj["Key"]
        if not key.endswith(".pdf"):
            continue
        # Check for processed tag
        try:
            tags = s3.get_object_tagging(Bucket=BUCKET, Key=key)
            tag_dict = {t["Key"]: t["Value"] for t in tags.get("TagSet", [])}
            if tag_dict.get("processed") == "true":
                continue
        except ClientError:
            pass
        keys.append(key)
    return keys


async def download_pdf(key: str) -> bytes:
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, lambda: _client().get_object(Bucket=BUCKET, Key=key)["Body"].read())


async def upload_pdf(key: str, data: bytes) -> None:
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: _client().put_object(Bucket=BUCKET, Key=key, Body=data, ContentType="application/pdf"),
    )


async def mark_processed(key: str) -> None:
    """Tag an S3 object as processed so we don't re-process it."""
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: _client().put_object_tagging(
            Bucket=BUCKET,
            Key=key,
            Tagging={"TagSet": [{"Key": "processed", "Value": "true"}]},
        ),
    )


async def update_userdata_json(data: dict) -> None:
    import json
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None,
        lambda: _client().put_object(
            Bucket=BUCKET,
            Key="userdata.json",
            Body=json.dumps(data, indent=2).encode(),
            ContentType="application/json",
        ),
    )
