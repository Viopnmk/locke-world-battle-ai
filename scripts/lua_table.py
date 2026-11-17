"""Minimal Lua data-table parser.

Handles the subset of Lua used by the BWIKI data modules:
`return { ... }` with string (quoted / long-bracket), number, boolean, nil,
nested table constructors, keyed (`k = v`, `[expr] = v`) and positional entries,
plus `--` line and `--[[ ]]` block comments.

A table with only positional entries becomes a list; otherwise a dict with the
positional entries under `_array`. That is enough for the wiki's data modules,
which never contain functions or expressions.
"""

import re

_TOKEN_NUMBER = re.compile(r"-?\d+\.?\d*(?:[eE][+-]?\d+)?")
_TOKEN_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_ESCAPES = {
    "n": "\n", "t": "\t", "r": "\r", "\\": "\\", '"': '"', "'": "'",
    "a": "\a", "b": "\b", "f": "\f", "v": "\v", "0": "\0",
}


class LuaTableParser:
    def __init__(self, text: str):
        self.s = text
        self.i = 0
        self.n = len(text)

    def _fail(self, msg: str):
        raise ValueError(f"Lua parse error at {self.i}: {msg}: "
                         f"...{self.s[max(0, self.i - 40):self.i + 40]!r}")

    def _skip(self):
        while self.i < self.n:
            c = self.s[self.i]
            if c in " \t\r\n":
                self.i += 1
            elif self.s.startswith("--", self.i):
                if self.s.startswith("--[[", self.i):
                    end = self.s.find("]]", self.i + 4)
                    self.i = self.n if end < 0 else end + 2
                else:
                    end = self.s.find("\n", self.i)
                    self.i = self.n if end < 0 else end + 1
            else:
                return

    def parse(self):
        self._skip()
        if self.s.startswith("return", self.i):
            self.i += 6
        return self._value()

    def _value(self):
        self._skip()
        if self.i >= self.n:
            self._fail("unexpected end")
        c = self.s[self.i]
        if c == "{":
            return self._table()
        if c in "\"'":
            return self._string()
        if self.s.startswith("[[", self.i):
            end = self.s.find("]]", self.i + 2)
            v = self.s[self.i + 2:end]
            self.i = end + 2
            return v
        if self.s.startswith("true", self.i):
            self.i += 4
            return True
        if self.s.startswith("false", self.i):
            self.i += 5
            return False
        if self.s.startswith("nil", self.i):
            self.i += 3
            return None
        m = _TOKEN_NUMBER.match(self.s, self.i)
        if m:
            self.i = m.end()
            tok = m.group()
            return float(tok) if ("." in tok or "e" in tok or "E" in tok) else int(tok)
        self._fail(f"unexpected char {c!r}")

    def _string(self):
        quote = self.s[self.i]
        self.i += 1
        out = []
        while self.i < self.n:
            c = self.s[self.i]
            if c == "\\":
                nxt = self.s[self.i + 1]
                if nxt in _ESCAPES:
                    out.append(_ESCAPES[nxt])
                    self.i += 2
                elif nxt.isdigit():
                    j = self.i + 1
                    num = ""
                    while j < self.n and self.s[j].isdigit() and len(num) < 3:
                        num += self.s[j]
                        j += 1
                    out.append(chr(int(num)))
                    self.i = j
                else:
                    out.append(nxt)
                    self.i += 2
            elif c == quote:
                self.i += 1
                return "".join(out)
            else:
                out.append(c)
                self.i += 1
        self._fail("unterminated string")

    def _table(self):
        self.i += 1
        items: dict = {}
        positional: list = []
        while True:
            self._skip()
            if self.i >= self.n:
                self._fail("unterminated table")
            if self.s[self.i] == "}":
                self.i += 1
                break
            start = self.i
            key = None
            if self.s[self.i] == "[":
                self.i += 1
                key = self._value()
                self._skip()
                if self.s[self.i] != "]":
                    self._fail("expected ]")
                self.i += 1
                self._skip()
                if self.s[self.i] != "=":
                    self._fail("expected = after [key]")
                self.i += 1
            else:
                m = _TOKEN_NAME.match(self.s, self.i)
                if m:
                    probe = m.end()
                    while probe < self.n and self.s[probe] in " \t":
                        probe += 1
                    if probe < self.n and self.s[probe] == "=":
                        key = m.group()
                        self.i = probe + 1
            if key is not None:
                items[key] = self._value()
            else:
                self.i = start
                positional.append(self._value())
            self._skip()
            if self.i < self.n and self.s[self.i] in ",;":
                self.i += 1
        if not items:
            return positional
        if positional:
            items["_array"] = positional
        return items


def parse_lua_table(text: str):
    return LuaTableParser(text).parse()
