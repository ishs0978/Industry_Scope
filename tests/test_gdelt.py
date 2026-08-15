from dataclasses import dataclass

import pytest
import requests

from ingest.sources.common import RETRYABLE_STATUS, RateLimiter, request_with_backoff
from ingest.sources.gdelt import GdeltUnavailable, fetch_mode, rotated_sectors


@dataclass(frozen=True)
class FakeSector:
    slug: str
    news_keywords: tuple = ("keyword",)


SECTORS = [FakeSector(f"s{index}") for index in range(5)]


def test_rotation_moves_the_starting_sector_each_day():
    assert [s.slug for s in rotated_sectors(SECTORS, 0)] == ["s0", "s1", "s2", "s3", "s4"]
    assert [s.slug for s in rotated_sectors(SECTORS, 2)] == ["s2", "s3", "s4", "s0", "s1"]


def test_rotation_covers_every_sector_first_across_a_cycle():
    # One failure defers every sector after it, so no sector may be permanently
    # last in line.
    leaders = {rotated_sectors(SECTORS, day)[0].slug for day in range(len(SECTORS))}
    assert leaders == {sector.slug for sector in SECTORS}


def test_rotation_handles_an_empty_registry():
    assert rotated_sectors([], 7) == []


class FakeResponse:
    def __init__(self, status_code=200, body="{}", headers=None):
        self.status_code = status_code
        self.text = body
        self.headers = headers or {}

    def json(self):
        import json
        return json.loads(self.text)

    def raise_for_status(self):
        if self.status_code >= 400:
            error = requests.HTTPError(f"HTTP {self.status_code}")
            error.response = self
            raise error


class ScriptedSession:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = 0

    def request(self, method, url, **kwargs):
        self.calls += 1
        result = self.responses.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def test_backoff_retries_a_429_then_succeeds():
    slept = []
    session = ScriptedSession([FakeResponse(429), FakeResponse(429), FakeResponse(200, '{"ok":1}')])
    response = request_with_backoff(
        session, "GET", "https://example.test", sleep=slept.append,
    )
    assert response.status_code == 200
    assert session.calls == 3
    assert len(slept) == 2


def test_backoff_gives_up_after_four_attempts_and_keeps_the_status():
    session = ScriptedSession([FakeResponse(429) for _ in range(4)])
    with pytest.raises(requests.HTTPError) as excinfo:
        request_with_backoff(session, "GET", "https://example.test", sleep=lambda _: None)
    assert session.calls == 4
    # The response must survive on the exception, or the caller cannot tell a
    # rate limit from a transport error.
    assert excinfo.value.response.status_code == 429


def test_backoff_does_not_retry_a_real_client_error():
    session = ScriptedSession([FakeResponse(404)])
    with pytest.raises(requests.HTTPError):
        request_with_backoff(session, "GET", "https://example.test", sleep=lambda _: None)
    assert session.calls == 1


def test_backoff_honours_retry_after():
    slept = []
    session = ScriptedSession([
        FakeResponse(503, headers={"Retry-After": "7"}), FakeResponse(200, '{"ok":1}'),
    ])
    request_with_backoff(session, "GET", "https://example.test", sleep=slept.append)
    assert slept == [7.0]


def test_every_retryable_status_is_covered():
    assert 429 in RETRYABLE_STATUS
    assert {500, 502, 503, 504}.issubset(RETRYABLE_STATUS)


def test_non_json_response_reports_the_body():
    session = ScriptedSession([FakeResponse(200, "<html><body>Rate limit exceeded</body></html>")])
    with pytest.raises(GdeltUnavailable) as excinfo:
        fetch_mode(session, SECTORS[0], "timelinevolraw", __import__("datetime").date(2026, 1, 1),
                   __import__("datetime").date(2026, 1, 2))
    # A rate limit and a malformed query fail identically without the body.
    assert "Rate limit exceeded" in str(excinfo.value)


def test_rate_limiter_spaces_requests():
    limiter = RateLimiter(requests_per_second=1 / 5)
    assert limiter.minimum_interval == pytest.approx(5.0)


def test_ord_terms_are_wrapped_in_parentheses():
    # GDELT answers HTTP 200 with "Queries containing OR'd terms must be
    # surrounded by ()." and no JSON body when they are not. Every sector query
    # contains OR, so this broke every sector on every run.
    query = __import__("ingest.sources.gdelt", fromlist=["query_for_sector"]).query_for_sector(
        FakeSector("multi", ("gold price", "gold mining", "silver price"))
    )
    assert query.startswith("(") and query.endswith(")")
    assert " OR " in query


def test_single_keyword_needs_no_parentheses():
    query = __import__("ingest.sources.gdelt", fromlist=["query_for_sector"]).query_for_sector(
        FakeSector("single", ("semiconductor",))
    )
    assert query == '"semiconductor"'
