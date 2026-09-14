#!/usr/bin/env python3
"""MCP server for Ruijie KM knowledge APIs.

The implementation intentionally uses only Python standard library modules so
the plugin can run in a fresh Codex environment without dependency install.
"""

from __future__ import annotations

import json
import os
import ssl
import sys
import traceback
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable


SERVER_NAME = "ruijie-km"
SERVER_VERSION = "0.2.0"
PROD_BASE_URL = "https://km.ruijie.com.cn"
TEST_BASE_URL = "https://kmtest.ruijie.com.cn:1443"
DEFAULT_TIMEOUT_SECONDS = 20.0
DEFAULT_SEARCH_PAGE_SIZE = 10
DEFAULT_DETAIL_LIMIT = 3
MAX_DETAIL_LIMIT = 5
CONTENT_SNIPPET_CHARS = 600
PLATFORM_ALIASES = {
    "marketing": "marketing",
    "makiting": "marketing",
    "市场资料平台": "marketing",
    "市场资料": "marketing",
}


JsonDict = dict[str, Any]
ToolHandler = Callable[[JsonDict], JsonDict]


class KMError(Exception):
    """User-facing API/tool error."""

    def __init__(self, message: str, details: Any | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details


@dataclass(frozen=True)
class KMConfig:
    base_url: str
    timeout_seconds: float
    insecure_tls: bool
    ca_file: str | None
    has_cookie: bool
    has_authorization: bool
    extra_header_names: list[str]


def env_truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "y", "on"}


def load_config() -> KMConfig:
    base_url = os.environ.get("RUIJIE_KM_BASE_URL", "").strip()
    if not base_url:
        env_name = os.environ.get("RUIJIE_KM_ENV", "prod").strip().lower()
        base_url = TEST_BASE_URL if env_name in {"test", "testing", "kmtest"} else PROD_BASE_URL

    timeout_raw = os.environ.get("RUIJIE_KM_TIMEOUT_SECONDS", "").strip()
    try:
        timeout_seconds = float(timeout_raw) if timeout_raw else DEFAULT_TIMEOUT_SECONDS
    except ValueError as exc:
        raise KMError("RUIJIE_KM_TIMEOUT_SECONDS must be a number.") from exc

    extra_headers = parse_extra_headers(validate_only=True)
    return KMConfig(
        base_url=base_url.rstrip("/"),
        timeout_seconds=timeout_seconds,
        insecure_tls=env_truthy(os.environ.get("RUIJIE_KM_INSECURE_TLS")),
        ca_file=os.environ.get("RUIJIE_KM_CA_FILE", "").strip() or None,
        has_cookie=bool(os.environ.get("RUIJIE_KM_COOKIE")),
        has_authorization=bool(os.environ.get("RUIJIE_KM_AUTHORIZATION")),
        extra_header_names=sorted(extra_headers.keys()),
    )


def parse_extra_headers(validate_only: bool = False) -> dict[str, str]:
    raw = os.environ.get("RUIJIE_KM_EXTRA_HEADERS", "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise KMError("RUIJIE_KM_EXTRA_HEADERS must be a JSON object.") from exc
    if not isinstance(parsed, dict):
        raise KMError("RUIJIE_KM_EXTRA_HEADERS must be a JSON object.")
    headers: dict[str, str] = {}
    for key, value in parsed.items():
        if not isinstance(key, str) or not key.strip():
            raise KMError("RUIJIE_KM_EXTRA_HEADERS contains an invalid header name.")
        if not isinstance(value, str):
            raise KMError(f"Header {key!r} in RUIJIE_KM_EXTRA_HEADERS must be a string.")
        headers[key.strip()] = value
    if validate_only:
        return headers
    return headers


def build_headers() -> dict[str, str]:
    headers = {
        "Accept": "application/json",
        "User-Agent": f"{SERVER_NAME}/{SERVER_VERSION}",
    }
    cookie = os.environ.get("RUIJIE_KM_COOKIE", "").strip()
    authorization = os.environ.get("RUIJIE_KM_AUTHORIZATION", "").strip()
    if cookie:
        headers["Cookie"] = cookie
    if authorization:
        headers["Authorization"] = authorization
    headers.update(parse_extra_headers())
    return headers


def compact_query(params: dict[str, Any]) -> dict[str, str]:
    query: dict[str, str] = {}
    for key, value in params.items():
        if value is None or value == "":
            continue
        if isinstance(value, bool):
            query[key] = "true" if value else "false"
        else:
            query[key] = str(value)
    return query


def request_json(path: str, query: dict[str, Any] | None = None) -> JsonDict:
    config = load_config()
    query_string = urllib.parse.urlencode(compact_query(query or {}), doseq=True)
    url = f"{config.base_url}{path}"
    if query_string:
        url = f"{url}?{query_string}"

    request = urllib.request.Request(url=url, method="GET", headers=build_headers())
    if config.insecure_tls:
        context = ssl._create_unverified_context()
    elif config.ca_file:
        context = ssl.create_default_context(cafile=config.ca_file)
    else:
        context = None

    try:
        with urllib.request.urlopen(  # nosec: configured internal URL.
            request,
            timeout=config.timeout_seconds,
            context=context,
        ) as response:
            body = response.read()
            charset = response.headers.get_content_charset() or "utf-8"
            text = body.decode(charset, errors="replace")
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise KMError(
            f"Ruijie KM HTTP request failed with status {exc.code}.",
            {
                "url": scrub_url(url),
                "status": exc.code,
                "body": body[:2000],
            },
        ) from exc
    except urllib.error.URLError as exc:
        raise KMError(
            "Ruijie KM HTTP request failed.",
            {
                "url": scrub_url(url),
                "reason": str(exc.reason),
            },
        ) from exc

    try:
        payload = json.loads(text)
    except json.JSONDecodeError as exc:
        raise KMError(
            "Ruijie KM response was not valid JSON.",
            {
                "url": scrub_url(url),
                "body": text[:2000],
            },
        ) from exc

    if not isinstance(payload, dict):
        raise KMError(
            "Ruijie KM response JSON was not an object.",
            {
                "url": scrub_url(url),
                "type": type(payload).__name__,
            },
        )

    payload.setdefault("_request", {"url": scrub_url(url)})
    return payload


def scrub_url(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, parsed.query, ""))


def as_int(
    args: JsonDict,
    key: str,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int | None:
    if key not in args or args[key] is None or args[key] == "":
        return None
    try:
        value = int(args[key])
    except (TypeError, ValueError) as exc:
        raise KMError(f"{key} must be an integer.") from exc
    if minimum is not None and value < minimum:
        raise KMError(f"{key} must be >= {minimum}.")
    if maximum is not None and value > maximum:
        raise KMError(f"{key} must be <= {maximum}.")
    return value


def as_string(args: JsonDict, key: str, required: bool = False) -> str | None:
    value = args.get(key)
    if value is None or value == "":
        if required:
            raise KMError(f"{key} is required.")
        return None
    if not isinstance(value, str):
        value = str(value)
    value = value.strip()
    if required and not value:
        raise KMError(f"{key} is required.")
    return value or None


def as_bool(args: JsonDict, key: str, default: bool | None = None) -> bool | None:
    if key not in args or args[key] is None or args[key] == "":
        return default
    value = args[key]
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        if value in (0, 1):
            return bool(value)
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"1", "true", "yes", "y", "on"}:
            return True
        if normalized in {"0", "false", "no", "n", "off"}:
            return False
    raise KMError(f"{key} must be a boolean.")


def normalize_order(value: str | None) -> str | None:
    if not value:
        return None
    normalized = value.upper()
    if normalized not in {"ASC", "DESC"}:
        raise KMError("order must be ASC or DESC.")
    return normalized


def normalize_platform(value: str | None) -> str | None:
    if not value:
        return None
    return PLATFORM_ALIASES.get(value.strip().lower(), value.strip())


def km_absolute_url(path_or_url: str | None) -> str | None:
    if not path_or_url:
        return None
    if path_or_url.startswith("http://") or path_or_url.startswith("https://"):
        return path_or_url
    return f"{load_config().base_url}{path_or_url}"


def text_snippet(value: Any, limit: int = CONTENT_SNIPPET_CHARS) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if len(text) <= limit:
        return text
    return f"{text[:limit].rstrip()}..."


def normalize_document(doc: JsonDict, detail: JsonDict | None = None) -> JsonDict:
    merged = dict(doc)
    if detail:
        merged.update({k: v for k, v in detail.items() if v is not None})
    attachments = merged.get("attachments")
    if not isinstance(attachments, list):
        attachments = []
    return {
        "docId": merged.get("docId"),
        "originId": merged.get("originId"),
        "title": merged.get("title"),
        "author": merged.get("author"),
        "categoryId": merged.get("categoryId"),
        "categoryName": merged.get("categoryName"),
        "platform": merged.get("platform"),
        "lastModified": merged.get("lastModified"),
        "publishTime": merged.get("publishTime"),
        "version": merged.get("version"),
        "permissions": merged.get("permissions"),
        "tags": merged.get("tags") or [],
        "summary": merged.get("summary") or "",
        "docUrl": km_absolute_url(merged.get("docUrl")),
        "contentSnippet": text_snippet(merged.get("content")),
        "attachmentsCount": len(attachments),
        "attachments": [
            {
                "attachmentId": item.get("attachmentId"),
                "filename": item.get("filename"),
                "attType": item.get("attType"),
                "downloadUrl": item.get("downloadUrl"),
                "viewUrl": item.get("viewUrl"),
            }
            for item in attachments
            if isinstance(item, dict)
        ],
    }


def require_success(payload: JsonDict) -> JsonDict:
    code = payload.get("code")
    if code not in (0, "0", None):
        raise KMError(
            "Ruijie KM API returned a non-zero code.",
            {
                "code": payload.get("code"),
                "message": payload.get("message"),
                "request": payload.get("_request"),
            },
        )
    return payload


def build_document_query(args: JsonDict, default_page_size: int | None = None) -> JsonDict:
    page = as_int(args, "page", minimum=1, maximum=10)
    page_size = as_int(args, "pageSize", minimum=1, maximum=100)
    latest_only = as_bool(args, "latestOnly")
    doc_is_new_version = as_int(args, "docIsNewVersion", minimum=0, maximum=1)
    if latest_only is not None:
        doc_is_new_version = 1 if latest_only else None

    query_text = as_string(args, "query")
    keyword = as_string(args, "keyword") or query_text

    return {
        "page": page or 1,
        "pageSize": page_size or default_page_size,
        "startTime": as_string(args, "startTime"),
        "endTime": as_string(args, "endTime"),
        "keyword": keyword,
        "categoryId": as_string(args, "categoryId"),
        "tag": as_string(args, "tag"),
        "platform": normalize_platform(as_string(args, "platform")),
        "sort": as_string(args, "sort") or "publishTime",
        "order": normalize_order(as_string(args, "order") or "DESC"),
        "accountNumber": as_string(args, "accountNumber"),
        "docIsNewVersion": doc_is_new_version,
    }


def tool_get_config(args: JsonDict) -> JsonDict:
    config = load_config()
    return {
        "baseUrl": config.base_url,
        "timeoutSeconds": config.timeout_seconds,
        "insecureTls": config.insecure_tls,
        "caFileConfigured": bool(config.ca_file),
        "hasCookie": config.has_cookie,
        "hasAuthorization": config.has_authorization,
        "extraHeaderNames": config.extra_header_names,
        "envVars": [
            "RUIJIE_KM_ENV",
            "RUIJIE_KM_BASE_URL",
            "RUIJIE_KM_COOKIE",
            "RUIJIE_KM_AUTHORIZATION",
            "RUIJIE_KM_EXTRA_HEADERS",
            "RUIJIE_KM_TIMEOUT_SECONDS",
            "RUIJIE_KM_INSECURE_TLS",
            "RUIJIE_KM_CA_FILE",
        ],
    }


def tool_list_documents(args: JsonDict) -> JsonDict:
    query = build_document_query(args)
    return require_success(request_json("/api/v1/knowledge/documents", query))


def tool_search_knowledge(args: JsonDict) -> JsonDict:
    query = build_document_query(args, default_page_size=DEFAULT_SEARCH_PAGE_SIZE)
    include_details = as_bool(args, "includeDetails", default=True)
    detail_limit = as_int(args, "detailLimit", minimum=0, maximum=MAX_DETAIL_LIMIT)
    if detail_limit is None:
        detail_limit = DEFAULT_DETAIL_LIMIT if include_details else 0

    list_payload = require_success(request_json("/api/v1/knowledge/documents", query))
    data = list_payload.get("data") if isinstance(list_payload.get("data"), dict) else {}
    documents = data.get("list") if isinstance(data, dict) else []
    if not isinstance(documents, list):
        documents = []

    normalized_docs: list[JsonDict] = []
    detail_errors: list[JsonDict] = []
    for index, doc in enumerate(documents):
        if not isinstance(doc, dict):
            continue
        detail_data = None
        if include_details and index < detail_limit and doc.get("docId"):
            try:
                detail_payload = tool_get_document({"docId": str(doc["docId"])})
                detail_data = detail_payload.get("data")
                if not isinstance(detail_data, dict):
                    detail_data = None
            except KMError as exc:
                detail_errors.append(
                    {
                        "docId": doc.get("docId"),
                        "title": doc.get("title"),
                        "error": exc.message,
                        "details": exc.details,
                    }
                )
        normalized_docs.append(normalize_document(doc, detail_data))

    latest_value = query.get("docIsNewVersion")
    if latest_value == 1:
        latest_only_value: bool | None = True
    elif latest_value == 0:
        latest_only_value = False
    else:
        latest_only_value = None

    return {
        "code": list_payload.get("code"),
        "message": list_payload.get("message"),
        "query": {
            "keyword": query.get("keyword"),
            "categoryId": query.get("categoryId"),
            "tag": query.get("tag"),
            "platform": query.get("platform"),
            "startTime": query.get("startTime"),
            "endTime": query.get("endTime"),
            "latestOnly": latest_only_value,
            "sort": query.get("sort"),
            "order": query.get("order"),
            "page": data.get("page") if isinstance(data, dict) else query.get("page"),
            "pageSize": data.get("pageSize") if isinstance(data, dict) else query.get("pageSize"),
        },
        "totalCount": data.get("totalCount", 0) if isinstance(data, dict) else 0,
        "results": normalized_docs,
        "detailErrors": detail_errors,
        "_request": list_payload.get("_request"),
    }


def tool_get_document(args: JsonDict) -> JsonDict:
    doc_id = as_string(args, "docId", required=True)
    assert doc_id is not None
    path_doc_id = urllib.parse.quote(doc_id, safe="")
    return require_success(request_json(f"/api/v1/knowledge/documents/{path_doc_id}"))


def tool_list_categories(args: JsonDict) -> JsonDict:
    query = {
        "accountNumber": as_string(args, "accountNumber"),
    }
    return require_success(request_json("/api/v1/knowledge/categories", query))


def tool_list_categories_by_parent(args: JsonDict) -> JsonDict:
    parent_id = as_string(args, "parentId", required=True)
    query = {
        "parentId": parent_id,
        "accountNumber": as_string(args, "accountNumber"),
    }
    return require_success(request_json("/api/v1/knowledge/categoriesByParentId", query))


def tool_list_tags(args: JsonDict) -> JsonDict:
    query = {
        "tagId": as_string(args, "tagId"),
        "tagName": as_string(args, "tagName"),
    }
    return require_success(request_json("/api/v1/knowledge/tags", query))


def tool_list_downloads(args: JsonDict) -> JsonDict:
    query = {
        "categoryId": as_string(args, "categoryId"),
    }
    return require_success(request_json("/api/v1/knowledge/download", query))


TOOLS: list[JsonDict] = [
    {
        "name": "km_get_config",
        "description": "Show the active Ruijie KM plugin configuration without exposing secret values.",
        "inputSchema": {
            "type": "object",
            "properties": {},
            "additionalProperties": False,
        },
    },
    {
        "name": "km_search",
        "description": "Search Ruijie KM like a knowledge-base assistant. Use this first for user-facing requests such as latest product brochures, parameter specs, manuals, category materials, or document summaries.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural search phrase or document title keyword, for example 产品彩页 RG-S6921 or 参数规格 交换机.",
                },
                "keyword": {
                    "type": "string",
                    "description": "Exact document title keyword. If omitted, query is used.",
                },
                "categoryId": {
                    "type": "string",
                    "description": "Optional KM category id when the user has already selected a category.",
                },
                "tag": {
                    "type": "string",
                    "description": "Optional KM tag name.",
                },
                "platform": {
                    "type": "string",
                    "description": "Optional platform filter. Accepts marketing, makiting, 市场资料平台, or a raw platform value.",
                },
                "startTime": {
                    "type": "string",
                    "description": "Start publish time, format yyyy-MM-dd HH:mm:ss.",
                },
                "endTime": {
                    "type": "string",
                    "description": "End publish time, format yyyy-MM-dd HH:mm:ss.",
                },
                "latestOnly": {
                    "type": "boolean",
                    "description": "Set true when the user asks for latest/current versions only.",
                },
                "page": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 10,
                    "description": "Current page, 1 to 10. Defaults to 1.",
                },
                "pageSize": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "description": "Rows per page. Defaults to 10 for assistant search.",
                },
                "includeDetails": {
                    "type": "boolean",
                    "description": "When true, fetch document detail for the top results so summaries, links, content snippets, and attachments are easier to present.",
                },
                "detailLimit": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 5,
                    "description": "How many top results should receive detail lookup. Defaults to 3; max 5.",
                },
                "accountNumber": {
                    "type": "string",
                    "description": "Optional user login account.",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "km_list_documents",
        "description": "Low-level paged Ruijie KM document list API. Prefer km_search for user-facing search and use this only when exact API-shaped paging is needed.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "page": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 10,
                    "description": "Current page, 1 to 10.",
                },
                "pageSize": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 100,
                    "description": "Rows per page. API default is 15; max is 100.",
                },
                "startTime": {
                    "type": "string",
                    "description": "Start publish time, format yyyy-MM-dd HH:mm:ss.",
                },
                "endTime": {
                    "type": "string",
                    "description": "End publish time, format yyyy-MM-dd HH:mm:ss.",
                },
                "keyword": {
                    "type": "string",
                    "description": "Document title keyword.",
                },
                "categoryId": {
                    "type": "string",
                    "description": "Category id from KM category APIs.",
                },
                "tag": {
                    "type": "string",
                    "description": "Tag name from KM tag API.",
                },
                "platform": {
                    "type": "string",
                    "description": "Platform filter. Accepts marketing, makiting, 市场资料平台, or a raw platform value.",
                },
                "sort": {
                    "type": "string",
                    "description": "Sort field. API default is publishTime.",
                },
                "order": {
                    "type": "string",
                    "enum": [
                        "ASC",
                        "DESC",
                        "asc",
                        "desc"
                    ],
                    "description": "Sort order. API default is DESC.",
                },
                "accountNumber": {
                    "type": "string",
                    "description": "User login account.",
                },
                "docIsNewVersion": {
                    "type": "integer",
                    "enum": [
                        0,
                        1
                    ],
                    "description": "1 means latest version; 0 means not latest.",
                },
                "latestOnly": {
                    "type": "boolean",
                    "description": "Convenience alias. true maps to docIsNewVersion=1.",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "km_get_document",
        "description": "Get full Ruijie KM document details by docId, including content and attachments returned by the API.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "docId": {
                    "type": "string",
                    "description": "Document id returned by km_list_documents.",
                }
            },
            "required": [
                "docId"
            ],
            "additionalProperties": False,
        },
    },
    {
        "name": "km_list_categories",
        "description": "Get the Ruijie KM tree-structured category data.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "accountNumber": {
                    "type": "string",
                    "description": "Optional user login account for account-related categories.",
                }
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "km_list_categories_by_parent",
        "description": "Get Ruijie KM categories by parentId. Use parentId=0 for top-level categories.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "parentId": {
                    "type": "string",
                    "description": "Parent category id. Pass 0 for top-level categories.",
                },
                "accountNumber": {
                    "type": "string",
                    "description": "Optional user login account for account-related categories.",
                },
            },
            "required": [
                "parentId"
            ],
            "additionalProperties": False,
        },
    },
    {
        "name": "km_list_tags",
        "description": "Search or list Ruijie KM tags. Tags are low-change data and should be cached by callers when possible.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "tagId": {
                    "type": "string",
                    "description": "Optional tag id.",
                },
                "tagName": {
                    "type": "string",
                    "description": "Optional tag name keyword.",
                },
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "km_list_downloads",
        "description": "Get Ruijie KM attachment download records by categoryId. This can expose downloader, department, IP, and download time; use only when the user explicitly asks for download/audit records.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "categoryId": {
                    "type": "string",
                    "description": "Optional category id.",
                }
            },
            "additionalProperties": False,
        },
    },
]


HANDLERS: dict[str, ToolHandler] = {
    "km_get_config": tool_get_config,
    "km_search": tool_search_knowledge,
    "km_list_documents": tool_list_documents,
    "km_get_document": tool_get_document,
    "km_list_categories": tool_list_categories,
    "km_list_categories_by_parent": tool_list_categories_by_parent,
    "km_list_tags": tool_list_tags,
    "km_list_downloads": tool_list_downloads,
}


def json_rpc_result(message_id: Any, result: Any) -> JsonDict:
    return {
        "jsonrpc": "2.0",
        "id": message_id,
        "result": result,
    }


def json_rpc_error(message_id: Any, code: int, message: str, data: Any | None = None) -> JsonDict:
    error: JsonDict = {
        "code": code,
        "message": message,
    }
    if data is not None:
        error["data"] = data
    return {
        "jsonrpc": "2.0",
        "id": message_id,
        "error": error,
    }


def write_message(message: JsonDict) -> None:
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def handle_initialize(message_id: Any, params: JsonDict) -> JsonDict:
    protocol_version = params.get("protocolVersion") or "2024-11-05"
    return json_rpc_result(
        message_id,
        {
            "protocolVersion": protocol_version,
            "capabilities": {
                "tools": {},
            },
            "serverInfo": {
                "name": SERVER_NAME,
                "version": SERVER_VERSION,
            },
            "instructions": "Use km_search first for user-facing Ruijie KM knowledge searches. Use low-level list/detail/category/tag tools only for precise follow-up. Do not call km_list_downloads unless the user explicitly asks for download or audit records.",
        },
    )


def handle_tools_list(message_id: Any) -> JsonDict:
    return json_rpc_result(message_id, {"tools": TOOLS})


def handle_tools_call(message_id: Any, params: JsonDict) -> JsonDict:
    name = params.get("name")
    args = params.get("arguments") or {}
    if not isinstance(args, dict):
        return json_rpc_error(message_id, -32602, "Tool arguments must be an object.")
    if not isinstance(name, str) or name not in HANDLERS:
        return json_rpc_error(message_id, -32602, f"Unknown tool: {name!r}")

    try:
        payload = HANDLERS[name](args)
    except KMError as exc:
        error_payload = {
            "error": exc.message,
            "details": exc.details,
        }
        return json_rpc_result(
            message_id,
            {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(error_payload, ensure_ascii=False, indent=2),
                    }
                ],
                "isError": True,
            },
        )
    except Exception as exc:  # pragma: no cover - final safety net for MCP clients.
        error_payload = {
            "error": str(exc),
            "traceback": traceback.format_exc(limit=5),
        }
        return json_rpc_result(
            message_id,
            {
                "content": [
                    {
                        "type": "text",
                        "text": json.dumps(error_payload, ensure_ascii=False, indent=2),
                    }
                ],
                "isError": True,
            },
        )

    return json_rpc_result(
        message_id,
        {
            "content": [
                {
                    "type": "text",
                    "text": json.dumps(payload, ensure_ascii=False, indent=2),
                }
            ],
            "structuredContent": payload,
        },
    )


def handle_message(message: JsonDict) -> JsonDict | None:
    message_id = message.get("id")
    method = message.get("method")
    params = message.get("params") or {}
    if not isinstance(params, dict):
        return json_rpc_error(message_id, -32602, "params must be an object.")

    if method == "initialize":
        return handle_initialize(message_id, params)
    if method == "tools/list":
        return handle_tools_list(message_id)
    if method == "tools/call":
        return handle_tools_call(message_id, params)
    if method == "ping":
        return json_rpc_result(message_id, {})

    if isinstance(method, str) and method.startswith("notifications/"):
        return None
    return json_rpc_error(message_id, -32601, f"Method not found: {method!r}")


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            write_message(json_rpc_error(None, -32700, "Parse error", str(exc)))
            continue
        if not isinstance(message, dict):
            write_message(json_rpc_error(None, -32600, "Invalid request"))
            continue

        response = handle_message(message)
        if response is not None and "id" in message:
            write_message(response)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
