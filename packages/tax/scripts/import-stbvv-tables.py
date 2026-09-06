"""Explicit maintenance tool, NEVER run at application start.

Fetches the official consolidated annexes. Numeric rows are imported unchanged;
progression rules remain reviewed code. Updating requires fachkatalog review.
"""
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import urlopen
import hashlib
import json
import re


class Tables(HTMLParser):
    def __init__(self):
        super().__init__()
        self.tables = []
        self.table = None
        self.row = None
        self.cell = None

    def handle_starttag(self, tag, attrs):
        if tag == 'table': self.table = []
        elif tag == 'tr': self.row = []
        elif tag in ('td', 'th'): self.cell = ''

    def handle_data(self, data):
        if self.cell is not None: self.cell += data

    def handle_endtag(self, tag):
        if tag in ('td', 'th') and self.row is not None:
            self.row.append(self.cell)
            self.cell = None
        elif tag == 'tr' and self.table is not None:
            self.table.append(self.row)
            self.row = None
        elif tag == 'table':
            self.tables.append(self.table)
            self.table = None


out = {'version': 'STBVV-2025-07-01-TABLES-2026-08-31', 'checkedAt': '2026-08-31', 'sources': [], 'tables': {}}
for annex, names in [(1, ['A']), (2, ['B']), (3, ['C']), (4, ['Da', 'Db'])]:
    url = f'https://www.gesetze-im-internet.de/stbgebv/anlage_{annex}.html'
    raw = urlopen(url, timeout=30).read()
    parser = Tables()
    parser.feed(raw.decode('iso-8859-1'))
    assert len(parser.tables) == len(names), (annex, len(parser.tables))
    out['sources'].append({'url': url, 'sha256': hashlib.sha256(raw).hexdigest()})
    for name, table in zip(names, parser.tables):
        rows = []
        for row in table:
            values = [re.sub(r'\s+', '', x or '') for x in row]
            if len(values) == 2 and all(re.fullmatch(r'\d+(,\d+)?', x) for x in values):
                rows.append([float(x.replace(',', '.')) for x in values])
        assert len(rows) > 20 and all(rows[i][0] < rows[i+1][0] for i in range(len(rows)-1))
        out['tables'][name] = rows
target = Path(__file__).resolve().parents[1] / 'src' / 'stbvv' / 'tables.json'
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(json.dumps(out, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print({name: len(rows) for name, rows in out['tables'].items()})
