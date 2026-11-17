#!/usr/bin/env python3
"""Fetch real 《洛克王国：世界》 (NRC) spirit data from BWIKI and build src/data/*.json.

Everything written here comes from wiki.biligame.com/nrc — nothing is invented.
Fields the wiki does not publish stay absent instead of being filled with guesses.

Sources
  1. https://wiki.biligame.com/nrc/精灵列表   rendered roster table (662 rows):
     dex number, avatar, name, types, trait name + effect, six base stats + total,
     evolution stage, form, season, egg groups, height, weight, ride flags, blurb.
  2. MediaWiki API (action=query&prop=revisions) for the Lua data modules:
     模块:Pets/data/{Catalog,Skills,Learnsets}          base game records
     模块:精灵图鉴/S5/数据/{精灵,技能,特性,辅助}          current-season shards (packed)
     模块:Pets/data/Types                              type matchup matrix
     模块:Pets/Theme, 模块:Pets/data/Config             type colours / display order
     模块:TypeData                                    type icon files
  3. Skill details joined from the learned-skill ids of each spirit's learnset.

Usage:  python3 scripts/fetch-wiki.py [--offline]
Output: src/data/spirits.json, src/data/type-chart.json, src/data/meta.json
Raw responses are cached under .cache/wiki/ (gitignored) so a rerun is cheap.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lua_table import parse_lua_table  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache", "wiki")
OUT_DATA = os.path.join(ROOT, "src", "data")

API = "https://wiki.biligame.com/nrc/api.php"
LIST_PAGE = "精灵列表"
LIST_URL = "https://wiki.biligame.com/nrc/" + urllib.parse.quote(LIST_PAGE)
HDRS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Referer": "https://wiki.biligame.com/nrc/",
    "Accept-Language": "zh-CN,zh;q=0.9",
}

MODULES = [
    "模块:Pets/data/Catalog",
    "模块:Pets/data/Skills",
    "模块:Pets/data/Learnsets",
    "模块:Pets/data/Types",
    "模块:Pets/data/Config",
    "模块:Pets/Theme",
    "模块:TypeData",
    "模块:精灵图鉴/S5/数据/精灵",
    "模块:精灵图鉴/S5/数据/技能",
    "模块:精灵图鉴/S5/数据/特性",
    "模块:精灵图鉴/S5/数据/辅助",
]

TZ = dt.timezone(dt.timedelta(hours=8))


# --------------------------------------------------------------------------- io
def _cache_path(name: str) -> str:
    safe = name.replace(":", "_").replace("/", "_").replace(" ", "_")
    return os.path.join(CACHE, safe)


def http_get(url: str, *, cache_name: str, offline: bool, retries: int = 3) -> str:
    """GET with an on-disk cache. Returns decoded text."""
    os.makedirs(CACHE, exist_ok=True)
    path = _cache_path(cache_name)
    if offline or os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            return f.read()
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=HDRS)
            with urllib.request.urlopen(req, timeout=120) as resp:
                status = resp.status
                raw = resp.read()
            if status != 200:
                raise RuntimeError(f"HTTP {status} for {url}")
            text = raw.decode("utf-8")
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            print(f"  fetched {cache_name}  {len(raw) / 1024:.0f} KiB")
            return text
        except (urllib.error.URLError, TimeoutError, RuntimeError) as exc:  # network hiccup
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise SystemExit(f"failed to fetch {url}: {last}")


def module_source(title: str, *, offline: bool) -> str:
    url = API + "?" + urllib.parse.urlencode({
        "action": "query", "prop": "revisions", "rvprop": "content",
        "rvslots": "main", "titles": title, "format": "json",
    })
    raw = http_get(url, cache_name="module_" + title, offline=offline)
    payload = json.loads(raw)
    for page in payload["query"]["pages"].values():
        if "revisions" in page:
            return page["revisions"][0]["slots"]["main"]["*"]
    raise SystemExit(f"wiki module missing: {title}")


# --------------------------------------------------------------- roster (HTML)
class _Cell:
    __slots__ = ("column", "text", "imgs", "links", "aria", "tag")

    def __init__(self, tag: str, column: str = ""):
        self.tag = tag
        self.column = column
        self.text: list[str] = []
        self.imgs: list[str] = []
        self.links: list[tuple[str, str]] = []
        self.aria = ""

    @property
    def plain(self) -> str:
        return re.sub(r"\s+", " ", "".join(self.text)).strip()


class RosterParser(HTMLParser):
    """Collects the spirit-list table: header column names + one record per row."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.header: list[str] = []
        self.rows: list[dict] = []
        self._cells: list[_Cell] = []
        self._cell: _Cell | None = None
        self._attrs: dict | None = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == "tr":
            self._cells = []
            self._attrs = a
        elif tag in ("td", "th"):
            self._cell = _Cell(tag, a.get("data-column", ""))
            self._cells.append(self._cell)
        elif self._cell is not None:
            if tag == "img":
                self._cell.imgs.append(a.get("src", ""))
            elif tag == "a":
                href = a.get("href", "")
                if href.startswith("/nrc/"):
                    self._cell.links.append((urllib.parse.unquote(href[5:]), a.get("title", "")))
            aria = a.get("aria-label")
            if aria and not self._cell.aria:
                self._cell.aria = aria

    def handle_endtag(self, tag):
        if tag in ("td", "th"):
            self._cell = None
        elif tag == "tr" and self._attrs is not None:
            if any(c.tag == "th" and c.column for c in self._cells) and not self.header:
                self.header = [c.column for c in self._cells]
            elif self._attrs.get("data-id"):
                self.rows.append({**self._attrs, "cells": list(self._cells)})
            self._attrs = None
            self._cells = []
            self._cell = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.text.append(data)


def parse_roster(html: str) -> tuple[list[dict], list[str], int | None]:
    p = RosterParser()
    p.feed(html)
    if not p.header:
        raise SystemExit("roster table header not found — wiki markup changed?")
    cols = p.header
    rows = []
    for raw in p.rows:
        cells = {}
        for idx, cell in enumerate(raw["cells"]):
            cells[cols[idx] if idx < len(cols) else f"col{idx}"] = cell
        rows.append({**{k: v for k, v in raw.items() if k != "cells"}, "_cells": cells})
    m = re.search(r'<span class="npc-total-number">(\d+)</span>', html)
    return rows, cols, int(m.group(1)) if m else None


# --------------------------------------------------------------- S5 shard codec
def decode_shard(packed):
    """`dragon-tuples-1` packed tables, same scheme the wiki's own Lua unpacker uses."""
    if not isinstance(packed, list) or not packed or packed[0] != "dragon-tuples-1":
        raise SystemExit("unexpected shard encoding")
    fields = packed[1]

    def dec(node):
        if isinstance(node, list):
            if not node:
                return {}
            if node[0] == 1:
                return {fields[entry[0] - 1]: dec(entry[1]) for entry in node[1]}
            if node[0] == 2:
                return [dec(child) for child in node[1]]
            raise SystemExit(f"unexpected shard node tag {node[0]!r}")
        return node

    return dec(packed[2])


# ------------------------------------------------------------------- utilities
def short_type(value: str | None) -> str:
    """'草系' -> '草'; the form the game itself shows."""
    return (value or "").strip().removesuffix("系")


def clean_name(title: str) -> str:
    return title.replace("（", "").replace("）", "").replace("(", "").replace(")", "")


def parse_range(text: str, unit: str) -> dict | None:
    """'0.53~0.75M' -> {'min': 0.53, 'max': 0.75, 'unit': 'M', 'raw': ...}"""
    raw = (text or "").strip()
    if not raw or raw in {"—", "-"}:
        return None
    body = raw.upper().removesuffix(unit.upper())
    nums = re.findall(r"\d+(?:\.\d+)?", body)
    if not nums:
        return None
    vals = [float(n) for n in nums]
    return {"min": min(vals), "max": max(vals), "unit": unit, "raw": raw}


def to_int(text: str) -> int | None:
    m = re.search(r"-?\d+", text or "")
    return int(m.group()) if m else None


# ------------------------------------------------------------------- main build
def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="use the cached responses only")
    args = ap.parse_args()

    print("[1/6] roster page 精灵列表")
    html = http_get(LIST_URL, cache_name="page_" + LIST_PAGE, offline=args.offline)
    rows, cols, page_total = parse_roster(html)
    print(f"  columns: {', '.join(cols)}")
    print(f"  rows parsed: {len(rows)}  (page says {page_total} 种形态)")
    if page_total is not None and page_total != len(rows):
        raise SystemExit("roster row count does not match the page total — refusing to publish")

    print("[2/6] Lua data modules")
    mods = {title: (parse_lua_table(module_source(title, offline=args.offline))
                    if title != "模块:TypeData" else module_source(title, offline=args.offline))
            for title in MODULES}

    skills_raw = dict(mods["模块:Pets/data/Skills"])
    learnsets = dict(mods["模块:Pets/data/Learnsets"])
    catalog = dict(mods["模块:Pets/data/Catalog"])

    s5_pets = decode_shard(mods["模块:精灵图鉴/S5/数据/精灵"])
    s5_skills = decode_shard(mods["模块:精灵图鉴/S5/数据/技能"])
    s5_traits = decode_shard(mods["模块:精灵图鉴/S5/数据/特性"])
    s5_aux = decode_shard(mods["模块:精灵图鉴/S5/数据/辅助"])

    skills_raw.update(s5_skills)        # season arts
    skills_raw.update(s5_traits)        # season traits
    learnsets.update(s5_aux.get("Learnsets") or {})
    catalog.update(s5_pets)
    season_stones = s5_aux.get("SeasonLearnsets") or {}   # {pet_id: {skill_stones: [...]}}
    print(f"  pets: {len(catalog)}   skill/trait records: {len(skills_raw)}   learnsets: {len(learnsets)}")

    # ---- skill id -> record
    # The wiki categories are 攻击 / 状态 / 防御 / 特性; 攻击 is split into 物攻 / 魔攻 by
    # damage_class, exactly as the wiki's own skill list shows it.
    CATEGORY = {"攻击": None, "状态": "状态", "防御": "防御", "特性": "特性"}
    skill_index = {}
    for sid, row in skills_raw.items():
        if not isinstance(row, dict):
            continue
        category = row.get("category") or ""
        if category == "攻击":
            category = "物理" if row.get("damage_class") == "物攻" else "魔法"
        elif category in CATEGORY and CATEGORY[category]:
            category = CATEGORY[category]
        element = row.get("element") or ""
        skill_index[sid] = {
            "id": sid,
            "name": row.get("name") or sid,
            "type": "" if element in ("无系别", "") else short_type(element),
            "category": category,
            "power": row.get("power"),
            "energy": row.get("energy"),
            "effect": row.get("desc") or "",
        }

    # ---- learnsets: one skill list per learnset id, shared by an evolution line
    # entry = [skill id, learn code, level?]; code 0 = by level, 1 = skill stone, 2 = blood-line
    learnset_out: dict[str, list] = {}
    for ls_id, ls in learnsets.items():
        if not isinstance(ls, dict):
            continue
        seen: set[tuple[str, str]] = set()
        entries: list[list] = []

        def add(skill_id: str, code: int, level=None):
            rec = skill_index.get(skill_id)
            if not rec or rec["category"] == "特性":
                return
            key = (rec["name"], rec["type"])
            if key in seen:
                return
            seen.add(key)
            entries.append([skill_id, code] + ([level] if level is not None else []))

        for item in ls.get("native_skills") or []:
            if isinstance(item, dict):
                add(item.get("skill"), 0, to_int(str(item.get("level"))))
        for sid in ls.get("skill_stones") or []:
            add(sid, 1)
        # blood-line skills: the ordinary pick, not the 18 typed variants
        for item in ls.get("blood_skills") or []:
            if isinstance(item, dict) and item.get("blood") in (None, "普通"):
                add(item.get("skill"), 2)
        if entries:
            learnset_out[ls_id] = entries

    used_skill_ids = {row[0] for entries in learnset_out.values() for row in entries}
    used_skill_ids |= {sid for extra in season_stones.values()
                       if isinstance(extra, dict) for sid in extra.get("skill_stones") or []}

    # ---- roster records
    spirits = []
    missing_skills = []
    for row in rows:
        cells = row["_cells"]
        name = cells["name"].plain if "name" in cells else ""
        types = [t.strip().removesuffix("系")
                 for t in (cells["types"].aria if "types" in cells else "").split("/") if t.strip()]
        avatar = cells["avatar"].imgs[0] if "avatar" in cells and cells["avatar"].imgs else ""
        name_cell = cells.get("name")
        page_title = clean_name(name_cell.links[0][0]) if name_cell and name_cell.links else name
        page_title = page_title or name

        stats = {
            key: to_int(cells[key].plain) if key in cells else None
            for key in ("hp", "atk", "def", "spa", "spd", "spe")
        }
        total = to_int(cells["total"].plain) if "total" in cells else None
        if total is None and all(v is not None for v in stats.values()):
            total = sum(stats.values())
        stats["total"] = total
        if not name or not types or stats["total"] is None:
            raise SystemExit(f"roster row incomplete, refusing to publish: {row.get('data-id')} {name!r}")

        trait_cell = cells.get("feature")
        trait_name = trait_cell.links[0][0].replace("特性：", "") if trait_cell and trait_cell.links else ""
        if not trait_name and trait_cell:
            trait_name = trait_cell.plain
        trait_effect = cells["featureDesc"].plain if "featureDesc" in cells else ""
        trait_effect = "" if trait_effect in ("—", "-") else trait_effect

        season_text = cells["season"].plain if "season" in cells else ""
        season = None if season_text in ("", "—", "-") else season_text

        pet_id = row["data-id"]
        cat_row = catalog.get(pet_id) or {}
        learnset_id = cat_row.get("learnset_id") or ""
        # season skill stones are attached to single spirits, so they stay per-spirit
        extra_stones = [sid for sid in (season_stones.get(pet_id) or {}).get("skill_stones") or []
                        if sid in skill_index and skill_index[sid]["category"] != "特性"]
        if not learnset_out.get(learnset_id) and not extra_stones:
            missing_skills.append(name)

        egg_text = cells["eggs"].plain if "eggs" in cells else ""
        egg_groups = [g.strip() for g in re.split(r"[/、,]", egg_text)
                      if g.strip() and g.strip() not in ("—", "-")]

        spirits.append({
            "id": pet_id,
            "dex": row.get("data-number", ""),
            "name": name,
            "page": page_title,
            "type": types,
            "stats": stats,
            "trait": {"name": trait_name, "effect": trait_effect} if (trait_name or trait_effect) else None,
            "stage": to_int(row.get("data-stage", "")),
            "form": row.get("data-form") or "",
            "season": season,
            "eggGroups": egg_groups,
            "height": parse_range(cells["height"].plain if "height" in cells else "", "M"),
            "weight": parse_range(cells["weight"].plain if "weight" in cells else "", "KG"),
            "rideable": (cells["ride"].aria if "ride" in cells else "") == "可骑乘",
            "doubleRide": (cells["doubleRide"].aria if "doubleRide" in cells else "") == "可同乘",
            "avatar": avatar,
            "desc": cells["description"].plain if "description" in cells else "",
            "learnset": learnset_id or None,
            **(({"extraStones": extra_stones}) if extra_stones else {}),
        })

    spirits.sort(key=lambda s: (int(s["dex"]) if s["dex"].isdigit() else 9999, s["id"]))

    # ---- type chart
    print("[3/6] type chart 模块:Pets/data/Types")
    chart_raw = mods["模块:Pets/data/Types"]
    theme = mods["模块:Pets/Theme"]
    colors = theme.get("colors") or {}
    type_ids = theme.get("ids") or {}
    type_data_src = mods["模块:TypeData"]
    icons = {name: url for name, url in
             re.findall(r'\["([^"]+)"\]\s*=\s*"(https://patchwiki\.biligame\.com/[^"]+)"', type_data_src)}

    order = ["普通", "草", "火", "水", "光", "地", "冰", "龙", "电",
             "毒", "虫", "武", "翼", "萌", "幽", "恶", "机械", "幻"]
    type_meta = []
    for name in order:
        c = colors.get(name) or {}
        type_meta.append({
            "name": name,
            "id": type_ids.get(name),
            "icon": icons.get(name),
            "color": c.get("top"),
            "light": c.get("light"),
            "dark": c.get("bot"),
        })
    if any(not t["icon"] or not t["color"] for t in type_meta):
        raise SystemExit("type icons/colours incomplete — wiki module layout changed?")

    defense: dict[str, dict[str, float]] = {}
    pairs: dict[str, dict[str, float]] = {}
    for key, rel in chart_raw.items():
        if not isinstance(rel, dict):
            continue
        incoming: dict[str, float] = {}
        for bucket in ("weak", "resist"):
            for item in rel.get(bucket) or []:
                if isinstance(item, dict) and item.get("type"):
                    incoming[short_type(item["type"])] = item.get("multiplier")
        names = [short_type(part) for part in str(key).split("|")]
        if len(names) == 1:
            defense[names[0]] = incoming
        else:
            pairs["|".join(sorted(names, key=lambda n: order.index(n) if n in order else 99))] = incoming

    unknown_types = sorted({t for s in spirits for t in s["type"] if t not in order})
    if unknown_types:
        raise SystemExit(f"roster has types missing from the chart: {unknown_types}")
    if set(defense) != set(order):
        raise SystemExit(f"type chart singles mismatch: {sorted(set(order) - set(defense))}")

    # The wiki publishes 86 dual-type rows. For a combination it does not list
    # (only 毒|幻 of the current roster), the published rows confirm the rule
    # single(a) * single(b) capped at 3 — checked below against every listed row.
    def combine(a: str, b: str, atk: str) -> float:
        return min(defense[a].get(atk, 1) * defense[b].get(atk, 1), 3)

    rule_mismatch = [(key, atk, inc.get(atk, 1), combine(key.split("|")[0], key.split("|")[1], atk))
                     for key, inc in pairs.items() for atk in order
                     if abs(inc.get(atk, 1) - combine(key.split("|")[0], key.split("|")[1], atk)) > 1e-9]
    if rule_mismatch:
        raise SystemExit(f"dual-type rule does not reproduce published rows: {rule_mismatch[:5]}")

    roster_pairs = {"|".join(sorted(s["type"], key=order.index))
                    for s in spirits if len(s["type"]) > 1}
    derived_pairs = sorted(p for p in roster_pairs if p not in pairs)
    for key in derived_pairs:
        a, b = key.split("|")
        pairs[key] = {atk: combine(a, b, atk) for atk in order
                      if combine(a, b, atk) != 1}

    type_chart = {
        "types": type_meta,
        "statusImmunity": {"草": "寄生", "火": "灼烧", "毒": "中毒", "冰": "冻结"},
        "defense": defense,     # defending type -> {attacking type: multiplier}, as published
        "pairs": pairs,         # defending "A|B" -> dual-type multipliers
        "derivedPairs": derived_pairs,   # not in the wiki table, computed with the rule it follows
        "rule": "双属性倍率 = 单属性倍率相乘，上限 3（wiki 已发布的 86 个组合全部符合）",
        "multipliers": sorted({m for d in list(defense.values()) + list(pairs.values())
                               for m in d.values()}),
        "source": {
            "module": "模块:Pets/data/Types",
            "moduleUrl": "https://wiki.biligame.com/nrc/模块:Pets/data/Types",
            "page": "https://wiki.biligame.com/nrc/克制计算器",
        },
    }

    # ---- meta
    stat_fields = ["hp", "atk", "def", "spa", "spd", "spe", "total"]
    coverage = {
        "withStats": sum(1 for s in spirits if all(s["stats"][f] is not None for f in stat_fields)),
        "withTrait": sum(1 for s in spirits if s["trait"]),
        "withSkills": sum(1 for s in spirits if s.get("learnset") in learnset_out or s.get("extraStones")),
        "withDescription": sum(1 for s in spirits if s["desc"]),
        "withHeightWeight": sum(1 for s in spirits if s["height"] and s["weight"]),
        "withSeason": sum(1 for s in spirits if s["season"]),
        "dualType": sum(1 for s in spirits if len(s["type"]) > 1),
        "learnsetEntries": sum(len(v) for v in learnset_out.values()),
        "uniqueLearnableSkills": len(used_skill_ids),
    }
    skill_out = [skill_index[sid] for sid in sorted(used_skill_ids)]
    by_type: dict[str, int] = {}
    for s in spirits:
        for t in s["type"]:
            by_type[t] = by_type.get(t, 0) + 1

    meta = {
        "game": "洛克王国：世界",
        "spiritCount": len(spirits),
        "pageReportedCount": page_total,
        "fetchedAt": dt.datetime.now(TZ).isoformat(timespec="seconds"),
        "sources": [
            {"name": "精灵列表（wiki 渲染表格）", "url": LIST_URL},
            {"name": "MediaWiki API（Lua 数据模块）", "url": API},
            {"name": "属性克制数据模块", "url": "https://wiki.biligame.com/nrc/模块:Pets/data/Types"},
            {"name": "克制计算器页面", "url": "https://wiki.biligame.com/nrc/克制计算器"},
        ],
        "fieldsFromWiki": [
            "id、图鉴编号、名称、属性、特性名与特性效果、生命/物攻/物防/魔攻/魔防/速度/总种族值、"
            "进化阶段、形态、归属赛季、蛋组、身高、体重、可骑乘/可同乘、精灵介绍、头像",
            "技能：名称、属性、类别（物理/魔法/变化）、威力、能耗、效果文本、学习来源（等级/技能石/血脉）、等级",
            "属性克制：18 系单属性与双属性受击倍率、状态免疫",
        ],
        "notPublished": [
            "技能命中率（wiki 数据模块无此字段，未以默认值填充）",
            "技能 PP（本作以能耗计，无 PP 字段）",
            "隐藏特性等未在列表页公开的字段",
        ],
        "coverage": coverage,
        "byType": by_type,
        "spiritsWithoutSkills": missing_skills,
        "typeChart": {
            "types": len(type_meta),
            "singleEntries": len(defense),
            "dualEntries": len(pairs),
            "derivedPairs": derived_pairs,
            "multipliers": type_chart["multipliers"],
        },
    }

    print("[4/6] writing JSON")
    os.makedirs(OUT_DATA, exist_ok=True)
    outputs = (
        ("spirits.json", spirits),
        ("learnsets.json", learnset_out),
        ("skills.json", skill_out),
        ("type-chart.json", type_chart),
        ("meta.json", meta),
    )
    for fname, obj in outputs:
        path = os.path.join(OUT_DATA, fname)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
        print(f"  wrote {os.path.relpath(path, ROOT)}  {os.path.getsize(path) / 1024:.0f} KiB")

    print("\n[5/6] summary")
    print(f"  spirits: {len(spirits)}   learnsets: {len(learnset_out)}   skills: {len(skill_out)}   "
          f"learnable entries: {coverage['learnsetEntries']}")
    print(f"  trait {coverage['withTrait']} · desc {coverage['withDescription']} · "
          f"dual-type {coverage['dualType']} · season-tagged {coverage['withSeason']}")
    print(f"  type chart: {len(defense)} single + {len(pairs)} dual "
          f"({len(derived_pairs)} derived), multipliers {type_chart['multipliers']}")
    if missing_skills:
        print(f"  WARNING no skills for {len(missing_skills)}: {missing_skills[:8]}")

    print("[6/6] integrity checks")
    dup_pages = [s["page"] for s in spirits if [t["page"] for t in spirits].count(s["page"]) > 1]
    if dup_pages:
        print(f"  note: {len(set(dup_pages))} shared page titles (forms of one spirit): {sorted(set(dup_pages))[:6]}")
    ts = [s["stats"]["total"] for s in spirits]
    print(f"  stat total range {min(ts)}–{max(ts)}")
    print("  OK")


if __name__ == "__main__":
    main()
