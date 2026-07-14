"""Tests for rookery_mcp.openalex — hermetic via the injectable _fetch."""

import urllib.parse

import pytest

from rookery_mcp.openalex import (
    ABSTRACT_CAP,
    map_work,
    reconstruct_abstract,
    search_openalex,
)

WORK = {
    "id": "https://openalex.org/W2741809807",
    "display_name": "The state of OA: a large-scale analysis",
    "publication_date": "2018-02-13",
    "relevance_score": 345.9,
    "cited_by_count": 1234,
    "doi": "https://doi.org/10.7717/peerj.4375",
    "open_access": {"is_oa": True},
    "primary_location": {
        "landing_page_url": "https://peerj.com/articles/4375",
        "source": {"display_name": "PeerJ"},
    },
    "authorships": [
        {"author": {"display_name": "Heather Piwowar"}},
        {"author": {"display_name": "Jason Priem"}},
    ],
    "abstract_inverted_index": {"Despite": [0], "growing": [1], "interest": [2]},
}


def fake_fetch_factory(captured, results=None):
    def _fetch(url):
        captured.append(url)
        return {"results": results if results is not None else [WORK]}

    return _fetch


def test_map_work_produces_crow_add_source_ready_fields():
    m = map_work(WORK)
    assert m["title"] == "The state of OA: a large-scale analysis"
    assert m["source_type"] == "academic_paper"
    assert m["authors"] == "Heather Piwowar, Jason Priem"
    assert m["publication_date"] == "2018-02-13"
    assert m["publisher"] == "PeerJ"
    assert m["doi"] == "10.7717/peerj.4375"  # bare DOI, prefix stripped
    assert m["url"] == "https://peerj.com/articles/4375"
    assert m["abstract"] == "Despite growing interest"
    assert m["relevance_score"] == 345.9
    assert m["is_open_access"] is True


def test_map_work_survives_sparse_records():
    m = map_work({"id": "https://openalex.org/W1", "display_name": "Bare"})
    assert m["title"] == "Bare"
    assert m["authors"] is None
    assert m["doi"] is None
    assert m["abstract"] is None
    assert m["url"] == "https://openalex.org/W1"  # falls back to the OpenAlex id


def test_reconstruct_abstract_orders_and_caps():
    assert reconstruct_abstract({"b": [1], "a": [0], "c": [2]}) == "a b c"
    assert reconstruct_abstract(None) is None
    long = {f"w{i}": [i] for i in range(1000)}
    text = reconstruct_abstract(long)
    assert len(text) <= ABSTRACT_CAP + 2
    assert text.endswith("…")


def test_search_builds_url_with_filters_and_mailto():
    captured = []
    out = search_openalex(
        "local llm harness",
        per_page=5,
        year_from=2020,
        year_to=2026,
        open_access=True,
        mailto="op@example.org",
        _fetch=fake_fetch_factory(captured),
    )
    assert len(out) == 1 and out[0]["title"].startswith("The state of OA")
    q = urllib.parse.parse_qs(urllib.parse.urlparse(captured[0]).query)
    assert q["search"] == ["local llm harness"]
    assert q["per-page"] == ["5"]
    assert q["mailto"] == ["op@example.org"]
    assert q["filter"] == [
        "from_publication_date:2020-01-01,to_publication_date:2026-12-31,is_oa:true"
    ]


def test_search_defaults_omit_filter_and_mailto():
    captured = []
    search_openalex("x", _fetch=fake_fetch_factory(captured))
    q = urllib.parse.parse_qs(urllib.parse.urlparse(captured[0]).query)
    assert "filter" not in q and "mailto" not in q
    assert q["per-page"] == ["10"]


def test_search_clamps_per_page_and_rejects_empty_query():
    captured = []
    search_openalex("x", per_page=999, _fetch=fake_fetch_factory(captured))
    q = urllib.parse.parse_qs(urllib.parse.urlparse(captured[0]).query)
    assert q["per-page"] == ["25"]
    with pytest.raises(ValueError):
        search_openalex("   ", _fetch=fake_fetch_factory([]))


def test_search_handles_empty_results():
    assert search_openalex("x", _fetch=fake_fetch_factory([], results=[])) == []
