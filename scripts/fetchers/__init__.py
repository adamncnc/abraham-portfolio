from .tw_stock import fetch_tw_stock
from .us_stock import fetch_us_stock
from .gold import fetch_gold

FETCHERS = {
    "tw_etf": fetch_tw_stock,
    "tw_stock": fetch_tw_stock,
    "us_etf": fetch_us_stock,
    "us_stock": fetch_us_stock,
    "commodity": fetch_gold,
}


def fetch_by_type(item_type: str, symbol: str) -> dict:
    fetcher = FETCHERS.get(item_type)
    if fetcher is None:
        raise ValueError(f"Unknown item type: {item_type}")
    return fetcher(symbol)
