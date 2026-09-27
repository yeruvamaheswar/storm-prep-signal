"""Build geo/tx-roster-counties.json: the roster counties (fleet.ZONE_COUNTIES), simplified from the Census file.

Usage: python scripts/build_roster_counties_geo.py <path to cb_2023_us_county_5m.shp>

Source: U.S. Census Bureau, 2023 Cartographic Boundary File, counties, 1:5,000,000
(https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_5m.zip). The Replay map draws rain over
the counties an alert names, so it needs their outlines. Each county keeps its largest part only (Galveston's
islands are dropped), simplified with Douglas-Peucker at SIMPLIFY_DEG and rounded to 3 decimals. Standard
library only: the shapefile and its .dbf are read directly.
"""
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server.engine.fleet import ZONE_COUNTIES  # noqa: E402

SOURCE_URL = "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_5m.zip"
SIMPLIFY_DEG = 0.01
OUT = ROOT / "geo" / "tx-roster-counties.json"


def read_dbf(path):
    data = Path(path).read_bytes()
    count, header_len, record_len = struct.unpack("<IHH", data[4:12])
    fields, pos = [], 32
    while data[pos] != 0x0D:
        name = data[pos:pos + 11].split(b"\0")[0].decode()
        fields.append((name, data[pos + 16]))
        pos += 32
    rows = []
    for i in range(count):
        start = header_len + i * record_len + 1  # skip the deletion flag
        row, offset = {}, start
        for name, width in fields:
            row[name] = data[offset:offset + width].decode("utf-8", "replace").strip()
            offset += width
        rows.append(row)
    return rows


def read_polygons(path):
    """Each record's rings as lists of (lng, lat), in file order."""
    data = Path(path).read_bytes()
    pos, shapes = 100, []
    while pos < len(data):
        _, words = struct.unpack(">ii", data[pos:pos + 8])
        content = data[pos + 8:pos + 8 + words * 2]
        pos += 8 + words * 2
        if struct.unpack("<i", content[:4])[0] != 5:
            shapes.append([])
            continue
        parts_n, points_n = struct.unpack("<ii", content[36:44])
        parts = list(struct.unpack(f"<{parts_n}i", content[44:44 + 4 * parts_n]))
        base = 44 + 4 * parts_n
        points = [struct.unpack("<dd", content[base + 16 * k:base + 16 * k + 16]) for k in range(points_n)]
        shapes.append([points[a:b] for a, b in zip(parts, parts[1:] + [points_n])])
    return shapes


def ring_area(ring):
    return abs(sum(x1 * y2 - x2 * y1 for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]))) / 2


def simplify(points, tolerance):
    """Douglas-Peucker on an open polyline."""
    if len(points) < 3:
        return points
    (x1, y1), (x2, y2) = points[0], points[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = (dx * dx + dy * dy) ** 0.5
    best, index = -1.0, 0
    for k in range(1, len(points) - 1):
        px, py = points[k]
        dist = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / norm if norm else ((px - x1) ** 2 + (py - y1) ** 2) ** 0.5
        if dist > best:
            best, index = dist, k
    if best <= tolerance:
        return [points[0], points[-1]]
    return simplify(points[:index + 1], tolerance)[:-1] + simplify(points[index:], tolerance)


def simplify_ring(ring, tolerance):
    # Split the closed ring at its far point so both halves are open polylines.
    far = max(range(len(ring)), key=lambda k: (ring[k][0] - ring[0][0]) ** 2 + (ring[k][1] - ring[0][1]) ** 2)
    half = simplify(ring[:far + 1], tolerance)[:-1] + simplify(ring[far:] + [ring[0]], tolerance)
    return [[round(x, 3), round(y, 3)] for x, y in half[:-1]] + [[round(half[0][0], 3), round(half[0][1], 3)]]


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    shp = Path(argv[0])
    rows, shapes = read_dbf(shp.with_suffix(".dbf")), read_polygons(shp)
    wanted = {fips: (zone, name) for zone, counties in ZONE_COUNTIES.items() for fips, name in counties}
    features = []
    for row, rings in zip(rows, shapes):
        if row.get("GEOID") not in wanted:
            continue
        zone, name = wanted[row["GEOID"]]
        largest = max(rings, key=ring_area)
        features.append({"type": "Feature",
                         "properties": {"fips": row["GEOID"], "name": name, "zone": zone,
                                        "census_name": row.get("NAME"), "label": "simplified", "source": SOURCE_URL},
                         "geometry": {"type": "Polygon", "coordinates": [simplify_ring(largest, SIMPLIFY_DEG)]}})
    missing = sorted(set(wanted) - {f["properties"]["fips"] for f in features})
    if missing:
        raise SystemExit(f"roster counties missing from the Census file: {missing}")
    features.sort(key=lambda f: f["properties"]["fips"])
    OUT.write_text(json.dumps({
        "type": "FeatureCollection",
        "label": "simplified",
        "source": SOURCE_URL,
        "comment": ("U.S. Census Bureau 2023 cartographic boundary counties (1:5,000,000), the roster counties "
                    "in fleet.ZONE_COUNTIES only. Largest part of each county, Douglas-Peucker at "
                    f"{SIMPLIFY_DEG} degrees, 3 decimals. Built by scripts/build_roster_counties_geo.py."),
        "features": features,
    }, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {OUT} ({len(features)} counties)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
